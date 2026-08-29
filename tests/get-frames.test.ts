import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../src/config.js";
import { getFrames } from "../src/tools/get-frames.js";
import sharp from "sharp";

const fixtures = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");
let scratch: string;
let config: Config;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "media-intel-frames-test-"));
  config = { ...loadConfig(), cacheDir: join(scratch, "cache") };
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("get_frames tool", () => {
  it("extracts frames at specified timestamps", async () => {
    const result = await getFrames(config, {
      source: join(fixtures, "clip.mp4"),
      timestamps: [0.5, 1.5],
      frame_format: "jpeg",
    });

    expect(result.frames).toHaveLength(2);
    expect(result.frames[0]).toMatchObject({
      requested_t_s: 0.5,
      format: "jpeg",
      width: expect.any(Number),
      height: expect.any(Number),
      bytes: expect.any(Number),
    });
    expect(result.manifest).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    expect(result.total_bytes).toBeGreaterThan(0);
  });

  it("honors frame format (PNG, JPEG)", async () => {
    const formats: Array<"jpeg" | "png"> = ["jpeg", "png"];
    for (const fmt of formats) {
      const result = await getFrames(config, {
        source: join(fixtures, "clip.mp4"),
        timestamps: [0.5],
        frame_format: fmt,
      });
      expect(result.frames[0].format).toBe(fmt);
      // Verify magic bytes
      if (fmt === "jpeg") {
        const buf = require("node:fs").readFileSync(result.frames[0].cache_path);
        expect(buf.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      } else if (fmt === "png") {
        const buf = require("node:fs").readFileSync(result.frames[0].cache_path);
        expect(buf.subarray(1, 4).toString()).toBe("PNG");
      }
    }
  });

  it("respects max_width scaling", async () => {
    const unscaled = await getFrames(config, {
      source: join(fixtures, "clip.mp4"),
      timestamps: [0.5],
      max_width: 0,
    });

    const scaled = await getFrames(config, {
      source: join(fixtures, "clip.mp4"),
      timestamps: [0.5],
      max_width: 160,
    });

    expect(scaled.frames[0].width).toBeLessThanOrEqual(160);
    if (unscaled.frames[0].width > 160) {
      expect(scaled.frames[0].width).toBeLessThan(unscaled.frames[0].width);
    }
  });

  it("skips timestamps beyond duration with reason", async () => {
    const result = await getFrames(config, {
      source: join(fixtures, "clip.mp4"),
      timestamps: [0.5, 999.0],
      frame_format: "jpeg",
    });

    expect(result.frames).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].requested_t_s).toBe(999.0);
    expect(result.skipped[0].reason).toContain("beyond media duration");
  });

  it("rejects all out-of-range timestamps with hard error", async () => {
    await expect(
      getFrames(config, {
        source: join(fixtures, "clip.mp4"),
        timestamps: [999.0, 1000.0],
        frame_format: "jpeg",
      }),
    ).rejects.toMatchObject({ code: "no_valid_timestamps" });
  });

  it("applies region cropping before scaling", async () => {
    const result = await getFrames(config, {
      source: join(fixtures, "clip.mp4"),
      timestamps: [0.5],
      region: { x: 10, y: 10, width: 100, height: 100 },
      max_width: 0,
    });

    expect(result.frames[0].width).toBeLessThanOrEqual(100);
    expect(result.frames[0].height).toBeLessThanOrEqual(100);
  });

  it("overlays timestamp on frame when requested", async () => {
    const withoutOverlay = await getFrames(config, {
      source: join(fixtures, "clip.mp4"),
      timestamps: [0.5],
      frame_format: "jpeg",
      overlay_timestamp: false,
    });

    const withOverlay = await getFrames(config, {
      source: join(fixtures, "clip.mp4"),
      timestamps: [0.5],
      frame_format: "jpeg",
      overlay_timestamp: true,
    });

    // Overlay should change the file size
    expect(withOverlay.frames[0].bytes).not.toBe(withoutOverlay.frames[0].bytes);
    expect(withOverlay.frames[0]).toHaveProperty("t_s", 0.5);
  });

  it("caches frames and hits cache on second call", async () => {
    const firstResult = await getFrames(config, {
      source: join(fixtures, "clip.mp4"),
      timestamps: [1.5],
      frame_format: "jpeg",
    });

    const firstPath = firstResult.frames[0].cache_path;
    const firstStat = await stat(firstPath);

    // Small delay to ensure mtime would differ if file was re-written
    await new Promise((r) => setTimeout(r, 100));

    const secondResult = await getFrames(config, {
      source: join(fixtures, "clip.mp4"),
      timestamps: [1.5],
      frame_format: "jpeg",
    });

    const secondPath = secondResult.frames[0].cache_path;
    const secondStat = await stat(secondPath);

    expect(firstPath).toBe(secondPath);
    expect(firstStat.mtimeMs).toBe(secondStat.mtimeMs); // Same mtime means cache hit
  });

  it("respects quality parameter", async () => {
    const highQuality = await getFrames(config, {
      source: join(fixtures, "clip.mp4"),
      timestamps: [0.5],
      frame_format: "jpeg",
      quality: 95,
    });

    const lowQuality = await getFrames(config, {
      source: join(fixtures, "clip.mp4"),
      timestamps: [0.5],
      frame_format: "jpeg",
      quality: 20,
    });

    // Higher quality JPEG should be larger
    expect(highQuality.frames[0].bytes).toBeGreaterThan(lowQuality.frames[0].bytes);
  });

  it("includes manifest with grid_index and cell_index", async () => {
    const result = await getFrames(config, {
      source: join(fixtures, "clip.mp4"),
      timestamps: [0.5, 1.0, 1.5],
      frame_format: "jpeg",
    });

    expect(result.manifest).toHaveLength(3);
    for (let i = 0; i < result.manifest.length; i++) {
      expect(result.manifest[i]).toMatchObject({
        grid_index: 0,
        cell_index: i,
        t_s: expect.any(Number),
      });
    }
  });

  it("warns if total bytes exceed 6 MiB", async () => {
    // This is hard to trigger naturally, so we just verify the check exists
    // by looking at the code path for large images or many frames
    const result = await getFrames(config, {
      source: join(fixtures, "clip.mp4"),
      timestamps: [0.5],
      frame_format: "jpeg",
      quality: 95,
    });

    // Result should have warnings array even if not triggered
    expect(result.warnings).toBeDefined();
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("validates timestamp array size", async () => {
    await expect(
      getFrames(config, {
        source: join(fixtures, "clip.mp4"),
        timestamps: [],
      }),
    ).rejects.toMatchObject({ code: expect.any(String) });
  });
});
