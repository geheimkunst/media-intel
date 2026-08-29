import * as z from "zod/v4";
import type { Config } from "../config.js";
import { commonOutput, frameUntrusted, wrapUntrusted } from "../contracts.js";
import { MediaIntelError } from "../errors.js";
import { resolveSource } from "../source.js";
import { cacheEntry, readSidecarJson, writeSidecarJson } from "../cache.js";
import { fetchInfojson } from "../backends/ytdlp.js";

export const getEngagementInput = z.object({
  url: z.string().min(1).describe("YouTube URL or other platform page URL."),
  include: z.array(z.enum(["metrics", "chapters", "heatmap", "sponsorblock", "comments"])).optional().describe('Include: metrics, chapters, heatmap, sponsorblock, comments. Default: ["metrics", "chapters", "heatmap", "sponsorblock"].'),
  max_comments: z.number().int().min(1).max(200).optional().describe("Maximum number of comments to fetch (1-200). Default: 50."),
  refresh: z.boolean().optional().describe("Re-fetch even if cached. Default: false."),
});

const metric = z.object({
  view_count: z.number().optional(),
  like_count: z.number().optional(),
  comment_count: z.number().optional(),
  follower_count: z.number().optional(),
});

const chapter = z.object({
  start_s: z.number().nonnegative(),
  end_s: z.number().nonnegative(),
  title: z.string().optional(),
});

const heatmapEntry = z.object({
  start_s: z.number().nonnegative(),
  end_s: z.number().nonnegative(),
  value: z.number().nonnegative(),
});

const sponsorblockEntry = z.object({
  category: z.string(),
  start_s: z.number().nonnegative(),
  end_s: z.number().nonnegative(),
});

const comment = z.object({
  author: z.string().optional(),
  text: z.string().optional(),
  like_count: z.number().optional(),
  is_pinned: z.boolean().optional(),
});

export const getEngagementOutput = z.object({
  url: z.string(),
  extractor: z.string().optional(),
  id: z.string().optional(),
  title: z.string().optional(), // untrusted
  channel: z.string().optional(), // untrusted, capped
  upload_date: z.string().optional(), // YYYY-MM-DD
  duration_s: z.number().optional(),
  metrics: metric.optional(),
  chapters: z.array(chapter),
  heatmap: z.array(heatmapEntry),
  most_replayed: z.array(heatmapEntry),
  sponsorblock: z.array(sponsorblockEntry),
  comments: z.array(comment),
  comments_text: z.string().optional(), // untrusted, framed
  ...commonOutput,
});

export type GetEngagementInput = z.infer<typeof getEngagementInput>;
export type GetEngagementResult = z.infer<typeof getEngagementOutput>;

/**
 * Tier-1 tool: get engagement metrics for a video without downloading it.
 * Extracts view count, likes, comments, chapters, heatmap (most replayed),
 * SponsorBlock data, and optionally top comments.
 */
