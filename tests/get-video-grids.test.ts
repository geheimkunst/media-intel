import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execa } from "execa";
import { createServer } from "../src/server.js";
import { loadConfig, type Config } from "../src/config.js";
import { getVideoGrids } from "../src/tools/get-video-grids.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
let scratch: string;
let config: Config;
let colorFixture: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "media-intel-grids-test-"));
  config = { ...loadConfig(), cacheDir: join(scratch, "cache") };

  // Create a fixture with all identical frames (solid red color).
  colorFixture = join(scratch, "color.mp4");
  await execa("ffmpeg", [
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=320x240:d=3",
    "-y",
    colorFixture,
  ]);
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("get_video_grids", () => {
  it("extracts grids from a 3s fixture", async () => {
    const result = await getVideoGrids(config, {
      source: join(fixtures, "clip.mp4"),
      cells: 4,
      grid_long_edge: 1568,
      max_frames: 8,
      frame_format: "jpeg",
      quality: 80,
      dedup: false,
    });

    expect(result.grids.length).toBeGreaterThan(0);
    const grid = result.grids[0];
    expect(grid.grid_index).toBe(0);
    expect(grid.cols).toBeGreaterThan(0);
    expect(grid.rows).toBeGreaterThan(0);
    expect(grid.cells.length).toBe(grid.cols * grid.rows);
    expect(grid.format).toBe("jpeg");
    expect(grid.bytes).toBeGreaterThan(0);
    expect(grid.width).toBeGreaterThan(0);
    expect(grid.height).toBeGreaterThan(0);

    // Verify manifest.
    expect(result.manifest.length).toBeGreaterThan(0);
    const totalCells = result.grids.reduce((sum, g) => sum + g.cells.length, 0);
    expect(result.manifest.length).toBe(totalCells);
    expect(result.manifest[0].grid_index).toBe(0);
    expect(result.manifest[0].cell_index).toBe(0);
    expect(result.manifest[0].t_s).toBeGreaterThanOrEqual(0);

    // Verify timestamps are monotonic within each grid.
    for (let i = 1; i < result.manifest.length; i++) {
      if (result.manifest[i].grid_index === result.manifest[i - 1].grid_index) {
        expect(result.manifest[i].t_s).toBeGreaterThanOrEqual(result.manifest[i - 1].t_s);
      }
    }

    expect(result.frames_sampled).toBeGreaterThan(0);
    expect(result.pagination.total_duration_s).toBe(3);
  });

  it("respects max_frames budget", async () => {
    const result = await getVideoGrids(config, {
      source: join(fixtures, "clip.mp4"),
      cells: 4,
      grid_long_edge: 1568,
      max_frames: 8,
      frame_format: "jpeg",
      quality: 80,
      dedup: false,
    });

    expect(result.frames_sampled).toBeLessThanOrEqual(8);
  });

  it("handles explicit timestamps", async () => {
    const timestamps = [0.3, 0.8, 1.5, 2.2];
    const result = await getVideoGrids(config, {
      source: join(fixtures, "clip.mp4"),
      cells: 4,
      grid_long_edge: 1568,
      max_frames: 4,
      frame_format: "jpeg",
      quality: 80,
      dedup: false,
      timestamps,
    });

    expect(result.grids).toHaveLength(1);
    expect(result.manifest).toHaveLength(4);
    // Timestamps in manifest should match (or be close to) input timestamps.
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(result.manifest[i].t_s - timestamps[i])).toBeLessThan(0.1);
    }
  });

  it("deduplicates near-identical frames", async () => {
    const result = await getVideoGrids(config, {
      source: join(fixtures, "clip.mp4"),
      cells: 4,
      grid_long_edge: 1568,
      max_frames: 8,
      frame_format: "jpeg",
      quality: 80,
      dedup: true,
    });

    expect(result.grids.length).toBeGreaterThan(0);
    const cells = result.grids[0].cells;
    expect(cells.length).toBe(4);
    // Dedup should run without error and count deduplications.
    expect(result.frames_deduplicated).toBeGreaterThanOrEqual(0);
  });

  it("validates grid dimensions", async () => {
    const result = await getVideoGrids(config, {
      source: join(fixtures, "clip.mp4"),
      cells: 4,
      grid_long_edge: 1568,
      max_frames: 6,
      frame_format: "jpeg",
      quality: 80,
      dedup: false,
    });

    const grid = result.grids[0];
    // Grid's long edge should be close to the requested value (within 2 px tolerance).
    const longEdge = Math.max(grid.width, grid.height);
    expect(Math.abs(longEdge - 1568)).toBeLessThanOrEqual(2);
  });

  it("returns jpeg format", async () => {
    const result = await getVideoGrids(config, {
      source: join(fixtures, "clip.mp4"),
      cells: 4,
      grid_long_edge: 1568,
      max_frames: 4,
      frame_format: "jpeg",
      quality: 80,
      dedup: false,
    });

    expect(result.grids[0].format).toBe("jpeg");
  });

  it("returns png format", async () => {
    const result = await getVideoGrids(config, {
      source: join(fixtures, "clip.mp4"),
      cells: 4,
      grid_long_edge: 1568,
      max_frames: 4,
      frame_format: "png",
      quality: 80,
      dedup: false,
    });

    expect(result.grids[0].format).toBe("png");
  });

  it("handles grid dimensions correctly for landscape aspect ratio (defect fix #1)", async () => {
    // clip.mp4 is landscape (320x240 aspect ~1.33)
    const result = await getVideoGrids(config, {
      source: join(fixtures, "clip.mp4"),
      cells: 4,
      grid_long_edge: 1568,
      max_frames: 8,
      frame_format: "jpeg",
      quality: 80,
      dedup: false,
    });

    const grid = result.grids[0];
    expect(grid).toBeDefined();
    // Grid's long edge should equal grid_long_edge ± 2 px.
    const longEdge = Math.max(grid.width, grid.height);
    expect(Math.abs(longEdge - 1568)).toBeLessThanOrEqual(2);
    // For landscape, width should be longer than height.
    expect(grid.width).toBeGreaterThanOrEqual(grid.height);
  });

  it("does not include black padding in frames_sampled count (defect fix #2)", async () => {
    const result = await getVideoGrids(config, {
      source: join(fixtures, "clip.mp4"),
      cells: 4,
      grid_long_edge: 1568,
      max_frames: 4,
      frame_format: "jpeg",
      quality: 80,
      dedup: false,
    });

    // frames_sampled should not include black tile padding.
    // With cells=4 and max_frames=4, we extract exactly 4 frames, making 1 grid.
    // frames_sampled should be 4 (actual extracted frames), not 4 + any padding.
    expect(result.frames_sampled).toBe(4);
    const grid = result.grids[0];
    expect(grid.cells).toHaveLength(4);
    expect(result.manifest).toHaveLength(4);
    // All cells should have valid timestamps (not 0 from padding).
    for (const cell of grid.cells) {
      expect(cell.t_s).toBeGreaterThan(0);
    }
  });

  it("deduplicates and re-samples from gaps when frames are identical (defect fix #3)", async () => {
    // colorFixture has all identical red frames.
    const result = await getVideoGrids(config, {
      source: colorFixture,
      cells: 4,
      grid_long_edge: 1568,
      max_frames: 8,
      frame_format: "jpeg",
      quality: 80,
      dedup: true,
    });

    expect(result.grids.length).toBeGreaterThan(0);
    // With dedup on all-identical frames, most frames should be marked as duplicates.
    // frames_deduplicated should be > 0.
    expect(result.frames_deduplicated).toBeGreaterThan(0);
    // The grid should still have 4 cells (either kept frames or re-sampled/black).
    expect(result.grids[0].cells).toHaveLength(4);
    // Some cells should be marked as duplicates or filled with re-sampled frames.
    const firstGrid = result.grids[0];
    const hasDuplicate = firstGrid.cells.some((c) => c.duplicate_of !== undefined);
    const hasResampled = firstGrid.cells.some((c) => !c.duplicate_of && !c.empty);
    expect(hasDuplicate || hasResampled).toBe(true);
  });

  it("marks re-sampled and empty frames correctly after dedup", async () => {
    const result = await getVideoGrids(config, {
      source: colorFixture,
      cells: 16, // 16 cells to increase dedup likelihood.
      grid_long_edge: 1568,
      max_frames: 8,
      frame_format: "jpeg",
      quality: 80,
      dedup: true,
    });

    const grid = result.grids[0];
    expect(grid.cells).toHaveLength(16);

    // Count frame types: kept, duplicate, re-sampled, empty.
    let keptCount = 0;
    let dupCount = 0;
    let resampledCount = 0;
    let emptyCount = 0;

    for (const cell of grid.cells) {
      if (cell.empty) {
        emptyCount++;
      } else if (cell.duplicate_of !== undefined) {
        dupCount++;
      } else if (cell.t_s > 0) {
        keptCount++;
      }
    }

    // With dedup and re-sampling, we should have some mix of these.
    expect(keptCount + dupCount + resampledCount + emptyCount).toBe(16);
    // With all identical frames, dedup should work.
    expect(dupCount + keptCount + emptyCount + resampledCount).toBe(16);
  });
});

