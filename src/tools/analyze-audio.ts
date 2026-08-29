import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { cacheEntry, readSidecarJson, sidecarExists, sidecarPath, writeSidecarBytes, writeSidecarJson } from "../cache.js";
import type { Config } from "../config.js";
import { commonOutput, resolveWindow, round3, windowInput } from "../contracts.js";
import { MediaIntelError, toolErrorResult } from "../errors.js";
import { analyzeAudio as ffAnalyzeAudio, ffmpeg, ffprobe, parseNumber, type AudioAnalysis } from "../ffmpeg.js";
import { resolveSource } from "../source.js";
import { readFile } from "node:fs/promises";

export const analyzeAudioInput = z.object({
  source: z.string().min(1).describe("Local audio/video path, file:// URL, or direct http(s) URL."),
  window: windowInput.optional(),
  silence_db: z.number().max(0).optional().describe("Silence threshold in dBFS. Default -40. Use -30 for noisy rooms."),
  silence_min_s: z.number().min(0.05).max(30).optional().describe("Minimum silence length in seconds. Default 0.5."),
  images: z.array(z.enum(["waveform", "spectrogram"])).optional().describe("Images to render for the model. Default ['waveform']. Waveform costs ~1.2 KB, spectrogram ~70 KB."),
  image_width: z.number().int().min(320).max(2576).optional().describe("Width of rendered images in px. Default 1200."),
  max_silences: z.number().int().min(1).max(5000).optional().describe("Cap on silence intervals returned. Default 200."),
});

const interval = z.object({ start_s: z.number(), end_s: z.number(), duration_s: z.number() });

export const analyzeAudioOutput = z.object({
  source: z.string(),
  analysed_s: z.number(),
  loudness: z.object({
    integrated_lufs: z.number().optional(),
    loudness_range_lu: z.number().optional(),
    true_peak_dbfs: z.number().optional(),
    rms_level_db: z.number().optional(),
    peak_level_db: z.number().optional(),
    noise_floor_db: z.number().optional(),
  }),
  silences: z.array(interval),
  silence_total_s: z.number(),
  speech_ratio: z.number().optional(),
  speech_segments: z.array(interval),
  longest_speech_segment_s: z.number().optional(),
  verdicts: z.array(z.string()),
  images: z.array(z.object({ kind: z.enum(["waveform", "spectrogram"]), width: z.number(), height: z.number(), bytes: z.number(), cache_path: z.string() })),
  pagination: z.object({
    total_duration_s: z.number().optional(),
    window_start_s: z.number(),
    window_end_s: z.number(),
    has_more: z.boolean(),
    next_window: z.object({ start_s: z.number(), end_s: z.number() }).optional(),
  }),
  ...commonOutput,
});

export type AnalyzeAudioInput = z.infer<typeof analyzeAudioInput>;
export type AnalyzeAudioResult = z.infer<typeof analyzeAudioOutput>;

const MAX_SPAN_S = 4 * 3600;

interface Rendered {
  kind: "waveform" | "spectrogram";
  width: number;
  height: number;
  bytes: number;
  cache_path: string;
  data: Buffer;
}

async function renderImage(config: Config, location: string, kind: "waveform" | "spectrogram", width: number, window: { start_s: number; end_s?: number }, entry: Awaited<ReturnType<typeof cacheEntry>>): Promise<Rendered> {
  const height = kind === "waveform" ? Math.round(width / 8) : Math.round(width / 3);
  const name = `${kind}_${width}_${Math.round(window.start_s * 1000)}-${window.end_s !== undefined ? Math.round(window.end_s * 1000) : "end"}.png`;
  if (await sidecarExists(entry, name)) {
    const data = await readFile(sidecarPath(entry, name));
    return { kind, width, height, bytes: data.length, cache_path: sidecarPath(entry, name), data };
  }
  const args: string[] = ["-ss", String(window.start_s)];
  if (window.end_s !== undefined) args.push("-to", String(window.end_s));
  const filter = kind === "waveform"
    ? `showwavespic=s=${width}x${height}:colors=white:scale=lin:split_channels=0`
    : `showspectrumpic=s=${width}x${height}:legend=0:color=intensity:scale=log`;
  args.push("-i", location, "-vn", "-sn", "-filter_complex", `[0:a]aformat=channel_layouts=mono,${filter}[v]`, "-map", "[v]", "-frames:v", "1", "-f", "image2", "-update", "1", "-vcodec", "png", "pipe:1");
  const r = await ffmpeg(config, args, { binary: true });
  if (r.exitCode !== 0 || !r.stdoutBuffer || r.stdoutBuffer.length === 0) {
    throw new MediaIntelError("ffmpeg_failed", `Could not render ${kind}`, "Does the file have an audio stream?");
  }
  const path = await writeSidecarBytes(entry, name, r.stdoutBuffer);
  return { kind, width, height, bytes: r.stdoutBuffer.length, cache_path: path, data: r.stdoutBuffer };
}

