import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { loadConfig, type Config } from "./config.js";
import { toolErrorResult } from "./errors.js";
import { doctor, doctorInput, doctorOutput, summarizeDoctor } from "./tools/doctor.js";
import { probeMedia, probeMediaInput, probeMediaOutput, summarizeProbe } from "./tools/probe-media.js";
import { getVideoGrids, getVideoGridsInput, getVideoGridsOutput, summarizeGetVideoGrids } from "./tools/get-video-grids.js";

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
    "get_video_grids",
    {
      title: "Get video grids",
      description:
        "Extract frames from a video at evenly-spaced timestamps and arrange them into contact sheets (grids). " +
        "Supports deduplication via pHash (removes near-identical frames), time-windowed processing for long videos, " +
        "and pagination. Output includes structured manifest (grid index, cell index, timestamp) so you can read times " +
        "from the manifest, not from pixels. Default: 64 cells, 1568 px long edge, JPEG at 80% quality, 512 frame budget. " +
        "64 cells per grid ≈ 1.9k tokens; use cells=16 for small grids to preserve on-screen text.",
      inputSchema: getVideoGridsInput,
      outputSchema: getVideoGridsOutput,
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await getVideoGrids(config, args);
        const imageBlocks = await Promise.all(
          result.grids.map(async (g) => {
            const buffer = await readFile(g.cache_path);
            return {
              type: "image" as const,
              data: buffer.toString("base64"),
              mimeType: `image/${g.format === "webp" ? "webp" : g.format === "png" ? "png" : "jpeg"}` as const,
            };
          }),
        );
        return {
          content: [{ type: "text", text: summarizeGetVideoGrids(result) }, ...imageBlocks],
          structuredContent: result,
        };
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  return server;
}
