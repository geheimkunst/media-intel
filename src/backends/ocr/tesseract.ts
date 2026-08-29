import type { Config } from "../../config.js";
import { MediaIntelError } from "../../errors.js";
import { runBinary } from "../../process.js";
import { findBinary } from "../../binaries.js";

/**
 * A single word as parsed from tesseract TSV output.
 */
export interface TesseractWord {
  text: string;
  confidence: number; // 0..100
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A line of text, grouped from words.
 */
export interface TextLine {
  text: string;
  confidence: number; // mean of word confidences
  box: { x: number; y: number; width: number; height: number };
}

/**
 * Result of OCR on a single image.
 */
export interface OcrResult {
  text: string;
  lines: TextLine[];
  word_count: number;
  mean_confidence: number;
  image_width: number;
  image_height: number;
}

/**
 * Parsed row from tesseract TSV output (level 5 = words).
 * Format: level page_num block_num par_num line_num word_num left top width height conf text
 */
interface TsvRow {
  level: number;
  block_num: number;
  par_num: number;
  line_num: number;
  word_num: number;
  left: number;
  top: number;
  width: number;
  height: number;
  conf: number;
  text: string;
}

/**
 * Parse a single TSV line (1-indexed, skip header).
 */
function parseTsvLine(line: string): TsvRow | undefined {
  const parts = line.split("\t");
  if (parts.length < 11) return undefined;
  const level = Number(parts[0]);
  const block_num = Number(parts[2]);
  const par_num = Number(parts[3]);
  const line_num = Number(parts[4]);
  const word_num = Number(parts[5]);
  const left = Number(parts[6]);
  const top = Number(parts[7]);
  const width = Number(parts[8]);
  const height = Number(parts[9]);
  const conf = Number(parts[10]);
  const text = parts.slice(11).join("\t");

  if (
    !Number.isFinite(level) ||
    !Number.isFinite(block_num) ||
    !Number.isFinite(par_num) ||
    !Number.isFinite(line_num) ||
    !Number.isFinite(word_num) ||
    !Number.isFinite(left) ||
    !Number.isFinite(top) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    !Number.isFinite(conf)
  ) {
    return undefined;
  }

  return { level, block_num, par_num, line_num, word_num, left, top, width, height, conf, text };
}

/**
 * Parse tesseract TSV output (words only, conf >= 0, non-empty text).
 * Group by (block, par, line) into lines, preserving order.
 */
function parseTsvOutput(tsv: string): { words: TesseractWord[]; lines: TextLine[] } {
  const words: TesseractWord[] = [];
  const lines: TextLine[] = [];
  const lineMap = new Map<string, TesseractWord[]>();

  for (const line of tsv.split("\n")) {
    const row = parseTsvLine(line);
    if (!row) continue;
    // Level 5 = words; skip level 0-4 (page, block, par, line, components).
    if (row.level !== 5) continue;
    // Skip rows with confidence < 0 or empty text.
    if (row.conf < 0 || !row.text.trim()) continue;

    const word: TesseractWord = {
      text: row.text,
      confidence: row.conf,
      x: row.left,
      y: row.top,
      width: row.width,
      height: row.height,
    };
    words.push(word);

    // Group by line: key = (block_num, par_num, line_num)
    const key = `${row.block_num}:${row.par_num}:${row.line_num}`;
    if (!lineMap.has(key)) lineMap.set(key, []);
    lineMap.get(key)!.push(word);
  }

  // Convert line groups to TextLine objects, preserving order of first word.
  for (const lineWords of lineMap.values()) {
    if (lineWords.length === 0) continue;
    const text = lineWords.map((w) => w.text).join(" ");
    const confidence = lineWords.length > 0 ? lineWords.reduce((a, w) => a + w.confidence, 0) / lineWords.length : 0;
    const minX = Math.min(...lineWords.map((w) => w.x));
    const minY = Math.min(...lineWords.map((w) => w.y));
    const maxX = Math.max(...lineWords.map((w) => w.x + w.width));
    const maxY = Math.max(...lineWords.map((w) => w.y + w.height));
    lines.push({
      text,
      confidence: Math.round(confidence * 10) / 10,
      box: {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      },
    });
  }

  return { words, lines };
}

/**
 * Run tesseract OCR on an image file.
 * Returns parsed text with line and word boxes, or throws MediaIntelError.
 */
export async function runTesseract(
  config: Config,
  imagePath: string,
  language: string,
  psm: number,
  imageWidth: number,
  imageHeight: number,
): Promise<OcrResult> {
  const tesseractPath = await findBinary(config.tesseractBin);
  if (!tesseractPath) {
    throw new MediaIntelError(
      "tesseract_missing",
      "tesseract binary was not found",
      'Install: brew install tesseract tesseract-lang / apt install tesseract-ocr tesseract-ocr-deu, or set MEDIA_INTEL_TESSERACT',
    );
  }

  // Run tesseract with TSV output format for structured data.
  const args = [imagePath, "-", "-l", language, "--psm", String(psm), "tsv"];
  const r = await runBinary(config, tesseractPath, args);
  if (r.missing) {
    throw new MediaIntelError("tesseract_missing", "tesseract binary could not be started");
  }
  if (r.timedOut) {
    throw new MediaIntelError("tesseract_timeout", "tesseract exceeded the process timeout");
  }

  const { words, lines } = parseTsvOutput(r.stdout);
  const meanConfidence = words.length > 0 ? words.reduce((a, w) => a + w.confidence, 0) / words.length : 0;
  const text = words.map((w) => w.text).join(" ");

  return {
    text,
    lines,
    word_count: words.length,
    mean_confidence: Math.round(meanConfidence * 10) / 10,
    image_width: imageWidth,
    image_height: imageHeight,
  };
}
