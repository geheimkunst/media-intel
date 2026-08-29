/**
 * Discover and parse sidecar subtitle files (.srt, .vtt, .{lang}.srt, .{lang}.vtt).
 */

import { readFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import * as fs from "node:fs/promises";
import { MediaIntelError } from "../../errors.js";
import { parseSrt, parseVtt, type Segment } from "./srt.js";

export interface SidecarOptions {
  language?: string;
}

/**
 * Find sidecar subtitle files next to a local media source.
 * Looks for:
 * - <basename>.srt / .vtt (generic)
 * - <basename>.<lang>.srt / .vtt (language-specific)
 *
 * Prefer manual subtitles over auto, and requested language over others.
 */
export async function findSidecarSubtitles(location: string, opts: SidecarOptions): Promise<string | null> {
  // Only works for local files
  if (!location.startsWith("/")) return null;

  const dir = dirname(location);
  const base = basename(location);
  const nameWithoutExt = base.replace(/\.[^.]+$/, "");

  // Candidates, in priority order
  const candidates = [];

  if (opts.language) {
    // Preferred language, explicit
    candidates.push(
      `${nameWithoutExt}.${opts.language}.srt`,
      `${nameWithoutExt}.${opts.language}.vtt`,
      `${nameWithoutExt}.${opts.language}.auto.srt`,
      `${nameWithoutExt}.${opts.language}.auto.vtt`,
    );
  }

  // Fallback: any language-specific, prefer manual over auto
  candidates.push(`${nameWithoutExt}.*.srt`, `${nameWithoutExt}.*.vtt`, `${nameWithoutExt}.*.auto.srt`, `${nameWithoutExt}.*.auto.vtt`);

  // Generic
  candidates.push(`${nameWithoutExt}.srt`, `${nameWithoutExt}.vtt`);

  // Try each candidate with literal patterns and glob
  for (const cand of candidates) {
    if (cand.includes("*")) {
      // Glob pattern: read directory and match
      try {
        const entries = await fs.readdir(dir);
        const pattern = cand
          .replace(/\./g, "\\.")
          .replace(/\*/g, ".*");
        const regex = new RegExp(`^${pattern}$`);
        const match = entries.find((e) => regex.test(e));
        if (match) {
          const path = join(dir, match);
          const content = await readFile(path, "utf-8");
          return content;
        }
      } catch {
        // Silently continue
      }
    } else {
      // Literal file
      try {
        const path = join(dir, cand);
        const content = await readFile(path, "utf-8");
        return content;
      } catch {
        // Silently continue
      }
    }
  }

  return null;
}

/**
 * Load sidecar subtitles from a local file.
 */
export async function extractSidecarSubtitles(location: string, opts: SidecarOptions): Promise<{ segments: Segment[]; language?: string } | null> {
  const content = await findSidecarSubtitles(location, opts);
  if (!content) return null;

  // Try to detect language from filename
  let detectedLang = opts.language;
  const base = basename(location);
  const nameWithoutExt = base.replace(/\.[^.]+$/, "");
  if (!detectedLang) {
    const langMatch = nameWithoutExt.match(/\.([a-z]{2})(?:\.auto)?\.(?:srt|vtt)$/);
    if (langMatch) detectedLang = langMatch[1];
  }

  // Parse SRT or VTT
  let segments = parseSrt(content);
  if (segments.length === 0) {
    segments = parseVtt(content);
  }

  if (segments.length === 0) {
    return null;
  }

  return { segments, ...(detectedLang !== undefined ? { language: detectedLang } : {}) };
}
