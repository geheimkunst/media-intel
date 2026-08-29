/**
 * SRT/VTT parser and formatter.
 * Parses both formats and converts to a common segment structure.
 */

export interface Segment {
  start_s: number;
  end_s: number;
  text: string;
}

/**
 * Parse SRT format: sequential subtitle blocks separated by blank lines.
 * Each block: index, time range, text (one or more lines).
 */
export function parseSrt(srtText: string): Segment[] {
  const segments: Segment[] = [];
  const blocks = srtText.split(/\n\s*\n/).filter((b) => b.trim().length > 0);

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 2) continue;

    // Try to find the timecode line (skip index if present)
    let timelineIdx = lines.findIndex((l) => l.includes("-->"));
    if (timelineIdx === -1) continue;

    const timeLine = lines[timelineIdx];
    const times = timeLine.split("-->").map((t) => t.trim());
    if (times.length !== 2) continue;

    const start = parseTimeCode(times[0]);
    const end = parseTimeCode(times[1]);
    if (start === null || end === null) continue;

    const textLines = lines.slice(timelineIdx + 1).filter((l) => l.trim().length > 0);
    const text = textLines.join("\n");

    segments.push({ start_s: start, end_s: end, text });
  }

  return segments;
}

/**
 * Parse VTT format: WEBVTT header, then similar to SRT but with optional cues.
 */
export function parseVtt(vttText: string): Segment[] {
  const lines = vttText.split("\n");
  const segments: Segment[] = [];

  // Skip header and NOTE blocks
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("WEBVTT")) {
      i++;
      break;
    }
    if (line.startsWith("NOTE")) {
      // Skip until next blank line
      while (i < lines.length && lines[i].trim().length > 0) i++;
      i++;
      continue;
    }
    i++;
  }

  // Parse cues
  while (i < lines.length) {
    const line = lines[i];

    if (line.includes("-->")) {
      const times = line.split("-->").map((t) => t.trim());
      if (times.length === 2) {
        const start = parseTimeCode(times[0]);
        const end = parseTimeCode(times[1]);
        if (start !== null && end !== null) {
          const textLines: string[] = [];
          i++;
          while (i < lines.length && lines[i].trim().length > 0) {
            textLines.push(lines[i]);
            i++;
          }
          const text = textLines.join("\n");
          segments.push({ start_s: start, end_s: end, text });
        }
      }
    }
    i++;
  }

  return segments;
}

/**
 * Parse a timecode in HH:MM:SS,mmm or HH:MM:SS.mmm format (SRT/VTT).
 */
export function parseTimeCode(tc: string): number | null {
  // Replace comma with dot for consistency
  const normalized = tc.replace(",", ".");
  const parts = normalized.split(":");
  if (parts.length !== 3) return null;

  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const s = parseFloat(parts[2]);

  if (isNaN(h) || isNaN(m) || isNaN(s)) return null;
  return h * 3600 + m * 60 + s;
}

/**
 * Format seconds as HH:MM:SS,mmm for SRT.
 */
export function formatTimeCodeSrt(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const ms = Math.round((s % 1) * 1000);
  const sInt = Math.floor(s);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sInt).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

/**
 * Encode segments as SRT format.
 */
export function encodeSrt(segments: Segment[]): string {
  const lines: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    lines.push(String(i + 1));
    lines.push(`${formatTimeCodeSrt(seg.start_s)} --> ${formatTimeCodeSrt(seg.end_s)}`);
    lines.push(seg.text);
    if (i < segments.length - 1) lines.push("");
  }
  return lines.join("\n");
}

/**
 * Format seconds as HH:MM:SS.mmm for VTT.
 */
export function formatTimeCodeVtt(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const ms = Math.round((s % 1) * 1000);
  const sInt = Math.floor(s);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sInt).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

/**
 * Encode segments as VTT format.
 */
export function encodeVtt(segments: Segment[]): string {
  const lines: string[] = ["WEBVTT"];
  lines.push("");
  for (const seg of segments) {
    lines.push(`${formatTimeCodeVtt(seg.start_s)} --> ${formatTimeCodeVtt(seg.end_s)}`);
    lines.push(seg.text);
    lines.push("");
  }
  return lines.join("\n");
}