export async function getEngagement(config: Config, input: GetEngagementInput): Promise<GetEngagementResult> {
  const resolved = await resolveSource(input.url);
  const entry = await cacheEntry(config, resolved);

  const include = input.include ?? ["metrics", "chapters", "heatmap", "sponsorblock"];
  const maxComments = input.max_comments ?? 50;
  const refresh = input.refresh ?? false;

  const warnings: string[] = [];
  const suggested: string[] = [];

  // Check cache
  if (!refresh) {
    const cached = await readSidecarJson<Partial<GetEngagementResult>>(entry as any, "info.engagement.json");
    if (cached) {
      return {
        ...cached,
        warnings,
        suggested_next: suggested,
      } as GetEngagementResult;
    }
  }

  // Fetch infojson
  let infoResult = await fetchInfojson(config, input.url, { timeoutMs: config.processTimeoutMs * 5 });

  // Fetch comments if requested
  if (include.includes("comments")) {
    // This is a simplified approach; in production we might need to run yt-dlp again with --write-comments
    // For now, we'll use comments from the infojson if available
  }

  const result: GetEngagementResult = {
    url: input.url,
    extractor: infoResult.extractor,
    id: infoResult.id,
    title: infoResult.title ? wrapUntrusted(infoResult.title, 500).text : undefined,
    channel: infoResult.channel ? infoResult.channel.slice(0, 200) : undefined,
    duration_s: infoResult.duration,
    metrics: include.includes("metrics")
      ? {
          ...(infoResult.view_count !== undefined ? { view_count: infoResult.view_count } : {}),
          ...(infoResult.like_count !== undefined ? { like_count: infoResult.like_count } : {}),
          ...(infoResult.comment_count !== undefined ? { comment_count: infoResult.comment_count } : {}),
          ...(infoResult.follower_count !== undefined ? { follower_count: infoResult.follower_count } : {}),
        }
      : undefined,
    chapters: include.includes("chapters")
      ? (infoResult.chapters ?? []).map((c) => ({
          start_s: c.start_time ?? 0,
          end_s: c.end_time ?? 0,
          ...(c.title !== undefined ? { title: c.title } : {}),
        }))
      : [],
    heatmap: include.includes("heatmap") ? (infoResult.heatmap ?? []).map((h) => ({ start_s: h.start_time, end_s: h.end_time, value: h.value })) : [],
    most_replayed: [],
    sponsorblock: include.includes("sponsorblock") ? (infoResult.sponsorblock_chapters ?? []).map((s) => ({ category: s.category, start_s: s.start_time, end_s: s.end_time })) : [],
    comments: [],
    warnings,
    suggested_next: suggested,
  };

  // Build most_replayed from top 5 heatmap entries
  if (result.heatmap.length > 0) {
    const sorted = [...result.heatmap].sort((a, b) => b.value - a.value);
    const topEntries = sorted.slice(0, 5);

    // Merge adjacent entries
    const merged: typeof result.most_replayed = [];
    for (const entry of topEntries) {
      const last = merged.length > 0 ? merged[merged.length - 1] : undefined;
      if (last !== undefined && Math.abs(last.end_s - entry.start_s) < 1) {
        // Adjacent or overlapping, merge
        last.end_s = Math.max(last.end_s, entry.end_s);
        last.value = Math.max(last.value, entry.value);
      } else {
        merged.push({ start_s: entry.start_s, end_s: entry.end_s, value: entry.value });
      }
    }
    result.most_replayed = merged;
  }

  // Handle comments
  if (include.includes("comments") && infoResult.comments && infoResult.comments.length > 0) {
    const commentsList = infoResult.comments.slice(0, maxComments).map((c) => ({
      ...(c.author !== undefined ? { author: c.author } : {}),
      ...(c.text !== undefined ? { text: c.text.slice(0, 500) } : {}),
      ...(c.like_count !== undefined ? { like_count: c.like_count } : {}),
      ...(c.is_pinned !== undefined ? { is_pinned: c.is_pinned } : {}),
    }));
    result.comments = commentsList;

    // Build comments_text for framing
    const allCommentTexts = commentsList.map((c) => `${c.author ?? "Unknown"}: ${c.text ?? ""}`).join("\n");
    const wrapped = wrapUntrusted(allCommentTexts, config.maxTextFieldChars);
    result.comments_text = wrapped.text;
  }

  // Warnings
  if (!result.heatmap || result.heatmap.length === 0) {
    warnings.push("No heatmap data available; this video may not support 'Most Replayed'.");
  }

  // Cache the result
  await writeSidecarJson(entry as any, "info.engagement.json", result);

  return result;
}

export function summarizeGetEngagement(r: GetEngagementResult): string {
  const parts: string[] = [];
  if (r.title) parts.push(`"${r.title}"`);
  if (r.channel) parts.push(`from ${r.channel}`);
  if (r.duration_s !== undefined) parts.push(`${Math.round(r.duration_s)}s`);

  if (r.metrics) {
    const metricParts: string[] = [];
    if (r.metrics.view_count !== undefined) metricParts.push(`${r.metrics.view_count.toLocaleString()} views`);
    if (r.metrics.like_count !== undefined) metricParts.push(`${r.metrics.like_count.toLocaleString()} likes`);
    if (r.metrics.comment_count !== undefined) metricParts.push(`${r.metrics.comment_count.toLocaleString()} comments`);
    if (metricParts.length > 0) parts.push(metricParts.join(", "));
  }

  if (r.chapters.length > 0) parts.push(`${r.chapters.length} chapters`);
  if (r.heatmap.length > 0) parts.push(`heatmap (${r.heatmap.length} entries)`);
  if (r.most_replayed.length > 0) parts.push(`most replayed (${r.most_replayed.length} entries)`);
  if (r.sponsorblock.length > 0) parts.push(`${r.sponsorblock.length} sponsorblock entries`);
  if (r.comments.length > 0) parts.push(`${r.comments.length} comments`);

  const line = parts.join(" | ");
  const warn = r.warnings.length > 0 ? `\nWarnings:\n- ${r.warnings.join("\n- ")}` : "";
  return `${line}${warn}`;
}
