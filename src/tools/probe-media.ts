import * as z from "zod/v4";
import type { Config } from "../config.js";
import { commonOutput } from "../contracts.js";
import { MediaIntelError } from "../errors.js";
import { analyzeAudio, ffprobe, parseNumber, parseRational, type FfprobeStream } from "../ffmpeg.js";
import { resolveSource } from "../source.js";

export const probeMediaInput = z.object({
  source: z.string().min(1).describe("Absolute path to a local media file, or a direct http(s) URL to a media file."),
  deep: z
    .boolean()
    .optional()
    .describe("Also run one audio pass: silence map, loudness (LUFS), noise floor. Costs roughly 1 s per 5 minutes of audio."),
});

const videoStream = z.object({
  codec: z.string().optional(),
  profile: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  fps: z.number().optional(),
  frame_count: z.number().optional(),
  pixel_format: z.string().optional(),
  bit_rate: z.number().optional(),
});

const audioStream = z.object({
  codec: z.string().optional(),
  sample_rate: z.number().optional(),
  channels: z.number().optional(),
  channel_layout: z.string().optional(),
  bit_rate: z.number().optional(),
  language: z.string().optional(),
});

const subtitleStream = z.object({
  index: z.number(),
  codec: z.string().optional(),
  language: z.string().optional(),
  title: z.string().optional(),
});

const chapter = z.object({
  start_s: z.number(),
  end_s: z.number(),
  title: z.string().optional(),
});

const silence = z.object({ start_s: z.number(), end_s: z.number(), duration_s: z.number() });

const audioDeep = z.object({
  silences: z.array(silence),
  silence_total_s: z.number(),
  speech_ratio: z.number().optional(),
  integrated_lufs: z.number().optional(),
  loudness_range_lu: z.number().optional(),
  true_peak_dbfs: z.number().optional(),
  rms_level_db: z.number().optional(),
  noise_floor_db: z.number().optional(),
});

export const probeMediaOutput = z.object({
  source: z.string(),
  source_kind: z.enum(["file", "url"]),
  kind: z.enum(["video", "audio", "image", "unknown"]),
  container: z.string().optional(),
  duration_s: z.number().optional(),
  size_bytes: z.number().optional(),
  bit_rate: z.number().optional(),
  video: videoStream.optional(),
  audio: audioStream.optional(),
  subtitles: z.array(subtitleStream),
  chapters: z.array(chapter),
  tags: z.record(z.string(), z.string()),
  stream_counts: z.object({
    video: z.number(),
    audio: z.number(),
    subtitle: z.number(),
    other: z.number(),
  }),
  /** Heuristic: desktop-sized, low-motion video is probably a screen recording (prefer png frames, OCR). */
  looks_like_screen_recording: z.boolean(),
  audio_deep: audioDeep.optional(),
  ...commonOutput,
});

export type ProbeMediaInput = z.infer<typeof probeMediaInput>;
export type ProbeMediaResult = z.infer<typeof probeMediaOutput>;

const IMAGE_CODECS = new Set(["png", "mjpeg", "webp", "gif", "bmp", "tiff", "jpegxl", "avif", "heif", "hevc_still"]);
const IMAGE_FORMATS = new Set(["png_pipe", "image2", "webp_pipe", "gif", "bmp_pipe", "tiff_pipe", "jpeg_pipe"]);

function pickTags(tags: Record<string, string> | undefined, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!tags) return out;
  const lower = new Map(Object.entries(tags).map(([k, v]) => [k.toLowerCase(), v]));
  for (const key of keys) {
    const value = lower.get(key);
    if (value !== undefined && value.trim().length > 0) out[key] = value.trim().slice(0, 500);
  }
  return out;
}

function classify(format: string | undefined, video: FfprobeStream | undefined, audio: FfprobeStream | undefined, videoCount: number) {
  if (video && videoCount > 0) {
    const codec = video.codec_name ?? "";
    const frames = parseNumber(video.nb_frames);
    const isImageFormat = format !== undefined && [...IMAGE_FORMATS].some((f) => format.includes(f));
    if (IMAGE_CODECS.has(codec) || isImageFormat) {
      if (frames === undefined || frames <= 1) return "image" as const;
    }
    if (video.disposition?.attached_pic === 1 && audio) return "audio" as const;
    return "video" as const;
  }
  if (audio) return "audio" as const;
  return "unknown" as const;
}

