import type { Config } from "./config.js";
import { MediaIntelError } from "./errors.js";
import { runBinary, type RunResult } from "./process.js";

/** Subset of the ffprobe JSON output we rely on. Everything else stays untyped. */
export interface FfprobeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  codec_long_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  nb_frames?: string;
  duration?: string;
  bit_rate?: string;
  sample_rate?: string;
  channels?: number;
  channel_layout?: string;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
}

export interface FfprobeFormat {
  filename?: string;
  format_name?: string;
  format_long_name?: string;
  duration?: string;
  size?: string;
  bit_rate?: string;
  nb_streams?: number;
  tags?: Record<string, string>;
}

export interface FfprobeChapter {
  id: number;
  start_time?: string;
  end_time?: string;
  tags?: Record<string, string>;
}

export interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
  chapters?: FfprobeChapter[];
}

function missingError(kind: "ffprobe" | "ffmpeg", bin: string): MediaIntelError {
  return new MediaIntelError(
    `${kind}_missing`,
    `${kind} binary '${bin}' was not found`,
    `Install FFmpeg (brew install ffmpeg / apt install ffmpeg) or set MEDIA_INTEL_${kind.toUpperCase()} to the binary path. Run the doctor tool to see what is installed.`,
  );
}

function failureError(kind: "ffprobe" | "ffmpeg", r: RunResult, location: string, hint: string): MediaIntelError {
  if (r.timedOut) {
    return new MediaIntelError(`${kind}_timeout`, `${kind} exceeded the process timeout on ${location}`);
  }
  const stderr = r.stderr.trim();
  const last = stderr.length > 0 ? (stderr.split("\n").at(-1) ?? stderr) : `${kind} exited with code ${r.exitCode}`;
  return new MediaIntelError(`${kind}_failed`, last, hint);
}

/**
 * Run ffprobe and return its parsed JSON. `location` may be a local path or
 * a URL; ffprobe handles both, and for URLs it only reads the headers it
 * needs, so this stays cheap even for large remote files.
 */
export async function ffprobe(config: Config, location: string): Promise<FfprobeOutput> {
  const args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", location];
  const r = await runBinary(config, config.ffprobeBin, args);
  if (r.missing) throw missingError("ffprobe", config.ffprobeBin);
  if (r.timedOut || r.exitCode !== 0) {
    throw failureError("ffprobe", r, location, "The file is probably not a media container, is corrupt, or the URL is not directly downloadable.");
  }
  try {
    return JSON.parse(r.stdout) as FfprobeOutput;
  } catch {
    throw new MediaIntelError("ffprobe_failed", "ffprobe returned invalid JSON");
  }
}

