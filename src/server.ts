import { McpServer } from "@modelcontextprotocol/server";
import { loadConfig, type Config } from "./config.js";
import { toolErrorResult } from "./errors.js";
import { frameUntrusted } from "./contracts.js";
import { doctor, doctorInput, doctorOutput, summarizeDoctor } from "./tools/doctor.js";
import { probeMedia, probeMediaInput, probeMediaOutput, summarizeProbe } from "./tools/probe-media.js";
import { getTranscript, getTranscriptInput, getTranscriptOutput, summarizeGetTranscript } from "./tools/get-transcript.js";
import { detectLanguage, detectLanguageInput, detectLanguageOutput, summarizeDetectLanguage } from "./tools/detect-language.js";

export const SERVER_NAME = "media-intel";
export const SERVER_VERSION = "0.1.0";

/**
 * Build a fully configured server. Transport is chosen by the caller
 * (stdio in the CLI, in-memory in tests, Streamable HTTP behind a bridge).
 *
 * Adding a tool: create src/tools/<name>.ts with xInput, xOutput, x() and
 * summarizeX(), then register it below following the same shape.
 */
export function createServer(config: Config = loadConfig()): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "doctor",
    {
      title: "Doctor",
      description:
        "Report what this media-intel installation can do: which binaries (ffmpeg, ffprobe, yt-dlp, whisper-cli, tesseract) " +
        "are installed with versions, which ffmpeg filters exist, whether local Whisper models are present, OCR languages, " +
        "cache usage, and a per-capability ready/partial/missing verdict with what is needed. Call this once when a tool " +
        "reports a missing dependency, instead of retrying.",
      inputSchema: doctorInput,
      outputSchema: doctorOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const result = await doctor(config);
        return { content: [{ type: "text", text: summarizeDoctor(result) }], structuredContent: result };
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "probe_media",
    {
      title: "Probe media",
      description:
        "Inspect a media file or direct URL without decoding it: kind (video/audio/image), container, duration, " +
        "resolution, fps, codecs, audio layout, subtitle tracks, chapters, tags, and warnings. Fast (tens of ms). " +
        "With deep=true also runs one audio pass for a silence map, loudness (LUFS) and noise floor. " +
        "Call this first; its `suggested_next` field tells you which deeper tool fits the input.",
      inputSchema: probeMediaInput,
      outputSchema: probeMediaOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await probeMedia(config, args);
        return { content: [{ type: "text", text: summarizeProbe(result) }], structuredContent: result };
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "get_transcript",
    {
      title: "Get transcript",
      description:
        "Extract or generate a transcript from a media file. Automatically chains through embedded subtitles, sidecar files (.srt/.vtt), " +
        "local whisper.cpp (free, ~2 min per 5 min), and paid APIs (OpenAI/Groq, with cost preflight). " +
        "Long media is paginated into 20-minute windows. Use window parameter and has_more/next_window for pagination.",
      inputSchema: getTranscriptInput,
      outputSchema: getTranscriptOutput,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await getTranscript(config, args);
        return {
          content: [{ type: "text", text: `${summarizeGetTranscript(result)}\n\n${frameUntrusted("Transcript", result.text)}` }],
          structuredContent: result,
        };
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "detect_language",
    {
      title: "Detect language",
      description: "Detect the language of audio in a media file using whisper.cpp (local, free, ~10 sec for 30 sec probe). Returns an ISO-639-1 language code.",
      inputSchema: detectLanguageInput,
      outputSchema: detectLanguageOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await detectLanguage(config, args);
        return { content: [{ type: "text", text: summarizeDetectLanguage(result) }], structuredContent: result };
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  return server;
}
