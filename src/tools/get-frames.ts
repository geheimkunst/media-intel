import * as z from "zod/v4";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";
import { commonOutput, manifestEntry, round3, type ManifestEntry } from "../contracts.js";
import { MediaIntelError, toolErrorResult } from "../errors.js";
import { extractFrame, ffprobe, parseNumber, type FrameFormat } from "../ffmpeg.js";
import { resolveSource } from "../source.js";
import { cacheEntry, sidecarExists, writeSidecarBytes } from "../cache.js";
import { McpServer } from "@modelcontextprotocol/server";
import sharp from "sharp";

export const getFramesInput = z.object({
  source: z.string().min(1).describe("Absolute path to a local media file, or a direct http(s) URL to a media file."),
  timestamps: z
    .array(z.number().nonnegative())
    .min(1)
    .max(64)
    .describe("Frame timestamps in seconds."),
  frame_format: z
    .enum(["jpeg", "png", "webp"])
    .optional()
    .default("jpeg")
    .describe(
      "Output format. Use png for screen recordings and UI text where clarity is critical; jpeg is smaller; webp offers both. Default: jpeg.",
    ),
  max_width: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .default(1024)
    .describe("Scale to this width in pixels, keeping aspect ratio. 0 = original size. Default: 1024."),
  quality: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(85)
    .describe("JPEG/WebP quality 1..100. Default: 85."),
  region: z
    .object({
      x: z.number().int().nonnegative().describe("Left edge in source pixels."),
      y: z.number().int().nonnegative().describe("Top edge in source pixels."),
      width: z.number().int().positive().describe("Width in source pixels."),
      height: z.number().int().positive().describe("Height in source pixels."),
    })
    .optional()
    .describe("Optional crop region in source pixels, applied before scaling."),
  overlay_timestamp: z
    .boolean()
    .optional()
    .default(false)
    .describe("Overlay a timestamp label (mm:ss.mmm) on the frame (bottom-left, semi-transparent box)."),
});

export type GetFramesInput = z.infer<typeof getFramesInput>;

const frameData = z.object({
  t_s: z.number().nonnegative().describe("Actual frame timestamp in seconds."),
  requested_t_s: z.number().nonnegative().describe("Timestamp that was requested."),
  width: z.number().int().positive().describe("Actual frame width in pixels."),
  height: z.number().int().positive().describe("Actual frame height in pixels."),
  bytes: z.number().int().positive().describe("Frame file size in bytes."),
  format: z.enum(["jpeg", "png", "webp"]).describe("Frame format."),
  cache_path: z.string().describe("Cache entry path for this frame."),
});

export type FrameData = z.infer<typeof frameData>;

const skippedFrame = z.object({
  requested_t_s: z.number().nonnegative(),
  reason: z.string(),
});

export type SkippedFrame = z.infer<typeof skippedFrame>;

export const getFramesOutput = z.object({
  source: z.string(),
  frames: z.array(frameData),
  manifest: z.array(manifestEntry),
  skipped: z.array(skippedFrame),
  total_bytes: z.number().int().nonnegative(),
  ...commonOutput,
});

export type GetFramesResult = z.infer<typeof getFramesOutput>;

/** Format a timestamp as mm:ss.mmm for overlay. */
function formatTimestamp(seconds: number): string {
  const abs = Math.max(0, seconds);
  const mins = Math.floor(abs / 60);
  const secs = abs % 60;
  const mm = String(mins).padStart(2, "0");
  const ss = String(Math.floor(secs)).padStart(2, "0");
  const mmm = String(Math.round((secs % 1) * 1000)).padStart(3, "0");
  return `${mm}:${ss}.${mmm}`;
}

/**
 * Create a sidecar file name from frame extraction parameters.
 * Includes the timestamp (in milliseconds), scaling width, format, quality, overlay flag, and region hash if present.
 */
function sidecarName(
  t_ms: number,
  width: number,
  format: FrameFormat,
  quality: number,
  overlay: boolean,
  region?: { x: number; y: number; width: number; height: number },
): string {
  const regionHash = region
    ? createHash("sha256")
        .update(`${region.x}:${region.y}:${region.width}:${region.height}`)
        .digest("hex")
        .slice(0, 8)
    : "noregion";
  const overlay_flag = overlay ? "ov" : "no";
  const ext = format === "jpeg" ? "jpg" : format;
  return `frame_${t_ms}_w${width}_${format}_q${quality}_${overlay_flag}_${regionHash}.${ext}`;
}

