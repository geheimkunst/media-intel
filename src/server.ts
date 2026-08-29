import { McpServer } from "@modelcontextprotocol/server";
import { loadConfig, type Config } from "./config.js";
import { toolErrorResult } from "./errors.js";
import { doctor, doctorInput, doctorOutput, summarizeDoctor } from "./tools/doctor.js";
import { probeMedia, probeMediaInput, probeMediaOutput, summarizeProbe } from "./tools/probe-media.js";
import { fetchMedia, fetchMediaInput, fetchMediaOutput, summarizeFetchMedia } from "./tools/fetch-media.js";
import { getEngagement, getEngagementInput, getEngagementOutput, summarizeGetEngagement } from "./tools/get-engagement.js";

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
    "fetch_media",
    {
      title: "Fetch media",
      description:
        "Download a video, audio, or metadata from a platform page URL via yt-dlp. " +
        "Supports selective downloads (video, audio, subtitles, thumbnail), quality selection, " +
        "time-window cutting, subtitle language choice, and caching. " +
        "Platform pages (YouTube, etc.) must go through this tool first; local files can go directly to probe_media.",
      inputSchema: fetchMediaInput,
      outputSchema: fetchMediaOutput,
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await fetchMedia(config, args);
        return { content: [{ type: "text", text: summarizeFetchMedia(result) }], structuredContent: result };
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  server.registerTool(
    "get_engagement",
    {
      title: "Get engagement",
      description:
        "Extract engagement metrics from a video URL without downloading it: view count, likes, comments, chapters, " +
        "heatmap (most replayed sections), SponsorBlock categories, and optionally top comments. " +
        "Uses yt-dlp to read metadata only; does not download media.",
      inputSchema: getEngagementInput,
      outputSchema: getEngagementOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await getEngagement(config, args);
        return { content: [{ type: "text", text: summarizeGetEngagement(result) }], structuredContent: result };
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );

  return server;
}
