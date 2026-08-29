import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Runtime configuration. Everything is overridable through environment
 * variables so the server can run unchanged under a launcher, in Docker,
 * or behind an OAuth bridge. Secrets (API keys) are read lazily by the
 * backends that need them and never stored here.
 */
export interface Config {
  /** Binaries. Names resolve through PATH, absolute paths are used as-is. */
  ffprobeBin: string;
  ffmpegBin: string;
  ytdlpBin: string;
  whisperBin: string;
  tesseractBin: string;

  /** Directory for derived artifacts (frames, transcripts, downloads, index). */
  cacheDir: string;
  /** Cache entries older than this are swept at startup (days). */
  cacheTtlDays: number;
  /** Cache is trimmed oldest-first above this size (bytes). */
  cacheMaxBytes: number;

  /** Per-call timeout for external processes in milliseconds. */
  processTimeoutMs: number;

  /** Hard limits: inputs beyond these are rejected, not just warned about. */
  maxDurationSeconds: number;
  maxInputBytes: number;
  maxStreams: number;
  maxPixels: number;

  /** Soft limits: probe warns above these. */
  warnFileSizeBytes: number;
  warnDurationSeconds: number;

  /** Untrusted-text contract: characters per field before truncation. */
  maxTextFieldChars: number;

  /** Paid backends refuse calls whose estimate exceeds this (USD). */
  maxCostUsd: number;

  /** Local whisper.cpp model file; empty means "look in cacheDir/models". */
  whisperModel: string;
  /** ElevenLabs Scribe model id for the paid backend: scribe_v2 (default) or scribe_v1. */
  elevenlabsModel: string;
  /** Default OCR languages for tesseract, plus-separated. */
  ocrLanguages: string;
  /** Netscape cookie file for yt-dlp; empty disables cookies. */
  ytdlpCookiesFile: string;
}

function envNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envString(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

function defaultCacheDir(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CACHE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".cache");
  return join(base, "media-intel");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cacheDir = envString(env, "MEDIA_INTEL_CACHE_DIR", defaultCacheDir(env));
  return {
    ffprobeBin: envString(env, "MEDIA_INTEL_FFPROBE", "ffprobe"),
    ffmpegBin: envString(env, "MEDIA_INTEL_FFMPEG", "ffmpeg"),
    ytdlpBin: envString(env, "MEDIA_INTEL_YTDLP", "yt-dlp"),
    whisperBin: envString(env, "MEDIA_INTEL_WHISPER", "whisper-cli"),
    tesseractBin: envString(env, "MEDIA_INTEL_TESSERACT", "tesseract"),

    cacheDir,
    cacheTtlDays: envNumber(env, "MEDIA_INTEL_CACHE_TTL_DAYS", 14),
    cacheMaxBytes: envNumber(env, "MEDIA_INTEL_CACHE_MAX_BYTES", 5 * 1024 ** 3),

    processTimeoutMs: envNumber(env, "MEDIA_INTEL_PROCESS_TIMEOUT_MS", 120_000),

    maxDurationSeconds: envNumber(env, "MEDIA_INTEL_MAX_DURATION_S", 4 * 3600),
    maxInputBytes: envNumber(env, "MEDIA_INTEL_MAX_BYTES", 20 * 1024 ** 3),
    maxStreams: envNumber(env, "MEDIA_INTEL_MAX_STREAMS", 20),
    maxPixels: envNumber(env, "MEDIA_INTEL_MAX_PIXELS", 7680 * 4320),

    warnFileSizeBytes: envNumber(env, "MEDIA_INTEL_WARN_FILE_SIZE_BYTES", 4 * 1024 ** 3),
    warnDurationSeconds: envNumber(env, "MEDIA_INTEL_WARN_DURATION_SECONDS", 3 * 3600),

    maxTextFieldChars: envNumber(env, "MEDIA_INTEL_MAX_TEXT_FIELD_CHARS", 20_000),
    maxCostUsd: envNumber(env, "MEDIA_INTEL_MAX_COST_USD", 0.1),

    whisperModel: envString(env, "MEDIA_INTEL_WHISPER_MODEL", ""),
    elevenlabsModel: envString(env, "MEDIA_INTEL_ELEVENLABS_MODEL", DEFAULT_ELEVENLABS_MODEL),
    ocrLanguages: envString(env, "MEDIA_INTEL_OCR_LANGUAGES", "deu+eng"),
    ytdlpCookiesFile: envString(env, "MEDIA_INTEL_YTDLP_COOKIES", ""),
  };
}

/** Where local whisper.cpp models live unless MEDIA_INTEL_WHISPER_MODEL points elsewhere. */
export function modelsDir(config: Config): string {
  return join(config.cacheDir, "models");
}

export const DEFAULT_WHISPER_MODEL = "ggml-large-v3-turbo-q5_0.bin";

/** ElevenLabs Scribe model used unless MEDIA_INTEL_ELEVENLABS_MODEL overrides it. */
export const DEFAULT_ELEVENLABS_MODEL = "scribe_v2";
