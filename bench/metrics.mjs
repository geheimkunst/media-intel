/** Quality metrics with no dependencies: WER, CER, cut precision/recall, token estimates. */

const NUM_WORDS = {
  null: "0", eins: "1", ein: "1", eine: "1", zwei: "2", drei: "3", vier: "4", fünf: "5", sechs: "6", sieben: "7", acht: "8", neun: "9", zehn: "10",
  elf: "11", zwölf: "12", fünfzehn: "15", fünfzehnten: "15", zwanzig: "20", hundert: "100", zweihundert: "200", zweiten: "2", zweite: "2", dritten: "3", dritte: "3",
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", fifteen: "15", twenty: "20", hundred: "100", second: "2", third: "3",
};

export function normalizeWords(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => NUM_WORDS[w] ?? w)
    .map((w) => w.replace(/^(\d+)(er|te|ten|th|st|nd|rd)$/u, "$1"));
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/** Word error rate in 0..1+ (can exceed 1 for very long hypotheses). */
export function wer(truth, hypothesis) {
  const t = normalizeWords(truth);
  const h = normalizeWords(hypothesis ?? "");
  if (t.length === 0) return h.length === 0 ? 0 : 1;
  return round(levenshtein(t, h) / t.length);
}

/** Character error rate on normalized text (spaces collapsed). */
export function cer(truth, hypothesis) {
  const t = normalizeWords(truth).join(" ");
  const h = normalizeWords(hypothesis ?? "").join(" ");
  if (t.length === 0) return h.length === 0 ? 0 : 1;
  return round(levenshtein([...t], [...h]) / t.length);
}

/** Precision / recall / F1 of detected cut times against truth with a tolerance. */
export function cutScore(truthCuts, detected, toleranceS) {
  const used = new Set();
  let tp = 0;
  for (const t of truthCuts) {
    let best = -1;
    let bestD = Infinity;
    detected.forEach((d, i) => {
      if (used.has(i)) return;
      const dd = Math.abs(d - t);
      if (dd <= toleranceS && dd < bestD) { best = i; bestD = dd; }
    });
    if (best >= 0) { used.add(best); tp += 1; }
  }
  const precision = detected.length > 0 ? tp / detected.length : truthCuts.length === 0 ? 1 : 0;
  const recall = truthCuts.length > 0 ? tp / truthCuts.length : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, detected: detected.length, truth: truthCuts.length, precision: round(precision), recall: round(recall), f1: round(f1) };
}

/**
 * Anthropic vision cost estimate: images are downscaled so the long edge is
 * at most 1568 px, then tokens ≈ (w*h)/750.
 */
export function imageTokens(width, height, longEdgeCap = 1568) {
  const long = Math.max(width, height);
  const scale = long > longEdgeCap ? longEdgeCap / long : 1;
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  return Math.ceil((w * h) / 750);
}

export function textTokens(chars) {
  return Math.ceil(chars / 4);
}

export function round(n, digits = 3) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
