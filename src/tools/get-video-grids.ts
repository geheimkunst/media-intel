import phashModule from "sharp-phash";
import sharp from "sharp";

const phash = (phashModule as unknown) as (buffer: Buffer) => Promise<string>;
import * as z from "zod/v4";
import type { Config } from "../config.js";
import { commonOutput, defaultFrameBudget, manifestEntry, pagination, resolveWindow, round3, sampleTimestamps, type ManifestEntry, windowInput } from "../contracts.js";
import { MediaIntelError } from "../errors.js";
import { extractFrame, type FrameFormat, ffprobe, parseNumber } from "../ffmpeg.js";
import { resolveSource } from "../source.js";
import { cacheEntry, writeSidecarBytes } from "../cache.js";

export const getVideoGridsInput = z.object({
  source: z.string().min(1).describe("Absolute path to a local video file, or a direct http(s) URL."),
  window: windowInput.optional().describe("Time window to process. Omit for the whole file (subject to budget)."),
  cells: z.enum(["4", "9", "16", "25", "36", "64"]).default("64").transform(Number).describe("Contact sheet grid size (cells). Default 64."),
  grid_long_edge: z.enum(["1568", "2576"]).default("1568").transform(Number).describe("Pixel width of the grid's longer edge. Default 1568."),
  max_frames: z.number().int().min(1).max(2048).default(512).describe("Maximum frames to extract. Default 512."),
  frame_format: z.enum(["jpeg", "png", "webp"]).default("jpeg").describe("Frame encoding format. Default jpeg."),
  quality: z.number().int().min(1).max(100).default(80).describe("JPEG/WebP quality. Default 80."),
  dedup: z.boolean().default(true).describe("Remove near-identical frames (pHash hamming <= 6). Default true."),
  timestamps: z.array(z.number().nonnegative()).optional().describe("Explicit frame timestamps (seconds). When given, sample exactly these instead of the heuristic."),
});

export type GetVideoGridsInput = z.infer<typeof getVideoGridsInput>;

const cellSpec = z.object({
  cell_index: z.number().int().nonnegative(),
  t_s: z.number().nonnegative(),
  duplicate_of: z.number().int().nonnegative(),
  empty: z.boolean(),
}).partial({ duplicate_of: true, empty: true });

