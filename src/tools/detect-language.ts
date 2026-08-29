/**
 * detect_language: Detect the language of audio in a media file.
 * Uses whisper.cpp to auto-detect from the first probe_duration_s seconds.
 */

import * as z from "zod/v4";
import type { Config } from "../config.js";
import { commonOutput } from "../contracts.js";
import { MediaIntelError } from "../errors.js";
import { probeMedia } from "./probe-media.js";
import { resolveSource } from "../source.js";
import { transcribeWithWhisperCpp } from "../backends/transcribe/whisper-cpp.js";

export const detectLanguageInput = z.object({
  source: z.string().min(1).describe("Absolute path or direct http(s) URL to a media file."),
  probe_duration_s: z.number().positive().default(30).describe("Duration in seconds to analyze for language detection."),
});

export const detectLanguageOutput = z.object({
  source: z.string(),
  language: z.string().describe("Detected ISO-639-1 language code (e.g., 'de', 'en')."),
  confidence: z.number().nonnegative().describe("Confidence value (0.0-1.0) if available."),
  backend: z.literal("whisper_cpp"),
  ...commonOutput,
});

export type DetectLanguageInput = z.infer<typeof detectLanguageInput>;
export type DetectLanguageResult = z.infer<typeof detectLanguageOutput>;

/**
 * Detect language from audio using whisper.cpp.
 */
export async function detectLanguage(config: Config, input: DetectLanguageInput): Promise<DetectLanguageResult> {
  const resolved = await resolveSource(input.source);

  // Probe for duration and audio
  const probe = await probeMedia(config, { source: input.source });

  if (probe.kind !== "video" && probe.kind !== "audio") {
    throw new MediaIntelError("not_audio_or_video", "Source is not audio or video", "Use probe_media to check the media type.");
  }

  if (probe.kind === "video" && probe.audio === undefined) {
    throw new MediaIntelError("no_audio", "Video has no audio stream", "Use a different media file.");
  }

  // Use whisper.cpp to detect language from the first probe_duration_s seconds
  try {
    const result = await transcribeWithWhisperCpp(config, resolved.location, {
      language: "auto",
      wordTimestamps: false,
      startSeconds: 0,
      endSeconds: input.probe_duration_s,
    });

    return {
      source: input.source,
      language: result.language,
      confidence: result.language_confidence ?? 0,
      backend: "whisper_cpp",
      warnings: [],
      suggested_next: ["get_transcript"],
    };
  } catch (err) {
    if (err instanceof MediaIntelError && err.code === "whisper_missing") {
      throw err;
    }
    throw new MediaIntelError(
      "language_detection_failed",
      `Failed to detect language: ${err instanceof Error ? err.message : String(err)}`,
      "Check the audio content or try a different audio file.",
    );
  }
}

export function summarizeDetectLanguage(result: DetectLanguageResult): string {
  return `Detected language: ${result.language} (confidence: ${(result.confidence * 100).toFixed(0)}%).`;
}
