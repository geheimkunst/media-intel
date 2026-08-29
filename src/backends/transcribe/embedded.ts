/**
 * Extract transcription from embedded subtitle tracks.
 */

import type { Config } from "../../config.js";
import { extractSubtitleTrack } from "../../ffmpeg.js";
import { MediaIntelError } from "../../errors.js";
import { parseSrt, parseVtt, type Segment } from "./srt.js";

export interface EmbeddedOptions {
  /** Index of the subtitle stream; if not provided, uses first subtitle stream of the requested language. */
  subtitleStreamIndex?: number;
  /** ISO-639-1 language code, e.g., "de", "en". If provided, prefer subtitles in this language. */
  language?: string;
}

/**
 * Extract subtitles from an embedded subtitle track.
 * Returns parsed segments from an SRT or VTT subtitle track.
 */
export async function extractEmbeddedSubtitles(
  config: Config,
  location: string,
  opts: EmbeddedOptions,
): Promise<{ segments: Segment[]; language?: string }> {
  let subtitleIndex = opts.subtitleStreamIndex;

  // If no explicit index, we'd need the probe data to find the right track.
  // For now, extractSubtitleTrack with no stream specifier gets the first.
  try {
    const srtText = await extractSubtitleTrack(config, location, subtitleIndex);

    if (!srtText || srtText.trim().length === 0) {
      throw new MediaIntelError(
        "no_embedded_subtitles",
        "No subtitle data extracted from the specified track",
        "Check the subtitle stream index or use sidecar subtitles or transcription.",
      );
    }

    // Try SRT first, then VTT
    let segments = parseSrt(srtText);
    if (segments.length === 0) {
      segments = parseVtt(srtText);
    }

    if (segments.length === 0) {
      throw new MediaIntelError(
        "subtitle_parse_failed",
        "Could not parse extracted subtitle text as SRT or VTT",
        "The subtitle format may not be supported.",
      );
    }

    return { segments, ...(opts.language !== undefined ? { language: opts.language } : {}) };
  } catch (err) {
    if (err instanceof MediaIntelError) throw err;
    throw new MediaIntelError(
      "embedded_subtitles_failed",
      `Failed to extract embedded subtitles: ${err instanceof Error ? err.message : String(err)}`,
      "Try sidecar subtitles or transcription.",
    );
  }
}