const gridSpec = z.object({
  grid_index: z.number().int().nonnegative(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().positive(),
  format: z.enum(["jpeg", "png", "webp"]),
  cache_path: z.string(),
  cells: z.array(cellSpec),
});

export const getVideoGridsOutput = z.object({
  source: z.string(),
  grids: z.array(gridSpec),
  manifest: z.array(manifestEntry),
  frames_sampled: z.number().int().nonnegative(),
  frames_deduplicated: z.number().int().nonnegative(),
  total_bytes: z.number().int().nonnegative(),
  pagination,
  ...commonOutput,
});

export type GetVideoGridsResult = z.infer<typeof getVideoGridsOutput>;

interface FrameData {
  buffer: Buffer;
  t_s: number;
  hash: string | undefined;
}

interface CellInfo {
  cell_index: number;
  t_s: number;
  duplicate_of: number | undefined;
  empty: boolean | undefined;
}

/**
 * Tier-3 tool: extract frames at sampled timestamps, deduplicate via pHash,
 * and compose into contact sheets. Returns one or more grids plus a manifest
 * mapping cell indices to timestamps.
 */
export async function getVideoGrids(config: Config, input: GetVideoGridsInput): Promise<GetVideoGridsResult> {
  const resolved = await resolveSource(input.source);
  const probe = await ffprobe(config, resolved.location);
  const format = probe.format;
  const streams = probe.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === "video");

  if (!videoStream) {
    throw new MediaIntelError("no_video_stream", "No video stream found in the media file.");
  }

  const durationS = parseNumber(format?.duration) ?? parseNumber(videoStream.duration);
  if (durationS === undefined) {
    throw new MediaIntelError("unknown_duration", "Container reports no duration; grids require a known duration.");
  }

  const width = videoStream.width ?? 320;
  const height = videoStream.height ?? 240;
  const aspectRatio = width / height;

  // Resolve window and pagination.
  const windowed = resolveWindow(input.window, durationS, durationS);
  const windowSpanS = windowed.end_s - windowed.start_s;

  // Calculate frames_total = min(max_frames, max(cells, defaultFrameBudget(windowSpan))), rounded UP to a multiple of cells.
  const defaultBudget = defaultFrameBudget(windowSpanS);
  const framesBeforeRounding = Math.max(input.cells, Math.min(input.max_frames, defaultBudget));
  const framesTotal = Math.ceil(framesBeforeRounding / input.cells) * input.cells;

  // Determine pagination: if framesTotal/cells > 8, keep 8 grids and paginate.
  const gridsCount = Math.ceil(framesTotal / input.cells);
  const hasMoreGrids = gridsCount > 8;
  const actualGridsCount = hasMoreGrids ? 8 : gridsCount;
  const framesInWindow = actualGridsCount * input.cells;

  // If we're paginating, split the window.
  let paginatedEnd = windowed.end_s;
  if (hasMoreGrids) {
    const fractionUsed = framesInWindow / framesTotal;
    paginatedEnd = windowed.start_s + (windowed.end_s - windowed.start_s) * fractionUsed;
  }

  // Sample timestamps.
  const rawTimestamps = input.timestamps ?? sampleTimestamps(windowed.start_s, paginatedEnd, framesInWindow);
  const timestamps = rawTimestamps.slice(0, framesInWindow);

  // Compute tile dimensions based on aspect ratio.
  // For landscape (aspectRatio >= 1): grid's long edge = tileWidth * cols, so tileWidth = grid_long_edge / cols.
  // For portrait (aspectRatio < 1): grid's long edge = tileHeight * rows, so tileHeight = grid_long_edge / rows.
  const cols = Math.sqrt(input.cells);
  const rows = Math.sqrt(input.cells);
  let tileWidth: number;
  let tileHeight: number;
  if (aspectRatio >= 1) {
    // Landscape: compute width-first.
    tileWidth = Math.floor(input.grid_long_edge / cols);
    tileHeight = Math.floor(tileWidth / aspectRatio);
  } else {
    // Portrait: compute height-first.
    tileHeight = Math.floor(input.grid_long_edge / rows);
    tileWidth = Math.floor(tileHeight * aspectRatio);
  }

  // Extract frames concurrently (4 at a time).
  const frameDataList: FrameData[] = [];
  const batchSize = 4;
  for (let i = 0; i < timestamps.length; i += batchSize) {
    const batch = timestamps.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (t_s) => {
        try {
          const buffer = await extractFrame(config, resolved.location, t_s, {
            format: input.frame_format,
            width: tileWidth,
            quality: input.quality,
          });
          return { buffer, t_s, hash: undefined };
        } catch (error) {
          throw new MediaIntelError("frame_extraction_failed", `Failed to extract frame at ${t_s}s`, String(error));
        }
      }),
    );
    frameDataList.push(...results);
  }

  // Save frame count before padding.
  const extractedFrameCount = frameDataList.length;

  // Deduplication with pHash.
  let dedupCount = 0;
  const cellData: CellInfo[] = [];
  if (input.dedup) {
    // Compute pHash for each frame.
    const hashes = await Promise.all(frameDataList.map(async (f) => phash(f.buffer)));
    frameDataList.forEach((f, i) => {
      f.hash = hashes[i];
    });

    // Track kept frames and mark duplicates.
    const keptIndices = new Set<number>();
    const duplicateOf = new Map<number, number>();

    for (let i = 0; i < frameDataList.length; i++) {
      let isDuplicate = false;
      const frame = frameDataList[i];
      if (!frame) continue;
      const frameHash = frame.hash;
      // Check against previously kept frames.
      for (const keptIdx of keptIndices) {
        const keptFrame = frameDataList[keptIdx];
        if (!keptFrame) continue;
        const keptHash = keptFrame.hash;
        if (frameHash !== undefined && keptHash !== undefined) {
          const distance = hammingDistance(frameHash, keptHash);
          if (distance <= 6) {
            duplicateOf.set(i, keptIdx);
            isDuplicate = true;
            dedupCount++;
            break;
          }
        }
      }
      if (!isDuplicate) {
        keptIndices.add(i);
      }
    }

    // Build cellData with duplicates marked.
    for (let i = 0; i < frameDataList.length; i++) {
      const frame = frameDataList[i];
      if (!frame) continue;
      const dupOf = duplicateOf.get(i);
      const cell: CellInfo = {
        cell_index: i,
        t_s: round3(frame.t_s),
        duplicate_of: dupOf,
        empty: undefined,
      };
      cellData.push(cell);
    }

    // If we have fewer kept frames than cells, try one round of re-sampling from largest gaps.
    if (keptIndices.size < input.cells && keptIndices.size > 0) {
      const sortedKeptIndices = Array.from(keptIndices).sort((a, b) => a - b);
      const gaps: { start_idx: number; end_idx: number; gap_size: number }[] = [];

      // Identify gaps between kept frames.
      for (let i = 0; i < sortedKeptIndices.length - 1; i++) {
        const start = sortedKeptIndices[i];
        const end = sortedKeptIndices[i + 1];
        if (start !== undefined && end !== undefined) {
          const gap = end - start - 1;
          if (gap > 0) {
            gaps.push({ start_idx: start, end_idx: end, gap_size: gap });
          }
        }
      }

      // Also consider gap before first and after last kept frame.
      const firstKept = sortedKeptIndices[0];
      const lastKept = sortedKeptIndices[sortedKeptIndices.length - 1];
      if (firstKept !== undefined && firstKept !== 0) {
        gaps.push({ start_idx: -1, end_idx: firstKept, gap_size: firstKept });
      }
      if (lastKept !== undefined && lastKept !== frameDataList.length - 1) {
        gaps.push({
          start_idx: lastKept,
          end_idx: frameDataList.length,
          gap_size: frameDataList.length - lastKept - 1,
        });
      }

      // Sort gaps by size (largest first) and re-sample from largest gaps.
      gaps.sort((a, b) => b.gap_size - a.gap_size);
      let resampled = 0;
      for (const gap of gaps) {
        if (frameDataList.length >= input.cells || resampled >= 1) break; // At most one replacement round.
        // Re-sample one frame from this gap.
        const frameAfterGap = frameDataList[gap.start_idx + 1];
        const frameAtEnd = frameDataList[gap.end_idx];
        const startT = frameAfterGap?.t_s ?? windowed.start_s;
        const endT = frameAtEnd?.t_s ?? windowed.end_s;
        const midT = (startT + endT) / 2;
        if (midT >= windowed.start_s && midT <= windowed.end_s) {
          try {
            const buffer = await extractFrame(config, resolved.location, midT, {
              format: input.frame_format,
              width: tileWidth,
              quality: input.quality,
            });
            frameDataList.push({ buffer, t_s: midT, hash: undefined });
            cellData.push({
              cell_index: frameDataList.length - 1,
              t_s: round3(midT),
              duplicate_of: undefined,
              empty: undefined,
            });
            resampled++;
          } catch {
            // If re-sampling fails, continue to black tiles.
          }
        }
      }
    }

    // If still fewer frames than cells, fill trailing cells with black and mark empty.
    if (frameDataList.length < input.cells) {
      const blackTile = await sharp({ create: { width: tileWidth, height: tileHeight, channels: 3, background: "#000000" } }).toBuffer();
      for (let i = frameDataList.length; i < input.cells; i++) {
        frameDataList.push({ buffer: blackTile, t_s: 0, hash: undefined });
        const cell: CellInfo = {
          cell_index: i,
          t_s: 0,
          duplicate_of: undefined,
          empty: true,
        };
        cellData.push(cell);
      }
    }
  } else {
    // No dedup: just build cellData as-is.
    for (let i = 0; i < frameDataList.length; i++) {
      const frame = frameDataList[i];
      if (!frame) continue;
      const cell: CellInfo = {
        cell_index: i,
        t_s: round3(frame.t_s),
        duplicate_of: undefined,
        empty: undefined,
      };
      cellData.push(cell);
    }
    if (frameDataList.length < input.cells) {
      const blackTile = await sharp({ create: { width: tileWidth, height: tileHeight, channels: 3, background: "#000000" } }).toBuffer();
      for (let i = frameDataList.length; i < input.cells; i++) {
        frameDataList.push({ buffer: blackTile, t_s: 0, hash: undefined });
        const cell: CellInfo = {
          cell_index: i,
          t_s: 0,
          duplicate_of: undefined,
          empty: true,
        };
        cellData.push(cell);
      }
    }
  }

  // Montage with sharp composite (tileWidth and tileHeight already computed above).

  const grids: GridSpec[] = [];
  const manifest: ManifestEntry[] = [];
  let totalBytes = 0;

  const gridCount = Math.ceil(frameDataList.length / input.cells);
  for (let gridIdx = 0; gridIdx < gridCount; gridIdx++) {
    const startIdx = gridIdx * input.cells;
    const endIdx = Math.min(startIdx + input.cells, frameDataList.length);
    const gridFrames = frameDataList.slice(startIdx, endIdx);

    // Pad to exact cells count if needed.
    while (gridFrames.length < input.cells) {
      const blackTile = await sharp({ create: { width: tileWidth, height: tileHeight, channels: 3, background: "#000000" } }).toBuffer();
      gridFrames.push({ buffer: blackTile, t_s: 0, hash: undefined });
    }

    // Compose grid.
    const width = tileWidth * cols;
    const height = tileHeight * rows;
    let composite = sharp({ create: { width, height, channels: 3, background: "#000000" } });

    for (let i = 0; i < gridFrames.length; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const left = col * tileWidth;
      const top = row * tileHeight;

      // Ensure frame is the right size.
      const gridFrame = gridFrames[i];
      if (!gridFrame) continue;
      let frameBuffer = gridFrame.buffer;
      const metadata = await sharp(frameBuffer).metadata();
      if ((metadata.width ?? 0) !== tileWidth || (metadata.height ?? 0) !== tileHeight) {
        frameBuffer = await sharp(frameBuffer).resize(tileWidth, tileHeight, { fit: "cover", withoutEnlargement: true }).toBuffer();
      }

      composite = composite.composite([{ input: frameBuffer, left, top }]);
    }

    // Encode grid.
    let encoded: Buffer;
    if (input.frame_format === "png") {
      encoded = await composite.png().toBuffer();
    } else if (input.frame_format === "webp") {
      encoded = await composite.webp({ quality: input.quality }).toBuffer();
    } else {
      encoded = await composite.jpeg({ quality: input.quality }).toBuffer();
    }

    // Cache the grid.
    const entry = await cacheEntry(config, resolved);
    const cacheName = `grid_${round3(windowed.start_s)}_${round3(paginatedEnd)}_${input.cells}_${input.grid_long_edge}_${input.frame_format}_${input.quality}_${input.dedup ? "dedup" : "nodup"}_${gridIdx}.${input.frame_format === "png" ? "png" : input.frame_format === "webp" ? "webp" : "jpg"}`;
    const cachePath = await writeSidecarBytes(entry, cacheName, encoded);

    totalBytes += encoded.byteLength;

    const gridCells = cellData.slice(startIdx, endIdx);
    grids.push({
      grid_index: gridIdx,
      cols,
      rows,
      width,
      height,
      bytes: encoded.byteLength,
      format: input.frame_format,
      cache_path: cachePath,
      cells: gridCells,
    });

    for (const cell of gridCells) {
      manifest.push({
        grid_index: gridIdx,
        cell_index: cell.cell_index,
        t_s: cell.t_s,
      });
    }
  }

  // Pagination for next window.
  const hasMore = hasMoreGrids;
  const nextWindow = hasMore ? { start_s: round3(paginatedEnd), end_s: round3(windowed.end_s) } : undefined;

  const warnings: string[] = [];
  const suggested: string[] = [];

  if (grids.length > 1) {
    warnings.push(`${grids.length} grids; 64 cells ≈ 1.9k tokens per grid on Claude. Use cells=16 for on-screen text.`);
  }

  return {
    source: input.source,
    grids,
    manifest,
    frames_sampled: extractedFrameCount,
    frames_deduplicated: dedupCount,
    total_bytes: totalBytes,
    pagination: {
      total_duration_s: round3(durationS),
      window_start_s: round3(windowed.start_s),
      window_end_s: round3(paginatedEnd),
      has_more: hasMore,
      ...(nextWindow ? { next_window: nextWindow } : {}),
    },
    warnings,
    suggested_next: suggested,
  };
}

