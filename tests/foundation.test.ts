import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../src/config.js";
import { cacheEntry, cacheStats, fingerprint, readSidecarJson, sidecarPath, sweepCache, writeSidecarJson } from "../src/cache.js";
import { defaultFrameBudget, frameUntrusted, resolveWindow, sampleTimestamps, UNTRUSTED_BEGIN, UNTRUSTED_END, wrapUntrusted } from "../src/contracts.js";
import {
  analyzeAudio, analyzeVideo, extractFrame, keyframeTimestamps, parseAstats, parseBlackdetect, parseEbur128,
  parseFreezedetect, parseScdet, parseSilencedetect, qualityToMjpegQ, toWav16k,
} from "../src/ffmpeg.js";
import { redactSecrets } from "../src/process.js";
import { isPrivateAddress, resolveSource } from "../src/source.js";
import { doctor } from "../src/tools/doctor.js";
import { probeMedia } from "../src/tools/probe-media.js";
import { findBinary } from "../src/binaries.js";

const fixtures = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");
let scratch: string;
let config: Config;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "media-intel-test-"));
  config = { ...loadConfig(), cacheDir: join(scratch, "cache") };
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("contracts", () => {
  it("wraps and frames untrusted text with truncation", () => {
    const t = wrapUntrusted("a".repeat(50), 10);
    expect(t).toMatchObject({ source_trust: "untrusted", truncated: true, chars: 50 });
    expect(t.text).toHaveLength(10);
    const framed = frameUntrusted("Transcript", t);
    expect(framed).toContain(UNTRUSTED_BEGIN);
    expect(framed).toContain(UNTRUSTED_END);
    expect(framed).toContain("truncated to 10 of 50");
  });

  it("resolves windows with pagination", () => {
    const w = resolveWindow(undefined, 100, 30);
    expect(w).toMatchObject({ start_s: 0, end_s: 30 });
    expect(w.pagination).toMatchObject({ total_duration_s: 100, has_more: true, next_window: { start_s: 30, end_s: 60 } });
    const last = resolveWindow({ start_s: 90 }, 100, 30);
    expect(last.pagination.has_more).toBe(false);
    expect(last.pagination.next_window).toBeUndefined();
    const clipped = resolveWindow({ start_s: 10, end_s: 500 }, 100, 1000);
    expect(clipped.end_s).toBe(100);
  });

  it("frame budget and sampling", () => {
    expect(defaultFrameBudget(10)).toBe(30);
    expect(defaultFrameBudget(500)).toBe(80);
    expect(defaultFrameBudget(7200)).toBe(128);
    expect(sampleTimestamps(0, 10, 4)).toEqual([1.25, 3.75, 6.25, 8.75]);
    expect(sampleTimestamps(0, 0, 4)).toEqual([]);
  });
});

describe("ffmpeg parsers", () => {
  it("parses silencedetect", () => {
    const s = "[silencedetect @ 0x1] silence_start: 1\n[silencedetect @ 0x1] silence_end: 2.500062 | silence_duration: 1.500063\n";
    expect(parseSilencedetect(s)).toEqual([{ start_s: 1, end_s: 2.5, duration_s: 1.5 }]);
  });
  it("parses scdet, blackdetect, freezedetect", () => {
    expect(parseScdet("[Parsed_scdet_0 @ 0x1] lavfi.scd.score: 32.610, lavfi.scd.time: 2\n")).toEqual([{ t_s: 2, score: 32.61 }]);
    expect(parseBlackdetect("[blackdetect @ 0x1] black_start:10 black_end:15 black_duration:5\n")).toEqual([{ start_s: 10, end_s: 15, duration_s: 5 }]);
    const f = parseFreezedetect("[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 5\n[x] lavfi.freezedetect.freeze_duration: 3\n[x] lavfi.freezedetect.freeze_end: 8\n");
    expect(f).toEqual([{ start_s: 5, end_s: 8, duration_s: 3 }]);
  });
  it("parses ebur128 and astats summaries", () => {
    expect(parseEbur128("  I:         -21.8 LUFS\n  LRA:        20.0 LU\n  Peak:       -1.2 dBFS")).toEqual({ integrated_lufs: -21.8, loudness_range_lu: 20, true_peak_dbfs: -1.2 });
    const a = parseAstats("[Parsed_astats_2 @ 0x1] Overall\n[x] Peak level dB: -3.0\n[x] RMS level dB: -20.5\n[x] Noise floor dB: -60.1\n");
    expect(a).toEqual({ rms_level_db: -20.5, peak_level_db: -3, noise_floor_db: -60.1 });
  });
  it("maps quality to mjpeg q", () => {
    expect(qualityToMjpegQ(100)).toBe(2);
    expect(qualityToMjpegQ(1)).toBe(31);
  });
});

