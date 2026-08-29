import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Config } from "../config.js";
import { commonOutput, untrustedText, wrapUntrusted } from "../contracts.js";
import { MediaIntelError } from "../errors.js";
import { toolErrorResult } from "../errors.js";
import { cacheEntry, readSidecarJson, sidecarExists, writeSidecarJson } from "../cache.js";
import { resolveSource } from "../source.js";
import { fetchInfojson, runYtdlp, type Infojson } from "../backends/ytdlp.js";

export const fetchMediaInput = z.object({
  url: z.string().min(1).describe("YouTube URL or other platform page URL."),
  what: z.array(z.enum(["info", "audio", "video", "subtitles", "thumbnail"])).optional().describe("What to download: info, audio, video, subtitles, thumbnail. Default: [info, audio, subtitles]."),
  video_quality: z.enum(["smallest", "480p", "720p", "best"]).optional().describe('Video quality: "smallest" (≤360p), "480p", "720p", or "best". Default: "smallest".'),
  audio_only_format: z.enum(["m4a", "wav", "mp3"]).optional().describe("Audio format when downloading audio only. Default: m4a."),
  section: z.object({ start_s: z.number().nonnegative(), end_s: z.number().positive() }).optional().describe("Download only this time section."),
  subtitle_languages: z.array(z.string()).optional().describe('Languages for subtitles; e.g. ["en", "de"]. Default: ["en", "de"].'),
  refresh: z.boolean().optional().describe("Re-download even if files are cached. Default: false."),
});

const fileInfo = z.object({
  path: z.string(),
  bytes: z.number().optional(),
  height: z.number().optional(),
});

const subtitleTrack = z.object({
  language: z.string(),
  automatic: z.boolean(),
  path: z.string(),
});

export const fetchMediaOutput = z.object({
  url: z.string(),
  extractor: z.string().optional(),
  id: z.string().optional(),
  title: untrustedText.optional(),
  uploader: z.string().optional(), // untrusted, capped
  duration_s: z.number().optional(),
  cache_dir: z.string(),
  files: z.object({
    info: z.string().optional(),
    video: fileInfo.optional(),
    audio: fileInfo.optional(),
    thumbnail: z.string().optional(),
    subtitles: z.array(subtitleTrack),
  }),
  from_cache: z.boolean(),
  ...commonOutput,
});

export type FetchMediaInput = z.infer<typeof fetchMediaInput>;
export type FetchMediaResult = z.infer<typeof fetchMediaOutput>;

async function filesExistInCache(
  entry: { dir: string },
  what: string[],
): Promise<boolean> {
  const has = async (name: string): Promise<boolean> => sidecarExists(entry as any, name);
  for (const w of what) {
    if (w === "info" && !(await has("info.json"))) return false;
    if (w === "video" && !(await has("media.mp4")) && !(await has("media.webm")) && !(await has("media.mkv"))) return false;
    if (w === "audio" && !(await has("audio.m4a")) && !(await has("audio.wav")) && !(await has("audio.mp3"))) return false;
    if (w === "thumbnail" && !(await has("thumb.jpg")) && !(await has("thumb.png"))) return false;
    if (w === "subtitles") {
      // For subtitles, we need at least one
      const files = await readdir(entry.dir);
      if (!files.some((f) => /^subs\.[a-z]{2}/.test(f))) return false;
    }
  }
  return true;
}

/**
 * Map video quality setting to yt-dlp format string.
 * These are heuristics that should work for most sources.
 */
function formatForQuality(quality: string): string {
  switch (quality) {
    case "480p":
      return "bv*[height<=480]+ba/b[height<=480]/worst";
    case "720p":
      return "bv*[height<=720]+ba/b[height<=720]/worst";
    case "best":
      return "bv*+ba/b";
    case "smallest":
    default:
      return "bv*[height<=360]+ba/b[height<=360]/worst";
  }
}

/**
 * Tier-1 tool: download media from platform pages via yt-dlp.
 * Supports video, audio, subtitles (manual and auto), and thumbnail.
 * Cached by URL; respects refresh flag.
 */
