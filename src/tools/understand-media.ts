import type { McpServer } from "@modelcontextprotocol/server";
import { readFile } from "node:fs/promises";
import * as z from "zod/v4";
import type { Config } from "../config.js";
import { commonOutput, frameUntrusted, manifestEntry, round3, untrustedText, wrapUntrusted } from "../contracts.js";
import { MediaIntelError, toolErrorResult } from "../errors.js";
import { getScenes } from "./get-scenes.js";
import { getTranscript, getTranscriptInput } from "./get-transcript.js";
import { getVideoGrids, getVideoGridsInput } from "./get-video-grids.js";
import { probeMedia } from "./probe-media.js";

export const understandMediaInput = z.object({
  source: z.string().min(1).describe("Local media path, file:// URL, or direct http(s) URL. Platform pages: run fetch_media first."),
  max_total_chars: z.number().int().min(2000).max(400_000).optional().describe("Budget for all text in the result. Default 60000."),
  max_grids: z.number().int().min(0).max(8).optional().describe("Upper bound on contact sheets. Default 2. 0 disables visuals."),
  cells: z.union([z.literal(4), z.literal(9), z.literal(16), z.literal(25), z.literal(36), z.literal(64)]).optional().describe("Cells per grid. Default 64, or 16 for screen recordings."),
  visual: z.enum(["auto", "always", "never"]).optional().describe("auto (default): grids only when the transcript cannot carry the content (silent, screen recording, sparse speech)."),
  language: z.string().optional().describe("Transcript language hint, default auto."),
});

const segment = z.object({ start_s: z.number(), end_s: z.number(), text: z.string() });

export const understandMediaOutput = z.object({
  source: z.string(),
  kind: z.enum(["video", "audio", "image", "unknown"]),
  duration_s: z.number().optional(),
  looks_like_screen_recording: z.boolean(),
  audio: z.object({ speech_ratio: z.number().optional(), integrated_lufs: z.number().optional(), silence_total_s: z.number() }).optional(),
  transcript: z
    .object({
      transcription_source: z.string(),
      language: z.string(),
      segment_count: z.number(),
      segments: z.array(segment),
      text: untrustedText,
      covered_s: z.number(),
      has_more: z.boolean(),
      next_window: z.object({ start_s: z.number(), end_s: z.number() }).optional(),
    })
    .optional(),
  scenes: z
    .object({ cut_count: z.number(), cuts_per_minute: z.number(), hook_cuts: z.number(), first_cut_s: z.number().optional(), fallback_uniform: z.boolean() })
    .optional(),
  grids: z
    .object({ count: z.number(), cells: z.number(), manifest: z.array(manifestEntry), frames_sampled: z.number() })
    .optional(),
  decisions: z.array(z.string()),
  budget: z.object({ max_total_chars: z.number(), used_chars: z.number() }),
  ...commonOutput,
});

export type UnderstandMediaInput = z.infer<typeof understandMediaInput>;
export type UnderstandMediaResult = z.infer<typeof understandMediaOutput>;

/**
 * One-call orchestration, transcript-first with lazy visual verification
 * (harvest-agentic #7): probe deep, transcript, scenes, and grids only when
 * the words cannot carry the content. Every skipped step is explained in
 * `decisions` so the model knows what to call next.
 */
