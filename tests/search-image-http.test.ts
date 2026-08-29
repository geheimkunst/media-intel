import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { loadConfig, type Config } from "../src/config.js";
import { closeIndex, indexDocument, searchIndex, toFtsQuery } from "../src/search.js";
import { mediaSearch, registerMediaSearch } from "../src/tools/media-search.js";
import { probeImage } from "../src/tools/probe-image.js";
import { startHttp } from "../src/http.js";
import { createServer } from "../src/server.js";

let scratch: string;
let config: Config;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "media-intel-p2b-"));
  config = { ...loadConfig(), cacheDir: join(scratch, "cache") };
});

afterAll(async () => {
  closeIndex();
  await rm(scratch, { recursive: true, force: true });
});

describe("search index", () => {
  it("indexes, searches with diacritics folded, and is idempotent per document", async () => {
    const doc = {
      hash: "a".repeat(64),
      origin: "/x/voice-note.m4a",
      kind: "transcript" as const,
      language: "de",
      backend: "whisper_cpp",
      segments: [
        { start_s: 0, end_s: 4.2, text: "Heute besprechen wir die Übergabe an Hermes." },
        { start_s: 4.2, end_s: 9, text: "Danach kommt der Deploy auf den Server." },
      ],
    };
    const first = await indexDocument(config, doc);
    expect(first.segments).toBe(2);
    const again = await indexDocument(config, doc);
    expect(again.doc_id).toBe(first.doc_id);
    const hits = await searchIndex(config, "ubergabe hermes");
    expect(hits.length).toBe(1);
    expect(hits[0]).toMatchObject({ origin: "/x/voice-note.m4a", start_s: 0, end_s: 4.2, language: "de" });
    expect(hits[0]?.snippet).toContain("[Übergabe]");
    expect(await searchIndex(config, "nothing-here-xyz")).toEqual([]);
    expect(toFtsQuery('a "b* c')).toBe('"a" "b" "c"');
  });

  it("media_search tool wraps hits as untrusted and reports index stats", async () => {
    const r = await mediaSearch(config, { query: "deploy", top_k: 5 });
    expect(r.hits.length).toBe(1);
    expect(r.hits_text.source_trust).toBe("untrusted");
    expect(r.index.documents).toBe(1);
    const server = new McpServer({ name: "t", version: "0" });
    registerMediaSearch(server, config);
    const { InMemoryTransport } = await import("@modelcontextprotocol/server");
    const client = new Client({ name: "c", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    const res = await client.callTool({ name: "media_search", arguments: { query: "hermes" } });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { hits: unknown[] }).hits.length).toBe(1);
    await client.close();
    await server.close();
  });
});

describe("probe_image", () => {
  it("reads dimensions, hash, and decodes a QR code", async () => {
    const { writeBarcode } = await import("zxing-wasm/writer");
    const qr = await writeBarcode("https://example.com/hello", { format: "QRCode", scale: 6 });
    const qrPng = join(scratch, "qr.png");
    await writeFile(qrPng, Buffer.from(await qr.image!.arrayBuffer()));
    const r = await probeImage(config, { source: qrPng });
    expect(r.format).toBe("png");
    expect(r.width).toBeGreaterThan(50);
    expect(r.phash).toMatch(/^[01]{64}$/);
    expect(r.codes.length).toBe(1);
    expect(r.codes[0]?.format).toBe("QRCode");
    expect(r.codes[0]?.text.text).toBe("https://example.com/hello");
    expect(r.codes[0]?.text.source_trust).toBe("untrusted");
    // second call comes from the sidecar
    const again = await probeImage(config, { source: qrPng });
    expect(again.phash).toBe(r.phash);
  });

  it("flags a large flat png as screenshot-like and rejects non-images", async () => {
    const shot = join(scratch, "shot.png");
    await sharp({ create: { width: 800, height: 500, channels: 3, background: { r: 245, g: 245, b: 245 } } }).png().toFile(shot);
    const r = await probeImage(config, { source: shot, include: ["stats"] });
    expect(r.looks_like_screenshot).toBe(true);
    expect(r.stats?.entropy).toBeLessThan(6);
    const txt = join(scratch, "not-image.txt");
    await writeFile(txt, "hello");
    await expect(probeImage(config, { source: txt })).rejects.toMatchObject({ code: "not_an_image" });
  });
});

describe("streamable http", () => {
  it("serves the full server statelessly with a bearer token and rejects bad tokens", async () => {
    const server = createServer(config);
    const { url, close } = await startHttp(server, { port: 0, bearerToken: "s3cret-token" });
    try {
      const unauth = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
      expect(unauth.status).toBe(401);
      const health = await fetch(new URL("/healthz", url));
      expect(health.status).toBe(200);

      const client = new Client({ name: "http-client", version: "0" });
      const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: "Bearer s3cret-token" } } });
      await client.connect(transport);
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toContain("probe_media");
      const r = await client.callTool({ name: "doctor", arguments: {} });
      expect(r.isError).toBeFalsy();
      await client.close();
    } finally {
      await close();
    }
  });
});
