import { McpServer } from "@modelcontextprotocol/server";
import { loadConfig, type Config } from "./config.js";
import { toolErrorResult } from "./errors.js";
import { frameUntrusted } from "./contracts.js";
import { doctor, doctorInput, doctorOutput, summarizeDoctor } from "./tools/doctor.js";
import { probeMedia, probeMediaInput, probeMediaOutput, summarizeProbe } from "./tools/probe-media.js";
import { extractText, extractTextInput, extractTextOutput, summarizeExtractText } from "./tools/extract-text.js";

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
    "extract_text",
    {
      title: "Extract text (OCR)",
      description:
        "Extract text from images or video frames using OCR (tesseract). For images, run directly. " +
        "For video, specify timestamps (1..32 per call) to extract frames and OCR them. " +
        "Returns text with word boxes, line-level confidence, and language-aware detection. " +
        "Supports region crops and upscaling for small text. Language codes: deu+eng (German+English). " +
        "Warning: tesseract is optional; run doctor first to check availability.",
      inputSchema: extractTextInput,
      outputSchema: extractTextOutput,
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await extractText(config, args);
        const headerLine = `Extracted text from ${result.results.length} image(s) in language: ${result.language}`;
        const contentLines = [headerLine];
        for (const r of result.results) {
          const label = `OCR ${r.t_s !== undefined ? `t=${r.t_s}s` : "image"}`;
          contentLines.push(frameUntrusted(label, r.text));
        }
        return { content: [{ type: "text", text: contentLines.join("\n") }], structuredContent: result };
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  return server;
}
