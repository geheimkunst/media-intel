/**
 * Transcription via Groq Whisper API.
 * Requires GROQ_API_KEY environment variable.
 * Audio file must be <= 25 MB; larger files are transcoded to M4A.
 */

import { readFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../../config.js";
import { ffmpeg, tmpDir } from "../../ffmpeg.js";
import { MediaIntelError } from "../../errors.js";
import { redactSecrets } from "../../process.js";
import type { Segment } from "./srt.js";

export interface GroqOptions {
  language?: string; // ISO-639-1 code
}

interface WhisperApiResponse {
  language: string;
  segments: {
    id: number;
    seek: number;
    start: number;
    end: number;
    text: string;
    tokens: number[];
    temperature: number;
    avg_logprob: number;
    compression_ratio: number;
    no_speech_prob: number;
  }[];
  text: string;
}

/**
 * Transcribe using Groq Whisper API.
 * Requires GROQ_API_KEY set in environment.
 */
export async function transcribeWithGroq(
  config: Config,
  location: string,
  opts: GroqOptions,
): Promise<{
  segments: Segment[];
  language: string;
  model: string;
  cost_estimate_usd: number;
}> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new MediaIntelError(
      "groq_no_key",
      "GROQ_API_KEY not set in environment",
      "Set the environment variable or use a different transcription backend.",
    );
  }

  const tmpDirPath = await tmpDir(config);
  const wavFile = location.startsWith("/") ? location : join(tmpDirPath, "input.wav");
  let uploadFile = wavFile;

  try {
    // Check file size; if > 25 MB, transcode to M4A
    const fileStats = await stat(wavFile);
    if (fileStats.size > 25 * 1024 * 1024) {
      const m4aFile = join(tmpDirPath, "input.m4a");
      // Transcode to M4A at 64 kbps, mono, 16 kHz
      await ffmpeg(config, ["-i", wavFile, "-ac", "1", "-ar", "16000", "-b:a", "64k", "-c:a", "aac", "-f", "ipod", m4aFile]);
      uploadFile = m4aFile;
    }

    // Read file for upload
    const audioBuffer = await readFile(uploadFile);

    // Prepare FormData
    const formData = new FormData();
    formData.append("model", "whisper-large-v3-turbo");
    formData.append("file", new Blob([audioBuffer], { type: "audio/wav" }), "audio.wav");
    formData.append("response_format", "verbose_json");
    if (opts.language && opts.language !== "auto") {
      formData.append("language", opts.language);
    }

    // Call Groq API
    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new MediaIntelError(
        "groq_api_error",
        `Groq API error ${response.status}: ${redactSecrets(errorText)}`,
        "Check your API key and quota.",
      );
    }

    const data = (await response.json()) as WhisperApiResponse;

    if (!data.segments || data.segments.length === 0) {
      throw new MediaIntelError("groq_empty", "Groq Whisper returned no transcript", "Check the audio content.");
    }

    const segments: Segment[] = data.segments.map((seg) => ({
      start_s: seg.start,
      end_s: seg.end,
      text: seg.text.trim(),
    }));

    // Estimate cost: $0.04 per hour
    const durationSeconds = segments.length > 0 ? segments[segments.length - 1].end_s : 0;
    const costPerMin = 0.04 / 60;
    const costEstimate = (durationSeconds / 60) * costPerMin;

    return {
      segments,
      language: data.language,
      model: "whisper-large-v3-turbo",
      cost_estimate_usd: costEstimate,
    };
  } finally {
    // Clean up temp files
    try {
      if (uploadFile !== wavFile && (uploadFile.includes("input.m4a") || uploadFile.includes("input.mp3"))) {
        await unlink(uploadFile);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}
