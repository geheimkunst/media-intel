import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chmod } from "node:fs/promises";
import { type Config, loadConfig } from "../src/config.js";
import { fetchMedia, type FetchMediaInput } from "../src/tools/fetch-media.js";
import { getEngagement, type GetEngagementInput } from "../src/tools/get-engagement.js";
import { fetchInfojson } from "../src/backends/ytdlp.js";

let fakeBinDir: string;
let config: Config;
let ytdlpCallCount = 0;

/**
 * Create a fake yt-dlp binary that records calls and returns test data.
 * The fake binary writes infojson to the output path and tracks invocations.
 */
async function createFakeYtdlp(dir: string): Promise<void> {
  const binPath = join(dir, "yt-dlp");
  const counterPath = join(dir, "call-counter");

  // Initialize counter
  await writeFile(counterPath, "0");

  // Write a Node.js script as the fake binary
  const script = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const testData = {
  id: "dQw4w9WgXcQ",
  title: "Test Video",
  extractor: "youtube",
  ext: "mp4",
  duration: 213,
  uploader: "Test Channel",
  channel: "Test Channel",
  upload_date: "20230101",
  view_count: 1000000,
  like_count: 50000,
  comment_count: 5000,
  follower_count: 100000,
  is_live: false,
  chapters: [
    { start_time: 0, end_time: 60, title: "Intro" },
    { start_time: 60, end_time: 120, title: "Main" },
  ],
  heatmap: [
    { start_time: 0, end_time: 30, value: 0.5 },
    { start_time: 30, end_time: 60, value: 0.8 },
    { start_time: 60, end_time: 90, value: 0.9 },
    { start_time: 90, end_time: 120, value: 0.7 },
    { start_time: 120, end_time: 150, value: 0.4 },
    { start_time: 150, end_time: 180, value: 0.95 },
    { start_time: 180, end_time: 213, value: 0.6 },
    { start_time: 0, end_time: 50, value: 0.85 },
    { start_time: 50, end_time: 100, value: 0.92 },
    { start_time: 100, end_time: 150, value: 0.75 },
  ],
  sponsorblock_chapters: [
    { category: "sponsor", start_time: 100, end_time: 110 },
    { category: "intro", start_time: 0, end_time: 20 },
  ],
  comments: [
    { author: "User1", text: "Great video!", like_count: 100, is_pinned: true },
    { author: "User2", text: "Thanks for sharing this content.", like_count: 50, is_pinned: false },
  ],
};

async function main() {
  const args = process.argv.slice(2);

  try {
    // Record arguments
    const counterPath = "${counterPath}";
    let count = 0;
    try {
      const content = await fs.promises.readFile(counterPath, "utf8");
      count = parseInt(content, 10) || 0;
    } catch {}
    count += 1;
    await fs.promises.writeFile(counterPath, String(count), "utf8");

    // Look for -J (JSON only)
    if (args.includes("-J")) {
      console.log(JSON.stringify(testData));
      process.exit(0);
    }

    // Look for --write-info-json
    if (args.includes("--write-info-json")) {
      // Find all -o output templates
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "-o" && i + 1 < args.length) {
          const template = args[i + 1];

          if (template.includes("info")) {
            const infojsonPath = template + ".json";
            await fs.promises.writeFile(infojsonPath, JSON.stringify(testData, null, 2), "utf8");
          }

          if (template.includes("media")) {
            const mediaPath = template + ".mp4";
            await fs.promises.writeFile(mediaPath, "fake video data", "utf8");
          }

          if (template.includes("audio")) {
            const audioPath = template + ".m4a";
            await fs.promises.writeFile(audioPath, "fake audio data", "utf8");
          }

          if (template.includes("thumb")) {
            const thumbPath = template + ".jpg";
            await fs.promises.writeFile(thumbPath, "fake thumb", "utf8");
          }

          if (template.includes("subs")) {
            await fs.promises.writeFile(template + ".en.vtt", "WEBVTT\\n0:00:00 --> 0:00:01\\nHello", "utf8");
            await fs.promises.writeFile(template + ".de.vtt", "WEBVTT\\n0:00:00 --> 0:00:01\\nHallo", "utf8");
          }
        }
      }
      process.exit(0);
    }

    // Default: success
    process.exit(0);
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

main();
`;

  await writeFile(binPath, script);
  await chmod(binPath, 0o755);
}

beforeAll(async () => {
  fakeBinDir = await mkdtemp(join(tmpdir(), "media-intel-test-"));
  await createFakeYtdlp(fakeBinDir);

  // Create custom config pointing to fake binary
  config = loadConfig();
  config.ytdlpBin = join(fakeBinDir, "yt-dlp");
});

afterAll(async () => {
  if (fakeBinDir) {
    await rm(fakeBinDir, { recursive: true, force: true });
  }
});

describe("yt-dlp backend", () => {
  it("fetchInfojson parses valid JSON", async () => {
    const info = await fetchInfojson(config, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(info.id).toBe("dQw4w9WgXcQ");
    expect(info.title).toBe("Test Video");
    expect(info.duration).toBe(213);
    expect(info.heatmap).toHaveLength(10);
  });

  it("fetchInfojson throws on missing yt-dlp", async () => {
    const badConfig = { ...config, ytdlpBin: "/nonexistent/yt-dlp" };
    await expect(fetchInfojson(badConfig, "https://example.com")).rejects.toMatchObject({
      code: "ytdlp_missing",
    });
  });
});

describe("fetch_media tool", () => {
  it("downloads media and returns file info", async () => {
    const input: FetchMediaInput = {
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      what: ["info", "video", "subtitles", "thumbnail"],
      refresh: true,
    };
    const result = await fetchMedia(config, input);
    expect(result.id).toBe("dQw4w9WgXcQ");
    expect(result.title).toBe("Test Video");
    expect(result.duration_s).toBe(213);
    expect(result.files.video).toBeDefined();
    expect(result.files.thumbnail).toBeDefined();
    expect(result.files.info).toBeDefined();
    expect(result.from_cache).toBe(false);
  });

  it("downloads audio when video not requested", async () => {
    const input: FetchMediaInput = {
      url: "https://www.youtube.com/watch?v=audio-test",
      what: ["info", "audio"],
      refresh: true,
    };
    const result = await fetchMedia(config, input);
    expect(result.files.audio).toBeDefined();
    expect(result.files.video).toBeUndefined();
  });

  it("returns from cache on second call", async () => {
    const input1: FetchMediaInput = {
      url: "https://www.youtube.com/watch?v=cache-first",
      what: ["info"],
      refresh: true,
    };
    // First call
    const result1 = await fetchMedia(config, input1);
    expect(result1.from_cache).toBe(false);

    // Second call (should be from cache)
    const input2: FetchMediaInput = {
      url: "https://www.youtube.com/watch?v=cache-first",
      what: ["info"],
      refresh: false,
    };
    const result2 = await fetchMedia(config, input2);
    expect(result2.from_cache).toBe(true);
  });

  it("respects refresh flag", async () => {
    const input: FetchMediaInput = {
      url: "https://www.youtube.com/watch?v=refresh-test",
      what: ["info"],
      refresh: true,
    };
    const result = await fetchMedia(config, input);
    expect(result.from_cache).toBe(false);
  });

  it("handles subtitle discovery", async () => {
    const input: FetchMediaInput = {
      url: "https://www.youtube.com/watch?v=subtitle-test",
      what: ["subtitles"],
      refresh: true,
    };
    const result = await fetchMedia(config, input);
    expect(result.files.subtitles.length).toBeGreaterThan(0);
    expect(result.files.subtitles[0]).toHaveProperty("language");
    expect(result.files.subtitles[0]).toHaveProperty("automatic");
    expect(result.files.subtitles[0]).toHaveProperty("path");
  });
});

describe("get_engagement tool", () => {
  it("extracts engagement metrics", async () => {
    const input: GetEngagementInput = {
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      include: ["metrics", "chapters", "heatmap", "sponsorblock"],
    };
    const result = await getEngagement(config, input);
    expect(result.id).toBe("dQw4w9WgXcQ");
    expect(result.title).toBe("Test Video");
    expect(result.metrics?.view_count).toBe(1000000);
    expect(result.metrics?.like_count).toBe(50000);
    expect(result.chapters).toHaveLength(2);
    expect(result.heatmap).toHaveLength(10);
    expect(result.sponsorblock).toHaveLength(2);
  });

  it("builds most_replayed from top 5 heatmap entries", async () => {
    const input: GetEngagementInput = {
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      include: ["heatmap"],
    };
    const result = await getEngagement(config, input);
    expect(result.most_replayed.length).toBeLessThanOrEqual(5);
    // Verify they're sorted by value descending
    for (let i = 0; i < result.most_replayed.length - 1; i++) {
      expect(result.most_replayed[i].value).toBeGreaterThanOrEqual(result.most_replayed[i + 1].value);
    }
  });

  it("caches engagement data", async () => {
    const input: GetEngagementInput = {
      url: "https://www.youtube.com/watch?v=cache-test",
      include: ["metrics"],
    };
    // First call
    const result1 = await getEngagement(config, input);
    expect(result1.metrics?.view_count).toBe(1000000);

    // Second call (from cache)
    const result2 = await getEngagement(config, input);
    expect(result2.metrics?.view_count).toBe(1000000);
  });

  it("caps comment text length", async () => {
    const input: GetEngagementInput = {
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      include: ["comments"],
      max_comments: 50,
    };
    const result = await getEngagement(config, input);
    for (const comment of result.comments) {
      if (comment.text) {
        expect(comment.text.length).toBeLessThanOrEqual(500);
      }
    }
  });
});

