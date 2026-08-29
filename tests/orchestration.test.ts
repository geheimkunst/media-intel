import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execa } from "execa";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { loadConfig, type Config } from "../src/config.js";
import { createServer } from "../src/server.js";
import { analyzeMoment } from "../src/tools/analyze-moment.js";
import { understandMedia } from "../src/tools/understand-media.js";
import { closeIndex, searchIndex } from "../src/search.js";

const fixtures = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");
let scratch: string;
let config: Config;
let cutClip: string;

/**
 * A fake whisper-cli that writes the real whisper.cpp JSON shape
 * ({ result: { language }, transcription: [...] }) so the chain resolves
 * locally without the 550 MB model and without API keys.
 */
async function fakeWhisper(dir: string): Promise<{ bin: string; model: string }> {
  const bin = join(dir, "whisper-cli");
  const model = join(dir, "model.bin");
  await writeFile(model, "x");
  await writeFile(
    bin,
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const of = args[args.indexOf("-of") + 1];
if (args.includes("-dl")) { process.stderr.write("whisper_full_with_state: auto-detected language: de (p = 0.970000)\\n"); process.exit(0); }
const json = { result: { language: "de" }, transcription: [
  { timestamps: { from: "00:00:00,000", to: "00:00:01,500" }, offsets: { from: 0, to: 1500 }, text: " Hallo Welt, das ist ein Test." },
  { timestamps: { from: "00:00:01,500", to: "00:00:02,900" }, offsets: { from: 1500, to: 2900 }, text: " Zweiter Satz mit Termin am Montag." }
] };
fs.writeFileSync(of + ".json", JSON.stringify(json));
process.stderr.write("whisper_full_with_state: auto-detected language: de (p = 0.970000)\\n");
`,
  );
  await chmod(bin, 0o755);
  return { bin, model };
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "media-intel-orch-"));
  const fw = await fakeWhisper(scratch);
  config = { ...loadConfig(), cacheDir: join(scratch, "cache"), whisperBin: fw.bin, whisperModel: fw.model };
  cutClip = join(scratch, "cut.mp4");
  await execa("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=2",
    "-f", "lavfi", "-i", "smptebars=size=320x240:rate=10:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-filter_complex", "[0][1]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", cutClip]);
});

afterAll(async () => {
  closeIndex();
  await rm(scratch, { recursive: true, force: true });
});

describe("understand_media", () => {
  it("runs transcript-first and skips grids when the transcript is rich enough", async () => {
    const { result, images } = await understandMedia(config, { source: cutClip, max_grids: 2 });
    expect(result.kind).toBe("video");
    expect(result.transcript?.transcription_source).toBe("whisper_cpp");
    expect(result.transcript?.language).toBe("de");
    expect(result.transcript?.text.source_trust).toBe("untrusted");
    expect(result.scenes?.cut_count).toBeGreaterThanOrEqual(1);
    // Fake transcript is short (< 800 chars) so auto mode adds visuals.
    expect(result.grids?.count).toBeGreaterThanOrEqual(1);
    expect(images.length).toBe(result.grids?.count);
    expect(result.decisions.some((d) => d.startsWith("transcript via whisper_cpp"))).toBe(true);
    expect(result.budget.used_chars).toBeGreaterThan(0);
  });

  it("honors visual=never and indexes the transcript for media_search", async () => {
    const { result, images } = await understandMedia(config, { source: cutClip, visual: "never" });
    expect(result.grids).toBeUndefined();
    expect(images).toEqual([]);
    const hits = await searchIndex(config, "termin montag");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.origin.endsWith("cut.mp4")).toBe(true);
  });

  it("rejects images with a hint", async () => {
    await expect(understandMedia(config, { source: join(fixtures, "red.png") })).rejects.toMatchObject({ code: "not_time_based" });
  });
});

describe("analyze_moment", () => {
  it("returns a burst of frames, the transcript around t, and OCR on request", async () => {
    const { result, images } = await analyzeMoment(config, { source: cutClip, t_s: 2, span_s: 1, burst: 3, ocr: true });
    expect(result.frames.length).toBe(3);
    expect(images.length).toBe(3);
    expect(result.window).toEqual({ start_s: 1.5, end_s: 2.5 });
    expect(result.transcript?.segments.length).toBe(2);
    expect(result.transcript?.text.source_trust).toBe("untrusted");
    expect(result.ocr).toBeDefined();
    expect(result.manifest.length).toBe(3);
  });

  it("rejects timestamps beyond the duration", async () => {
    await expect(analyzeMoment(config, { source: cutClip, t_s: 99 })).rejects.toMatchObject({ code: "timestamp_out_of_range" });
  });
});

describe("full server surface", () => {
  it("lists all 17 tools and calls understand_media over MCP with image blocks", async () => {
    const server = createServer(config);
    const client = new Client({ name: "c", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "analyze_audio", "analyze_moment", "detect_language", "diff_frames", "doctor", "extract_text", "fetch_media",
      "get_engagement", "get_frames", "get_scenes", "get_transcript", "get_video_grids", "list_cached", "media_search",
      "probe_image", "probe_media", "understand_media",
    ]);
    const r = await client.callTool({ name: "understand_media", arguments: { source: cutClip, visual: "always", max_grids: 1 } });
    expect(r.isError).toBeFalsy();
    expect(r.content.some((c) => c.type === "image")).toBe(true);
    const sc = r.structuredContent as { decisions: string[]; grids?: { count: number } };
    expect(sc.grids?.count).toBe(1);
    await client.close();
    await server.close();
  });
});
