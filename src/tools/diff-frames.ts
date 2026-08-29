import type { McpServer } from "@modelcontextprotocol/server";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import sharp from "sharp";
import * as z from "zod/v4";
import type { Config } from "../config.js";
import { commonOutput, round3 } from "../contracts.js";
import { MediaIntelError, toolErrorResult } from "../errors.js";
import { extractFrame, ffprobe, parseNumber } from "../ffmpeg.js";
import { resolveSource } from "../source.js";

export const diffFramesInput = z.object({
  source: z.string().min(1).describe("Local video path, file:// URL, or direct http(s) URL."),
  from_s: z.number().nonnegative().describe("First timestamp in seconds."),
  to_s: z.number().nonnegative().describe("Second timestamp in seconds."),
  threshold: z.number().min(0).max(1).optional().describe("Per-pixel sensitivity 0..1 (pixelmatch). Default 0.1; lower = more sensitive."),
  max_width: z.number().int().min(0).max(4096).optional().describe("Downscale both frames to this width before comparing. Default 1280, 0 = original."),
  return: z.enum(["regions", "image", "both"]).optional().describe("What to return. Default 'both': change rectangles plus a diff image (changed pixels in red on a faded frame)."),
  max_regions: z.number().int().min(1).max(200).optional().describe("Cap on returned change rectangles. Default 20."),
});

const region = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number(), changed_pixels: z.number(), share: z.number() });

export const diffFramesOutput = z.object({
  source: z.string(),
  from_s: z.number(),
  to_s: z.number(),
  width: z.number(),
  height: z.number(),
  changed_pixels: z.number(),
  changed_ratio: z.number(),
  verdict: z.enum(["identical", "minor", "moderate", "major"]),
  regions: z.array(region),
  diff_image: z.object({ bytes: z.number(), format: z.literal("png") }).optional(),
  ...commonOutput,
});

export type DiffFramesInput = z.infer<typeof diffFramesInput>;
export type DiffFramesResult = z.infer<typeof diffFramesOutput>;

interface Box { x0: number; y0: number; x1: number; y1: number; count: number }

/** Connected-ish components over a coarse grid of changed pixels (cheap, good enough for UI diffs). */
function findRegions(mask: Uint8Array, width: number, height: number, cell = 16): Box[] {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const counts = new Uint32Array(cols * rows);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x]) {
        const ci = Math.floor(y / cell) * cols + Math.floor(x / cell);
        counts[ci] = (counts[ci] ?? 0) + 1;
      }
    }
  }
  const active = counts.map((c) => (c >= Math.max(4, (cell * cell) / 32) ? 1 : 0));
  const seen = new Uint8Array(cols * rows);
  const boxes: Box[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const idx = r * cols + c;
      if (!active[idx] || seen[idx]) continue;
      const stack = [idx];
      seen[idx] = 1;
      const box: Box = { x0: c, y0: r, x1: c, y1: r, count: 0 };
      while (stack.length > 0) {
        const cur = stack.pop() as number;
        const cr = Math.floor(cur / cols);
        const cc = cur % cols;
        box.x0 = Math.min(box.x0, cc); box.x1 = Math.max(box.x1, cc);
        box.y0 = Math.min(box.y0, cr); box.y1 = Math.max(box.y1, cr);
        box.count += counts[cur] ?? 0;
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const) {
          const nr = cr + dr;
          const nc = cc + dc;
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
          const n = nr * cols + nc;
          if (active[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
        }
      }
      boxes.push({ x0: box.x0 * cell, y0: box.y0 * cell, x1: Math.min(width, (box.x1 + 1) * cell), y1: Math.min(height, (box.y1 + 1) * cell), count: box.count });
    }
  }
  return boxes.sort((a, b) => b.count - a.count);
}

async function framePng(config: Config, location: string, tS: number, width: number): Promise<PNG> {
  const buf = await extractFrame(config, location, tS, { format: "png", ...(width > 0 ? { width } : {}) });
  return PNG.sync.read(buf);
}

