import type { McpServer } from "@modelcontextprotocol/server";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod/v4";
import { cacheStats, sweepCache, type CacheMeta } from "../cache.js";
import type { Config } from "../config.js";
import { commonOutput } from "../contracts.js";
import { toolErrorResult } from "../errors.js";

export const listCachedInput = z.object({
  limit: z.number().int().min(1).max(500).optional().describe("Max entries to return, newest first. Default 50."),
  sweep: z.boolean().optional().describe("Run the TTL/size sweep first. Default false."),
});

const entry = z.object({
  hash: z.string(),
  origin: z.string(),
  kind: z.enum(["file", "url"]),
  created_at: z.string(),
  modified_at: z.string(),
  bytes: z.number(),
  artifacts: z.array(z.string()),
});

export const listCachedOutput = z.object({
  cache_dir: z.string(),
  entries: z.array(entry),
  total_entries: z.number(),
  total_bytes: z.number(),
  ttl_days: z.number(),
  max_bytes: z.number(),
  swept: z.object({ removed: z.number(), freed_bytes: z.number() }).optional(),
  ...commonOutput,
});

export type ListCachedResult = z.infer<typeof listCachedOutput>;

export async function listCached(config: Config, input: z.infer<typeof listCachedInput>): Promise<ListCachedResult> {
  const swept = input.sweep ? await sweepCache(config) : undefined;
  const root = join(config.cacheDir, "entries");
  const entries: ListCachedResult["entries"] = [];
  let shards: string[] = [];
  try {
    shards = await readdir(root);
  } catch {
    shards = [];
  }
  for (const shard of shards) {
    let hashes: string[] = [];
    try {
      hashes = await readdir(join(root, shard));
    } catch {
      continue;
    }
    for (const hash of hashes) {
      const dir = join(root, shard, hash);
      try {
        const info = await stat(dir);
        if (!info.isDirectory()) continue;
        const files = (await readdir(dir)).filter((f) => f !== "meta.json" && !f.includes(".tmp-"));
        let bytes = 0;
        for (const f of files) {
          try {
            bytes += (await stat(join(dir, f))).size;
          } catch {
            /* vanished */
          }
        }
        let meta: CacheMeta | undefined;
        try {
          meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as CacheMeta;
        } catch {
          meta = undefined;
        }
        entries.push({
          hash,
          origin: meta?.origin ?? "(unknown)",
          kind: meta?.kind ?? "file",
          created_at: meta?.created_at ?? new Date(info.birthtimeMs).toISOString(),
          modified_at: new Date(info.mtimeMs).toISOString(),
          bytes,
          artifacts: files.sort(),
        });
      } catch {
        /* vanished */
      }
    }
  }
  entries.sort((a, b) => (a.modified_at < b.modified_at ? 1 : -1));
  const stats = await cacheStats(config);
  const limit = input.limit ?? 50;
  return {
    cache_dir: config.cacheDir,
    entries: entries.slice(0, limit),
    total_entries: stats.entries,
    total_bytes: stats.bytes,
    ttl_days: config.cacheTtlDays,
    max_bytes: config.cacheMaxBytes,
    ...(swept ? { swept } : {}),
    warnings: entries.length > limit ? [`${entries.length} entries; showing ${limit}.`] : [],
    suggested_next: [],
  };
}

export function summarizeListCached(r: ListCachedResult): string {
  const lines = r.entries.map((e) => `${e.hash.slice(0, 12)}  ${(e.bytes / 1024 ** 2).toFixed(1).padStart(7)} MiB  ${e.modified_at.slice(0, 16)}  ${e.origin}  [${e.artifacts.length} artifacts]`);
  const swept = r.swept ? `\nSwept: ${r.swept.removed} entries, ${(r.swept.freed_bytes / 1024 ** 2).toFixed(1)} MiB freed` : "";
  return `${r.total_entries} entries, ${(r.total_bytes / 1024 ** 2).toFixed(1)} MiB in ${r.cache_dir} (ttl ${r.ttl_days} d, cap ${(r.max_bytes / 1024 ** 3).toFixed(1)} GiB)${swept}\n${lines.join("\n")}`;
}

export function registerListCached(server: McpServer, config: Config): void {
  server.registerTool(
    "list_cached",
    {
      title: "List cached media",
      description:
        "Introspect the media-intel cache: which sources have derived artifacts (transcripts, frames, grids, downloads), " +
        "their size and age, plus totals and the TTL/size policy. Optionally run the sweep. Read-only apart from the sweep.",
      inputSchema: listCachedInput,
      outputSchema: listCachedOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = await listCached(config, args);
        return { content: [{ type: "text", text: summarizeListCached(result) }], structuredContent: result };
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );
}