/** Keyframe timestamps (seconds) for the first video stream, without decoding. */
export async function keyframeTimestamps(config: Config, location: string, limit = 5000): Promise<number[]> {
  const args = [
    "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey",
    "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", location,
  ];
  const r = await runBinary(config, config.ffprobeBin, args);
  if (r.missing) throw missingError("ffprobe", config.ffprobeBin);
  if (r.timedOut || r.exitCode !== 0) throw failureError("ffprobe", r, location, "Could not enumerate packets.");
  const out: number[] = [];
  for (const line of r.stdout.split("\n")) {
    const [pts, flags] = line.split(",");
    if (!pts || !flags?.includes("K")) continue;
    const t = Number(pts);
    if (Number.isFinite(t)) out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Run ffmpeg with the given arguments. Returns the raw result; callers parse
 * stderr for analysis filters or take the stdout buffer for image output.
 */
export async function ffmpeg(config: Config, args: string[], options: { binary?: boolean; timeoutMs?: number } = {}) {
  const full = ["-hide_banner", "-nostdin", "-nostats", "-loglevel", "info", ...args];
  const r = await runBinary(config, config.ffmpegBin, full, {
    ...(options.binary !== undefined ? { binary: options.binary } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  if (r.missing) throw missingError("ffmpeg", config.ffmpegBin);
  return r;
}

export type FrameFormat = "jpeg" | "png" | "webp";

export interface ExtractFrameOptions {
  format?: FrameFormat;
  /** Scale to this width, keeping aspect ratio. 0 or undefined = original. */
  width?: number;
  /** Crop region in source pixels, applied before scaling. */
  crop?: { x: number; y: number; width: number; height: number };
  /** JPEG/WebP quality 1..100. */
  quality?: number;
}

const CODEC_FOR_FORMAT: Record<FrameFormat, string> = { jpeg: "mjpeg", png: "png", webp: "libwebp" };

/**
 * Extract one frame at `tS`. `-ss` goes BEFORE `-i` so ffmpeg seeks by
 * keyframe first (0.14 s instead of 4.4 s on a 5 min file, measured).
 */
export async function extractFrame(config: Config, location: string, tS: number, options: ExtractFrameOptions = {}): Promise<Buffer> {
  const format = options.format ?? "jpeg";
  const filters: string[] = [];
  if (options.crop) filters.push(`crop=${options.crop.width}:${options.crop.height}:${options.crop.x}:${options.crop.y}`);
  if (options.width && options.width > 0) filters.push(`scale=${options.width}:-2`);
  const args = ["-ss", String(Math.max(0, tS)), "-i", location, "-frames:v", "1", "-an", "-sn"];
  if (filters.length > 0) args.push("-vf", filters.join(","));
  args.push("-f", "image2", "-update", "1", "-vcodec", CODEC_FOR_FORMAT[format]);
  if (format === "jpeg") args.push("-q:v", String(qualityToMjpegQ(options.quality ?? 85)));
  if (format === "webp") args.push("-quality", String(options.quality ?? 85));
  args.push("pipe:1");

  const r = await ffmpeg(config, args, { binary: true });
  if (r.timedOut || r.exitCode !== 0 || !r.stdoutBuffer || r.stdoutBuffer.length === 0) {
    throw failureError("ffmpeg", r, location, `No frame at ${tS}s; is the timestamp inside the duration?`);
  }
  return r.stdoutBuffer;
}

/** ffmpeg's mjpeg -q:v runs 2 (best) .. 31 (worst); map a 1..100 quality onto it. */
export function qualityToMjpegQ(quality: number): number {
  const q = Math.min(100, Math.max(1, quality));
  return Math.round(31 - ((q - 1) / 99) * 29);
}

/* ------------------------------------------------------------------------ */
/* Analysis filters: run with `-f null -`, parse stderr.                     */
/* ------------------------------------------------------------------------ */

export interface SilenceInterval {
  start_s: number;
  end_s: number;
  duration_s: number;
}

export function parseSilencedetect(stderr: string): SilenceInterval[] {
  const out: SilenceInterval[] = [];
  let pendingStart: number | undefined;
  for (const line of stderr.split("\n")) {
    const start = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (start?.[1]) {
      pendingStart = Number(start[1]);
      continue;
    }
    const end = line.match(/silence_end:\s*(-?[\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/);
    if (end?.[1] && end[2] && pendingStart !== undefined) {
      out.push({ start_s: round3(pendingStart), end_s: round3(Number(end[1])), duration_s: round3(Number(end[2])) });
      pendingStart = undefined;
    }
  }
  return out;
}

export interface SceneCut {
  t_s: number;
  score: number;
}

export function parseScdet(stderr: string): SceneCut[] {
  const out: SceneCut[] = [];
  for (const line of stderr.split("\n")) {
    const m = line.match(/lavfi\.scd\.score:\s*([\d.]+),\s*lavfi\.scd\.time:\s*([\d.]+)/);
    if (m?.[1] && m[2]) out.push({ t_s: round3(Number(m[2])), score: round3(Number(m[1])) });
  }
  return out;
}

export interface BlackInterval {
  start_s: number;
  end_s: number;
  duration_s: number;
}

export function parseBlackdetect(stderr: string): BlackInterval[] {
  const out: BlackInterval[] = [];
  for (const line of stderr.split("\n")) {
    const m = line.match(/black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)\s+black_duration:\s*([\d.]+)/);
    if (m?.[1] && m[2] && m[3]) out.push({ start_s: round3(Number(m[1])), end_s: round3(Number(m[2])), duration_s: round3(Number(m[3])) });
  }
  return out;
}

export interface FreezeInterval {
  start_s: number;
  end_s: number | undefined;
  duration_s: number | undefined;
}

export function parseFreezedetect(stderr: string): FreezeInterval[] {
  const out: FreezeInterval[] = [];
  let current: FreezeInterval | undefined;
  for (const line of stderr.split("\n")) {
    const start = line.match(/freeze_start:\s*([\d.]+)/);
    if (start?.[1]) {
      current = { start_s: round3(Number(start[1])), end_s: undefined, duration_s: undefined };
      out.push(current);
      continue;
    }
    const dur = line.match(/freeze_duration:\s*([\d.]+)/);
    if (dur?.[1] && current) current.duration_s = round3(Number(dur[1]));
    const end = line.match(/freeze_end:\s*([\d.]+)/);
    if (end?.[1] && current) {
      current.end_s = round3(Number(end[1]));
      current = undefined;
    }
  }
  return out;
}

export interface LoudnessSummary {
  integrated_lufs: number | undefined;
  loudness_range_lu: number | undefined;
  true_peak_dbfs: number | undefined;
}

/** Parse the ebur128 summary block ("I: -21.8 LUFS", "LRA: 20.0 LU", "Peak: -1.2 dBFS"). */
export function parseEbur128(stderr: string): LoudnessSummary {
  const i = stderr.match(/\bI:\s*(-?[\d.]+)\s*LUFS/);
  const lra = stderr.match(/\bLRA:\s*(-?[\d.]+)\s*LU\b/);
  const peak = stderr.match(/\bPeak:\s*(-?[\d.]+)\s*dBFS/);
  return {
    integrated_lufs: i?.[1] ? round3(Number(i[1])) : undefined,
    loudness_range_lu: lra?.[1] ? round3(Number(lra[1])) : undefined,
    true_peak_dbfs: peak?.[1] ? round3(Number(peak[1])) : undefined,
  };
}

export interface AstatsSummary {
  rms_level_db: number | undefined;
  peak_level_db: number | undefined;
  noise_floor_db: number | undefined;
}

/** Parse the "Overall" section of astats. */
export function parseAstats(stderr: string): AstatsSummary {
  const overallIdx = stderr.lastIndexOf("Overall");
  const section = overallIdx >= 0 ? stderr.slice(overallIdx) : stderr;
  const grab = (label: string) => {
    const m = section.match(new RegExp(`${label}:\\s*(-?[\\d.]+|-inf)`));
    if (!m?.[1]) return undefined;
    return m[1] === "-inf" ? -Infinity : round3(Number(m[1]));
  };
  return {
    rms_level_db: grab("RMS level dB"),
    peak_level_db: grab("Peak level dB"),
    noise_floor_db: grab("Noise floor dB"),
  };
}

export interface AudioAnalysis {
  silences: SilenceInterval[];
  loudness: LoudnessSummary;
  stats: AstatsSummary;
}

/**
 * One decode pass over the audio: silence map, loudness and level stats.
 * About 1.1 s for 5 minutes of audio (measured).
 */
export async function analyzeAudio(
  config: Config,
  location: string,
  options: { silenceNoiseDb?: number; silenceMinS?: number; window?: { start_s: number; end_s?: number } } = {},
): Promise<AudioAnalysis> {
  const noise = options.silenceNoiseDb ?? -40;
  const minS = options.silenceMinS ?? 0.3;
  const args: string[] = [];
  if (options.window) {
    args.push("-ss", String(options.window.start_s));
    if (options.window.end_s !== undefined) args.push("-to", String(options.window.end_s));
  }
  args.push("-i", location, "-vn", "-sn", "-af", `silencedetect=n=${noise}dB:d=${minS},ebur128=framelog=quiet,astats=measure_overall=all:measure_perchannel=none`, "-f", "null", "-");
  const r = await ffmpeg(config, args);
  if (r.timedOut || r.exitCode !== 0) throw failureError("ffmpeg", r, location, "Audio analysis failed; does the file have an audio stream?");
  const offset = options.window?.start_s ?? 0;
  const silences = parseSilencedetect(r.stderr).map((s) => ({
    start_s: round3(s.start_s + offset),
    end_s: round3(s.end_s + offset),
    duration_s: s.duration_s,
  }));
  return { silences, loudness: parseEbur128(r.stderr), stats: parseAstats(r.stderr) };
}

export interface VideoAnalysis {
  cuts: SceneCut[];
  black: BlackInterval[];
  freezes: FreezeInterval[];
}

/** One decode pass over the video: scene cuts, black frames, frozen stretches. */
export async function analyzeVideo(
  config: Config,
  location: string,
  options: { sceneThreshold?: number; freezeNoiseDb?: number; freezeMinS?: number; window?: { start_s: number; end_s?: number } } = {},
): Promise<VideoAnalysis> {
  const threshold = options.sceneThreshold ?? 10;
  const args: string[] = [];
  if (options.window) {
    args.push("-ss", String(options.window.start_s));
    if (options.window.end_s !== undefined) args.push("-to", String(options.window.end_s));
  }
  args.push(
    "-i", location, "-an", "-sn",
    "-vf", `scdet=threshold=${threshold},blackdetect=d=0.5:pix_th=0.10,freezedetect=n=${options.freezeNoiseDb ?? -60}dB:d=${options.freezeMinS ?? 2}`,
    "-f", "null", "-",
  );
  const r = await ffmpeg(config, args);
  if (r.timedOut || r.exitCode !== 0) throw failureError("ffmpeg", r, location, "Video analysis failed; does the file have a video stream?");
  const offset = options.window?.start_s ?? 0;
  const shift = (t: number) => round3(t + offset);
  return {
    cuts: parseScdet(r.stderr).map((c) => ({ ...c, t_s: shift(c.t_s) })),
    black: parseBlackdetect(r.stderr).map((b) => ({ ...b, start_s: shift(b.start_s), end_s: shift(b.end_s) })),
    freezes: parseFreezedetect(r.stderr).map((f) => ({
      ...f,
      start_s: shift(f.start_s),
      end_s: f.end_s === undefined ? undefined : shift(f.end_s),
    })),
  };
}

/** Extract an embedded subtitle stream as SRT text (undefined if the stream does not exist). */
export async function extractSubtitleTrack(config: Config, location: string, streamIndex = 0): Promise<string | undefined> {
  const r = await ffmpeg(config, ["-i", location, "-map", `0:s:${streamIndex}`, "-f", "srt", "pipe:1"]);
  if (r.timedOut) throw failureError("ffmpeg", r, location, "Subtitle extraction timed out.");
  if (r.exitCode !== 0) return undefined;
  return r.stdout.length > 0 ? r.stdout : undefined;
}

/** Transcode any input to 16 kHz mono WAV (what whisper.cpp wants). */
export async function toWav16k(config: Config, location: string, outPath: string, window?: { start_s: number; end_s?: number }): Promise<void> {
  const args: string[] = [];
  if (window) {
    args.push("-ss", String(window.start_s));
    if (window.end_s !== undefined) args.push("-to", String(window.end_s));
  }
  args.push("-i", location, "-vn", "-sn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", outPath);
  const r = await ffmpeg(config, args);
  if (r.timedOut || r.exitCode !== 0) throw failureError("ffmpeg", r, location, "Could not decode audio; does the file have an audio stream?");
}

/* ------------------------------------------------------------------------ */

/** Parse ffprobe rational strings like "30000/1001" into a number. */
export function parseRational(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const [num, den] = value.split("/").map(Number);
  if (num === undefined || !Number.isFinite(num)) return undefined;
  if (den === undefined) return num;
  if (!Number.isFinite(den) || den === 0) return undefined;
  return num / den;
}

export function parseNumber(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