const DESKTOP_SIZES = new Set(["1280x720", "1280x800", "1366x768", "1440x900", "1512x982", "1536x864", "1680x1050", "1728x1117", "1920x1080", "1920x1200", "2560x1440", "2560x1600", "2880x1800", "3024x1964", "3456x2234", "3840x2160"]);

function screenRecordingHeuristic(
  video: { width?: number | undefined; height?: number | undefined; fps?: number | undefined; bit_rate?: number | undefined } | undefined,
  durationS: number | undefined,
): boolean {
  if (!video?.width || !video.height) return false;
  const desktop = DESKTOP_SIZES.has(`${video.width}x${video.height}`);
  // Screen recordings compress extremely well: low bits per pixel per frame.
  const bpp = video.bit_rate && video.fps ? video.bit_rate / (video.width * video.height * video.fps) : undefined;
  const lowMotion = bpp !== undefined ? bpp < 0.05 : false;
  return desktop && (lowMotion || durationS === undefined);
}

/**
 * Tier-1 tool: cheap, decode-free inspection. Everything else in media-intel
 * builds on the answers here (duration drives frame budgets, audio presence
 * decides whether transcription is possible, size drives cost warnings).
 */
export async function probeMedia(config: Config, input: ProbeMediaInput): Promise<ProbeMediaResult> {
  const resolved = await resolveSource(input.source);
  if (resolved.sizeBytes !== undefined && resolved.sizeBytes > config.maxInputBytes) {
    throw new MediaIntelError("input_too_large", `File is ${resolved.sizeBytes} bytes, above MEDIA_INTEL_MAX_BYTES`, "Raise the limit or trim the file first.");
  }
  const probe = await ffprobe(config, resolved.location);
  const streams = probe.streams ?? [];
  const format = probe.format;

  if (streams.length > config.maxStreams) {
    throw new MediaIntelError("input_rejected", `${streams.length} streams exceed MEDIA_INTEL_MAX_STREAMS`, "Remux to a file with fewer streams.");
  }

  const videoStreams = streams.filter((s) => s.codec_type === "video");
  const audioStreams = streams.filter((s) => s.codec_type === "audio");
  const subtitleStreams = streams.filter((s) => s.codec_type === "subtitle");
  const otherCount = streams.length - videoStreams.length - audioStreams.length - subtitleStreams.length;

  const primaryVideo = videoStreams.find((s) => s.disposition?.attached_pic !== 1) ?? videoStreams[0];
  const primaryAudio = audioStreams.find((s) => s.disposition?.default === 1) ?? audioStreams[0];

  const kind = classify(format?.format_name, primaryVideo, primaryAudio, videoStreams.length);
  const duration = parseNumber(format?.duration) ?? parseNumber(primaryVideo?.duration) ?? parseNumber(primaryAudio?.duration);
  const sizeBytes = resolved.sizeBytes ?? parseNumber(format?.size);

  if (duration !== undefined && duration > config.maxDurationSeconds) {
    throw new MediaIntelError("input_rejected", `Duration ${Math.round(duration)}s exceeds MEDIA_INTEL_MAX_DURATION_S`, "Process a time window with fetch_media --download-sections or trim the file.");
  }
  if (primaryVideo?.width && primaryVideo.height && primaryVideo.width * primaryVideo.height > config.maxPixels) {
    throw new MediaIntelError("input_rejected", `Resolution ${primaryVideo.width}x${primaryVideo.height} exceeds MEDIA_INTEL_MAX_PIXELS`);
  }

  const warnings: string[] = [];
  const suggested: string[] = [];

  if (sizeBytes !== undefined && sizeBytes > config.warnFileSizeBytes) {
    warnings.push(`File is ${(sizeBytes / 1024 ** 3).toFixed(1)} GiB; full analysis will be slow. Prefer time-windowed tools.`);
  }
  if (duration !== undefined && duration > config.warnDurationSeconds) {
    warnings.push(`Duration is ${(duration / 3600).toFixed(1)} h; transcribe in windows and sample frames sparsely.`);
  }
  if (kind === "video" && audioStreams.length === 0) {
    warnings.push("No audio stream: transcription is not possible, rely on frames and OCR.");
  }
  if (kind === "video" && duration === undefined) {
    warnings.push("Container reports no duration (live stream or truncated file); frame budgets will be estimated.");
  }
  if (resolved.kind === "url") {
    warnings.push("Remote URL probed over HTTP; size may be unknown and later tools will download the file.");
  }

  const result: ProbeMediaResult = {
    source: input.source,
    source_kind: resolved.kind,
    kind,
    subtitles: subtitleStreams.map((s, i) => ({
      index: i,
      ...(s.codec_name !== undefined ? { codec: s.codec_name } : {}),
      ...(s.tags?.language !== undefined ? { language: s.tags.language } : {}),
      ...(s.tags?.title !== undefined ? { title: s.tags.title.slice(0, 200) } : {}),
    })),
    chapters: (probe.chapters ?? []).map((c) => ({
      start_s: parseNumber(c.start_time) ?? 0,
      end_s: parseNumber(c.end_time) ?? 0,
      ...(c.tags?.title !== undefined ? { title: c.tags.title.slice(0, 200) } : {}),
    })),
    tags: pickTags(format?.tags, ["title", "artist", "album", "date", "comment", "encoder", "creation_time"]),
    stream_counts: {
      video: videoStreams.length,
      audio: audioStreams.length,
      subtitle: subtitleStreams.length,
      other: otherCount,
    },
    looks_like_screen_recording: false,
    warnings,
    suggested_next: suggested,
  };

  if (format?.format_name !== undefined) result.container = format.format_name;
  if (duration !== undefined) result.duration_s = Math.round(duration * 1000) / 1000;
  if (sizeBytes !== undefined) result.size_bytes = sizeBytes;
  const bitRate = parseNumber(format?.bit_rate);
  if (bitRate !== undefined) result.bit_rate = bitRate;

  if (primaryVideo && kind !== "audio") {
    const fps = parseRational(primaryVideo.avg_frame_rate) ?? parseRational(primaryVideo.r_frame_rate);
    const frameCount = parseNumber(primaryVideo.nb_frames) ?? (fps !== undefined && duration !== undefined ? Math.round(fps * duration) : undefined);
    const vbr = parseNumber(primaryVideo.bit_rate) ?? (kind === "video" && bitRate !== undefined && audioStreams.length === 0 ? bitRate : undefined);
    result.video = {
      ...(primaryVideo.codec_name !== undefined ? { codec: primaryVideo.codec_name } : {}),
      ...(primaryVideo.profile !== undefined ? { profile: primaryVideo.profile } : {}),
      ...(primaryVideo.width !== undefined ? { width: primaryVideo.width } : {}),
      ...(primaryVideo.height !== undefined ? { height: primaryVideo.height } : {}),
      ...(fps !== undefined && fps > 0 ? { fps: Math.round(fps * 1000) / 1000 } : {}),
      ...(frameCount !== undefined && kind === "video" ? { frame_count: frameCount } : {}),
      ...(primaryVideo.pix_fmt !== undefined ? { pixel_format: primaryVideo.pix_fmt } : {}),
      ...(vbr !== undefined ? { bit_rate: vbr } : {}),
    };
    if (kind === "video") result.looks_like_screen_recording = screenRecordingHeuristic(result.video, duration);
  }

  if (primaryAudio) {
    const sampleRate = parseNumber(primaryAudio.sample_rate);
    const abr = parseNumber(primaryAudio.bit_rate);
    result.audio = {
      ...(primaryAudio.codec_name !== undefined ? { codec: primaryAudio.codec_name } : {}),
      ...(sampleRate !== undefined ? { sample_rate: sampleRate } : {}),
      ...(primaryAudio.channels !== undefined ? { channels: primaryAudio.channels } : {}),
      ...(primaryAudio.channel_layout !== undefined ? { channel_layout: primaryAudio.channel_layout } : {}),
      ...(abr !== undefined ? { bit_rate: abr } : {}),
      ...(primaryAudio.tags?.language !== undefined ? { language: primaryAudio.tags.language } : {}),
    };
  }

  if (input.deep && audioStreams.length > 0) {
    const a = await analyzeAudio(config, resolved.location);
    const silenceTotal = a.silences.reduce((acc, s) => acc + s.duration_s, 0);
    result.audio_deep = {
      silences: a.silences,
      silence_total_s: Math.round(silenceTotal * 1000) / 1000,
      ...(duration !== undefined && duration > 0 ? { speech_ratio: Math.round(Math.max(0, 1 - silenceTotal / duration) * 1000) / 1000 } : {}),
      ...(a.loudness.integrated_lufs !== undefined ? { integrated_lufs: a.loudness.integrated_lufs } : {}),
      ...(a.loudness.loudness_range_lu !== undefined ? { loudness_range_lu: a.loudness.loudness_range_lu } : {}),
      ...(a.loudness.true_peak_dbfs !== undefined ? { true_peak_dbfs: a.loudness.true_peak_dbfs } : {}),
      ...(a.stats.rms_level_db !== undefined && Number.isFinite(a.stats.rms_level_db) ? { rms_level_db: a.stats.rms_level_db } : {}),
      ...(a.stats.noise_floor_db !== undefined && Number.isFinite(a.stats.noise_floor_db) ? { noise_floor_db: a.stats.noise_floor_db } : {}),
    };
    if (duration !== undefined && duration > 0 && silenceTotal / duration > 0.9) {
      warnings.push("Audio is more than 90% silence; transcription will likely return nothing useful.");
    }
  } else if (input.deep) {
    warnings.push("deep=true ignored: no audio stream.");
  }

  switch (kind) {
    case "video":
      if (subtitleStreams.length > 0) suggested.push("get_transcript (embedded subtitles available, no ASR needed)");
      else if (audioStreams.length > 0) suggested.push("get_transcript");
      if (result.looks_like_screen_recording) suggested.push("extract_text", "get_frames (frame_format=png)");
      suggested.push("get_video_grids", "get_frames");
      if (result.chapters.length > 0) suggested.push("get_video_grids per chapter");
      break;
    case "audio":
      suggested.push("get_transcript");
      break;
    case "image":
      suggested.push("extract_text", "get_frames");
      break;
    default:
      break;
  }

  return result;
}

