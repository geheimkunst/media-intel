import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config.js";
import { MediaIntelError } from "../src/errors.js";
import { formatBytes, formatDuration, probeMedia, probeMediaOutput, summarizeProbe } from "../src/tools/probe-media.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const config = loadConfig();

describe("probe_media on fixtures", () => {
  it("classifies an mp4 with audio as video and reads geometry", async () => {
    const r = await probeMedia(config, { source: join(fixtures, "clip.mp4") });
    expect(r.kind).toBe("video");
    expect(r.source_kind).toBe("file");
    expect(r.container).toContain("mp4");
    expect(r.duration_s).toBeCloseTo(3, 0);
    expect(r.video?.width).toBe(320);
    expect(r.video?.height).toBe(240);
    expect(r.video?.fps).toBe(10);
    expect(r.video?.codec).toBe("h264");
    expect(r.audio?.codec).toBe("aac");
    expect(r.stream_counts).toEqual({ video: 1, audio: 1, subtitle: 0, other: 0 });
    expect(r.tags.title).toBe("Fixture Clip");
    expect(r.size_bytes).toBeGreaterThan(1000);
    expect(r.suggested_next).toEqual(["get_transcript", "get_video_grids", "get_frames"]);
    expect(r.warnings).toEqual([]);
    expect(() => probeMediaOutput.parse(r)).not.toThrow();
  });

  it("classifies a wav as audio", async () => {
    const r = await probeMedia(config, { source: join(fixtures, "tone.wav") });
    expect(r.kind).toBe("audio");
    expect(r.video).toBeUndefined();
    expect(r.audio?.sample_rate).toBe(16000);
    expect(r.audio?.channels).toBe(1);
    expect(r.duration_s).toBeCloseTo(2, 1);
    expect(r.suggested_next).toEqual(["get_transcript"]);
  });

  it("classifies a png as image", async () => {
    const r = await probeMedia(config, { source: join(fixtures, "red.png") });
    expect(r.kind).toBe("image");
    expect(r.video?.width).toBe(64);
    expect(r.video?.height).toBe(48);
    expect(r.video?.frame_count).toBeUndefined();
    expect(r.audio).toBeUndefined();
    expect(r.suggested_next).toEqual(["extract_text", "get_frames"]);
  });

  it("accepts relative paths and file:// URLs", async () => {
    const abs = join(fixtures, "red.png");
    const viaFileUrl = await probeMedia(config, { source: `file://${abs}` });
    expect(viaFileUrl.kind).toBe("image");
  });

  it("raises a hinted error for a missing file", async () => {
    await expect(probeMedia(config, { source: join(fixtures, "nope.mp4") })).rejects.toMatchObject({
      name: "MediaIntelError",
      code: "source_not_found",
    });
  });

  it("raises ffprobe_failed for a non-media file", async () => {
    const self = fileURLToPath(import.meta.url);
    const error = await probeMedia(config, { source: self }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MediaIntelError);
    expect((error as MediaIntelError).code).toBe("ffprobe_failed");
  });

  it("raises ffprobe_missing when the binary is not on PATH", async () => {
    const broken = { ...config, ffprobeBin: "/nonexistent/ffprobe-xyz" };
    const error = await probeMedia(broken, { source: join(fixtures, "red.png") }).catch((e: unknown) => e);
    expect((error as MediaIntelError).code).toBe("ffprobe_missing");
  });
});

describe("formatting helpers", () => {
  it("formats durations", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(3725)).toBe("1:02:05");
  });

  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(15 * 1024 ** 2)).toBe("15 MiB");
  });

  it("summarizes a probe result on one line plus warnings", async () => {
    const r = await probeMedia(config, { source: join(fixtures, "clip.mp4") });
    const text = summarizeProbe(r);
    expect(text).toContain("video");
    expect(text).toContain("320x240@10fps h264");
    expect(text).toContain("Suggested next: get_transcript");
  });
});