/**
 * Overlay a timestamp label on a frame using sharp.
 * Draws mm:ss.mmm in white text on a semi-transparent black box, bottom-left.
 */
async function overlayTimestamp(buffer: Buffer, t_s: number): Promise<Buffer> {
  const timestamp = formatTimestamp(t_s);

  // Create a simple SVG overlay with timestamp text and semi-transparent background
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="180" height="40">
      <rect x="0" y="0" width="180" height="40" fill="black" fill-opacity="0.6" />
      <text x="8" y="28" font-family="monospace" font-size="18" font-weight="bold" fill="white">${timestamp}</text>
    </svg>
  `.trim();

  const image = sharp(buffer);
  const meta = await image.metadata();
  if (!meta.width || !meta.height) throw new Error("Could not determine frame dimensions");

  // Composite the SVG at the bottom-left with padding
  const overlayBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return image
    .composite([
      {
        input: overlayBuffer,
        left: 10,
        top: meta.height - 40 - 10,
        blend: "over",
      },
    ])
    .toBuffer();
}

/**
 * Simple concurrent limiter: runs tasks with at most `maxConcurrent` at a time.
 */
async function runConcurrently<T>(tasks: (() => Promise<T>)[], maxConcurrent: number): Promise<T[]> {
  const results: (T | undefined)[] = Array(tasks.length);
  const executing: Promise<void>[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const index = i;
    const task = tasks[index];
    if (task === undefined) continue;

    const p = (async () => {
      results[index] = await task();
    })().then(() => {
      const idx = executing.indexOf(p);
      if (idx >= 0) executing.splice(idx, 1);
    });

    executing.push(p);

    if (executing.length >= maxConcurrent) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results.filter((x): x is T => x !== undefined);
}

/**
 * Extract frames at given timestamps, with caching, optional cropping, scaling, and overlay.
 */
export async function getFrames(config: Config, input: GetFramesInput): Promise<GetFramesResult> {
  const resolved = await resolveSource(input.source);
  const probe = await ffprobe(config, resolved.location);
  const duration = parseNumber(probe.format?.duration);

  const warnings: string[] = [];
  const suggested: string[] = [];
  const frames: FrameData[] = [];
  const skipped: SkippedFrame[] = [];
  const manifest: ManifestEntry[] = [];

  // Validate timestamps and reject those beyond duration
  const validTimestamps: number[] = [];
  for (const ts of input.timestamps) {
    if (duration !== undefined && ts > duration + 0.001) {
      skipped.push({
        requested_t_s: ts,
        reason: `Timestamp ${ts}s is beyond media duration ${duration}s`,
      });
    } else {
      validTimestamps.push(ts);
    }
  }

  if (validTimestamps.length === 0) {
    throw new MediaIntelError(
      "no_valid_timestamps",
      "All requested timestamps are beyond the media duration",
      "Check the duration with probe_media and request timestamps within the file.",
    );
  }

  // Get cache entry
  const cache = await cacheEntry(config, resolved);

  // Extract frames concurrently (max 4)
  type ExtractedFrame = { buffer: Buffer; frameEntry: FrameData };
  const extractionTasks = validTimestamps.map((ts) => {
    return async (): Promise<ExtractedFrame> => {
      const sidecarFileName = sidecarName(Math.round(ts * 1000), input.max_width, input.frame_format, input.quality, input.overlay_timestamp, input.region);
      const cacheHit = await sidecarExists(cache, sidecarFileName);

      let buffer: Buffer;
      if (cacheHit) {
        // Read from cache
        buffer = await readFile(join(cache.dir, sidecarFileName));
      } else {
        // Extract the frame
        buffer = await extractFrame(config, resolved.location, ts, {
          format: input.frame_format,
          ...(input.max_width > 0 ? { width: input.max_width } : {}),
          ...(input.region !== undefined ? { crop: input.region } : {}),
          quality: input.quality,
        });

        // Apply overlay if requested
        if (input.overlay_timestamp) {
          buffer = await overlayTimestamp(buffer, ts);
        }

        // Cache the result
        await writeSidecarBytes(cache, sidecarFileName, buffer);
      }

      // Get frame dimensions
      const meta = await sharp(buffer).metadata();
      if (!meta.width || !meta.height) throw new Error(`Could not determine dimensions for frame at ${ts}s`);

      const frameEntry: FrameData = {
        t_s: round3(ts),
        requested_t_s: ts,
        width: meta.width,
        height: meta.height,
        bytes: buffer.length,
        format: input.frame_format,
        cache_path: join(cache.dir, sidecarFileName),
      };
      return { buffer, frameEntry };
    };
  });

  const extractedFrames = await runConcurrently(extractionTasks, 4);

  // Organize frames in timestamp order
  let totalBytes = 0;
  for (let i = 0; i < extractedFrames.length; i++) {
    const item = extractedFrames[i];
    if (item !== undefined) {
      const { buffer, frameEntry } = item;
      frames.push(frameEntry);
      totalBytes += buffer.length;
      manifest.push({
        grid_index: 0,
        cell_index: i,
        t_s: frameEntry.t_s,
      });
    }
  }

  // Warn if total bytes exceed 6 MiB
  const MAX_INLINE_BYTES = 6 * 1024 * 1024;
  if (totalBytes > MAX_INLINE_BYTES) {
    warnings.push(
      `Total frame size is ${(totalBytes / 1024 / 1024).toFixed(1)} MiB, exceeds the 6 MiB inline suggestion. ` +
        `Lower max_width or quality, or reduce the number of frames.`,
    );
  }

  if (input.overlay_timestamp) {
    suggested.push("Timestamps are in the manifest, not read off pixels; overlay is for preview only.");
  }

  if (skipped.length > 0) {
    suggested.push("Some timestamps were skipped; see the skipped array for reasons.");
  }

  const result: GetFramesResult = {
    source: input.source,
    frames,
    manifest,
    skipped,
    total_bytes: totalBytes,
    warnings,
    suggested_next: suggested,
  };

  return result;
}

/** Compact summary for the human-readable content block. */
export function summarizeGetFrames(r: GetFramesResult): string {
  const parts: string[] = [`${r.frames.length} frames extracted`];
  const first = r.frames[0];
  if (first !== undefined) {
    parts.push(`${first.width}x${first.height} ${first.format}`);
  }
  parts.push(`${(r.total_bytes / 1024).toFixed(1)} KiB total`);
  if (r.skipped.length > 0) parts.push(`${r.skipped.length} skipped`);
  const line = parts.join(" | ");
  const warn = r.warnings.length > 0 ? `\nWarnings:\n- ${r.warnings.join("\n- ")}` : "";
  const next = r.suggested_next.length > 0 ? `\nSuggested next: ${r.suggested_next.join(", ")}` : "";
  return `${line}${warn}${next}`;
}

/** Register the tool with the MCP server. */
export function registerGetFrames(server: McpServer, config: Config): void {
  server.registerTool(
    "get_frames",
    {
      title: "Get frames",
      description:
        "Extract image frames at specified timestamps from video or media. Each frame is cached and returned with dimensions. " +
        "Timestamps are provided in the manifest; do not read times off pixels. Supports optional region cropping, " +
        "scaling, format selection (jpeg/png/webp), and timestamp overlay (for preview; the real data is in the manifest).",
      inputSchema: getFramesInput,
      outputSchema: getFramesOutput,
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await getFrames(config, args);
        // Build content blocks: text summary + one image block per frame
        const content: any[] = [{ type: "text", text: summarizeGetFrames(result) }];

        // Add image blocks for each frame (base64, mimeType)
        for (const frame of result.frames) {
          const frameBuffer = await readFile(frame.cache_path);
          const base64 = frameBuffer.toString("base64");
          const mimeType = frame.format === "jpeg" ? "image/jpeg" : frame.format === "png" ? "image/png" : "image/webp";
          content.push({
            type: "image",
            data: base64,
            mimeType,
          });
        }

        return { content, structuredContent: result };
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );
}
