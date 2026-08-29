/**
 * Transcription via OpenAI Whisper API.
 * Requires OPENAI_API_KEY environment variable.
 * Audio file must be <= 25 MB; larger files are transcoded to MP3/M4A.
 */

import { readFile, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../../config.js";
import { ffmpeg, toWav16k } from "../../ffmpeg.js";
import { tmpDir } from "../../cache.js";
import { MediaIntelError } from "../../errors.js";
import { redactSecrets } from "../../process.js";
import type { Segment } from "./srt.js";

export interface OpenAiOptions {
  language?: string; // ISO-639-1 code
  startSeconds?: number;
  endSeconds?: number;
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
 * Transcribe using OpenAI Whisper API.
 * Requires OPENAI_API_KEY set in environment.
 */
export async function transcribeWithOpenAi(
  config: Config,
  location: string,
  opts: OpenAiOptions,
): Promise<{
  segments: Segment[];
  language: string;
  model: string;
  cost_estimate_usd: number;
}> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new MediaIntelError(
      "openai_no_key",
      "OPENAI_API_KEY not set in environment",
      "Set the environment variable or use a different transcription backend.",
    );
  }

  const tmpDirPath = await tmpDir(config);
  const wavFile = join(tmpDirPath, "input.wav");
  let uploadFile = wavFile;
  let uploadMimeType = "audio/wav";
  let uploadFilename = "audio.wav";

  try {
    // Convert to WAV 16 kHz mono (applies window if specified)
    const window = opts.startSeconds !== undefined ? { start_s: opts.startSeconds, ...(opts.endSeconds !== undefined ? { end_s: opts.endSeconds } : {}) } : undefined;
    await toWav16k(config, location, wavFile, window);

    // Check file size; if > 25 MB, transcode to MP3
    const fileStats = await stat(wavFile);
    if (fileStats.size > 25 * 1024 * 1024) {
      const mp3File = join(tmpDirPath, "input.mp3");
      // Transcode to MP3 at 64 kbps, mono, 16 kHz
      await ffmpeg(config, ["-i", wavFile, "-ac", "1", "-ar", "16000", "-b:a", "64k", "-f", "mp3", mp3File]);
      uploadFile = mp3File;
      uploadMimeType = "audio/mpeg";
      uploadFilename = "audio.mp3";
    }

    // Read file for upload
    const audioBuffer = await readFile(uploadFile);

    // Prepare FormData
    const formData = new FormData();
    formData.append("model", "whisper-1");
    formData.append("file", new Blob([audioBuffer], { type: uploadMimeType }), uploadFilename);
    formData.append("response_format", "verbose_json");
    if (opts.language && opts.language !== "auto") {
      formData.append("language", opts.language);
    }

    // Call OpenAI API
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new MediaIntelError(
        "openai_api_error",
        `OpenAI API error ${response.status}: ${redactSecrets(errorText)}`,
        "Check your API key and quota.",
      );
    }

    const data = (await response.json()) as WhisperApiResponse;

    if (!data.segments || data.segments.length === 0) {
      throw new MediaIntelError("openai_empty", "OpenAI Whisper returned no transcript", "Check the audio content.");
    }

    const timeOffset = opts.startSeconds ?? 0;
    const segments: Segment[] = data.segments.map((seg) => ({
      start_s: seg.start + timeOffset,
      end_s: seg.end + timeOffset,
      text: seg.text.trim(),
    }));

    // Estimate cost
    const durationSeconds = segments.length > 0 ? segments[segments.length - 1]!.end_s : 0;
    const costPerMin = 0.006;
    const costEstimate = (durationSeconds / 60) * costPerMin;

    return {
      segments,
      language: data.language,
      model: "whisper-1",
      cost_estimate_usd: costEstimate,
    };
  } finally {
    // Clean up temp files
    try {
      if (uploadFile !== wavFile && uploadFile.includes("input.mp3")) {
        await unlink(uploadFile);
      }
      await unlink(wavFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}
