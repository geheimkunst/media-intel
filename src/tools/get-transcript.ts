/**
 * get_transcript: Extract or generate transcripts from media.
 *
 * Implements a multi-backend transcription chain:
 * 1. Embedded subtitles (fastest, free)
 * 2. Sidecar subtitle files (.srt/.vtt)
 * 3. whisper.cpp (local, free, ~2 min per 5 min audio on M2)
 * 4. OpenAI Whisper API (fastest, paid)
 * 5. Groq Whisper API (cheapest, paid)
 *
 * Supports pagination for long media (20-minute chunks per API call).
 */

import * as z from "zod/v4";
import type { Config } from "../config.js";
import { commonOutput, frameUntrusted, pagination, resolveWindow, round3, wrapUntrusted, windowInput } from "../contracts.js";
import { MediaIntelError } from "../errors.js";
import { cacheEntry, readSidecarJson, writeSidecarJson } from "../cache.js";
import { probeMedia } from "./probe-media.js";
import { resolveSource } from "../source.js";
import { extractEmbeddedSubtitles } from "../backends/transcribe/embedded.js";
import { extractSidecarSubtitles } from "../backends/transcribe/sidecar.js";
import { transcribeWithWhisperCpp } from "../backends/transcribe/whisper-cpp.js";
import { transcribeWithOpenAi } from "../backends/transcribe/openai.js";
import { transcribeWithGroq } from "../backends/transcribe/groq.js";
import { estimateCost } from "../backends/transcribe/cost.js";
import { encodeSrt, type Segment } from "../backends/transcribe/srt.js";

const segment = z.object({
  start_s: z.number().nonnegative(),
  end_s: z.number().nonnegative(),
  text: z.string(),
});

export const getTranscriptInput = z.object({
  source: z.string().min(1).describe("Absolute path or direct http(s) URL to a media file."),
  window: windowInput.optional().describe("Time window to process. Omit for the whole file (subject to pagination and budgets)."),
  format: z
    .enum(["text", "srt", "json"])
    .default("text")
    .describe("Output format: plain text (one line per segment), SRT, or JSON."),
  language: z.string().default("auto").describe("ISO-639-1 language code (e.g., 'de', 'en') or 'auto' for auto-detection."),
  backend: z
    .enum(["auto", "embedded", "sidecar", "whisper", "openai", "groq"])
    .default("auto")
    .describe("Transcription backend. 'auto' tries free options first (embedded > sidecar > whisper.cpp), then paid APIs if keys are set."),
  word_timestamps: z.boolean().default(false).describe("Include word-level timestamps (whisper.cpp only)."),
  subtitle_stream_index: z.number().int().nonnegative().optional().describe("Explicit subtitle stream index (embedded only)."),
  max_chars: z.number().int().positive().optional().describe("Max characters in returned transcript text; default from config."),
});

export const getTranscriptOutput = z.object({
  source: z.string(),
  transcription_source: z.enum(["embedded_subtitles", "sidecar_subtitles", "whisper_cpp", "openai", "groq"]),
  model: z.string().optional(),
  language: z.string(),
  language_confidence: z.number().nonnegative().optional(),
  format: z.enum(["text", "srt", "json"]),
  segments: z.array(segment),
  text: z.object({
    text: z.string(),
    source_trust: z.literal("untrusted"),
    truncated: z.boolean(),
    chars: z.number().int().nonnegative(),
  }),
  ...pagination,
  cost_estimate_usd: z.number().nonnegative().optional(),
  ...commonOutput,
});

export type GetTranscriptInput = z.infer<typeof getTranscriptInput>;
export type GetTranscriptResult = z.infer<typeof getTranscriptOutput>;

/**
 * Pagination cap for transcription: 20 minutes per API call.
 * Whisper APIs have a 25 MB file limit, but we cap at 20 min to be safe.
 */
const TRANSCRIPTION_WINDOW_SECONDS = 20 * 60;

type TranscriptionSource = "embedded_subtitles" | "sidecar_subtitles" | "whisper_cpp" | "openai" | "groq";

interface TranscriptionResult {
  source: TranscriptionSource;
  segments: Segment[];
  language: string;
  language_confidence?: number;
  model?: string;
  cost_estimate_usd?: number;
}

/**
 * Main transcription tool: tries multiple backends in order of speed/cost.
 */