export async function fetchMedia(config: Config, input: FetchMediaInput): Promise<FetchMediaResult> {
  const resolved = await resolveSource(input.url);
  const entry = await cacheEntry(config, resolved);

  const what = input.what ?? ["info", "audio", "subtitles"];
  const videoQuality = input.video_quality ?? "smallest";
  const audioFormat = input.audio_only_format ?? "m4a";
  const subLangs = input.subtitle_languages ?? ["en", "de"];
  const refresh = input.refresh ?? false;

  const warnings: string[] = [];
  const suggested: string[] = [];

  // Check cache first
  if (!refresh && (await filesExistInCache(entry, what))) {
    const cached = await readSidecarJson<Partial<Infojson>>(entry as any, "info.json");
    return buildResult(entry, cached, true, what, warnings, suggested, input.url);
  }

  // Run yt-dlp to fetch metadata
  const infoResult = await fetchInfojson(config, input.url, { timeoutMs: config.processTimeoutMs * 5 });

  if (infoResult.is_live) {
    warnings.push("Video is a live stream; some features may not work as expected.");
  }

  // Build yt-dlp args for downloading
  const ytdlpArgs: string[] = [];

  // Handle sections
  if (input.section) {
    const start = input.section.start_s;
    const end = input.section.end_s;
    ytdlpArgs.push("--download-sections", `*${start}-${end}`);
  }

  // If not downloading any media, just get info with -J
  const needsDownload = what.includes("video") || what.includes("audio") || what.includes("thumbnail") || what.includes("subtitles");

  if (needsDownload) {
    // Download video if requested
    if (what.includes("video")) {
      ytdlpArgs.push("-f", formatForQuality(videoQuality));
      ytdlpArgs.push("-o", join(entry.dir, "media.%(ext)s"));
    }

    // Download audio separately if requested and video is not included
    // (when video is included, audio is embedded in the video file)
    if (what.includes("audio") && !what.includes("video")) {
      ytdlpArgs.push("-f", `ba[ext=${audioFormat}]/ba/b`);
      ytdlpArgs.push("-x", "--audio-format", audioFormat);
      ytdlpArgs.push("-o", join(entry.dir, "audio.%(ext)s"));
    }

    // Download subtitles if requested
    if (what.includes("subtitles")) {
      ytdlpArgs.push("--write-subs", "--write-auto-subs", "--sub-langs", subLangs.join(","), "--sub-format", "vtt", "--convert-subs", "vtt");
      ytdlpArgs.push("-o", join(entry.dir, "subs"));
    }

    // Download thumbnail if requested
    if (what.includes("thumbnail")) {
      ytdlpArgs.push("--write-thumbnail", "-o", join(entry.dir, "thumb"));
    }

    // Always write info.json
    ytdlpArgs.push("--write-info-json", "-o", join(entry.dir, "info"));

    ytdlpArgs.push(input.url);

    const result = await runYtdlp(config, ytdlpArgs, { timeoutMs: config.processTimeoutMs * 5 });

    if (result.exitCode !== 0 && !result.missing) {
      if (input.section) {
        warnings.push("Section cutting failed; full media was downloaded.");
      }
    }
  } else {
    // Just info.json
    await writeSidecarJson(entry as any, "info.json", infoResult);
  }

  return buildResult(entry, infoResult, false, what, warnings, suggested, input.url);
}

