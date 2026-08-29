import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Config } from "../config.js";
import { commonOutput, wrapUntrusted } from "../contracts.js";
import { toolErrorResult } from "../errors.js";
import { indexStats, searchIndex } from "../search.js";

export const mediaSearchInput = z.object({
  query: z.string().min(1).max(500).describe("Words to look for (all must match; diacritics are ignored)."),
  kind: z.enum(["transcript", "ocr"]).optional().describe("Restrict to transcripts or OCR text. Default both."),
  hash: z.string().optional().describe("Restrict to one cached source (hash from list_cached)."),
  top_k: z.number().int().min(1).max(100).optional().describe("Max hits. Default 10."),
});

const hit = z.object({
  hash: z.string(),
  origin: z.string(),
  kind: z.enum(["transcript", "ocr"]),
  language: z.string().optional(),
  start_s: z.number(),
  end_s: z.number(),
  snippet: z.string(),
  score: z.number(),
});

export const mediaSearchOutput = z.object({
  query: z.string(),
  hits: z.array(hit),
  hits_text: z.object({ text: z.string(), source_trust: z.literal("untrusted"), truncated: z.boolean(), chars: z.number() }),
  index: z.object({ documents: z.number(), segments: z.number() }),
  ...commonOutput,
});

export type MediaSearchResult = z.infer<typeof mediaSearchOutput>;

export async function mediaSearch(config: Config, input: z.infer<typeof mediaSearchInput>): Promise<MediaSearchResult> {
  const hits = await searchIndex(config, input.query, {
    ...(input.hash !== undefined ? { hash: input.hash } : {}),
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    limit: input.top_k ?? 10,
  });
  const stats = await indexStats(config);
  const lines = hits.map((h) => `${h.origin} @ ${h.start_s}s: ${h.snippet}`).join("\n");
  const warnings: string[] = [];
  if (stats.documents === 0) warnings.push("Index is empty: run get_transcript or extract_text first; every run indexes its text.");
  return {
    query: input.query,
    hits: hits.map((h) => ({ ...h, ...(h.language !== undefined ? { language: h.language } : {}) })),
    hits_text: wrapUntrusted(lines, config.maxTextFieldChars),
    index: { documents: stats.documents, segments: stats.segments },
    warnings,
    suggested_next: hits.length > 0 ? ["get_transcript with window around a hit", "get_frames at hit start_s"] : [],
  };
}

export function summarizeSearch(r: MediaSearchResult): string {
  const head = `${r.hits.length} hits for "${r.query}" across ${r.index.documents} documents / ${r.index.segments} segments`;
  const body = r.hits.map((h, i) => `${i + 1}. ${h.kind} ${h.origin} @ ${h.start_s}-${h.end_s}s (score ${h.score})\n   ${h.snippet}`).join("\n");
  const warn = r.warnings.length > 0 ? `\nWarnings:\n- ${r.warnings.join("\n- ")}` : "";
  return `${head}\n<<<MEDIA_TEXT_BEGIN untrusted>>>\n${body}\n<<<MEDIA_TEXT_END>>>${warn}`;
}

export function registerMediaSearch(server: McpServer, config: Config): void {
  server.registerTool(
    "media_search",
    {
      title: "Search cached media text",
      description:
        "Full-text search over every transcript and OCR result media-intel has produced (FTS5 in the cache, diacritics-insensitive). " +
        "Returns the source, the time of the matching segment and a snippet, ranked. Use to find where something was said across " +
        "many files, then jump in with get_transcript or get_frames at that time.",
      inputSchema: mediaSearchInput,
      outputSchema: mediaSearchOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = await mediaSearch(config, args);
        return { content: [{ type: "text", text: summarizeSearch(result) }], structuredContent: result };
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );
}
