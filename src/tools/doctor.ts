import { stat } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod/v4";
import { ffmpegFilters, inspectBinary, tesseractLanguages } from "../binaries.js";
import { cacheStats } from "../cache.js";
import { DEFAULT_WHISPER_MODEL, modelsDir, type Config } from "../config.js";
import { commonOutput } from "../contracts.js";

export const doctorInput = z.object({});

const binaryReport = z.object({
  name: z.string(),
  required: z.boolean(),
  found: z.boolean(),
  path: z.string().optional(),
  version: z.string().optional(),
  used_by: z.array(z.string()),
});

const capability = z.object({
  name: z.string(),
  status: z.enum(["ready", "partial", "missing"]),
  needs: z.string().optional(),
});

export const doctorOutput = z.object({
  binaries: z.array(binaryReport),
  ffmpeg_filters: z.record(z.string(), z.boolean()),
  whisper_model: z.object({ path: z.string(), found: z.boolean(), size_bytes: z.number().optional() }),
  vad_model: z.object({ path: z.string(), found: z.boolean() }),
  tesseract_languages: z.array(z.string()),
  cache: z.object({ dir: z.string(), entries: z.number(), bytes: z.number(), ttl_days: z.number(), max_bytes: z.number() }),
  capabilities: z.array(capability),
  ...commonOutput,
});

export type DoctorResult = z.infer<typeof doctorOutput>;

const WANTED_FILTERS = ["scdet", "silencedetect", "blackdetect", "freezedetect", "ebur128", "astats", "loudnorm", "tile", "showwavespic", "showspectrumpic", "drawtext", "crop", "scale"];

export const VAD_MODEL = "ggml-silero-v5.1.2.bin";

export function whisperModelPath(config: Config): string {
  return config.whisperModel.length > 0 ? config.whisperModel : join(modelsDir(config), DEFAULT_WHISPER_MODEL);
}

export function vadModelPath(config: Config): string {
  return join(modelsDir(config), VAD_MODEL);
}

async function fileInfo(path: string): Promise<{ found: boolean; size_bytes: number | undefined }> {
  try {
    const s = await stat(path);
    return { found: s.isFile(), size_bytes: s.size };
  } catch {
    return { found: false, size_bytes: undefined };
  }
}

