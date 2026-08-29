import * as z from "zod/v4";
import type { Config } from "../config.js";
import { MediaIntelError } from "../errors.js";
import { findBinary } from "../binaries.js";
import { runBinary } from "../process.js";

/**
 * yt-dlp backend: extract metadata and download media from platform pages and direct URLs.
 * yt-dlp is optional; when missing, throws MediaIntelError ytdlp_missing with a hint.
 */

// Minimal subset of yt-dlp's JSON output that we care about
export const infojsonChapter = z.object({
  start_time: z.number().optional(),
  end_time: z.number().optional(),
  title: z.string().optional(),
});

export const infojsonSponsorblock = z.object({
  category: z.string(),
  start_time: z.number(),
  end_time: z.number(),
});

export const infojsonHeatmapEntry = z.object({
  start_time: z.number(),
  end_time: z.number(),
  value: z.number(),
});

export const infojsonComment = z.object({
  author: z.string().optional(),
  text: z.string().optional(),
  like_count: z.number().optional(),
  is_pinned: z.boolean().optional(),
});

export const infojson = z.object({
  id: z.string().optional(),
  title: z.string().optional(),
  ext: z.string().optional(),
  extractor: z.string().optional(),
  duration: z.number().optional(),
  uploader: z.string().optional(),
  channel: z.string().optional(),
  upload_date: z.string().optional(), // YYYYMMDD
  view_count: z.number().optional(),
  like_count: z.number().optional(),
  comment_count: z.number().optional(),
  follower_count: z.number().optional(),
  is_live: z.boolean().optional(),
  chapters: z
    .array(
      z.object({
        start_time: z.number().optional(),
        end_time: z.number().optional(),
        title: z.string().optional(),
      }),
    )
    .optional(),
  heatmap: z.array(infojsonHeatmapEntry).optional(),
  most_replayed: z.array(infojsonHeatmapEntry).optional(),
  sponsorblock_chapters: z.array(infojsonSponsorblock).optional(),
  comments: z.array(infojsonComment).optional(),
  requested_subtitles: z.record(z.string(), z.any()).optional(),
  automatic_captions: z.record(z.string(), z.any()).optional(),
  subtitles: z.record(z.string(), z.any()).optional(),
});

export type Infojson = z.infer<typeof infojson>;

export interface YtdlpRunOptions {
  /** Additional yt-dlp arguments (after core args like --no-playlist). */
  extraArgs?: string[];
  /** Custom timeout in milliseconds. */
  timeoutMs?: number;
  /** For binary output (downloads). */
  binary?: boolean;
}

/**
 * Run yt-dlp with core args always enforced.
 * Always adds: --no-playlist, --no-overwrites, --no-warnings, --no-progress
 * Conditionally adds: --cookies <file> (only if config.ytdlpCookiesFile is non-empty)
 */
export async function runYtdlp(
  config: Config,
  args: string[],
  options: YtdlpRunOptions = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined; timedOut: boolean; missing: boolean }> {
  const ytdlpBin = await findBinary(config.ytdlpBin);
  if (!ytdlpBin) {
    throw new MediaIntelError("ytdlp_missing", "yt-dlp not found on PATH", "brew install yt-dlp / pip install yt-dlp, or set MEDIA_INTEL_YTDLP");
  }

  const coreArgs = ["--no-playlist", "--no-overwrites", "--no-warnings", "--no-progress"];
  if (config.ytdlpCookiesFile.length > 0) {
    coreArgs.push("--cookies", config.ytdlpCookiesFile);
  }

  const allArgs = [...coreArgs, ...args, ...(options.extraArgs ?? [])];
  const timeoutMs = options.timeoutMs ?? config.processTimeoutMs * 5;

  const runOptions = {
    timeoutMs,
    ...(options.binary !== undefined ? { binary: options.binary } : {}),
  };

  const result = await runBinary(config, ytdlpBin, allArgs, runOptions);

  return result;
}

/**
 * Download metadata via -J (JSON output without download), parsing the first JSON object.
 */
export async function fetchInfojson(config: Config, url: string, options: YtdlpRunOptions = {}): Promise<Infojson> {
  const result = await runYtdlp(config, ["-J", url], options);

  if (result.missing) {
    throw new MediaIntelError("ytdlp_missing", "yt-dlp not found on PATH", "brew install yt-dlp / pip install yt-dlp");
  }
  if (result.exitCode !== 0 && result.exitCode !== undefined) {
    throw new MediaIntelError("ytdlp_failed", `yt-dlp exited with code ${result.exitCode}`, `Error output: ${result.stderr.slice(0, 500)}`);
  }
  if (result.timedOut) {
    throw new MediaIntelError("ytdlp_timeout", `yt-dlp did not complete within ${options.timeoutMs ?? config.processTimeoutMs * 5}ms`);
  }

  // Parse the JSON (first line usually)
  const stdout = result.stdout.trim();
  if (stdout.length === 0) {
    throw new MediaIntelError("ytdlp_no_output", "yt-dlp produced no output");
  }

  const lines = stdout.split("\n");
  const firstLine = lines[0];
  if (firstLine === undefined || firstLine.length === 0) {
    throw new MediaIntelError("ytdlp_no_output", "yt-dlp produced no output");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch (error) {
    throw new MediaIntelError("ytdlp_invalid_json", `Could not parse yt-dlp output: ${String(error)}`, `Output: ${firstLine.slice(0, 200)}`);
  }

  const validated = infojson.parse(parsed);
  return validated;
}
