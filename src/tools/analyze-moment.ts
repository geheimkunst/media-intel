import type { McpServer } from "@modelcontextprotocol/server";
import { readFile } from "node:fs/promises";
import * as z from "zod/v4";
import type { Config } from "../config.js";
import { commonOutput, frameUntrusted, manifestEntry, round3, untrustedText, wrapUntrusted } from "../contracts.js";
import { MediaIntelError, toolErrorResult } from "../errors.js";
import { ffprobe, parseNumber } from "../ffmpeg.js";
import { resolveSource } from "../source.js";
import { extractText } from "./extract-text.js";
import { getFrames, getFramesInput } from "./get-frames.js";
import { getTranscript, getTranscriptInput } from "./get-transcript.js";

export const analyzeMomentInput = z.object({
  source: z.string().min(1).describe("Local video path, file:// URL, or direct http(s) URL."),
  t_s: z.number().nonnegative().describe("The moment of interest in seconds."),
  span_s: z.number().min(0.2).max(60).optional().describe("Total width of the window around t_s for frames. Default 3."),
  burst: z.number().int().min(1).max(16).optional().describe("Number of frames spread across the window. Default 5."),
  transcript_pad_s: z.number().min(0).max(120).optional().describe("Seconds of transcript before and after t_s. Default 15."),
  frame_format: z.enum(["jpeg", "png", "webp"]).optional().describe("Default jpeg; png for UI text."),
  max_width: z.number().int().min(0).max(4096).optional().describe("Frame width. Default 1024, 0 = original."),
  ocr: z.boolean().optional().describe("Also OCR the frame closest to t_s. Default false."),
  ocr_language: z.string().optional().describe("tesseract languages for OCR, default from config."),
});

const frameInfo = z.object({ t_s: z.number(), requested_t_s: z.number(), width: z.number(), height: z.number(), bytes: z.number(), format: z.enum(["jpeg", "png", "webp"]), cache_path: z.string() });
const segment = z.object({ start_s: z.number(), end_s: z.number(), text: z.string() });
const ocrLine = z.object({ text: z.string(), confidence: z.number(), box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }) });

export const analyzeMomentOutput = z.object({
  source: z.string(),
  t_s: z.number(),
  window: z.object({ start_s: z.number(), end_s: z.number() }),
  frames: z.array(frameInfo),
  manifest: z.array(manifestEntry),
  transcript: z
    .object({
      transcription_source: z.string(),
      language: z.string(),
      segments: z.array(segment),
      text: untrustedText,
    })
    .optional(),
  ocr: z
    .object({
      t_s: z.number(),
      text: untrustedText,
      lines: z.array(ocrLine),
      mean_confidence: z.number(),
    })
    .optional(),
  ...commonOutput,
});

export type AnalyzeMomentInput = z.infer<typeof analyzeMomentInput>;
export type AnalyzeMomentResult = z.infer<typeof analyzeMomentOutput>;

/**
 * Deep-dive on one timestamp: a burst of frames around it, the transcript
 * around it, optional OCR on the nearest frame. Composes the tier-3 tools.
 */