function speechSegments(silences: Array<{ start_s: number; end_s: number }>, startS: number, endS: number): Array<{ start_s: number; end_s: number; duration_s: number }> {
  const out: Array<{ start_s: number; end_s: number; duration_s: number }> = [];
  let cursor = startS;
  for (const s of silences) {
    if (s.start_s > cursor + 0.05) out.push({ start_s: round3(cursor), end_s: round3(s.start_s), duration_s: round3(s.start_s - cursor) });
    cursor = Math.max(cursor, s.end_s);
  }
  if (Number.isFinite(endS) && endS > cursor + 0.05) out.push({ start_s: round3(cursor), end_s: round3(endS), duration_s: round3(endS - cursor) });
  return out;
}

export async function analyzeAudio(config: Config, input: AnalyzeAudioInput): Promise<{ result: AnalyzeAudioResult; images: Rendered[] }> {
  const resolved = await resolveSource(input.source);
  const probe = await ffprobe(config, resolved.location);
  if (!(probe.streams ?? []).some((s) => s.codec_type === "audio")) {
    throw new MediaIntelError("no_audio_stream", "analyze_audio needs an audio stream", "This file is silent or video-only; use get_scenes or get_video_grids.");
  }
  const duration = parseNumber(probe.format?.duration);
  const { start_s, end_s, pagination } = resolveWindow(input.window, duration, MAX_SPAN_S);
  const silenceDb = input.silence_db ?? -40;
  const silenceMin = input.silence_min_s ?? 0.5;
  const entry = await cacheEntry(config, resolved);
  const window = { start_s, ...(Number.isFinite(end_s) ? { end_s } : {}) };
  const sidecar = `audio_${silenceDb}_${silenceMin}_${Math.round(start_s * 1000)}-${Number.isFinite(end_s) ? Math.round(end_s * 1000) : "end"}.json`;
  let analysis = await readSidecarJson<AudioAnalysis>(entry, sidecar);
  if (!analysis) {
    analysis = await ffAnalyzeAudio(config, resolved.location, { silenceNoiseDb: silenceDb, silenceMinS: silenceMin, ...(input.window ? { window } : {}) });
    await writeSidecarJson(entry, sidecar, analysis);
  }

  const analysedEnd = Number.isFinite(end_s) ? end_s : (duration ?? start_s);
  const analysedS = Math.max(0, analysedEnd - start_s);
  const warnings: string[] = [];
  const maxSil = input.max_silences ?? 200;
  let silences = analysis.silences;
  if (silences.length > maxSil) {
    warnings.push(`${silences.length} silences; returning the ${maxSil} longest.`);
    silences = [...silences].sort((a, b) => b.duration_s - a.duration_s).slice(0, maxSil).sort((a, b) => a.start_s - b.start_s);
  }
  const silenceTotal = round3(analysis.silences.reduce((a, s) => a + s.duration_s, 0));
  const speech = speechSegments(analysis.silences, start_s, analysedEnd);
  const speechRatio = analysedS > 0 ? round3(Math.max(0, 1 - silenceTotal / analysedS)) : undefined;

  const verdicts: string[] = [];
  const lufs = analysis.loudness.integrated_lufs;
  if (lufs !== undefined) {
    if (lufs < -30) verdicts.push("very quiet recording (below -30 LUFS); normalize before ASR or raise gain");
    else if (lufs > -10) verdicts.push("hot recording (above -10 LUFS); may clip");
    else verdicts.push("loudness in a normal range for speech");
  }
  if (analysis.stats.noise_floor_db !== undefined && Number.isFinite(analysis.stats.noise_floor_db) && analysis.stats.noise_floor_db > -40) {
    verdicts.push("high noise floor (above -40 dB); expect ASR errors, consider a denoise pass");
  }
  if (speechRatio !== undefined && speechRatio < 0.2) verdicts.push("mostly silence; transcription will return little");
  if (analysis.loudness.true_peak_dbfs !== undefined && analysis.loudness.true_peak_dbfs > -0.5) verdicts.push("true peak near 0 dBFS: clipping likely");
  if (verdicts.length === 0) verdicts.push("inconclusive");

  const kinds = input.images ?? ["waveform"];
  const width = input.image_width ?? 1200;
  const images: Rendered[] = [];
  for (const kind of kinds) images.push(await renderImage(config, resolved.location, kind, width, window, entry));

  const longest = speech.length > 0 ? Math.max(...speech.map((s) => s.duration_s)) : undefined;
  const result: AnalyzeAudioResult = {
    source: input.source,
    analysed_s: round3(analysedS),
    loudness: {
      ...(analysis.loudness.integrated_lufs !== undefined ? { integrated_lufs: analysis.loudness.integrated_lufs } : {}),
      ...(analysis.loudness.loudness_range_lu !== undefined ? { loudness_range_lu: analysis.loudness.loudness_range_lu } : {}),
      ...(analysis.loudness.true_peak_dbfs !== undefined ? { true_peak_dbfs: analysis.loudness.true_peak_dbfs } : {}),
      ...(analysis.stats.rms_level_db !== undefined && Number.isFinite(analysis.stats.rms_level_db) ? { rms_level_db: analysis.stats.rms_level_db } : {}),
      ...(analysis.stats.peak_level_db !== undefined && Number.isFinite(analysis.stats.peak_level_db) ? { peak_level_db: analysis.stats.peak_level_db } : {}),
      ...(analysis.stats.noise_floor_db !== undefined && Number.isFinite(analysis.stats.noise_floor_db) ? { noise_floor_db: analysis.stats.noise_floor_db } : {}),
    },
    silences,
    silence_total_s: silenceTotal,
    ...(speechRatio !== undefined ? { speech_ratio: speechRatio } : {}),
    speech_segments: speech.slice(0, maxSil),
    ...(longest !== undefined ? { longest_speech_segment_s: round3(longest) } : {}),
    verdicts,
    images: images.map(({ kind, width: w, height, bytes, cache_path }) => ({ kind, width: w, height, bytes, cache_path })),
    pagination,
    warnings,
    suggested_next: speechRatio !== undefined && speechRatio > 0.2 ? ["get_transcript (skip silences via window)"] : ["get_video_grids (audio carries little)"],
  };
  return { result, images };
}