export async function getTranscript(config: Config, input: GetTranscriptInput): Promise<GetTranscriptResult> {
  const resolved = await resolveSource(input.source);

  // Probe for duration and audio presence
  const probe = await probeMedia(config, { source: input.source });

  if (probe.kind !== "video" && probe.kind !== "audio") {
    throw new MediaIntelError("not_audio_or_video", "Source is not audio or video", "Use probe_media to check the media type.");
  }

  if (probe.kind === "video" && probe.audio === undefined) {
    throw new MediaIntelError("no_audio", "Video has no audio stream", "Use OCR or images instead.");
  }

  // Resolve time window
  const { start_s, end_s, pagination: pag } = resolveWindow(input.window, probe.duration_s, TRANSCRIPTION_WINDOW_SECONDS);

  // Check for cached result
  const cache = await cacheEntry(config, resolved);
  const cacheKey = buildCacheKey(input, start_s, end_s);
  let cachedResult = await readSidecarJson<TranscriptionResult>(cache, `transcript.${cacheKey}.json`);
  if (cachedResult && cachedResult.source) {
    return buildResult(input, cachedResult, pag, probe.duration_s, config);
  }

  // Try backends in order
  let result: TranscriptionResult | null = null;

  if (input.backend === "auto" || input.backend === "embedded") {
    result = await tryEmbeddedSubtitles(config, resolved.location, input).catch(() => null);
    if (result) {
      await writeSidecarJson(cache, `transcript.${cacheKey}.json`, result);
      return buildResult(input, result, pag, probe.duration_s, config);
    }
    if (input.backend === "embedded") {
      throw new MediaIntelError("embedded_unavailable", "No embedded subtitles found", "Try sidecar files or transcription.");
    }
  }

  if (input.backend === "auto" || input.backend === "sidecar") {
    result = await trySidecarSubtitles(config, resolved.location, input).catch(() => null);
    if (result) {
      await writeSidecarJson(cache, `transcript.${cacheKey}.json`, result);
      return buildResult(input, result, pag, probe.duration_s, config);
    }
    if (input.backend === "sidecar") {
      throw new MediaIntelError("sidecar_unavailable", "No sidecar subtitles found", "Try embedded subtitles or transcription.");
    }
  }

  if (input.backend === "auto" || input.backend === "whisper") {
    result = await tryWhisperCpp(config, resolved.location, start_s, end_s, input).catch(() => null);
    if (result) {
      await writeSidecarJson(cache, `transcript.${cacheKey}.json`, result);
      return buildResult(input, result, pag, probe.duration_s, config);
    }
    if (input.backend === "whisper") {
      throw new MediaIntelError("whisper_unavailable", "whisper-cpp not available", "Install with: brew install whisper-cpp");
    }
  }

  // Paid backends only if keys are set and cost is acceptable
  if (input.backend === "auto" || input.backend === "openai") {
    if (process.env.OPENAI_API_KEY) {
      const cost = estimateCost("openai", end_s - start_s);
      if (cost.estimated_cost_usd <= config.maxCostUsd) {
        result = await tryOpenAi(config, resolved.location, start_s, end_s, input).catch(() => null);
        if (result) {
          await writeSidecarJson(cache, `transcript.${cacheKey}.json`, result);
          return buildResult(input, result, pag, probe.duration_s, config);
        }
      } else if (input.backend === "openai") {
        throw new MediaIntelError(
          "cost_above_threshold",
          `Estimated cost $${cost.estimated_cost_usd.toFixed(2)} exceeds MEDIA_INTEL_MAX_COST_USD ($${config.maxCostUsd.toFixed(2)})`,
          "Raise MEDIA_INTEL_MAX_COST_USD, narrow the window, or use whisper.cpp.",
        );
      }
    } else if (input.backend === "openai") {
      throw new MediaIntelError("openai_no_key", "OPENAI_API_KEY not set", "Set the environment variable to use OpenAI.");
    }
  }

  if (input.backend === "auto" || input.backend === "groq") {
    if (process.env.GROQ_API_KEY) {
      const cost = estimateCost("groq", end_s - start_s);
      if (cost.estimated_cost_usd <= config.maxCostUsd) {
        result = await tryGroq(config, resolved.location, start_s, end_s, input).catch(() => null);
        if (result) {
          await writeSidecarJson(cache, `transcript.${cacheKey}.json`, result);
          return buildResult(input, result, pag, probe.duration_s, config);
        }
      } else if (input.backend === "groq") {
        throw new MediaIntelError(
          "cost_above_threshold",
          `Estimated cost $${cost.estimated_cost_usd.toFixed(2)} exceeds MEDIA_INTEL_MAX_COST_USD ($${config.maxCostUsd.toFixed(2)})`,
          "Raise MEDIA_INTEL_MAX_COST_USD, narrow the window, or use whisper.cpp.",
        );
      }
    } else if (input.backend === "groq") {
      throw new MediaIntelError("groq_no_key", "GROQ_API_KEY not set", "Set the environment variable to use Groq.");
    }
  }

  if (input.backend === "auto") {
    throw new MediaIntelError(
      "no_transcription_available",
      "No free transcription backend available (whisper-cpp missing) and no paid API keys set",
      "Install whisper-cpp or set OPENAI_API_KEY or GROQ_API_KEY.",
    );
  }

  throw new MediaIntelError("backend_unavailable", `Backend '${input.backend}' not available`, "Check configuration and try another backend.");
}

async function tryEmbeddedSubtitles(config: Config, location: string, input: GetTranscriptInput): Promise<TranscriptionResult> {
  const result = await extractEmbeddedSubtitles(config, location, {
    language: input.language === "auto" ? undefined : input.language,
    subtitleStreamIndex: input.subtitle_stream_index,
  });

  if (!result || result.segments.length === 0) {
    throw new MediaIntelError("embedded_subtitles_empty", "No embedded subtitles extracted", "");
  }

  return {
    source: "embedded_subtitles",
    segments: result.segments,
    language: result.language || input.language,
  };
}