/** Compact one-line summary for the human-readable content block. */
export function summarizeProbe(r: ProbeMediaResult): string {
  const parts: string[] = [r.kind];
  if (r.container) parts.push(r.container);
  if (r.duration_s !== undefined) parts.push(`${formatDuration(r.duration_s)}`);
  if (r.video?.width && r.video.height) {
    parts.push(`${r.video.width}x${r.video.height}${r.video.fps ? `@${r.video.fps}fps` : ""} ${r.video.codec ?? ""}`.trim());
  }
  if (r.audio) parts.push(`audio ${r.audio.codec ?? "?"} ${r.audio.sample_rate ?? "?"}Hz ${r.audio.channels ?? "?"}ch`);
  if (r.subtitles.length > 0) parts.push(`${r.subtitles.length} subtitle track(s)`);
  if (r.chapters.length > 0) parts.push(`${r.chapters.length} chapters`);
  if (r.size_bytes !== undefined) parts.push(formatBytes(r.size_bytes));
  if (r.tags.title) parts.push(`title=${JSON.stringify(r.tags.title)}`);
  if (r.looks_like_screen_recording) parts.push("looks like a screen recording");
  const line = parts.join(" | ");
  const deep = r.audio_deep
    ? `\nAudio: ${r.audio_deep.silences.length} silences (${r.audio_deep.silence_total_s}s total)` +
      (r.audio_deep.integrated_lufs !== undefined ? `, ${r.audio_deep.integrated_lufs} LUFS` : "") +
      (r.audio_deep.noise_floor_db !== undefined ? `, noise floor ${r.audio_deep.noise_floor_db} dB` : "")
    : "";
  const warn = r.warnings.length > 0 ? `\nWarnings:\n- ${r.warnings.join("\n- ")}` : "";
  const next = r.suggested_next.length > 0 ? `\nSuggested next: ${r.suggested_next.join(", ")}` : "";
  return `${line}${deep}${warn}${next}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}
