import * as z from "zod/v4";

/**
 * Contracts shared by every tool. See docs/architecture.md A13, A14, A15.
 *
 * - Untrusted text: anything that came out of a medium (transcript, OCR,
 *   subtitles, comments, titles) is attacker-controlled input for the model
 *   reading it. It is carried in explicit fields, length-capped, and framed
 *   with fixed markers in the human-readable block.
 * - Pagination: long media is consumed in time windows; every windowed tool
 *   says where it stopped and where to continue.
 * - Manifest: timestamps are data, never only pixels.
 */

export const UNTRUSTED_BEGIN = "<<<MEDIA_TEXT_BEGIN untrusted>>>";
export const UNTRUSTED_END = "<<<MEDIA_TEXT_END>>>";

export const untrustedText = z.object({
  text: z.string(),
  source_trust: z.literal("untrusted"),
  truncated: z.boolean(),
  chars: z.number().int().nonnegative(),
});
export type UntrustedText = z.infer<typeof untrustedText>;

/** Cap and tag a text that originated from media content. */
export function wrapUntrusted(raw: string, maxChars: number): UntrustedText {
  const chars = raw.length;
  const truncated = chars > maxChars;
  return {
    text: truncated ? raw.slice(0, maxChars) : raw,
    source_trust: "untrusted",
    truncated,
    chars,
  };
}

/** Frame an untrusted text for the human-readable content block. */
export function frameUntrusted(label: string, t: UntrustedText): string {
  const note = t.truncated ? ` (truncated to ${t.text.length} of ${t.chars} chars)` : "";
  return `${label}${note}:\n${UNTRUSTED_BEGIN}\n${t.text}\n${UNTRUSTED_END}`;
}

export const pagination = z.object({
  total_duration_s: z.number().optional(),
  window_start_s: z.number(),
  window_end_s: z.number(),
  has_more: z.boolean(),
  /** Pass this as `window` to continue. */
  next_window: z.object({ start_s: z.number(), end_s: z.number() }).optional(),
});
export type Pagination = z.infer<typeof pagination>;

export const windowInput = z
  .object({
    start_s: z.number().nonnegative().describe("Window start in seconds."),
    end_s: z.number().positive().optional().describe("Window end in seconds; omit for 'until the end or budget'."),
  })
  .describe("Time window to process. Omit for the whole file (subject to budgets).");
export type WindowInput = z.infer<typeof windowInput>;

/**
 * Resolve a requested window against the known duration and a maximum span.
 * Returns the effective window plus pagination fields.
 */
export function resolveWindow(
  requested: WindowInput | undefined,
  totalDurationS: number | undefined,
  maxSpanS: number,
): { start_s: number; end_s: number; pagination: Pagination } {
  const start = requested?.start_s ?? 0;
  const hardEnd = totalDurationS ?? Number.POSITIVE_INFINITY;
  const wantedEnd = Math.min(requested?.end_s ?? hardEnd, hardEnd);
  const end = Math.min(wantedEnd, start + maxSpanS);
  const hasMore = end < wantedEnd - 1e-6;
  const base = {
    window_start_s: round3(start),
    window_end_s: round3(end === Number.POSITIVE_INFINITY ? start + maxSpanS : end),
    has_more: hasMore,
  };
  const pag: Pagination = {
    ...base,
    ...(totalDurationS !== undefined ? { total_duration_s: round3(totalDurationS) } : {}),
    ...(hasMore ? { next_window: { start_s: round3(end), end_s: round3(Math.min(end + maxSpanS, wantedEnd)) } } : {}),
  };
  return { start_s: start, end_s: base.window_end_s, pagination: pag };
}

export const manifestEntry = z.object({
  grid_index: z.number().int().nonnegative(),
  cell_index: z.number().int().nonnegative(),
  t_s: z.number().nonnegative(),
});
export type ManifestEntry = z.infer<typeof manifestEntry>;

/** Common trailing fields on every tool output. */
export const commonOutput = {
  warnings: z.array(z.string()),
  suggested_next: z.array(z.string()),
};

export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Duration-based frame budget (claude-video heuristic, harvest-agentic #2).
 * Returns how many frames a whole-file sampling should use before grids.
 */
export function defaultFrameBudget(durationS: number | undefined): number {
  if (durationS === undefined) return 30;
  if (durationS <= 30) return 30;
  if (durationS <= 60) return 40;
  if (durationS <= 180) return 60;
  if (durationS <= 600) return 80;
  if (durationS <= 1800) return 100;
  return 128;
}

/** Evenly spaced sample timestamps inside [start, end), never on the exact edges. */
export function sampleTimestamps(startS: number, endS: number, count: number): number[] {
  const span = Math.max(0, endS - startS);
  if (count <= 0 || span === 0) return [];
  const step = span / count;
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) out.push(round3(startS + step * (i + 0.5)));
  return out;
}
