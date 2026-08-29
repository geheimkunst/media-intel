#!/usr/bin/env node
/** Render a results JSON into Markdown tables (stdout). Usage: node bench/report.mjs results.json */
import { readFile } from "node:fs/promises";

const file = process.argv[2];
if (!file) { console.error("usage: node bench/report.mjs <results.json>"); process.exit(1); }
const r = JSON.parse(await readFile(file, "utf8"));
const cands = r.candidates.filter((c) => !c.failed);
const names = cands.map((c) => c.name);
const fmt = (v, d = 2) => (v === undefined || v === null || Number.isNaN(v) ? "n/a" : typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(d)) : String(v));
const cell = (c, task, file, pick, extra) => {
  const recs = c.results.filter((x) => x.task === task && x.file === file && (extra ? extra(x) : true));
  if (recs.length === 0) return "n/a";
  const x = recs[0];
  if (!x.ok && task !== "robust") return `ERR (${(x.error ?? "").slice(0, 40)})`;
  return pick(x);
};
const table = (title, rows, pick, task, extra) => {
  const out = [`### ${title}`, "", `| Datei | ${names.join(" | ")} |`, `|---|${names.map(() => "---").join("|")}|`];
  for (const row of rows) out.push(`| ${row.label ?? row} | ${cands.map((c) => cell(c, task, row.file ?? row, pick, extra ? extra(row) : undefined)).join(" | ")} |`);
  return out.join("\n") + "\n";
};
const files = (task) => [...new Set(cands.flatMap((c) => c.results.filter((x) => x.task === task).map((x) => x.file)))];

console.log(`# Benchmark ${r.meta.date.slice(0, 10)} auf ${r.meta.host} (${r.meta.cpus} Cores, ${r.meta.mem_gb} GB, ${r.meta.cpu ?? ""})\n`);
console.log(`Kandidaten: ${cands.map((c) => `**${c.name}** (${c.tools.length} Tools, Start ${c.startup_ms} ms${c.alive_after_suite ? "" : ", NACH SUITE TOT"})`).join(", ")}${r.candidates.filter((c) => c.failed).map((c) => `; ${c.name}: nicht lauffähig (${c.failed.slice(0, 80)})`).join("")}\n`);

console.log(table("Transkript: WER (niedriger ist besser) und Wanduhr", files("transcript"), (x) => `${fmt(x.quality?.wer)} WER, ${(x.wall_ms / 1000).toFixed(1)} s${x.quality?.language ? `, ${x.quality.language}` : ""}`, "transcript"));
console.log(table("Sprach-Erkennung", files("language"), (x) => `${x.quality?.language ?? "?"} ${x.quality?.language_ok ? "richtig" : "falsch"}, ${(x.wall_ms / 1000).toFixed(1)} s`, "language"));
console.log(table("Szenen: Precision / Recall / F1", files("scenes"), (x) => `${fmt(x.quality?.precision)} / ${fmt(x.quality?.recall)} / ${fmt(x.quality?.f1)} (${x.quality?.detected} erkannt), ${(x.wall_ms / 1000).toFixed(1)} s`, "scenes"));
console.log(table("OCR: CER (niedriger ist besser)", [...files("ocr").filter((f) => f.endsWith(".png")).map((f) => ({ file: f, label: f })), ...[1.5, 4.5, 7.5].map((t) => ({ file: "ocr-video.mp4", label: `ocr-video.mp4 @ ${t}s`, t }))], (x) => `${fmt(x.quality?.cer)} CER, ${(x.wall_ms / 1000).toFixed(1)} s`, "ocr", (row) => (row.t !== undefined ? (x) => x.t === row.t : undefined)));
console.log(table("Frames: 5 Einzelbilder (Tokens geschätzt, Bytes, Wanduhr, Zeitabweichung)", files("frames"), (x) => `${x.images.length} Bilder, ~${x.est_tokens} Tok, ${(x.response_bytes / 1024).toFixed(0)} KiB, ${(x.wall_ms / 1000).toFixed(1)} s${x.quality?.mean_abs_dev_s !== undefined ? `, Δt ${x.quality.mean_abs_dev_s} s` : ""}`, "frames"));
console.log(table("Übersicht: ganzes 60-s-Video abdecken", files("overview"), (x) => `${x.images.length} Bilder, ${(x.quality?.pixels / 1e6).toFixed(1)} MP, ~${x.est_tokens} Tok, ${(x.response_bytes / 1024).toFixed(0)} KiB, ${(x.wall_ms / 1000).toFixed(1)} s`, "overview"));
console.log(table("Probe: Wanduhr und strukturierte Ausgabe", files("probe"), (x) => `${x.wall_ms} ms${x.has_structured ? ", structured" : ""}`, "probe"));
console.log(table("Robustheit", files("robust"), (x) => (x.quality?.graceful ? `sauber (${x.quality.is_error ? "Fehler gemeldet" : "kein Fehler"})` : `ABSTURZ/TIMEOUT: ${(x.quality?.text ?? "").slice(0, 40)}`), "robust"));

console.log("### Spitzen-RAM je Kandidat (MiB, docker stats)\n");
console.log(`| Kandidat | Peak MiB | Summe Wanduhr s | Fehler |\n|---|---|---|---|`);
for (const c of cands) {
  const peak = Math.max(0, ...c.results.map((x) => x.peak_mem_mb ?? 0));
  const wall = c.results.reduce((a, x) => a + x.wall_ms, 0) / 1000;
  const errs = c.results.filter((x) => !x.ok && x.task !== "robust").length;
  console.log(`| ${c.name} | ${peak.toFixed(0)} | ${wall.toFixed(1)} | ${errs} |`);
}