describe("ffmpeg on fixtures", () => {
  it("extracts a frame with -ss before -i and honors width/format", async () => {
    const jpeg = await extractFrame(config, join(fixtures, "clip.mp4"), 1.5, { width: 160 });
    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const png = await extractFrame(config, join(fixtures, "clip.mp4"), 0.5, { format: "png" });
    expect(png.subarray(1, 4).toString()).toBe("PNG");
  });
  it("analyzes audio in one pass", async () => {
    const a = await analyzeAudio(config, join(fixtures, "tone.wav"));
    expect(a.loudness.integrated_lufs).toBeTypeOf("number");
    expect(a.silences).toEqual([]);
  });
  it("analyzes video for cuts (testsrc has none)", async () => {
    const v = await analyzeVideo(config, join(fixtures, "clip.mp4"));
    expect(v.cuts).toEqual([]);
    expect(v.black).toEqual([]);
  });
  it("lists keyframes and transcodes to wav16k", async () => {
    const kf = await keyframeTimestamps(config, join(fixtures, "clip.mp4"));
    expect(kf.length).toBeGreaterThan(0);
    expect(kf[0]).toBe(0);
    const out = join(scratch, "a.wav");
    await toWav16k(config, join(fixtures, "clip.mp4"), out, { start_s: 0, end_s: 1 });
    expect((await stat(out)).size).toBeGreaterThan(1000);
  });
});

