import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer } from "../src/server.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("media-intel MCP server end to end (in-memory transport)", () => {
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

  it("advertises probe_media with input and output schema", async () => {
    const { tools } = await client.listTools();
    const probe = tools.find((t) => t.name === "probe_media");
    expect(probe).toBeDefined();
    expect(probe?.inputSchema.properties).toHaveProperty("source");
    expect(probe?.outputSchema?.properties).toHaveProperty("kind");
    expect(probe?.annotations?.readOnlyHint).toBe(true);
  });

  it("returns text plus structuredContent for a video", async () => {
    const result = await client.callTool({ name: "probe_media", arguments: { source: join(fixtures, "clip.mp4") } });
    expect(result.isError).toBeFalsy();
    const text = result.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toContain("video");
    const sc = result.structuredContent as { kind: string; video: { width: number } };
    expect(sc.kind).toBe("video");
    expect(sc.video.width).toBe(320);
  });

  it("rejects invalid arguments before the handler runs", async () => {
    const result = await client.callTool({ name: "probe_media", arguments: { source: "" } });
    expect(result.isError).toBe(true);
  });

  it("turns a missing file into an isError result with a hint", async () => {
    const result = await client.callTool({ name: "probe_media", arguments: { source: "/definitely/not/here.mp4" } });
    expect(result.isError).toBe(true);
    const text = result.content[0];
    expect(text && "text" in text ? text.text : "").toContain("source_not_found");
    expect(text && "text" in text ? text.text : "").toContain("Hint:");
  });
});
