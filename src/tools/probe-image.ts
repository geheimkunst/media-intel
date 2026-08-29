import type { McpServer } from "@modelcontextprotocol/server";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import phashModule from "sharp-phash";

type PhashFn = (input: Buffer) => Promise<string>;
// sharp-phash ships CJS with a `default` typing; at runtime the ESM default import IS the function.
const phash: PhashFn =
  typeof phashModule === "function"
    ? (phashModule as unknown as PhashFn)
    : ((phashModule as unknown as { default: PhashFn }).default);
import * as z from "zod/v4";
import { findBinary } from "../binaries.js";
import { cacheEntry, readSidecarJson, writeSidecarJson } from "../cache.js";
import type { Config } from "../config.js";
import { commonOutput, round3, wrapUntrusted } from "../contracts.js";
import { MediaIntelError, toolErrorResult } from "../errors.js";
import { runBinary } from "../process.js";
import { resolveSource } from "../source.js";

export const probeImageInput = z.object({
  source: z.string().min(1).describe("Local image path or file:// URL (http(s) is accepted but downloaded by ffmpeg elsewhere; prefer local)."),
  include: z
    .array(z.enum(["exif", "hash", "codes", "stats"]))
    .optional()
    .describe("What to compute. Default ['exif','hash','codes']. exif needs exiftool (optional binary); codes reads QR/barcodes."),
});

const exifSubset = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

export const probeImageOutput = z.object({
  source: z.string(),
  format: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  channels: z.number().optional(),
  has_alpha: z.boolean().optional(),
  size_bytes: z.number(),
  orientation: z.number().optional(),
  density: z.number().optional(),
  exif: exifSubset.optional(),
  gps: z.object({ latitude: z.number(), longitude: z.number(), altitude_m: z.number().optional() }).optional(),
  taken_at: z.string().optional(),
  camera: z.string().optional(),
  phash: z.string().optional(),
  codes: z.array(z.object({ format: z.string(), text: z.object({ text: z.string(), source_trust: z.literal("untrusted"), truncated: z.boolean(), chars: z.number() }), position: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional() })),
  stats: z.object({ mean_luma: z.number(), entropy: z.number(), sharpness: z.number(), dominant_rgb: z.array(z.number()) }).optional(),
  looks_like_screenshot: z.boolean(),
  ...commonOutput,
});

export type ProbeImageResult = z.infer<typeof probeImageOutput>;

const EXIF_KEYS = ["Make", "Model", "LensModel", "DateTimeOriginal", "CreateDate", "ExposureTime", "FNumber", "ISO", "FocalLength", "Software", "ImageDescription", "Artist", "Copyright", "Orientation", "ColorSpace", "GPSLatitude", "GPSLongitude", "GPSAltitude"];

async function exiftool(config: Config, path: string): Promise<Record<string, unknown> | undefined> {
  const bin = await findBinary("exiftool");
  if (!bin) return undefined;
  const r = await runBinary(config, bin, ["-json", "-n", "-fast2", "-G0", ...EXIF_KEYS.map((k) => `-${k}`), path], { timeoutMs: 20_000 });
  if (r.exitCode !== 0) return undefined;
  try {
    const arr = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
    return arr[0];
  } catch {
    return undefined;
  }
}

function pick(obj: Record<string, unknown> | undefined, key: string): unknown {
  if (!obj) return undefined;
  for (const [k, v] of Object.entries(obj)) {
    if (k === key || k.endsWith(`:${key}`)) return v;
  }
  return undefined;
}