export async function analyzeMoment(config: Config, input: AnalyzeMomentInput): Promise<{ result: AnalyzeMomentResult; images: Array<{ data: Buffer; mimeType: string }> }> {
  const resolved = await resolveSource(input.source);
  const probe = await ffprobe(config, resolved.location);
  const duration = parseNumber(probe.format?.duration);
  const hasVideo = (probe.streams ?? []).some((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const hasAudio = (probe.streams ?? []).some((s) => s.codec_type === "audio");
  if (duration !== undefined && input.t_s > duration) {
    throw new MediaIntelError("timestamp_out_of_range", `t_s ${input.t_s} is beyond the duration ${round3(duration)}s`);
  }

  const span = input.span_s ?? 3;
  const burst = input.burst ?? 5;
  const pad = input.transcript_pad_s ?? 15;
  const start = Math.max(0, input.t_s - span / 2);
  const end = duration !== undefined ? Math.min(duration, input.t_s + span / 2) : input.t_s + span / 2;
  const warnings: string[] = [];
  const images: Array<{ data: Buffer; mimeType: string }> = [];

  let frames: AnalyzeMomentResult["frames"] = [];
  let manifest: AnalyzeMomentResult["manifest"] = [];
  if (hasVideo) {
    const timestamps: number[] = [];
    for (let i = 0; i < burst; i += 1) {
      const t = burst === 1 ? input.t_s : start + ((end - start) * i) / (burst - 1);
      timestamps.push(round3(Math.min(t, duration !== undefined ? Math.max(0, duration - 0.05) : t)));
    }
    const unique = [...new Set(timestamps)];
    const fr = await getFrames(
      config,
      getFramesInput.parse({
        source: input.source,
        timestamps: unique,
        ...(input.frame_format !== undefined ? { frame_format: input.frame_format } : {}),
        ...(input.max_width !== undefined ? { max_width: input.max_width } : {}),
      }),
    );
    frames = fr.frames;
    manifest = fr.manifest;
    warnings.push(...fr.warnings);
    for (const f of frames) {
      images.push({ data: await readFile(f.cache_path), mimeType: `image/${f.format === "jpeg" ? "jpeg" : f.format}` });
    }
  } else {
    warnings.push("No video stream: frames skipped.");
  }

  let transcript: AnalyzeMomentResult["transcript"];
  if (hasAudio) {
    try {
      const tr = await getTranscript(
        config,
        getTranscriptInput.parse({ source: input.source, window: { start_s: Math.max(0, input.t_s - pad), end_s: input.t_s + pad }, format: "json" }),
      );
      transcript = { transcription_source: tr.transcription_source, language: tr.language, segments: tr.segments, text: wrapUntrusted(tr.segments.map((s) => `[${round3(s.start_s)}s] ${s.text}`).join("\n"), config.maxTextFieldChars) };
      warnings.push(...tr.warnings);
    } catch (error) {
      warnings.push(`Transcript unavailable: ${error instanceof MediaIntelError ? `${error.code} ${error.message}` : String(error)}`);
    }
  } else {
    warnings.push("No audio stream: transcript skipped.");
  }

  let ocr: AnalyzeMomentResult["ocr"];
  if (input.ocr && hasVideo) {
    try {
      const nearest = frames.reduce((best, f) => (Math.abs(f.t_s - input.t_s) < Math.abs(best.t_s - input.t_s) ? f : best), frames[0] ?? { t_s: input.t_s });
      const ex = await extractText(config, { source: input.source, timestamps: [nearest.t_s], ...(input.ocr_language !== undefined ? { language: input.ocr_language } : {}) });
      const r = ex.results[0];
      if (r) ocr = { t_s: r.t_s ?? nearest.t_s, text: r.text, lines: r.lines, mean_confidence: r.mean_confidence };
      warnings.push(...ex.warnings);
    } catch (error) {
      warnings.push(`OCR unavailable: ${error instanceof MediaIntelError ? `${error.code} ${error.message}` : String(error)}`);
    }
  }

  const result: AnalyzeMomentResult = {
    source: input.source,
    t_s: input.t_s,
    window: { start_s: round3(start), end_s: round3(end) },
    frames,
    manifest,
    ...(transcript ? { transcript } : {}),
    ...(ocr ? { ocr } : {}),
    warnings,
    suggested_next: ["diff_frames between the first and last burst frame", "get_scenes to find neighbouring cuts"],
  };
  return { result, images };
}

export function summarizeMoment(r: AnalyzeMomentResult): string {
  const head = `Moment ${r.t_s}s: ${r.frames.length} frames ${r.window.start_s}-${r.window.end_s}s` + (r.transcript ? `, transcript ${r.transcript.segments.length} segments (${r.transcript.transcription_source})` : "") + (r.ocr ? `, OCR ${r.ocr.lines.length} lines (conf ${Math.round(r.ocr.mean_confidence)})` : "");
  const parts = [head];
  if (r.frames.length > 0) parts.push(`Frames: ${r.frames.map((f) => `${f.t_s}s`).join(", ")} (manifest cell_index in order)`);
  if (r.transcript) parts.push(frameUntrusted("Transcript around the moment", r.transcript.text));
  if (r.ocr) parts.push(frameUntrusted(`OCR at ${r.ocr.t_s}s`, r.ocr.text));
  if (r.warnings.length > 0) parts.push(`Warnings:\n- ${r.warnings.join("\n- ")}`);
  return parts.join("\n");
}

export function registerAnalyzeMoment(server: McpServer, config: Config): void {
  server.registerTool(
    "analyze_moment",
    {
      title: "Analyze moment",
      description:
        "Deep-dive on one timestamp: a burst of frames around it (default 5 across 3 s), the transcript 15 s before and after, " +
        "and optionally OCR of the nearest frame. Use after get_scenes, get_engagement (most_replayed) or media_search pointed you at a time.",
      inputSchema: analyzeMomentInput,
      outputSchema: analyzeMomentOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { result, images } = await analyzeMoment(config, args);
        return {
          content: [{ type: "text", text: summarizeMoment(result) }, ...images.map((i) => ({ type: "image" as const, data: i.data.toString("base64"), mimeType: i.mimeType }))],
          structuredContent: result,
        };
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );
}
