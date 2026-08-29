import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { loadConfig, type Config } from "../src/config.js";
import { cacheEntry, readSidecarJson } from "../src/cache.js";
import { extractText, extractTextInput, extractTextOutput } from "../src/tools/extract-text.ts";
import { findBinary, tesseractLanguages } from "../src/binaries.js";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServer } from "../src/server.js";

const fixtures = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");
let scratch: string;
let config: Config;
let testImagePath: string;
let testVideoPath: string;
let tesseractAvailable = true;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "media-intel-ocr-test-"));
  config = { ...loadConfig(), cacheDir: join(scratch, "cache") };

  // Check if tesseract is available.
  tesseractAvailable = (await findBinary(config.tesseractBin)) !== undefined;

  // Create a test image with text using sharp SVG buffer.
  // Sharp supports SVG creation via buffer, not text with markup.
  const svgBuffer = Buffer.from(
    '<svg width="400" height="200" xmlns="http://www.w3.org/2000/svg">' +
    '<rect width="400" height="200" fill="white"/>' +
    '<text x="10" y="60" font-size="48" fill="black" font-family="sans-serif">Hallo Welt 123</text>' +
    '<text x="10" y="150" font-size="36" fill="red" font-family="monospace">ERROR: file not found</text>' +
    '</svg>'
  );

  const testImageBuffer = await sharp(svgBuffer)
    .png()
    .toBuffer();

  testImagePath = join(scratch, "test-image.png");
  await writeFile(testImagePath, testImageBuffer);

  // Create a test video with overlaid text (using the test image as a still).
  // For simplicity in tests, we'll skip video creation if ffmpeg is not available or has drawtext issues.
  // Instead, we just use the image for testing.
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("extract-text tool", () => {
  it("returns tesseract_missing error if tesseract is not installed", async () => {
    if (tesseractAvailable) {
      // Skip test if tesseract is available.
      expect(true).toBe(true);
      return;
    }

    const result = await extractText(config, {
      source: testImagePath,
    }).catch((e) => e);

    expect(result?.code || result?.message || "").toContain("tesseract");
  });

  it("processes a PNG image and extracts text", async () => {
    if (!tesseractAvailable) {
      expect(true).toBe(true);
      return;
    }

    const result = await extractText(config, {
      source: testImagePath,
    });

    expect(result).toMatchObject({
      source: testImagePath,
      language: expect.any(String),
      results: expect.any(Array),
      warnings: expect.any(Array),
      suggested_next: expect.any(Array),
    });

    // Check that we got at least one result.
    expect(result.results.length).toBeGreaterThan(0);

    // Check result structure.
    const firstResult = result.results[0]!;
    expect(firstResult).toMatchObject({
      image_width: expect.any(Number),
      image_height: expect.any(Number),
      text: expect.any(String),
      lines: expect.any(Array),
      word_count: expect.any(Number),
      mean_confidence: expect.any(Number),
    });

    // Image should not have t_s (it's an image, not a video frame).
    expect(firstResult.t_s).toBeUndefined();

    // Check that text contains expected strings (Hallo, ERROR).
    expect(firstResult.text.toLowerCase()).toContain("hallo");
    expect(firstResult.text.toUpperCase()).toContain("ERROR");

    // Validate output schema.
    const validated = extractTextOutput.parse(result);
    expect(validated).toBeDefined();
  });

  it("validates against output schema", async () => {
    if (!tesseractAvailable) {
      expect(true).toBe(true);
      return;
    }

    const result = await extractText(config, {
      source: testImagePath,
      language: "eng",
      psm: 6,
      min_confidence: 0,
      upscale: 1,
    });

    // This should not throw if output is valid.
    const validated = extractTextOutput.parse(result);
    expect(validated.source).toBe(testImagePath);
  });

  it("supports language parameter", async () => {
    if (!tesseractAvailable) {
      expect(true).toBe(true);
      return;
    }

    const result = await extractText(config, {
      source: testImagePath,
      language: "eng",
    });

    expect(result.language).toBe("eng");
  });

  it("handles missing language with warning", async () => {
    if (!tesseractAvailable) {
      expect(true).toBe(true);
      return;
    }

    const result = await extractText(config, {
      source: testImagePath,
      language: "xyz+eng", // xyz is not a real language.
    });

    // Should have a warning about the missing language.
    const hasWarning = result.warnings.some((w) => w.toLowerCase().includes("xyz"));
    expect(hasWarning).toBe(true);

    // Should fall back to available languages.
    expect(result.language).toContain("eng");
  });

  it("caches OCR results", async () => {
    if (!tesseractAvailable) {
      expect(true).toBe(true);
      return;
    }

    // First call - should run OCR.
    const result1 = await extractText(config, {
      source: testImagePath,
      language: "eng",
    });

    // Second call with same parameters - should use cache.
    const result2 = await extractText(config, {
      source: testImagePath,
      language: "eng",
    });

    // Results should be identical.
    expect(result2.results).toEqual(result1.results);

    // Cache should contain sidecar.
    const cache = await cacheEntry(config, { kind: "file", location: testImagePath });
    const cached = await readSidecarJson(cache, "ocr_t0_langeng_psm6_up1.json");
    expect(cached).toBeDefined();
  });

  it("respects confidence thresholds and warns", async () => {
    if (!tesseractAvailable) {
      expect(true).toBe(true);
      return;
    }

    const result = await extractText(config, {
      source: testImagePath,
      min_confidence: 95, // Very high threshold.
    });

    // If any result has low confidence, there should be a warning.
    if (result.results.some((r) => r.mean_confidence < 95)) {
      expect(result.warnings.length).toBeGreaterThan(0);
    }
  });

  it("rejects video without timestamps", async () => {
    if (!tesseractAvailable) {
      expect(true).toBe(true);
      return;
    }

    const result = await extractText(config, {
      source: join(fixtures, "clip.mp4"),
      // timestamps omitted for a video.
    }).catch((e) => e);

    expect(result?.message || String(result)).toContain("Timestamps are required");
  });

  it("rejects too many timestamps", async () => {
    if (!tesseractAvailable) {
      expect(true).toBe(true);
      return;
    }

    const tooManyTimestamps = Array.from({ length: 35 }, (_, i) => i);
    const result = await extractText(config, {
      source: join(fixtures, "clip.mp4"),
      timestamps: tooManyTimestamps,
    }).catch((e) => e);

    expect(result?.message || String(result)).toContain("32 timestamps");
  });

  it("validates input schema", () => {
    // Empty source should fail.
    expect(() => extractTextInput.parse({ source: "" })).toThrow();

    // Valid input.
    expect(() => extractTextInput.parse({ source: "/path/to/file.png" })).not.toThrow();

    // Valid with timestamps.
    expect(() => extractTextInput.parse({ source: "/path/to/file.mp4", timestamps: [0.5, 1.0] })).not.toThrow();

    // Invalid region (no width/height).
    expect(() =>
      extractTextInput.parse({ source: "/path/to/file.png", region: { x: 0, y: 0, width: 0, height: 100 } }),
    ).toThrow();
  });
});

