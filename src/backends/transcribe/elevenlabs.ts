/**
 * Transcription via ElevenLabs Speech to Text (Scribe).
 *
 * Docs read on 29-08-2026:
 * - https://elevenlabs.io/docs/capabilities/speech-to-text: 3 GB and 10 h per file, 90+ languages,
 *   diarization up to 32 speakers, audio event tags, word timestamps
 * - https://elevenlabs.io/docs/api-reference/speech-to-text/convert: multipart POST, model_id scribe_v2|scribe_v1,
 *   language_code ISO-639-1 or ISO-639-3, diarize, num_speakers, tag_audio_events, timestamps_granularity
 * - https://elevenlabs.io/docs/api-reference/authentication: header xi-api-key
 * - https://elevenlabs.io/pricing/api: Scribe v2 0.22 USD per hour, billed per audio minute
 *
 * The API returns words, not segments; wordsToSegments groups them by speaker, pause and sentence.
 * Requires ELEVENLABS_API_KEY in the environment (injected by a launcher, never read from a config file).
 */

import { readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../../config.js";
import { ffmpeg, toWav16k } from "../../ffmpeg.js";
import { tmpDir } from "../../cache.js";
import { round3 } from "../../contracts.js";
import { MediaIntelError } from "../../errors.js";
import { redactSecrets } from "../../process.js";
import { ELEVENLABS_SCRIBE_COST_PER_HOUR } from "./cost.js";
import type { Segment } from "./srt.js";

export const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";

/** Uploads above this are transcoded to AAC first. Upload time only: the API itself accepts 3 GB. */
const WAV_UPLOAD_LIMIT_BYTES = 25 * 1024 * 1024;

export interface ElevenLabsOptions {
  /** ISO-639-1 or ISO-639-3 code; omit (or "auto") for automatic detection. */
  language?: string;
  startSeconds?: number;
  endSeconds?: number;
  /** Speaker labels per word (up to 32 speakers). */
  diarize?: boolean;
  /** Upper bound for diarization, 1..32. Only sent with diarize. */
  numSpeakers?: number;
  /** Tag non-speech sounds like (laughter). API default is true. */
  tagAudioEvents?: boolean;
}

/** One entry of the response `words` array (SpeechToTextChunkResponseModel). */
export interface ElevenLabsWord {
  text: string;
  type: "word" | "spacing" | "audio_event";
  logprob?: number;
  start?: number | null;
  end?: number | null;
  speaker_id?: string | null;
}

export interface ElevenLabsResponse {
  language_code: string;
  language_probability: number;
  text: string;
  words: ElevenLabsWord[];
  transcription_id?: string | null;
  audio_duration_secs?: number | null;
}

export interface ElevenLabsResult {
  segments: Segment[];
  language: string;
  language_confidence: number;
  model: string;
  cost_estimate_usd: number;
  transcription_id?: string;
}

export interface SegmentingOptions {
  /** Added to every timestamp (window start). */
  offsetS?: number;
  /** A pause longer than this starts a new segment. */
  gapS?: number;
  /** Sentence ends split once a segment has at least this many characters. */
  sentenceMinChars?: number;
  /** Hard caps per segment. */
  maxChars?: number;
  maxSpanS?: number;
}

/**
 * Group Scribe words into subtitle-like segments. Splits on speaker change, pauses above gapS,
 * sentence ends (once the segment has some length) and hard caps. Spacing tokens only decide
 * whether a space is inserted, so languages without spaces (ja, zh, th) stay intact.
 */
export function wordsToSegments(words: ElevenLabsWord[], opts: SegmentingOptions = {}): Segment[] {
  const offset = opts.offsetS ?? 0;
  const gapS = opts.gapS ?? 1.0;
  const sentenceMinChars = opts.sentenceMinChars ?? 60;
  const maxChars = opts.maxChars ?? 200;
  const maxSpanS = opts.maxSpanS ?? 12;

  interface Open {
    start: number;
    end: number;
    text: string;
    speaker: string | undefined;
    sentenceEnded: boolean;
  }

  const segments: Segment[] = [];
  let current: Open | null = null;
  let pendingSpace = false;
  let lastEnd = 0;

  const flush = (open: Open | null): null => {
    if (open && open.text.length > 0) {
      segments.push({
        start_s: round3(open.start + offset),
        end_s: round3(Math.max(open.end, open.start) + offset),
        text: open.text,
        ...(open.speaker !== undefined ? { speaker: open.speaker } : {}),
      });
    }
    pendingSpace = false;
    return null;
  };

  for (const word of words) {
    if (word.type === "spacing") {
      pendingSpace = true;
      continue;
    }
    const text = word.text.trim();
    if (text.length === 0) continue;
    const start = typeof word.start === "number" ? word.start : lastEnd;
    const end = typeof word.end === "number" ? word.end : start;
    const speaker = word.speaker_id ?? undefined;

    if (current) {
      const split =
        speaker !== current.speaker ||
        start - current.end > gapS ||
        current.end - current.start >= maxSpanS ||
        current.text.length >= maxChars ||
        (current.sentenceEnded && current.text.length >= sentenceMinChars);
      if (split) current = flush(current);
    }
    if (current === null) {
      current = { start, end, text, speaker, sentenceEnded: false };
    } else {
      current.text += (pendingSpace ? " " : "") + text;
      current.end = Math.max(current.end, end);
    }
    current.sentenceEnded = word.type === "word" && /[.!?…]["')\]»]?$/.test(text);
    pendingSpace = false;
    lastEnd = Math.max(lastEnd, end);
  }
  flush(current);
  return segments;
}

const ISO_639_3_TO_1: Record<string, string> = {
  afr: "af", amh: "am", ara: "ar", aze: "az", bel: "be", ben: "bn", bos: "bs", bul: "bg", cat: "ca", ces: "cs",
  cmn: "zh", zho: "zh", cym: "cy", dan: "da", deu: "de", ell: "el", eng: "en", est: "et", eus: "eu", fas: "fa",
  fil: "tl", fin: "fi", fra: "fr", glg: "gl", guj: "gu", heb: "he", hin: "hi", hrv: "hr", hun: "hu", hye: "hy",
  ind: "id", isl: "is", ita: "it", jpn: "ja", kan: "kn", kat: "ka", kaz: "kk", khm: "km", kor: "ko", lav: "lv",
  lit: "lt", mal: "ml", mar: "mr", mkd: "mk", msa: "ms", mya: "my", nep: "ne", nld: "nl", nor: "no", nob: "nb",
  pan: "pa", pol: "pl", por: "pt", ron: "ro", rus: "ru", slk: "sk", slv: "sl", spa: "es", sqi: "sq", srp: "sr",
  swa: "sw", swe: "sv", tam: "ta", tel: "te", tgl: "tl", tha: "th", tur: "tr", ukr: "uk", urd: "ur", uzb: "uz",
  vie: "vi",
};

/** Scribe reports ISO-639-3 (deu); the rest of media-intel speaks ISO-639-1 (de). Unknown codes pass through. */
export function toIso6391(code: string): string {
  const c = code.trim().toLowerCase();
  if (c.length === 2) return c;
  return ISO_639_3_TO_1[c] ?? c;
}

/** Error bodies look like {"detail":{"status":"quota_exceeded","message":"..."}} (seen live on 29-08-2026). */
interface ElevenLabsErrorBody {
  detail?: { status?: string; code?: string; message?: string } | string;
}

const KNOWN_ERROR_STATUS: Record<string, string> = {
  quota_exceeded: "The ElevenLabs plan has no credits left for this request: top up or wait for the renewal, or use whisper.cpp or openai.",
  invalid_api_key: "The API key was rejected: check ELEVENLABS_API_KEY.",
  missing_permissions: "The key lacks the speech-to-text scope: edit the key's permissions in the ElevenLabs workspace settings.",
  too_many_concurrent_requests: "Concurrency limit reached: retry later or narrow the window.",
  rate_limit_exceeded: "Rate limit reached: retry later or narrow the window.",
  detected_unusual_activity: "ElevenLabs flagged the account (free tier abuse check): contact their support or use another backend.",
  free_users_not_allowed: "This feature needs a paid ElevenLabs plan.",
};

/** Map an error response to a stable code, a redacted message and a hint. */
export function classifyElevenLabsError(status: number, bodyText: string): { code: string; message: string; hint: string } {
  let detailStatus: string | undefined;
  let detailMessage: string | undefined;
  try {
    const parsed = JSON.parse(bodyText) as ElevenLabsErrorBody;
    if (parsed.detail && typeof parsed.detail === "object") {
      detailStatus = parsed.detail.status ?? parsed.detail.code;
      detailMessage = parsed.detail.message;
    } else if (typeof parsed.detail === "string") {
      detailMessage = parsed.detail;
    }
  } catch {
    // not JSON, keep the raw body
  }
  const known = detailStatus !== undefined && detailStatus in KNOWN_ERROR_STATUS;
  const code = known ? `elevenlabs_${detailStatus}` : "elevenlabs_api_error";
  const hint = known ? KNOWN_ERROR_STATUS[detailStatus as string]! : hintForStatus(status);
  const body = redactSecrets(detailMessage ?? bodyText).slice(0, 500);
  const message = `ElevenLabs API error ${status}${detailStatus ? ` (${detailStatus})` : ""}: ${body}`;
  return { code, message, hint };
}

function hintForStatus(status: number): string {
  switch (status) {
    case 401:
      return "The API key was rejected: check ELEVENLABS_API_KEY.";
    case 403:
      return "The key lacks the speech-to-text scope or this IP is not on the key's allowlist.";
    case 413:
      return "Upload too large: narrow the window.";
    case 422:
      return "Request rejected as invalid: check MEDIA_INTEL_ELEVENLABS_MODEL (scribe_v2 or scribe_v1) and the language code.";
    case 429:
      return "Rate or concurrency limit reached: retry later or narrow the window.";
    default:
      return "Check API key, quota and the ElevenLabs status page, then retry.";
  }
}

/**
 * Transcribe with ElevenLabs Scribe. Audio is cut to the window and resampled to 16 kHz mono first,
 * timestamps come back shifted by startSeconds, speakers land in Segment.speaker when diarize is set.
 */
export async function transcribeWithElevenLabs(config: Config, location: string, opts: ElevenLabsOptions): Promise<ElevenLabsResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new MediaIntelError(
      "elevenlabs_no_key",
      "ELEVENLABS_API_KEY not set in environment",
      "Inject it through the launcher (for example op run) or use a different transcription backend.",
    );
  }

  const tmpDirPath = await tmpDir(config);
  const wavFile = join(tmpDirPath, "input.wav");
  let uploadFile = wavFile;
  let uploadMimeType = "audio/wav";
  let uploadFilename = "audio.wav";

  try {
    const window = opts.startSeconds !== undefined ? { start_s: opts.startSeconds, ...(opts.endSeconds !== undefined ? { end_s: opts.endSeconds } : {}) } : undefined;
    await toWav16k(config, location, wavFile, window);

    const fileStats = await stat(wavFile);
    if (fileStats.size > WAV_UPLOAD_LIMIT_BYTES) {
      const m4aFile = join(tmpDirPath, "input.m4a");
      await ffmpeg(config, ["-i", wavFile, "-ac", "1", "-ar", "16000", "-b:a", "64k", "-c:a", "aac", "-f", "ipod", m4aFile]);
      uploadFile = m4aFile;
      uploadMimeType = "audio/mp4";
      uploadFilename = "audio.m4a";
    }

    const audioBuffer = await readFile(uploadFile);
    const formData = new FormData();
    formData.append("model_id", config.elevenlabsModel);
    formData.append("file", new Blob([audioBuffer], { type: uploadMimeType }), uploadFilename);
    formData.append("timestamps_granularity", "word");
    formData.append("diarize", opts.diarize ? "true" : "false");
    formData.append("tag_audio_events", opts.tagAudioEvents === false ? "false" : "true");
    if (opts.language && opts.language !== "auto") formData.append("language_code", opts.language);
    if (opts.diarize && opts.numSpeakers !== undefined) {
      formData.append("num_speakers", String(Math.min(32, Math.max(1, Math.round(opts.numSpeakers)))));
    }

    let response: Response;
    try {
      response = await fetch(ELEVENLABS_STT_URL, {
        method: "POST",
        headers: { "xi-api-key": apiKey },
        body: formData,
        signal: AbortSignal.timeout(config.processTimeoutMs * 5),
      });
    } catch (error) {
      throw new MediaIntelError(
        "elevenlabs_network_error",
        `ElevenLabs request failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
        "Check network access to api.elevenlabs.io and retry; long windows may need a higher MEDIA_INTEL_PROCESS_TIMEOUT_MS.",
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const classified = classifyElevenLabsError(response.status, errorText);
      throw new MediaIntelError(classified.code, classified.message, classified.hint);
    }

    const data = (await response.json()) as ElevenLabsResponse;
    if (!Array.isArray(data.words) || data.words.length === 0) {
      throw new MediaIntelError("elevenlabs_empty", "ElevenLabs returned no words", "Check that the audio contains speech in this window.");
    }

    const offset = opts.startSeconds ?? 0;
    const segments = wordsToSegments(data.words, { offsetS: offset });
    if (segments.length === 0) {
      throw new MediaIntelError("elevenlabs_empty", "ElevenLabs returned no transcribable words", "Check that the audio contains speech in this window.");
    }

    const windowSeconds = opts.startSeconds !== undefined && opts.endSeconds !== undefined ? Math.max(0, opts.endSeconds - opts.startSeconds) : undefined;
    const lastSegment = segments[segments.length - 1]!;
    const billedSeconds =
      typeof data.audio_duration_secs === "number" && data.audio_duration_secs > 0 ? data.audio_duration_secs : (windowSeconds ?? Math.max(0, lastSegment.end_s - offset));
    const probability = typeof data.language_probability === "number" ? Math.min(1, Math.max(0, data.language_probability)) : 0;

    return {
      segments,
      language: toIso6391(typeof data.language_code === "string" && data.language_code.length > 0 ? data.language_code : "und"),
      language_confidence: probability,
      model: config.elevenlabsModel,
      cost_estimate_usd: (billedSeconds / 3600) * ELEVENLABS_SCRIBE_COST_PER_HOUR,
      ...(typeof data.transcription_id === "string" && data.transcription_id.length > 0 ? { transcription_id: data.transcription_id } : {}),
    };
  } finally {
    try {
      if (uploadFile !== wavFile) await unlink(uploadFile);
      await unlink(wavFile);
    } catch {
      // Ignore cleanup errors
    }
  }
}