/** Stage-0 tool: what can this installation do, measured rather than assumed. */
export async function doctor(config: Config): Promise<DoctorResult> {
  const [ffmpeg, ffprobe, ytdlp, whisper, tesseract] = await Promise.all([
    inspectBinary(config, "ffmpeg", config.ffmpegBin),
    inspectBinary(config, "ffprobe", config.ffprobeBin),
    inspectBinary(config, "yt-dlp", config.ytdlpBin),
    inspectBinary(config, "whisper-cli", config.whisperBin),
    inspectBinary(config, "tesseract", config.tesseractBin),
  ]);
  const [filters, langs, cache, model, vad] = await Promise.all([
    ffmpegFilters(config),
    tesseractLanguages(config),
    cacheStats(config),
    fileInfo(whisperModelPath(config)),
    fileInfo(vadModelPath(config)),
  ]);

  const report = (info: typeof ffmpeg, required: boolean, usedBy: string[]) => ({
    name: info.name,
    required,
    found: info.path !== undefined,
    ...(info.path !== undefined ? { path: info.path } : {}),
    ...(info.version !== undefined ? { version: info.version } : {}),
    used_by: usedBy,
  });

  const binaries = [
    report(ffprobe, true, ["probe_media", "everything"]),
    report(ffmpeg, true, ["get_frames", "get_video_grids", "get_transcript", "get_scenes", "analyze_audio"]),
    report(ytdlp, false, ["fetch_media", "get_engagement"]),
    report(whisper, false, ["get_transcript (local)", "detect_language"]),
    report(tesseract, false, ["extract_text"]),
  ];

  const ffmpegFilterMap: Record<string, boolean> = {};
  for (const f of WANTED_FILTERS) ffmpegFilterMap[f] = filters.has(f);

  const warnings: string[] = [];
  const capabilities: DoctorResult["capabilities"] = [];
  const has = (b: { path: string | undefined }) => b.path !== undefined;

  capabilities.push({ name: "probe_media", status: has(ffprobe) ? "ready" : "missing", ...(has(ffprobe) ? {} : { needs: "ffprobe" }) });
  const framesOk = has(ffmpeg);
  capabilities.push({ name: "get_frames / get_video_grids", status: framesOk ? "ready" : "missing", ...(framesOk ? {} : { needs: "ffmpeg" }) });
  const scenesOk = has(ffmpeg) && ffmpegFilterMap.scdet === true;
  capabilities.push({ name: "get_scenes", status: scenesOk ? "ready" : "missing", ...(scenesOk ? {} : { needs: "ffmpeg with scdet filter" }) });
  const audioOk = has(ffmpeg) && ffmpegFilterMap.ebur128 === true && ffmpegFilterMap.silencedetect === true;
  capabilities.push({ name: "analyze_audio / probe deep", status: audioOk ? "ready" : "missing", ...(audioOk ? {} : { needs: "ffmpeg with ebur128 + silencedetect" }) });

  const whisperReady = has(whisper) && model.found;
  capabilities.push({
    name: "get_transcript (local whisper.cpp)",
    status: whisperReady ? (vad.found ? "ready" : "partial") : "missing",
    ...(whisperReady ? (vad.found ? {} : { needs: `VAD model at ${vadModelPath(config)} (optional, improves German voice notes)` }) : { needs: has(whisper) ? `model file at ${whisperModelPath(config)}` : "whisper-cli (brew install whisper-cpp) plus model file" }),
  });
  const openaiKey = Boolean(process.env.OPENAI_API_KEY);
  const groqKey = Boolean(process.env.GROQ_API_KEY);
  capabilities.push({
    name: "get_transcript (paid API)",
    status: openaiKey || groqKey ? "ready" : "missing",
    ...(openaiKey || groqKey ? {} : { needs: "OPENAI_API_KEY or GROQ_API_KEY in the environment (via launcher)" }),
  });
  capabilities.push({ name: "fetch_media / get_engagement", status: has(ytdlp) ? "ready" : "missing", ...(has(ytdlp) ? {} : { needs: "yt-dlp" }) });
  const ocrLangs = config.ocrLanguages.split("+");
  const ocrMissing = ocrLangs.filter((l) => !langs.includes(l));
  const ocrStatus = !has(tesseract) ? "missing" : ocrMissing.length === 0 ? "ready" : "partial";
  capabilities.push({
    name: "extract_text (tesseract)",
    status: ocrStatus,
    ...(ocrStatus === "ready" ? {} : { needs: has(tesseract) ? `tesseract language data: ${ocrMissing.join(", ")}` : "tesseract" }),
  });

  if (ffmpegFilterMap.drawtext === false && has(ffmpeg)) {
    warnings.push("ffmpeg has no drawtext filter (no freetype); timestamp overlays are rendered in Node instead.");
  }
  if (!has(ffprobe) || !has(ffmpeg)) warnings.push("FFmpeg is required for everything beyond doctor.");
  if (cache.bytes > config.cacheMaxBytes) warnings.push("Cache is above its size cap; the next sweep will trim it.");

  return {
    binaries,
    ffmpeg_filters: ffmpegFilterMap,
    whisper_model: { path: whisperModelPath(config), found: model.found, ...(model.size_bytes !== undefined ? { size_bytes: model.size_bytes } : {}) },
    vad_model: { path: vadModelPath(config), found: vad.found },
    tesseract_languages: langs,
    cache: { dir: cache.dir, entries: cache.entries, bytes: cache.bytes, ttl_days: config.cacheTtlDays, max_bytes: config.cacheMaxBytes },
    capabilities,
    warnings,
    suggested_next: capabilities.filter((c) => c.status === "ready").map((c) => c.name.split(" ")[0] ?? c.name).filter((v, i, a) => a.indexOf(v) === i),
  };
}

export function summarizeDoctor(r: DoctorResult): string {
  const bins = r.binaries.map((b) => `${b.found ? "ok " : "MISSING"} ${b.name}${b.version ? ` ${b.version}` : ""}${b.required ? " (required)" : ""}`);
  const caps = r.capabilities.map((c) => `${c.status.padEnd(7)} ${c.name}${c.needs ? ` -> needs ${c.needs}` : ""}`);
  const warn = r.warnings.length > 0 ? `\nWarnings:\n- ${r.warnings.join("\n- ")}` : "";
  return `Binaries:\n${bins.join("\n")}\n\nCapabilities:\n${caps.join("\n")}\n\nCache: ${r.cache.entries} entries, ${(r.cache.bytes / 1024 ** 2).toFixed(1)} MiB in ${r.cache.dir}${warn}`;
}