export async function diffFrames(config: Config, input: DiffFramesInput): Promise<{ result: DiffFramesResult; image: Buffer | undefined }> {
  const resolved = await resolveSource(input.source);
  const probe = await ffprobe(config, resolved.location);
  const duration = parseNumber(probe.format?.duration);
  if (duration !== undefined && (input.from_s > duration || input.to_s > duration)) {
    throw new MediaIntelError("timestamp_out_of_range", `Timestamps must be within 0..${round3(duration)}s`);
  }
  const width = input.max_width ?? 1280;
  const [a, b] = await Promise.all([framePng(config, resolved.location, input.from_s, width), framePng(config, resolved.location, input.to_s, width)]);
  if (a.width !== b.width || a.height !== b.height) throw new MediaIntelError("frame_mismatch", "Frames differ in size; the video changes resolution");

  const diff = new PNG({ width: a.width, height: a.height });
  const changed = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: input.threshold ?? 0.1, includeAA: false, alpha: 0.35, diffColor: [255, 0, 0] });
  const total = a.width * a.height;
  const ratio = total > 0 ? changed / total : 0;

  // Build a mask from the diff image (red pixels) for region detection.
  const mask = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    const o = i * 4;
    if (diff.data[o] === 255 && diff.data[o + 1] === 0 && diff.data[o + 2] === 0) mask[i] = 1;
  }
  const maxRegions = input.max_regions ?? 20;
  const boxes = findRegions(mask, a.width, a.height);
  const regions = boxes.slice(0, maxRegions).map((bx) => ({
    x: bx.x0, y: bx.y0, width: bx.x1 - bx.x0, height: bx.y1 - bx.y0,
    changed_pixels: bx.count,
    share: round3(changed > 0 ? bx.count / changed : 0),
  }));

  const verdict = ratio === 0 ? "identical" : ratio < 0.01 ? "minor" : ratio < 0.15 ? "moderate" : "major";
  const want = input.return ?? "both";
  const warnings: string[] = [];
  if (boxes.length > maxRegions) warnings.push(`${boxes.length} change regions; returning the ${maxRegions} largest.`);

  let image: Buffer | undefined;
  if (want !== "regions") {
    image = PNG.sync.write(diff);
    // Re-encode through sharp to shrink (palette PNG is enough for a diff overlay).
    image = await sharp(image).png({ compressionLevel: 9, palette: true }).toBuffer();
  }

  const result: DiffFramesResult = {
    source: input.source,
    from_s: input.from_s,
    to_s: input.to_s,
    width: a.width,
    height: a.height,
    changed_pixels: changed,
    changed_ratio: round3(ratio),
    verdict,
    regions: want === "image" ? [] : regions,
    ...(image ? { diff_image: { bytes: image.length, format: "png" as const } } : {}),
    warnings,
    suggested_next: regions.length > 0 ? ["extract_text with region=<largest region> at to_s", "get_frames at to_s (png)"] : ["get_scenes to find where change happens"],
  };
  return { result, image };
}

export function summarizeDiff(r: DiffFramesResult): string {
  const head = `${r.verdict}: ${r.changed_pixels} px changed (${Math.round(r.changed_ratio * 1000) / 10}%) between ${r.from_s}s and ${r.to_s}s at ${r.width}x${r.height}`;
  const regs = r.regions.slice(0, 10).map((g, i) => `#${i + 1} x=${g.x} y=${g.y} ${g.width}x${g.height} (${Math.round(g.share * 100)}%)`).join("; ");
  const warn = r.warnings.length > 0 ? `\nWarnings:\n- ${r.warnings.join("\n- ")}` : "";
  return `${head}${regs ? `\nRegions: ${regs}` : ""}${warn}`;
}

export function registerDiffFrames(server: McpServer, config: Config): void {
  server.registerTool(
    "diff_frames",
    {
      title: "Diff frames",
      description:
        "What changed on screen between two timestamps: changed-pixel ratio, a verdict (identical/minor/moderate/major), " +
        "the rectangles where change happened (largest first, in frame pixel coordinates), and a diff image with changes in red. " +
        "Built for screen recordings and bug repros: find the moment something appeared, then extract_text on that region.",
      inputSchema: diffFramesInput,
      outputSchema: diffFramesOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { result, image } = await diffFrames(config, args);
        return {
          content: [
            { type: "text", text: summarizeDiff(result) },
            ...(image ? [{ type: "image" as const, data: image.toString("base64"), mimeType: "image/png" }] : []),
          ],
          structuredContent: result,
        };
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );
}