async function trySidecarSubtitles(config: Config, location: string, input: GetTranscriptInput): Promise<TranscriptionResult> {
  const result = await extractSidecarSubtitles(location, {
    language: input.language === "auto" ? undefined : input.language,
  });

  if (!result) {
    throw new MediaIntelError("sidecar_not_found", "No sidecar subtitles found", "");
  }

  return {
    source: "sidecar_subtitles",
    segments: result.segments,
    language: result.language || input.language,
  };
}

async function tryWhisperCpp(config: Config, location: string, start_s: number, end_s: number, input: GetTranscriptInput): Promise<TranscriptionResult> {
  const result = await transcribeWithWhisperCpp(config, location, {
    language: input.language,
    wordTimestamps: input.word_timestamps,
  });

  // Filter segments to the requested window
  const filtered = result.segments.filter((seg) => seg.end_s > start_s && seg.start_s < end_s);

  return {
    source: "whisper_cpp",
    segments: filtered,
    language: result.language,
    language_confidence: result.language_confidence,
    model: result.model,
  };
}

async function tryOpenAi(config: Config, location: string, start_s: number, end_s: number, input: GetTranscriptInput): Promise<TranscriptionResult> {
  const result = await transcribeWithOpenAi(config, location, {
    language: input.language === "auto" ? undefined : input.language,
  });

  // Filter segments to the requested window
  const filtered = result.segments.filter((seg) => seg.end_s > start_s && seg.start_s < end_s);

  return {
    source: "openai",
    segments: filtered,
    language: result.language,
    model: result.model,
    cost_estimate_usd: result.cost_estimate_usd,
  };
}

async function tryGroq(config: Config, location: string, start_s: number, end_s: number, input: GetTranscriptInput): Promise<TranscriptionResult> {
  const result = await transcribeWithGroq(config, location, {
    language: input.language === "auto" ? undefined : input.language,
  });

  // Filter segments to the requested window
  const filtered = result.segments.filter((seg) => seg.end_s > start_s && seg.start_s < end_s);

  return {
    source: "groq",
    segments: filtered,
    language: result.language,
    model: result.model,
    cost_estimate_usd: result.cost_estimate_usd,
  };
}

function buildCacheKey(input: GetTranscriptInput, start_s: number, end_s: number): string {
  const backend = input.backend === "auto" ? "auto" : input.backend;
  const lang = input.language === "auto" ? "auto" : input.language;
  const wt = input.word_timestamps ? "1" : "0";
  return `${backend}.${lang}.${Math.round(start_s)}-${Math.round(end_s)}.${wt}`;
}

function buildResult(
  input: GetTranscriptInput,
  result: TranscriptionResult,
  pag: any,
  totalDurationS: number | undefined,
  config: Config,
): GetTranscriptResult {
  const maxChars = input.max_chars ?? config.maxTextFieldChars;

  // Filter by window
  const windowedSegments = result.segments.filter((seg) => seg.end_s > pag.window_start_s && seg.start_s < pag.window_end_s);

  // Format output text
  let formattedText: string;
  if (input.format === "srt") {
    formattedText = encodeSrt(windowedSegments);
  } else if (input.format === "json") {
    formattedText = JSON.stringify(windowedSegments);
  } else {
    // text format: one line per segment
    formattedText = windowedSegments.map((seg) => seg.text).join("\n");
  }

  const wrappedText = wrapUntrusted(formattedText, maxChars);

  // Check for empty/silence warnings
  const warnings: string[] = [];
  if (windowedSegments.length === 0) {
    warnings.push("No transcript data in this window.");
  }
  const totalText = windowedSegments.map((seg) => seg.text).join(" ");
  if (totalText.trim().length === 0 || /^\s*\[silence\]|music|\.{3}|\.\.\./i.test(totalText)) {
    warnings.push("Transcript appears to be mostly silence or music.");
  }

  return {
    source: input.source,
    transcription_source: result.source,
    model: result.model,
    language: result.language,
    language_confidence: result.language_confidence,
    format: input.format,
    segments: windowedSegments,
    text: wrappedText,
    ...(totalDurationS !== undefined ? { total_duration_s: round3(totalDurationS) } : {}),
    window_start_s: round3(pag.window_start_s),
    window_end_s: round3(pag.window_end_s),
    has_more: pag.has_more,
    ...(pag.next_window ? { next_window: pag.next_window } : {}),
    ...(result.cost_estimate_usd !== undefined ? { cost_estimate_usd: round3(result.cost_estimate_usd) } : {}),
    warnings,
    suggested_next: [],
  };
}

export function summarizeGetTranscript(result: GetTranscriptResult): string {
  return `Transcript (${result.format}, ${result.transcription_source}): ${result.segments.length} segments, ${result.text.chars} total chars, language ${result.language}${result.language_confidence ? ` (${(result.language_confidence * 100).toFixed(0)}%)` : ""}.`;
}
