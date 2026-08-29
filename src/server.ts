import { McpServer } from "@modelcontextprotocol/server";
import { loadConfig, type Config } from "./config.js";
import { toolErrorResult } from "./errors.js";
import { registerPrompts } from "./prompts.js";
import { registerAnalyzeAudio } from "./tools/analyze-audio.js";
import { registerDiffFrames } from "./tools/diff-frames.js";
import { doctor, doctorInput, doctorOutput, summarizeDoctor } from "./tools/doctor.js";
import { registerGetScenes } from "./tools/get-scenes.js";
import { registerListCached } from "./tools/list-cached.js";
import { probeMedia, probeMediaInput, probeMediaOutput, summarizeProbe } from "./tools/probe-media.js";

export const SERVER_NAME = "media-intel";
export const SERVER_VERSION = "0.2.0";

/**
 * Build a fully configured server. Transport is chosen by the caller
 * (stdio in the CLI, in-memory in tests, Streamable HTTP behind a bridge).
 *
 * Adding a tool: create src/tools/<name>.ts with xInput, xOutput, x(),
 * summarizeX() and registerX(server, config), then call registerX below.
 */
export function createServer(config: Config = loadConfig()): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // Stage 0
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
  registerListCached(server, config);

  // Stage 1
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

  // Stage 3 (analysis)
  registerGetScenes(server, config);
  registerAnalyzeAudio(server, config);
  registerDiffFrames(server, config);

  // Prompts
  registerPrompts(server);

  return server;
}
