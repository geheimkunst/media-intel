import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Config } from "../config.js";
import { commonOutput, resolveWindow, round3, windowInput } from "../contracts.js";
import { MediaIntelError, toolErrorResult } from "../errors.js";
import { analyzeVideo, ffprobe, keyframeTimestamps, parseNumber } from "../ffmpeg.js";
import { cacheEntry, readSidecarJson, writeSidecarJson } from "../cache.js";
import { resolveSource } from "../source.js";

export const getScenesInput = z.object({
  source: z.string().min(1).describe("Local video path, file:// URL, or direct http(s) URL."),
  window: windowInput.optional(),
  threshold: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe("Scene-change sensitivity 0..100 (ffmpeg scdet). Default 10. Reels/fast cuts: 8. Talking heads: 15."),
  hook_window_s: z.number().min(0).max(60).optional().describe("Length of the opening 'hook' window analysed separately. Default 10."),
  include_keyframes: z.boolean().optional().describe("Also list container keyframe timestamps (fast, no decoding). Default false."),
  max_cuts: z.number().int().min(1).max(2000).optional().describe("Cap on returned cuts. Default 500."),
});

const cut = z.object({ t_s: z.number(), score: z.number() });
const interval = z.object({ start_s: z.number(), end_s: z.number(), duration_s: z.number() });
const shot = z.object({ index: z.number(), start_s: z.number(), end_s: z.number(), duration_s: z.number() });

export const getScenesOutput = z.object({
  source: z.string(),
  threshold: z.number(),
  cuts: z.array(cut),
  shots: z.array(shot),
  black: z.array(interval),
  freezes: z.array(z.object({ start_s: z.number(), end_s: z.number().optional(), duration_s: z.number().optional() })),
  metrics: z.object({
    analysed_s: z.number(),
    cut_count: z.number(),
    cuts_per_minute: z.number(),
    mean_shot_s: z.number().optional(),
    median_shot_s: z.number().optional(),
    longest_shot_s: z.number().optional(),
    static_ratio: z.number().optional(),
  }),
  hook: z.object({
    window_s: z.number(),
    cut_count: z.number(),
    cuts_per_minute: z.number(),
    first_cut_s: z.number().optional(),
  }),
  keyframes: z.array(z.number()).optional(),
  fallback_uniform: z.boolean(),
  pagination: z.object({
    total_duration_s: z.number().optional(),
    window_start_s: z.number(),
    window_end_s: z.number(),
    has_more: z.boolean(),
    next_window: z.object({ start_s: z.number(), end_s: z.number() }).optional(),
  }),
  ...commonOutput,
});

export type GetScenesInput = z.infer<typeof getScenesInput>;
export type GetScenesResult = z.infer<typeof getScenesOutput>;

const MAX_SPAN_S = 2 * 3600;

interface SceneSidecar {
  cuts: Array<{ t_s: number; score: number }>;
  black: Array<{ start_s: number; end_s: number; duration_s: number }>;
  freezes: Array<{ start_s: number; end_s: number | undefined; duration_s: number | undefined }>;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const m = sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
  return round3(m);
}

/**
 * Cut list, shot metrics, hook window. ffmpeg scdet + blackdetect +
 * freezedetect in one decode pass (architecture A17). Falls back to a
 * uniform shot list when no cuts are detected so callers always get shots.
 */
