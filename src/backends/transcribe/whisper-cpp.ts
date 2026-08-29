/**
 * Transcription via local whisper-cpp binary.
 * Runs ffmpeg to transcode to WAV 16 kHz, then pipes to whisper-cli with -oj (JSON output).
 */

import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { cpus } from "node:os";
import type { Config } from "../../config.js";
import { toWav16k } from "../../ffmpeg.js";
import { tmpDir } from "../../cache.js";
import { runBinary } from "../../process.js";
import { MediaIntelError } from "../../errors.js";
import { whisperModelPath, vadModelPath } from "../../tools/doctor.js";
import type { Segment } from "./srt.js";

export interface WhisperCppOptions {
  language?: string; // ISO-639-1 code or "auto"
  wordTimestamps?: boolean;
  startSeconds?: number;
  endSeconds?: number;
}

interface WhisperCppOutput {
  /** whisper-cli writes { language } here, not the segments. */
  result?: { language?: string };
  transcription?: WhisperSegment[];
}

interface WhisperSegment {
  offsets: {
    from: number; // milliseconds
    to: number; // milliseconds
  };
  text: string;
}

/**
 * Transcribe using local whisper.cpp binary.
 * Requires ffmpeg and whisper-cli on PATH.
 */
export async function transcribeWithWhisperCpp(
  config: Config,
  location: string,
  opts: WhisperCppOptions,
): Promise<{
  segments: Segment[];
  language: string;
  language_confidence?: number;
  model: string;
}> {
  const tmpDirPath = await tmpDir(config);
  const wavFile = join(tmpDirPath, "transcript_input.wav");

  try {
    // Transcode to WAV 16 kHz mono
    const window = opts.startSeconds !== undefined ? { start_s: opts.startSeconds, ...(opts.endSeconds !== undefined ? { end_s: opts.endSeconds } : {}) } : undefined;
    await toWav16k(config, location, wavFile, window);

    const modelPath = whisperModelPath(config);
    const vadModelPath_ = vadModelPath(config);

    const args = ["-m", modelPath, "-f", wavFile, "-oj", "-of", join(tmpDirPath, "transcript"), "-l", opts.language || "auto", "-np", "-t", String(Math.min(8, cpus().length))];

    // Add VAD if available
    try {
      // Check if VAD model exists (fire-and-forget check)
      await import("node:fs/promises").then((m) => m.stat(vadModelPath_));
      args.push("--vad", "-vm", vadModelPath_);
    } catch {
      // VAD model not available, continue without it
    }

    // Add word timestamps if requested
    if (opts.wordTimestamps) {
      args.push("-ml", "1", "-sow");
    }

    const result = await runBinary(config, config.whisperBin, args);

    if (result.missing) {
      throw new MediaIntelError("whisper_missing", "whisper-cli binary not found on PATH", "Install with: brew install whisper-cpp");
    }

    if (result.exitCode !== 0) {
      throw new MediaIntelError("whisper_failed", `whisper-cli exited with code ${result.exitCode}: ${result.stderr}`, "Check the model path and audio file.");
    }

    // Read the JSON output
    const jsonPath = join(tmpDirPath, "transcript.json");
    const jsonData = await readFile(jsonPath, "utf-8");
    const output = JSON.parse(jsonData) as WhisperCppOutput;

    const rawSegments = output.transcription ?? [];
    if (rawSegments.length === 0) {
      throw new MediaIntelError("whisper_empty", "whisper-cli produced no transcript", "Check the audio content; with --vad the file may be all silence.");
    }

    const timeOffset = opts.startSeconds ?? 0;
    const segments: Segment[] = rawSegments.filter((seg) => seg.text.trim().length > 0).map((seg) => ({
      start_s: seg.offsets.from / 1000 + timeOffset,
      end_s: seg.offsets.to / 1000 + timeOffset,
      text: seg.text.trim(),
    }));

    // Extract language and confidence from stderr if available
    let language = opts.language || "auto";
    let confidence: number | undefined;

    const langMatch = `${result.stderr}\n${result.stdout}`.match(/auto-detected language:\s*([a-z]{2,3})\s*\(p\s*=\s*([\d.]+)\)/i);
    if (langMatch?.[1] && langMatch[2]) {
      language = langMatch[1];
      confidence = parseFloat(langMatch[2]);
    } else if (output.result?.language) {
      language = output.result.language;
    }

    return {
      segments,
      language,
      ...(confidence !== undefined ? { language_confidence: confidence } : {}),
      model: "large-v3-turbo-q5_0",
    };
  } finally {
    // Clean up temp WAV file
    try {
      await unlink(wavFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}