export function summarizeAudio(r: AnalyzeAudioResult): string {
  const l = r.loudness;
  const parts = [
    `${r.analysed_s}s analysed`,
    l.integrated_lufs !== undefined ? `${l.integrated_lufs} LUFS` : "",
    l.loudness_range_lu !== undefined ? `LRA ${l.loudness_range_lu} LU` : "",
    l.noise_floor_db !== undefined ? `noise floor ${l.noise_floor_db} dB` : "",
    l.true_peak_dbfs !== undefined ? `peak ${l.true_peak_dbfs} dBFS` : "",
    `${r.silences.length} silences (${r.silence_total_s}s)`,
    r.speech_ratio !== undefined ? `speech ${Math.round(r.speech_ratio * 100)}%` : "",
  ].filter((s) => s.length > 0);
  const seg = r.speech_segments.slice(0, 20).map((s) => `${s.start_s}-${s.end_s}s`).join(", ");
  const warn = r.warnings.length > 0 ? `\nWarnings:\n- ${r.warnings.join("\n- ")}` : "";
  return `${parts.join(" | ")}\nVerdict: ${r.verdicts.join("; ")}${seg ? `\nSpeech segments: ${seg}${r.speech_segments.length > 20 ? " …" : ""}` : ""}${warn}`;
}

export function registerAnalyzeAudio(server: McpServer, config: Config): void {
  server.registerTool(
    "analyze_audio",
    {
      title: "Analyze audio",
      description:
        "Loudness (LUFS, range, true peak), noise floor, silence map and speech segments for any audio or video, plus a " +
        "waveform image (about 1 KB) so you can see where speech is without reading numbers. One decode pass, ~1 s per 5 min. " +
        "Use before transcription to pick windows and to judge recording quality; verdicts are heuristics.",
      inputSchema: analyzeAudioInput,
      outputSchema: analyzeAudioOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { result, images } = await analyzeAudio(config, args);
        return {
          content: [
            { type: "text", text: summarizeAudio(result) },
            ...images.map((img) => ({ type: "image" as const, data: img.data.toString("base64"), mimeType: "image/png" })),
          ],
          structuredContent: result,
        };
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );
}