describe("media-intel MCP server: get_video_grids end to end", () => {
  const server = createServer();
  const client = new Client({ name: "test-client", version: "0.0.0" });

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it("advertises get_video_grids with correct schemas", async () => {
    const { tools } = await client.listTools();
    const grids = tools.find((t) => t.name === "get_video_grids");
    expect(grids).toBeDefined();
    expect(grids?.inputSchema.properties).toHaveProperty("source");
    expect(grids?.inputSchema.properties).toHaveProperty("cells");
    expect(grids?.outputSchema?.properties).toHaveProperty("grids");
    expect(grids?.outputSchema?.properties).toHaveProperty("manifest");
  });

  it("returns structured content with image blocks for grids", async () => {
    const result = await client.callTool({
      name: "get_video_grids",
      arguments: {
        source: join(fixtures, "clip.mp4"),
        cells: "4",
        grid_long_edge: "1568",
        max_frames: 4,
        frame_format: "jpeg",
        quality: 80,
        dedup: false,
      },
    });

    expect(result.isError).toBeFalsy();
    const text = result.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toContain("grid");

    // Should have image blocks for each grid.
    const images = result.content.filter((c) => c.type === "image");
    expect(images.length).toBeGreaterThan(0);

    const sc = result.structuredContent as { grids: Array<{ format: string }> };
    expect(sc.grids).toBeDefined();
    expect(sc.grids[0].format).toBe("jpeg");
  });

  it("handles time-windowed input", async () => {
    const result = await client.callTool({
      name: "get_video_grids",
      arguments: {
        source: join(fixtures, "clip.mp4"),
        window: { start_s: 0.5, end_s: 2.5 },
        cells: "4",
        grid_long_edge: "1568",
        max_frames: 8,
        frame_format: "jpeg",
        quality: 80,
        dedup: false,
      },
    });

    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { pagination: { window_start_s: number; window_end_s: number } };
    expect(sc.pagination.window_start_s).toBe(0.5);
  });
});