interface GridSpec {
  grid_index: number;
  cols: number;
  rows: number;
  width: number;
  height: number;
  bytes: number;
  format: FrameFormat;
  cache_path: string;
  cells: CellInfo[];
}

function hammingDistance(hash1: string, hash2: string): number {
  if (hash1.length !== hash2.length) return 64;
  let distance = 0;
  for (let i = 0; i < hash1.length; i++) {
    if (hash1[i] !== hash2[i]) distance++;
  }
  return distance;
}

export function summarizeGetVideoGrids(r: GetVideoGridsResult): string {
  const cells = r.grids[0]?.cells.length || 0;
  const cols = r.grids[0]?.cols || 1;
  const timeSpan = r.pagination.window_end_s - r.pagination.window_start_s;
  const gridCount = r.grids.length;

  const line = `${gridCount} grid${gridCount > 1 ? "s" : ""} (${cells} cells, ${cols}×${cols}), ` +
    `${timeSpan}s span, ${r.frames_sampled} frames sampled, ${r.frames_deduplicated} deduplicated.`;

  const manifest = r.manifest.length > 0
    ? `\nManifest: To find a frame, read manifest entry [index] to get grid_index and cell_index (row-major from top-left). ` +
      `Grid [g], cell [c] = manifest entry with that grid and cell. Example: grid 0, cell 15 (row 3, col 3 in 4×4) shows frame at t_s from manifest.`
    : "";

  const content = `Read timestamps from the manifest entries below (manifest[i].t_s), never from pixels.\n\n${line}${manifest}`;

  const warnings = r.warnings.length > 0 ? `\nWarnings:\n- ${r.warnings.join("\n- ")}` : "";
  return content + warnings;
}