describe("source hardening", () => {
  it("classifies private addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "152.53.113.189"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
  it("rejects unknown schemes, credentials and private hosts", async () => {
    await expect(resolveSource("ftp://example.com/a.mp4")).rejects.toMatchObject({ code: "invalid_source" });
    await expect(resolveSource("http://user:pw@example.com/a.mp4")).rejects.toMatchObject({ code: "invalid_source" });
    await expect(resolveSource("http://127.0.0.1/a.mp4")).rejects.toMatchObject({ code: "source_private_host" });
    await expect(resolveSource("http://localhost/a.mp4")).rejects.toMatchObject({ code: "source_private_host" });
    await expect(resolveSource("http://169.254.169.254/latest/meta-data")).rejects.toMatchObject({ code: "source_private_host" });
  });
  it("accepts public URLs without DNS in tests and resolves symlinked files", async () => {
    const r = await resolveSource("https://example.com/a.mp4", { skipDns: true });
    expect(r).toMatchObject({ kind: "url", location: "https://example.com/a.mp4" });
    const f = await resolveSource(join(fixtures, "red.png"));
    expect(f.kind).toBe("file");
  });
});

describe("cache", () => {
  it("fingerprints files stably and URLs by string", async () => {
    const a = await fingerprint({ kind: "file", location: join(fixtures, "red.png"), sizeBytes: 158 });
    const b = await fingerprint({ kind: "file", location: join(fixtures, "red.png"), sizeBytes: 158 });
    const c = await fingerprint({ kind: "file", location: join(fixtures, "tone.wav"), sizeBytes: 1 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const u = await fingerprint({ kind: "url", location: "https://example.com/x.mp4", sizeBytes: undefined });
    expect(u).toMatch(/^[0-9a-f]{64}$/);
  });
  it("creates entries with meta, sidecars, and sweeps by ttl and size", async () => {
    const src = await resolveSource(join(fixtures, "clip.mp4"));
    const entry = await cacheEntry(config, src);
    expect((await stat(entry.dir)).mode & 0o777).toBe(0o700);
    await writeSidecarJson(entry, "probe.json", { ok: true });
    expect(await readSidecarJson<{ ok: boolean }>(entry, "probe.json")).toEqual({ ok: true });
    expect(() => sidecarPath(entry, "../evil")).toThrow();
    const stats = await cacheStats(config);
    expect(stats.entries).toBe(1);
    expect(stats.bytes).toBeGreaterThan(0);

    // Age the entry past the TTL and sweep.
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    await utimes(entry.dir, old, old);
    const swept = await sweepCache(config);
    expect(swept.removed).toBe(1);
    expect((await cacheStats(config)).entries).toBe(0);

    // Size cap: two entries, cap below their total, oldest goes first.
    const e1 = await cacheEntry(config, src);
    await writeFile(sidecarPath(e1, "big.bin"), Buffer.alloc(2000));
    const e2 = await cacheEntry(config, await resolveSource(join(fixtures, "tone.wav")));
    await writeFile(sidecarPath(e2, "big.bin"), Buffer.alloc(2000));
    const older = new Date(Date.now() - 1000 * 60);
    await utimes(e1.dir, older, older);
    const tight = { ...config, cacheMaxBytes: 3000 };
    const swept2 = await sweepCache(tight);
    expect(swept2.removed).toBe(1);
    expect((await cacheStats(config)).entries).toBe(1);
  });
});

describe("process helpers", () => {
  it("redacts secret-looking env values", () => {
    const env = { OPENAI_API_KEY: "sk-abcdefghijklmnop", HOME: "/Users/x" };
    expect(redactSecrets("key sk-abcdefghijklmnop leaked at /Users/x", env)).toBe("key *** leaked at /Users/x");
  });
  it("finds binaries on PATH and extra dirs", async () => {
    expect(await findBinary("ffprobe")).toMatch(/ffprobe$/);
    expect(await findBinary("definitely-not-a-binary-xyz")).toBeUndefined();
  });
});

describe("doctor and probe deep", () => {
  it("reports ffmpeg as found and scenes/audio capabilities ready", async () => {
    const d = await doctor(config);
    expect(d.binaries.find((b) => b.name === "ffmpeg")?.found).toBe(true);
    expect(d.ffmpeg_filters.scdet).toBe(true);
    expect(d.capabilities.find((c) => c.name === "probe_media")?.status).toBe("ready");
    expect(d.cache.dir).toBe(config.cacheDir);
  });
  it("probe deep adds an audio summary", async () => {
    const r = await probeMedia(config, { source: join(fixtures, "clip.mp4"), deep: true });
    expect(r.audio_deep).toBeDefined();
    expect(r.audio_deep?.silence_total_s).toBe(0);
    expect(r.audio_deep?.integrated_lufs).toBeTypeOf("number");
    expect(r.subtitles).toEqual([]);
    expect(r.looks_like_screen_recording).toBe(false);
  });
  it("probe rejects oversized inputs by config", async () => {
    const tiny = { ...config, maxInputBytes: 10 };
    await expect(probeMedia(tiny, { source: join(fixtures, "clip.mp4") })).rejects.toMatchObject({ code: "input_too_large" });
  });
});

describe("source path policy", () => {
  it("refuses relative paths that escape the working directory", async () => {
    await expect(resolveSource("../../etc/passwd", { cwd: "/tmp/x/y" })).rejects.toMatchObject({ code: "source_outside_cwd" });
  });
  it("honors MEDIA_INTEL_ALLOWED_ROOTS for absolute paths", async () => {
    const prev = process.env.MEDIA_INTEL_ALLOWED_ROOTS;
    process.env.MEDIA_INTEL_ALLOWED_ROOTS = "/nonexistent-root";
    try {
      await expect(resolveSource(join(fixtures, "red.png"))).rejects.toMatchObject({ code: "source_outside_allowed_roots" });
    } finally {
      if (prev === undefined) delete process.env.MEDIA_INTEL_ALLOWED_ROOTS;
      else process.env.MEDIA_INTEL_ALLOWED_ROOTS = prev;
    }
  });
});