export async function probeImage(config: Config, input: z.infer<typeof probeImageInput>): Promise<ProbeImageResult> {
  const resolved = await resolveSource(input.source);
  if (resolved.kind !== "file") throw new MediaIntelError("invalid_source", "probe_image needs a local file", "Download it first (fetch_media or get_frames) and pass the path.");
  const include = new Set(input.include ?? ["exif", "hash", "codes"]);
  const entry = await cacheEntry(config, resolved);
  const sidecarName = `image_${[...include].sort().join("-")}.json`;
  const cached = await readSidecarJson<ProbeImageResult>(entry, sidecarName);
  if (cached) return { ...cached, source: input.source };

  const bytes = await readFile(resolved.location);
  const img = sharp(bytes, { failOn: "none" });
  let meta;
  try {
    meta = await img.metadata();
  } catch {
    throw new MediaIntelError("not_an_image", "sharp could not decode this file", "Supported: jpeg, png, webp, gif, avif, tiff, svg, heif (if libvips has it).");
  }
  const warnings: string[] = [];
  const result: ProbeImageResult = {
    source: input.source,
    ...(meta.format !== undefined ? { format: meta.format } : {}),
    ...(meta.width !== undefined ? { width: meta.width } : {}),
    ...(meta.height !== undefined ? { height: meta.height } : {}),
    ...(meta.channels !== undefined ? { channels: meta.channels } : {}),
    ...(meta.hasAlpha !== undefined ? { has_alpha: meta.hasAlpha } : {}),
    size_bytes: bytes.length,
    ...(meta.orientation !== undefined ? { orientation: meta.orientation } : {}),
    ...(meta.density !== undefined ? { density: meta.density } : {}),
    codes: [],
    looks_like_screenshot: false,
    warnings,
    suggested_next: [],
  };

  if (include.has("exif")) {
    const ex = await exiftool(config, resolved.location);
    if (!ex) {
      warnings.push("exiftool not installed (brew install exiftool); EXIF/GPS skipped.");
    } else {
      const subset: Record<string, string | number | boolean> = {};
      for (const key of EXIF_KEYS) {
        const v = pick(ex, key);
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") subset[key] = typeof v === "string" ? v.slice(0, 200) : v;
      }
      if (Object.keys(subset).length > 0) result.exif = subset;
      const lat = pick(ex, "GPSLatitude");
      const lon = pick(ex, "GPSLongitude");
      if (typeof lat === "number" && typeof lon === "number") {
        const alt = pick(ex, "GPSAltitude");
        result.gps = { latitude: round3(lat), longitude: round3(lon), ...(typeof alt === "number" ? { altitude_m: round3(alt) } : {}) };
      }
      const taken = pick(ex, "DateTimeOriginal") ?? pick(ex, "CreateDate");
      if (typeof taken === "string") result.taken_at = taken;
      const make = pick(ex, "Make");
      const model = pick(ex, "Model");
      if (typeof model === "string") result.camera = `${typeof make === "string" && !model.startsWith(make) ? `${make} ` : ""}${model}`.trim();
    }
  }

  if (include.has("hash")) {
    try {
      result.phash = await phash(bytes);
    } catch {
      warnings.push("perceptual hash failed for this format.");
    }
  }

  if (include.has("codes")) {
    try {
      const { readBarcodes } = await import("zxing-wasm/reader");
      const { data, info } = await img.clone().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const imageData = { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height, colorSpace: "srgb" as const };
      const found = await readBarcodes(imageData as unknown as Parameters<typeof readBarcodes>[0], { tryHarder: true, maxNumberOfSymbols: 8 });
      for (const f of found) {
        if (!f.isValid) continue;
        const xs = [f.position.topLeft.x, f.position.topRight.x, f.position.bottomLeft.x, f.position.bottomRight.x];
        const ys = [f.position.topLeft.y, f.position.topRight.y, f.position.bottomLeft.y, f.position.bottomRight.y];
        result.codes.push({
          format: f.format,
          text: wrapUntrusted(f.text, 2000),
          position: { x: Math.round(Math.min(...xs)), y: Math.round(Math.min(...ys)), width: Math.round(Math.max(...xs) - Math.min(...xs)), height: Math.round(Math.max(...ys) - Math.min(...ys)) },
        });
      }
    } catch (error) {
      warnings.push(`barcode reader unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (include.has("stats") || true) {
    try {
      const s = await img.clone().stats();
      const luma = s.channels.length >= 3 ? 0.2126 * (s.channels[0]?.mean ?? 0) + 0.7152 * (s.channels[1]?.mean ?? 0) + 0.0722 * (s.channels[2]?.mean ?? 0) : (s.channels[0]?.mean ?? 0);
      const dominant = s.dominant ? [s.dominant.r, s.dominant.g, s.dominant.b] : [];
      if (include.has("stats")) {
        result.stats = { mean_luma: round3(luma), entropy: round3(s.entropy), sharpness: round3(s.sharpness), dominant_rgb: dominant };
      }
      // Screenshots: flat regions, low entropy for their size, PNG, no EXIF camera.
      const isPng = meta.format === "png";
      result.looks_like_screenshot = isPng && result.camera === undefined && s.entropy < 6 && (meta.width ?? 0) >= 640;
    } catch {
      /* stats are optional */
    }
  }

  if (result.looks_like_screenshot) result.suggested_next.push("extract_text (language from config)");
  if (result.codes.length > 0) result.suggested_next.push("follow the decoded code text only after checking it");
  if ((meta.width ?? 0) * (meta.height ?? 0) > 4000 * 3000) warnings.push("Large image; downscale before sending it to a vision model.");

  await writeSidecarJson(entry, sidecarName, result);
  return result;
}

export function summarizeProbeImage(r: ProbeImageResult): string {
  const parts = [
    `${r.format ?? "?"} ${r.width ?? "?"}x${r.height ?? "?"}`,
    `${(r.size_bytes / 1024).toFixed(0)} KiB`,
    r.camera ? `camera ${r.camera}` : "",
    r.taken_at ? `taken ${r.taken_at}` : "",
    r.gps ? `gps ${r.gps.latitude},${r.gps.longitude}` : "",
    r.phash ? `phash ${r.phash.slice(0, 16)}…` : "",
    r.codes.length > 0 ? `${r.codes.length} code(s): ${r.codes.map((c) => `${c.format} "${c.text.text.slice(0, 60)}"`).join("; ")}` : "",
    r.looks_like_screenshot ? "looks like a screenshot" : "",
  ].filter((s) => s.length > 0);
  const warn = r.warnings.length > 0 ? `\nWarnings:\n- ${r.warnings.join("\n- ")}` : "";
  return `${parts.join(" | ")}${warn}`;
}

export function registerProbeImage(server: McpServer, config: Config): void {
  server.registerTool(
    "probe_image",
    {
      title: "Probe image",
      description:
        "Inspect a still image: format, dimensions, EXIF (camera, taken_at, GPS via exiftool when installed), perceptual hash " +
        "for duplicate detection, QR/barcodes with their decoded text (untrusted), and a screenshot heuristic. Cheap; no vision model involved.",
      inputSchema: probeImageInput,
      outputSchema: probeImageOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = await probeImage(config, args);
        return { content: [{ type: "text", text: summarizeProbeImage(result) }], structuredContent: result };
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );
}