export async function getScenes(config: Config, input: GetScenesInput): Promise<GetScenesResult> {
  const resolved = await resolveSource(input.source);
  const probe = await ffprobe(config, resolved.location);
  const hasVideo = (probe.streams ?? []).some((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  if (!hasVideo) throw new MediaIntelError("no_video_stream", "get_scenes needs a video stream", "For audio use probe_media with deep=true or analyze_audio.");
  const duration = parseNumber(probe.format?.duration);
  const threshold = input.threshold ?? 10;
  const hookWindow = input.hook_window_s ?? 10;
  const maxCuts = input.max_cuts ?? 500;

  const { start_s, end_s, pagination } = resolveWindow(input.window, duration, MAX_SPAN_S);
  const entry = await cacheEntry(config, resolved);
  const sidecarName = `scenes_${threshold}_${Math.round(start_s * 1000)}-${Math.round(end_s * 1000)}.json`;
  let analysis = await readSidecarJson<SceneSidecar>(entry, sidecarName);
  if (!analysis) {
    const windowOpt = input.window || duration === undefined ? { start_s, ...(Number.isFinite(end_s) ? { end_s } : {}) } : undefined;
    const v = await analyzeVideo(config, resolved.location, { sceneThreshold: threshold, ...(windowOpt ? { window: windowOpt } : {}) });
    analysis = { cuts: v.cuts, black: v.black, freezes: v.freezes };
    await writeSidecarJson(entry, sidecarName, analysis);
  }

  const warnings: string[] = [];
  const analysedEnd = Number.isFinite(end_s) ? end_s : (duration ?? start_s);
  const analysedS = Math.max(0, analysedEnd - start_s);
  let cuts = analysis.cuts.filter((c) => c.t_s >= start_s && c.t_s <= analysedEnd);
  if (cuts.length > maxCuts) {
    warnings.push(`${cuts.length} cuts detected; returning the ${maxCuts} strongest. Raise max_cuts or narrow the window.`);
    cuts = [...cuts].sort((a, b) => b.score - a.score).slice(0, maxCuts).sort((a, b) => a.t_s - b.t_s);
  }

  let fallback = false;
  let boundaries = [start_s, ...cuts.map((c) => c.t_s), analysedEnd];
  if (cuts.length === 0 && analysedS > 0) {
    fallback = true;
    warnings.push("No scene changes detected (static or single-shot video); shots are uniform 10 s slices. Use get_video_grids for coverage.");
    boundaries = [start_s];
    for (let t = start_s + 10; t < analysedEnd; t += 10) boundaries.push(round3(t));
    boundaries.push(analysedEnd);
  }
  const shots = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const s = boundaries[i] ?? 0;
    const e = boundaries[i + 1] ?? s;
    if (e - s <= 0.001) continue;
    shots.push({ index: shots.length, start_s: round3(s), end_s: round3(e), duration_s: round3(e - s) });
  }
  const shotLens = shots.map((s) => s.duration_s);
  const staticS = analysis.freezes.reduce((acc, f) => acc + (f.duration_s ?? 0), 0) + analysis.black.reduce((acc, b) => acc + b.duration_s, 0);

  const hookCuts = cuts.filter((c) => c.t_s < start_s + hookWindow);
  const firstCut = hookCuts[0]?.t_s;

  const result: GetScenesResult = {
    source: input.source,
    threshold,
    cuts,
    shots,
    black: analysis.black,
    freezes: analysis.freezes.map((f) => ({
      start_s: f.start_s,
      ...(f.end_s !== undefined ? { end_s: f.end_s } : {}),
      ...(f.duration_s !== undefined ? { duration_s: f.duration_s } : {}),
    })),
    metrics: {
      analysed_s: round3(analysedS),
      cut_count: cuts.length,
      cuts_per_minute: analysedS > 0 ? round3((cuts.length / analysedS) * 60) : 0,
      ...(!fallback && shotLens.length > 0 ? { mean_shot_s: round3(shotLens.reduce((a, b) => a + b, 0) / shotLens.length) } : {}),
      ...(!fallback && shotLens.length > 0 ? { median_shot_s: median(shotLens) ?? 0 } : {}),
      ...(!fallback && shotLens.length > 0 ? { longest_shot_s: round3(Math.max(...shotLens)) } : {}),
      ...(analysedS > 0 ? { static_ratio: round3(Math.min(1, staticS / analysedS)) } : {}),
    },
    hook: {
      window_s: hookWindow,
      cut_count: hookCuts.length,
      cuts_per_minute: hookWindow > 0 ? round3((hookCuts.length / hookWindow) * 60) : 0,
      ...(firstCut !== undefined ? { first_cut_s: firstCut } : {}),
    },
    fallback_uniform: fallback,
    pagination,
    warnings,
    suggested_next: [],
  };

  if (input.include_keyframes) {
    const kf = await keyframeTimestamps(config, resolved.location);
    result.keyframes = kf.filter((t) => t >= start_s && t <= analysedEnd).map(round3);
  }

  if (cuts.length > 0) result.suggested_next.push("get_frames at cut timestamps", "get_video_grids timestamps=<shot starts>");
  if (analysis.black.length > 0) result.suggested_next.push("skip black intervals when sampling");
  result.suggested_next.push("analyze_moment around the strongest cut");
  return result;
}

export function summarizeScenes(r: GetScenesResult): string {
  const m = r.metrics;
  const head = `${r.cuts.length} cuts in ${m.analysed_s}s (${m.cuts_per_minute}/min)` +
    (m.mean_shot_s !== undefined ? `, mean shot ${m.mean_shot_s}s, median ${m.median_shot_s}s, longest ${m.longest_shot_s}s` : "") +
    (m.static_ratio !== undefined ? `, static ${Math.round(m.static_ratio * 100)}%` : "");
  const hook = `Hook (first ${r.hook.window_s}s): ${r.hook.cut_count} cuts` + (r.hook.first_cut_s !== undefined ? `, first at ${r.hook.first_cut_s}s` : ", no cut");
  const list = r.cuts.slice(0, 40).map((c) => `${c.t_s}s (score ${c.score})`).join(", ");
  const more = r.cuts.length > 40 ? ` … +${r.cuts.length - 40} more` : "";
  const extras = [
    r.black.length > 0 ? `Black: ${r.black.map((b) => `${b.start_s}-${b.end_s}s`).join(", ")}` : "",
    r.freezes.length > 0 ? `Frozen: ${r.freezes.map((f) => `${f.start_s}s${f.duration_s !== undefined ? ` (${f.duration_s}s)` : ""}`).join(", ")}` : "",
  ].filter((s) => s.length > 0);
  const warn = r.warnings.length > 0 ? `\nWarnings:\n- ${r.warnings.join("\n- ")}` : "";
  const pag = r.pagination.has_more && r.pagination.next_window ? `\nMore: continue with window ${r.pagination.next_window.start_s}-${r.pagination.next_window.end_s}s` : "";
  return `${head}\n${hook}${list ? `\nCuts: ${list}${more}` : ""}${extras.length > 0 ? `\n${extras.join("\n")}` : ""}${warn}${pag}`;
}

export function registerGetScenes(server: McpServer, config: Config): void {
  server.registerTool(
    "get_scenes",
    {
      title: "Get scenes",
      description:
        "Cut list and pacing for a video in one decode pass: scene changes with scores (ffmpeg scdet), shots, black frames, " +
        "frozen stretches, cuts per minute, mean/median shot length, and a separate hook window (first 10 s). " +
        "Falls back to uniform 10 s shots when nothing changes (static screen recordings). Use the cut timestamps to place " +
        "get_frames or get_video_grids precisely. Threshold 10 default; 8 for fast social clips, 15 for talking heads.",
      inputSchema: getScenesInput,
      outputSchema: getScenesOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await getScenes(config, args);
        return { content: [{ type: "text", text: summarizeScenes(result) }], structuredContent: result };
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );
}