async function buildResult(
  entry: { dir: string },
  info: Partial<Infojson> | undefined,
  fromCache: boolean,
  what: string[],
  warnings: string[],
  suggested: string[],
  urlInput: string,
): Promise<FetchMediaResult> {
  const dirContents = await readdir(entry.dir);

  const baseUrl = urlInput.startsWith("http") ? urlInput : info?.id ? `https://www.youtube.com/watch?v=${info.id}` : urlInput;

  const result: FetchMediaResult = {
    url: baseUrl,
    extractor: info?.extractor,
    id: info?.id,
    ...(info?.title ? { title: wrapUntrusted(info.title, 500) } : {}),
    ...(info?.uploader ? { uploader: info.uploader.slice(0, 200) } : {}),
    ...(info?.duration !== undefined ? { duration_s: info.duration } : {}),
    cache_dir: entry.dir,
    files: {
      subtitles: [],
    },
    from_cache: fromCache,
    warnings,
    suggested_next: suggested,
  };

  // Find files in the directory
  if (what.includes("info")) {
    const infoPath = dirContents.find((f) => f === "info.json" || f.startsWith("info."));
    if (infoPath !== undefined) {
      result.files.info = join(entry.dir, infoPath);
    }
  }

  if (what.includes("video")) {
    const videoFile = dirContents.find((f) => f === "media.mp4" || f.startsWith("media."));
    if (videoFile !== undefined) {
      const path = join(entry.dir, videoFile);
      const stats = await stat(path).catch(() => null);
      result.files.video = {
        path,
        ...(stats?.size !== undefined ? { bytes: stats.size } : {}),
      };
    }
  }

  if (what.includes("audio")) {
    const audioFile = dirContents.find((f) => f.startsWith("audio."));
    if (audioFile !== undefined) {
      const path = join(entry.dir, audioFile);
      const stats = await stat(path).catch(() => null);
      result.files.audio = {
        path,
        ...(stats?.size !== undefined ? { bytes: stats.size } : {}),
      };
    }
  }

  if (what.includes("thumbnail")) {
    const thumbFile = dirContents.find((f) => f.startsWith("thumb."));
    if (thumbFile !== undefined) {
      result.files.thumbnail = join(entry.dir, thumbFile);
    }
  }

  if (what.includes("subtitles")) {
    const subFiles = dirContents.filter((f) => /^subs\.[a-z]{2}/.test(f));
    for (const subFile of subFiles) {
      const langMatch = subFile.match(/^subs\.([a-z]{2})(?:\.auto)?\.vtt$/);
      if (langMatch && langMatch[1] !== undefined) {
        const lang = langMatch[1];
        // Determine if automatic based on infojson: check if lang exists in automatic_captions vs subtitles
        let automatic = false;
        if (info?.automatic_captions && info.automatic_captions[lang] !== undefined) {
          automatic = true;
        } else if (info?.requested_subtitles && info.requested_subtitles[lang]?.automatic) {
          automatic = true;
        } else {
          // Fall back to filename heuristic if infojson doesn't have this data
          automatic = subFile.includes(".auto.");
        }
        result.files.subtitles.push({
          language: lang,
          automatic,
          path: join(entry.dir, subFile),
        });
      }
    }
    if (result.files.subtitles.length === 0) {
      warnings.push("No subtitles found for the requested languages.");
    }
  }

  if (!what.includes("subtitles") && result.files.subtitles.length > 0) {
    result.files.subtitles = [];
  }

  return result;
}

export function summarizeFetchMedia(r: FetchMediaResult): string {
  const parts: string[] = [];
  if (r.title) parts.push(`"${r.title.text}"`);
  if (r.uploader) parts.push(`by ${r.uploader}`);
  if (r.duration_s !== undefined) parts.push(`${Math.round(r.duration_s)}s`);
  if (r.files.video) parts.push(`video ${r.files.video.height ?? "?"}p`);
  if (r.files.audio) parts.push("audio");
  if (r.files.thumbnail) parts.push("thumbnail");
  const subCount = r.files.subtitles.length;
  if (subCount > 0) parts.push(`${subCount} subtitle track(s)`);
  const line = parts.join(" | ");
  const cache = r.from_cache ? "(from cache)" : "(downloaded fresh)";
  const warn = r.warnings.length > 0 ? `\nWarnings:\n- ${r.warnings.join("\n- ")}` : "";
  return `${line} ${cache}${warn}`;
}

export function registerFetchMedia(server: McpServer, config: Config): void {
  server.registerTool(
    "fetch_media",
    {
      title: "Fetch media",
      description:
        "Download a video, audio, or metadata from a platform page URL via yt-dlp. " +
        "Supports selective downloads (video, audio, subtitles, thumbnail), quality selection, " +
        "time-window cutting, subtitle language choice, and caching. " +
        "Platform pages (YouTube, etc.) must go through this tool first; local files can go directly to probe_media.",
      inputSchema: fetchMediaInput,
      outputSchema: fetchMediaOutput,
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await fetchMedia(config, args);
        return { content: [{ type: "text", text: summarizeFetchMedia(result) }], structuredContent: result };
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );
}