describe("extract-text MCP round trip", () => {
  const server = createServer();
  let client: Client;

  beforeAll(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it("advertises extract_text with input and output schema", async () => {
    const { tools } = await client.listTools();
    const extractTextTool = tools.find((t) => t.name === "extract_text");
    expect(extractTextTool).toBeDefined();
    expect(extractTextTool?.inputSchema.properties).toHaveProperty("source");
    expect(extractTextTool?.inputSchema.properties).toHaveProperty("timestamps");
    expect(extractTextTool?.outputSchema?.properties).toHaveProperty("language");
    expect(extractTextTool?.outputSchema?.properties).toHaveProperty("results");
  });

  it("processes an image via MCP and returns text", async () => {
    if (!tesseractAvailable) {
      expect(true).toBe(true);
      return;
    }

    const result = await client.callTool({ name: "extract_text", arguments: { source: testImagePath } });
    expect(result.isError).toBeFalsy();
    const text = result.content.find((c) => c.type === "text");
    const textContent = text && "text" in text ? text.text : "";
    expect(textContent).toContain("Extracted text");

    // structuredContent should be present.
    const sc = result.structuredContent as { language: string; results: Array<{ text: string }> };
    expect(sc.language).toBeDefined();
    expect(sc.results.length).toBeGreaterThan(0);
  });

  it("validates input before the handler runs", async () => {
    const result = await client.callTool({ name: "extract_text", arguments: { source: "" } });
    expect(result.isError).toBe(true);
  });
});
