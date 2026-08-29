#!/usr/bin/env node
/**
 * Deterministic benchmark fixtures with known ground truth.
 * Runs on macOS (uses `say` for speech); everything else is ffmpeg + sharp.
 * Output: bench/fixtures/<files> and bench/fixtures/truth.json
 */
import { execa } from "execa";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "fixtures");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const ff = (args) => execa("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
const truth = { speech: {}, ocr: {}, cuts: {}, language: {}, robustness: {} };

/* ------------------------------------------------------------------ speech */
const SPEECH = {
  "speech-de-clean": { voice: "Anna", lang: "de", text: "Hallo, das ist eine Testnotiz für den Benchmark. Morgen um zehn Uhr habe ich einen Termin mit dem Kunden in Berlin. Bitte erinnere mich daran, die Präsentation vorzubereiten und die Rechnung für August zu schicken. Die Zahlen aus dem zweiten Quartal sind besser als erwartet." },
  "speech-en-clean": { voice: "Samantha", lang: "en", text: "This is a short recording for the benchmark. The deployment finished on Tuesday and the error rate dropped below two percent. Please send the invoice for August and schedule the review with the customer in Berlin next week." },
  "speech-de-long": { voice: "Markus (Enhanced)", lang: "de", text: "Willkommen zur Wochenbesprechung. Erstens: Der Server läuft seit dem Umzug stabil, die Antwortzeiten liegen unter zweihundert Millisekunden. Zweitens: Die neue Suchfunktion ist fertig und wird am Freitag freigeschaltet. Drittens: Wir brauchen noch eine Entscheidung über das Budget für das dritte Quartal. Bitte prüft bis Donnerstag die Zahlen und schickt mir eure Rückmeldung. Zum Schluss ein Hinweis: Die Rechnung für August muss bis zum fünfzehnten raus, sonst gibt es Mahngebühren. Danke und bis nächste Woche." },
};
for (const [name, s] of Object.entries(SPEECH)) {
  const aiff = join(out, `${name}.aiff`);
  await execa("say", ["-v", s.voice, "-o", aiff, s.text]);
  await ff(["-i", aiff, "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "48k", join(out, `${name}.m4a`)]);
  await rm(aiff);
  truth.speech[`${name}.m4a`] = { text: s.text, lang: s.lang };
  truth.language[`${name}.m4a`] = s.lang;
}
// Degraded variants of the German clean note: white noise at -22 dB, and a music bed.
await ff(["-i", join(out, "speech-de-clean.m4a"), "-f", "lavfi", "-i", "anoisesrc=color=white:amplitude=0.08:duration=60", "-filter_complex", "[1]atrim=0:40[n];[0][n]amix=inputs=2:duration=first:normalize=0[a]", "-map", "[a]", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "48k", join(out, "speech-de-noise.m4a")]);
truth.speech["speech-de-noise.m4a"] = { text: SPEECH["speech-de-clean"].text, lang: "de" };
await ff(["-i", join(out, "speech-en-clean.m4a"), "-f", "lavfi", "-i", "sine=frequency=220:duration=60,volume=0.25", "-f", "lavfi", "-i", "sine=frequency=330:duration=60,volume=0.2", "-filter_complex", "[1][2]amix=inputs=2:normalize=0[m];[0][m]amix=inputs=2:duration=first:normalize=0[a]", "-map", "[a]", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "48k", join(out, "speech-en-music.m4a")]);
truth.speech["speech-en-music.m4a"] = { text: SPEECH["speech-en-clean"].text, lang: "en" };

/* --------------------------------------------------------------------- ocr */
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function svgText(lines, w, h, opts) {
  const { bg, fg, size, font, x0, y0, lh } = opts;
  return `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect width="${w}" height="${h}" fill="${bg}"/>${lines
    .map((l, i) => `<text x="${x0}" y="${y0 + i * lh}" font-family="${font}" font-size="${size}" fill="${l.color ?? fg}">${esc(l.text ?? l)}</text>`)
    .join("")}</svg>`;
}
const OCR = {
  "ocr-terminal-720": { w: 1280, h: 720, lines: ["$ npm run build", "> tsc -p tsconfig.json", "src/server.ts(12,5): error TS2304: Cannot find name 'registerTool'.", "Found 1 error in src/server.ts:12", "$ git status", "On branch main, nothing to commit"], opts: { bg: "#1e1e1e", fg: "#e6e6e6", size: 22, font: "Menlo, monospace", x0: 30, y0: 60, lh: 36 } },
  "ocr-terminal-1080": { w: 1920, h: 1080, lines: ["$ curl -s https://api.example.com/v1/orders/8821", "{\"id\": 8821, \"status\": \"failed\", \"reason\": \"payment declined\"}", "ERROR: ENOENT: no such file or directory, open 'config.yaml'", "    at Object.openSync (node:fs:581:3)", "Test Files 1 failed | 3 passed (4)"], opts: { bg: "#0b0e14", fg: "#dcdcdc", size: 30, font: "Menlo, monospace", x0: 40, y0: 90, lh: 52 } },
  "ocr-dialog-1080": { w: 1920, h: 1080, lines: ["Zahlung fehlgeschlagen", "Die Karte wurde abgelehnt. Bitte prüfen Sie Ihre Angaben.", "Rechnungsnummer 2026-08-0417", "Betrag: 1.249,00 EUR", "Erneut versuchen        Abbrechen"], opts: { bg: "#f4f4f4", fg: "#202020", size: 40, font: "Helvetica, Arial, sans-serif", x0: 300, y0: 300, lh: 90 } },
};
for (const [name, o] of Object.entries(OCR)) {
  const png = join(out, `${name}.png`);
  await sharp(Buffer.from(svgText(o.lines, o.w, o.h, o.opts))).png().toFile(png);
  truth.ocr[`${name}.png`] = { text: o.lines.map((l) => l.text ?? l).join("\n") };
}
// A 9 s "screen recording": the three OCR images, 3 s each, with a quiet tone.
await ff([
  "-loop", "1", "-t", "3", "-i", join(out, "ocr-terminal-720.png"),
  "-loop", "1", "-t", "3", "-i", join(out, "ocr-terminal-1080.png"),
  "-loop", "1", "-t", "3", "-i", join(out, "ocr-dialog-1080.png"),
  "-f", "lavfi", "-t", "9", "-i", "sine=frequency=200:duration=9,volume=0.05",
  "-filter_complex", "[0]scale=1920:1080[a];[1]scale=1920:1080[b];[2]scale=1920:1080[c];[a][b][c]concat=n=3:v=1:a=0,fps=10,format=yuv420p[v]",
  "-map", "[v]", "-map", "3:a", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest", join(out, "ocr-video.mp4"),
]);
truth.ocr["ocr-video.mp4"] = { frames: { 1.5: truth.ocr["ocr-terminal-720.png"].text, 4.5: truth.ocr["ocr-terminal-1080.png"].text, 7.5: truth.ocr["ocr-dialog-1080.png"].text } };
truth.cuts["ocr-video.mp4"] = { cuts: [3, 6], tolerance_s: 0.3 };

/* ------------------------------------------------------------------- cuts */
// 10 hard cuts: 11 visually distinct segments with varied durations.
const SEGS = [
  ["testsrc=size=1280x720:rate=25", 2.0], ["smptebars=size=1280x720:rate=25", 1.5], ["color=c=red:size=1280x720:rate=25", 1.0],
  ["rgbtestsrc=size=1280x720:rate=25", 2.5], ["color=c=blue:size=1280x720:rate=25", 0.8], ["testsrc2=size=1280x720:rate=25", 3.0],
  ["yuvtestsrc=size=1280x720:rate=25", 1.2], ["color=c=green:size=1280x720:rate=25", 1.7], ["pal75bars=size=1280x720:rate=25", 2.2],
  ["color=c=white:size=1280x720:rate=25", 0.9], ["mandelbrot=size=1280x720:rate=25", 3.2],
];
{
  const inputs = SEGS.flatMap(([src, d]) => ["-f", "lavfi", "-t", String(d), "-i", src]);
  const n = SEGS.length;
  const fc = `${SEGS.map((_, i) => `[${i}]`).join("")}concat=n=${n}:v=1:a=0,format=yuv420p[v]`;
  const total = SEGS.reduce((a, [, d]) => a + d, 0);
  await ff([...inputs, "-f", "lavfi", "-t", String(total), "-i", "sine=frequency=440:duration=60,volume=0.1", "-filter_complex", fc, "-map", "[v]", "-map", `${n}:a`, "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest", join(out, "cuts-10.mp4")]);
  const cuts = [];
  let t = 0;
  for (let i = 0; i < SEGS.length - 1; i += 1) { t += SEGS[i][1]; cuts.push(Math.round(t * 1000) / 1000); }
  truth.cuts["cuts-10.mp4"] = { cuts, tolerance_s: 0.25, duration_s: total };
}
// 3 crossfades of 0.5 s: truth is the fade midpoint, wider tolerance.
{
  const a = "testsrc=size=1280x720:rate=25:duration=4", b = "smptebars=size=1280x720:rate=25:duration=4", c = "rgbtestsrc=size=1280x720:rate=25:duration=4", d = "testsrc2=size=1280x720:rate=25:duration=4";
  await ff(["-f", "lavfi", "-i", a, "-f", "lavfi", "-i", b, "-f", "lavfi", "-i", c, "-f", "lavfi", "-i", d,
    "-filter_complex", "[0][1]xfade=transition=fade:duration=0.5:offset=3.5[x1];[x1][2]xfade=transition=fade:duration=0.5:offset=7[x2];[x2][3]xfade=transition=fade:duration=0.5:offset=10.5,format=yuv420p[v]",
    "-map", "[v]", "-c:v", "libx264", "-preset", "veryfast", join(out, "fades-3.mp4")]);
  truth.cuts["fades-3.mp4"] = { cuts: [3.75, 7.25, 10.75], tolerance_s: 0.6, duration_s: 14 };
}
// Frame timing reference: 60 s at 10 fps, static pattern with slow motion.
await ff(["-f", "lavfi", "-t", "60", "-i", "testsrc2=size=1280x720:rate=10", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", join(out, "frames-60s.mp4")]);

/* ------------------------------------------------------------- robustness */
await writeFile(join(out, "corrupt.mp4"), Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256)));
await writeFile(join(out, "empty.mp4"), Buffer.alloc(0));
await ff(["-f", "lavfi", "-t", "2", "-i", "anullsrc=r=16000:cl=mono", "-c:a", "pcm_s16le", join(out, "silent.wav")]);
await ff(["-f", "lavfi", "-t", "3", "-i", "testsrc=size=320x240:rate=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(out, "noaudio.mp4")]);
truth.robustness = {
  "corrupt.mp4": "graceful error",
  "empty.mp4": "graceful error",
  "silent.wav": "empty transcript or clear warning, no crash",
  "noaudio.mp4": "transcript refused with reason, frames still work",
  "http://169.254.169.254/latest/meta-data": "refused (private address)",
  "../../etc/passwd": "not found or refused, never read",
};

await writeFile(join(out, "truth.json"), JSON.stringify(truth, null, 2));
const { stdout } = await execa("ls", ["-la", out]);
console.log(stdout);
