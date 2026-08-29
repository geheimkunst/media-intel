import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServer } from "../src/server.js";

describe("prompts and full server surface", () => {
  const server = createServer();
  const client = new Client({ name: "t", version: "0" });

  beforeAll(async () => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it("lists the four report prompts and renders one with arguments", async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["hook_breakdown", "key_moments", "quotables", "tldr"]);
    const rendered = await client.getPrompt({ name: "tldr", arguments: { source: "/x/a.mp4", focus: "sales research" } });
    const text = rendered.messages[0]?.content;
    expect(text && text.type === "text" ? text.text : "").toContain("/x/a.mp4");
    expect(text && text.type === "text" ? text.text : "").toContain("sales research");
    expect(text && text.type === "text" ? text.text : "").toContain("MEDIA_TEXT_BEGIN");
  });

  it("exposes the stage 0..3 tools registered on main", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    for (const n of ["doctor", "list_cached", "probe_media", "get_scenes", "analyze_audio", "diff_frames"]) expect(names).toContain(n);
  });
});
