import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { loadConfig, type Config } from "../src/config.js";
import { getScenes, registerGetScenes } from "../src/tools/get-scenes.js";
import { analyzeAudio, registerAnalyzeAudio } from "../src/tools/analyze-audio.js";
import { diffFrames, registerDiffFrames } from "../src/tools/diff-frames.js";
import { listCached, registerListCached } from "../src/tools/list-cached.js";

const fixtures = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");
let scratch: string;
let config: Config;
let cutClip: string;
let gapWav: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "media-intel-p2-"));
  config = { ...loadConfig(), cacheDir: join(scratch, "cache") };
  cutClip = join(scratch, "cut.mp4");
  await execa("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=2",
    "-f", "lavfi", "-i", "smptebars=size=320x240:rate=10:duration=2",
    "-f", "lavfi", "-i", "color=c=black:size=320x240:rate=10:duration=1",
    "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", cutClip]);
  gapWav = join(scratch, "gap.wav");
  await execa("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1,apad=pad_dur=1.5",
    "-f", "lavfi", "-i", "sine=frequency=880:duration=1",
    "-filter_complex", "[0][1]concat=n=2:v=0:a=1[a]", "-map", "[a]", "-ar", "16000", gapWav]);
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("get_scenes", () => {
  it("finds the cut, computes shots, hook and black interval", async () => {
    const r = await getScenes(config, { source: cutClip, include_keyframes: true });
    expect(r.cuts.length).toBeGreaterThanOrEqual(1);
    expect(r.cuts[0]?.t_s).toBeCloseTo(2, 0);
    expect(r.shots.length).toBe(r.cuts.length + 1);
    expect(r.metrics.cut_count).toBe(r.cuts.length);
    expect(r.hook.cut_count).toBeGreaterThanOrEqual(1);
    expect(r.hook.first_cut_s).toBeCloseTo(2, 0);
    expect(r.black.length).toBeGreaterThanOrEqual(1);
    expect(r.fallback_uniform).toBe(false);
    expect(r.keyframes?.[0]).toBe(0);
    expect(r.pagination.has_more).toBe(false);
  });
  it("falls back to uniform shots on a static clip and caches", async () => {
    const r = await getScenes(config, { source: join(fixtures, "clip.mp4") });
    expect(r.cuts).toEqual([]);
    expect(r.fallback_uniform).toBe(true);
    expect(r.shots.length).toBe(1);
    expect(r.warnings[0]).toContain("No scene changes");
    const again = await getScenes(config, { source: join(fixtures, "clip.mp4") });
    expect(again.shots).toEqual(r.shots);
  });
  it("rejects audio-only input with a hint", async () => {
    await expect(getScenes(config, { source: join(fixtures, "tone.wav") })).rejects.toMatchObject({ code: "no_video_stream" });
  });
});

describe("analyze_audio", () => {
  it("maps silence, speech segments and renders a waveform", async () => {
    const { result, images } = await analyzeAudio(config, { source: gapWav, silence_min_s: 0.3 });
    expect(result.silences.length).toBe(1);
    expect(result.silences[0]?.start_s).toBeCloseTo(1, 0);
    expect(result.speech_segments.length).toBe(2);
    expect(result.speech_ratio).toBeGreaterThan(0.4);
    expect(result.loudness.integrated_lufs).toBeTypeOf("number");
    expect(result.images[0]?.kind).toBe("waveform");
    expect(images[0]?.data.subarray(1, 4).toString()).toBe("PNG");
    expect(result.verdicts.length).toBeGreaterThan(0);
  });
  it("renders a spectrogram on request and rejects silent video", async () => {
    const { result } = await analyzeAudio(config, { source: gapWav, images: ["spectrogram"], image_width: 400 });
    expect(result.images[0]).toMatchObject({ kind: "spectrogram", width: 400 });
    await expect(analyzeAudio(config, { source: cutClip })).rejects.toMatchObject({ code: "no_audio_stream" });
  });
});

describe("diff_frames", () => {
  it("reports identical frames within a shot and major change across the cut", async () => {
    // testsrc animates a counter, smptebars (2 s..4 s) is static.
    const same = await diffFrames(config, { source: cutClip, from_s: 2.2, to_s: 2.8, return: "regions" });
    expect(same.result.verdict).toBe("identical");
    expect(same.image).toBeUndefined();
    const across = await diffFrames(config, { source: cutClip, from_s: 1.5, to_s: 2.5 });
    expect(across.result.verdict).toBe("major");
    expect(across.result.regions.length).toBeGreaterThan(0);
    expect(across.result.regions[0]?.width).toBeGreaterThan(0);
    expect(across.image?.subarray(1, 4).toString()).toBe("PNG");
    expect(across.result.diff_image?.bytes).toBe(across.image?.length);
  });
  it("rejects out-of-range timestamps", async () => {
    await expect(diffFrames(config, { source: cutClip, from_s: 0, to_s: 99 })).rejects.toMatchObject({ code: "timestamp_out_of_range" });
  });
});

describe("list_cached", () => {
  it("lists entries created by the other tools", async () => {
    const r = await listCached(config, { limit: 10 });
    expect(r.total_entries).toBeGreaterThanOrEqual(2);
    expect(r.entries[0]?.artifacts.length).toBeGreaterThan(0);
    expect(r.entries.some((e) => e.origin.endsWith("cut.mp4"))).toBe(true);
  });
});

describe("MCP round trip for phase 2 tools", () => {
  it("registers and calls each tool with structuredContent and image blocks", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerGetScenes(server, config);
    registerAnalyzeAudio(server, config);
    registerDiffFrames(server, config);
    registerListCached(server, config);
    const client = new Client({ name: "c", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["analyze_audio", "diff_frames", "get_scenes", "list_cached"]);

    const scenes = await client.callTool({ name: "get_scenes", arguments: { source: cutClip } });
    expect(scenes.isError).toBeFalsy();
    expect((scenes.structuredContent as { cuts: unknown[] }).cuts.length).toBeGreaterThan(0);

    const audio = await client.callTool({ name: "analyze_audio", arguments: { source: gapWav } });
    expect(audio.content.some((c) => c.type === "image")).toBe(true);

    const diff = await client.callTool({ name: "diff_frames", arguments: { source: cutClip, from_s: 1.5, to_s: 2.5 } });
    expect(diff.content.some((c) => c.type === "image")).toBe(true);

    const bad = await client.callTool({ name: "diff_frames", arguments: { source: "/nope.mp4", from_s: 0, to_s: 1 } });
    expect(bad.isError).toBe(true);
    await client.close();
    await server.close();
  });
});
