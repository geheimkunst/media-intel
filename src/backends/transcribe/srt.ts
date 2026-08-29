/**
 * SRT/VTT parser and formatter. Both formats map onto one Segment shape.
 */

export interface Segment {
  start_s: number;
  end_s: number;
  text: string;
}

/**
 * Parse SRT: blocks separated by blank lines, each with an optional index,
 * a "start --> end" line and one or more text lines.
 */
export function parseSrt(srtText: string): Segment[] {
  const segments: Segment[] = [];
  const blocks = srtText.replace(/\r\n?/g, "\n").split(/\n\s*\n/).filter((b) => b.trim().length > 0);

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 2) continue;
    const timelineIdx = lines.findIndex((l) => l.includes("-->"));
    if (timelineIdx === -1) continue;
    const timeLine = lines[timelineIdx] ?? "";
    const times = timeLine.split("-->").map((t) => t.trim());
    const startRaw = times[0];
    const endRaw = times[1];
    if (times.length !== 2 || startRaw === undefined || endRaw === undefined) continue;
    const start = parseTimeCode(startRaw);
    const end = parseTimeCode(endRaw.split(/\s+/)[0] ?? endRaw);
    if (start === null || end === null) continue;
    const text = lines
      .slice(timelineIdx + 1)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join("\n");
    segments.push({ start_s: start, end_s: end, text });
  }
  return segments;
}

/**
 * Parse WebVTT: header, optional NOTE/STYLE blocks, then cues whose time
 * line may carry positioning settings after the end time.
 */
export function parseVtt(vttText: string): Segment[] {
  const lines = vttText.replace(/\r\n?/g, "\n").split("\n");
  const segments: Segment[] = [];
  let i = 0;

  // Header and leading blocks (NOTE, STYLE, REGION) up to the first cue.
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("WEBVTT")) {
      i += 1;
      continue;
    }
    if (line.startsWith("NOTE") || line.startsWith("STYLE") || line.startsWith("REGION")) {
      while (i < lines.length && (lines[i] ?? "").trim().length > 0) i += 1;
      i += 1;
      continue;
    }
    if (line.includes("-->")) break;
    i += 1;
  }

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.includes("-->")) {
      const times = line.split("-->").map((t) => t.trim());
      const startRaw = times[0];
      const endRaw = times[1];
      if (times.length === 2 && startRaw !== undefined && endRaw !== undefined) {
        const start = parseTimeCode(startRaw);
        const end = parseTimeCode(endRaw.split(/\s+/)[0] ?? endRaw);
        if (start !== null && end !== null) {
          const textLines: string[] = [];
          i += 1;
          while (i < lines.length && (lines[i] ?? "").trim().length > 0) {
            textLines.push(stripVttTags(lines[i] ?? ""));
            i += 1;
          }
          const text = textLines.join("\n").trim();
          if (text.length > 0) segments.push({ start_s: start, end_s: end, text });
          continue;
        }
      }
    }
    i += 1;
  }
  return dedupeConsecutive(segments);
}

/** Remove <c>, <v Speaker>, <00:00:01.000> inline tags that YouTube auto captions carry. */
function stripVttTags(line: string): string {
  return line.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** YouTube auto captions repeat the previous line in the next cue; drop exact consecutive duplicates. */
function dedupeConsecutive(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    const prev = out[out.length - 1];
    if (prev && prev.text === seg.text) {
      prev.end_s = Math.max(prev.end_s, seg.end_s);
      continue;
    }
    out.push({ ...seg });
  }
  return out;
}

/** Parse HH:MM:SS,mmm / HH:MM:SS.mmm / MM:SS.mmm into seconds. */
export function parseTimeCode(tc: string): number | null {
  const normalized = tc.trim().replace(",", ".");
  const parts = normalized.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  if (nums.length === 2) {
    const [m, s] = nums as [number, number];
    return m * 60 + s;
  }
  const [h, m, s] = nums as [number, number, number];
  return h * 3600 + m * 60 + s;
}

function splitSeconds(seconds: number): { h: string; m: string; s: string; ms: string } {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sInt = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  return {
    h: String(h).padStart(2, "0"),
    m: String(m).padStart(2, "0"),
    s: String(sInt).padStart(2, "0"),
    ms: String(Math.min(999, ms)).padStart(3, "0"),
  };
}

export function formatTimeCodeSrt(seconds: number): string {
  const t = splitSeconds(seconds);
  return `${t.h}:${t.m}:${t.s},${t.ms}`;
}

export function formatTimeCodeVtt(seconds: number): string {
  const t = splitSeconds(seconds);
  return `${t.h}:${t.m}:${t.s}.${t.ms}`;
}

export function encodeSrt(segments: Segment[]): string {
  const lines: string[] = [];
  segments.forEach((seg, i) => {
    lines.push(String(i + 1));
    lines.push(`${formatTimeCodeSrt(seg.start_s)} --> ${formatTimeCodeSrt(seg.end_s)}`);
    lines.push(seg.text);
    if (i < segments.length - 1) lines.push("");
  });
  return lines.join("\n");
}

export function encodeVtt(segments: Segment[]): string {
  const lines: string[] = ["WEBVTT", ""];
  for (const seg of segments) {
    lines.push(`${formatTimeCodeVtt(seg.start_s)} --> ${formatTimeCodeVtt(seg.end_s)}`);
    lines.push(seg.text);
    lines.push("");
  }
  return lines.join("\n");
}