export async function understandMedia(config: Config, input: UnderstandMediaInput): Promise<{ result: UnderstandMediaResult; images: Array<{ data: Buffer; mimeType: string }> }> {
  const budget = input.max_total_chars ?? 60_000;
  const maxGrids = input.max_grids ?? 2;
  const visual = input.visual ?? "auto";
  const decisions: string[] = [];
  const warnings: string[] = [];
  const images: Array<{ data: Buffer; mimeType: string }> = [];

  const probe = await probeMedia(config, { source: input.source, deep: true });
  warnings.push(...probe.warnings);
  if (probe.kind === "image") {
    throw new MediaIntelError("not_time_based", "understand_media is for audio and video", "For images use probe_image and extract_text.");
  }
  if (probe.kind === "unknown") throw new MediaIntelError("unknown_media", "Could not classify this file");

  let used = 0;
  const result: UnderstandMediaResult = {
    source: input.source,
    kind: probe.kind,
    ...(probe.duration_s !== undefined ? { duration_s: probe.duration_s } : {}),
    looks_like_screen_recording: probe.looks_like_screen_recording,
    ...(probe.audio_deep
      ? {
          audio: {
            ...(probe.audio_deep.speech_ratio !== undefined ? { speech_ratio: probe.audio_deep.speech_ratio } : {}),
            ...(probe.audio_deep.integrated_lufs !== undefined ? { integrated_lufs: probe.audio_deep.integrated_lufs } : {}),
            silence_total_s: probe.audio_deep.silence_total_s,
          },
        }
      : {}),
    decisions,
    budget: { max_total_chars: budget, used_chars: 0 },
    warnings,
    suggested_next: [],
  };

  // 1. Transcript first.
  let transcriptChars = 0;
  if (probe.stream_counts.audio > 0) {
    const speechRatio = probe.audio_deep?.speech_ratio;
    if (speechRatio !== undefined && speechRatio < 0.05) {
      decisions.push(`transcript skipped: speech ratio ${speechRatio} (silence)`);
    } else {
      try {
        const tr = await getTranscript(config, getTranscriptInput.parse({ source: input.source, format: "json", ...(input.language !== undefined ? { language: input.language } : {}) }));
        const rendered = tr.segments.map((s) => `[${round3(s.start_s)}s] ${s.text}`).join("\n");
        const allowed = Math.max(1000, budget - 4000);
        const text = wrapUntrusted(rendered, Math.min(allowed, config.maxTextFieldChars * 4));
        transcriptChars = text.text.length;
        used += transcriptChars;
        result.transcript = {
          transcription_source: tr.transcription_source,
          language: tr.language,
          segment_count: tr.segments.length,
          segments: tr.segments,
          text,
          covered_s: round3(tr.window_end_s - tr.window_start_s),
          has_more: tr.has_more,
          ...(tr.next_window ? { next_window: tr.next_window } : {}),
        };
        decisions.push(`transcript via ${tr.transcription_source} (${tr.segments.length} segments, ${transcriptChars} chars${tr.has_more ? ", more windows available" : ""})`);
        if (tr.has_more) result.suggested_next.push(`get_transcript window ${tr.next_window?.start_s}-${tr.next_window?.end_s}`);
        warnings.push(...tr.warnings);
      } catch (error) {
        const msg = error instanceof MediaIntelError ? `${error.code}: ${error.message}` : String(error);
        decisions.push(`transcript failed: ${msg}`);
        warnings.push(`Transcript unavailable (${msg}). Run doctor to see which transcription backends are ready.`);
      }
    }
  } else {
    decisions.push("transcript skipped: no audio stream");
  }

  // 2. Scenes (video only) as a cheap structural signal.
  if (probe.kind === "video") {
    try {
      const sc = await getScenes(config, { source: input.source });
      result.scenes = {
        cut_count: sc.metrics.cut_count,
        cuts_per_minute: sc.metrics.cuts_per_minute,
        hook_cuts: sc.hook.cut_count,
        ...(sc.hook.first_cut_s !== undefined ? { first_cut_s: sc.hook.first_cut_s } : {}),
        fallback_uniform: sc.fallback_uniform,
      };
      decisions.push(`scenes: ${sc.metrics.cut_count} cuts, ${sc.metrics.cuts_per_minute}/min`);
    } catch (error) {
      decisions.push(`scenes skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 3. Lazy visual verification.
  if (probe.kind === "video" && maxGrids > 0) {
    const sparse = transcriptChars < 800;
    const wantVisual = visual === "always" || (visual === "auto" && (sparse || probe.looks_like_screen_recording));
    if (!wantVisual) {
      decisions.push("grids skipped: transcript carries the content (call get_video_grids for specific windows if a claim needs visual proof)");
      result.suggested_next.push("get_video_grids window=<time range> when a statement needs visual evidence");
    } else {
      const cells = input.cells ?? (probe.looks_like_screen_recording ? 16 : 64);
      try {
        const gr = await getVideoGrids(config, getVideoGridsInput.parse({ source: input.source, cells, max_frames: cells * maxGrids }));
        const grids = gr.grids.slice(0, maxGrids);
        for (const g of grids) images.push({ data: await readFile(g.cache_path), mimeType: `image/${g.format === "jpeg" ? "jpeg" : g.format}` });
        result.grids = { count: grids.length, cells, manifest: gr.manifest.filter((m) => m.grid_index < grids.length), frames_sampled: gr.frames_sampled };
        decisions.push(`grids: ${grids.length} x ${cells} cells because ${sparse ? "transcript is sparse" : "screen recording"}`);
        if (gr.pagination.has_more) result.suggested_next.push(`get_video_grids window ${gr.pagination.next_window?.start_s}-${gr.pagination.next_window?.end_s}`);
        warnings.push(...gr.warnings);
      } catch (error) {
        decisions.push(`grids failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else if (probe.kind === "video") {
    decisions.push("grids skipped: max_grids=0");
  }

  if (probe.looks_like_screen_recording) result.suggested_next.push("extract_text at cut timestamps (png, full resolution)");
  if (result.scenes && result.scenes.cut_count > 0) result.suggested_next.push("analyze_moment at the strongest cut");
  result.budget.used_chars = used;
  return { result, images };
}

export function summarizeUnderstand(r: UnderstandMediaResult): string {
  const parts = [
    `${r.kind}${r.duration_s !== undefined ? ` ${round3(r.duration_s)}s` : ""}` +
      (r.audio?.speech_ratio !== undefined ? ` | speech ${Math.round(r.audio.speech_ratio * 100)}%` : "") +
      (r.scenes ? ` | ${r.scenes.cut_count} cuts (${r.scenes.cuts_per_minute}/min)` : "") +
      (r.grids ? ` | ${r.grids.count} grid(s) x ${r.grids.cells}` : "") +
      (r.looks_like_screen_recording ? " | screen recording" : ""),
    `Decisions:\n- ${r.decisions.join("\n- ")}`,
  ];
  if (r.transcript) parts.push(frameUntrusted(`Transcript (${r.transcript.transcription_source}, ${r.transcript.language}, ${r.transcript.covered_s}s covered${r.transcript.has_more ? ", more available" : ""})`, r.transcript.text));
  if (r.grids) parts.push(`Grid manifest: cell -> seconds, row-major from top-left; ${r.grids.manifest.length} entries in structuredContent.grids.manifest`);
  if (r.warnings.length > 0) parts.push(`Warnings:\n- ${r.warnings.join("\n- ")}`);
  if (r.suggested_next.length > 0) parts.push(`Suggested next: ${r.suggested_next.join("; ")}`);
  return parts.join("\n");
}

export function registerUnderstandMedia(server: McpServer, config: Config): void {
  server.registerTool(
    "understand_media",
    {
      title: "Understand media",
      description:
        "One call to understand a file: deep probe, transcript first (free backends before paid), scene structure, and contact sheets " +
        "only when words cannot carry the content (silent, sparse speech, screen recordings) or visual=always. Explains every decision " +
        "and points to the precise tool for the next step. Budgeted by max_total_chars and max_grids.",
      inputSchema: understandMediaInput,
      outputSchema: understandMediaOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { result, images } = await understandMedia(config, args);
        return {
          content: [{ type: "text", text: summarizeUnderstand(result) }, ...images.map((i) => ({ type: "image" as const, data: i.data.toString("base64"), mimeType: i.mimeType }))],
          structuredContent: result,
        };
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );
}
