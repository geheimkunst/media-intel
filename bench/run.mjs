#!/usr/bin/env node
/**
 * Benchmark runner: speaks MCP over stdio to each candidate (inside Docker),
 * runs the task suite against bench/fixtures, computes quality and cost
 * metrics, writes bench/results/<stamp>.json.
 *
 * Usage: node bench/run.mjs --fixtures /abs/fixtures --cache /abs/cache [--only name,name] [--docker "sudo docker"] [--out file.json]
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execa } from "execa";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, hostname, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { candidates } from "./candidates.mjs";
import { cer, cutScore, imageTokens, round, textTokens, wer } from "./metrics.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const FIXTURES = opt("fixtures", join(here, "fixtures"));
const CACHE = opt("cache", join(here, ".cache"));
const DOCKER = opt("docker", "docker").split(" ");
const ONLY = opt("only", "").split(",").filter(Boolean);
const OUT = opt("out", join(here, "results", `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${hostname()}.json`));
const CALL_TIMEOUT_MS = Number(opt("timeout", "900000"));
const truth = JSON.parse(await readFile(join(FIXTURES, "truth.json"), "utf8"));

/* --------------------------------------------------------------- helpers */
async function dockerPeakMemory(name, stop) {
  let peak = 0;
  while (!stop.done) {
    try {
      const { stdout } = await execa(DOCKER[0], [...DOCKER.slice(1), "stats", "--no-stream", "--format", "{{.MemUsage}}", name], { reject: false, timeout: 5000 });
      const m = stdout.match(/([\d.]+)\s*(KiB|MiB|GiB|B)/);
      if (m) {
        const v = Number(m[1]) * ({ B: 1 / 1024 ** 2, KiB: 1 / 1024, MiB: 1, GiB: 1024 }[m[2]] ?? 1);
        peak = Math.max(peak, v);
      }
    } catch {
      /* container gone */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return peak;
}

async function imagesOf(result) {
  const out = [];
  for (const c of result?.content ?? []) {
    if (c.type !== "image" || !c.data) continue;
    const buf = Buffer.from(c.data, "base64");
    try {
      const meta = await sharp(buf).metadata();
      out.push({ width: meta.width ?? 0, height: meta.height ?? 0, bytes: buf.length, mime: c.mimeType });
    } catch {
      out.push({ width: 0, height: 0, bytes: buf.length, mime: c.mimeType });
    }
  }
  return out;
}

function textOf(result) {
  return (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout after ${ms} ms: ${label}`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

/* ------------------------------------------------------------------ suite */
const SPEECH = Object.keys(truth.speech);
const OCR_IMAGES = Object.keys(truth.ocr).filter((f) => f.endsWith(".png"));
const FRAME_TIMES = [1, 15.5, 30, 45.25, 59];

function buildTasks(c) {
  const t = [];
  const P = (task, file, extra = {}) => t.push({ task, file, ...extra });
  for (const f of [...SPEECH, "cuts-10.mp4", "ocr-video.mp4"]) P("probe", f);
  for (const f of SPEECH) P("transcript", f, { truth: truth.speech[f] });
  for (const f of SPEECH.slice(0, 2)) P("language", f, { truth: truth.language[f] });
  P("frames", "frames-60s.mp4", { timestamps: FRAME_TIMES });
  P("overview", "frames-60s.mp4");
  for (const f of ["cuts-10.mp4", "fades-3.mp4", "ocr-video.mp4"]) P("scenes", f, { truth: truth.cuts[f] });
  for (const f of OCR_IMAGES) P("ocr", f, { truth: truth.ocr[f].text });
  for (const [ts, text] of Object.entries(truth.ocr["ocr-video.mp4"].frames)) P("ocr", "ocr-video.mp4", { t: Number(ts), truth: text });
  P("robust", "corrupt.mp4", { via: "probe" });
  P("robust", "empty.mp4", { via: "probe" });
  P("robust", "silent.wav", { via: "transcript" });
  P("robust", "noaudio.mp4", { via: "transcript" });
  P("robust", "http://169.254.169.254/latest/meta-data", { via: "probe", raw: true });
  P("robust", "../../etc/passwd", { via: "probe", raw: true });
  return t.filter((x) => c.tasks[x.task === "robust" ? x.via : x.task]);
}

async function runCandidate(c) {
  const cname = `bench-${c.name}`;
  const spawn = c.spawn({ fixtures: FIXTURES, cache: join(CACHE, c.name), docker: DOCKER, name: cname });
  await mkdir(join(CACHE, c.name), { recursive: true });
  const transport = new StdioClientTransport({ command: spawn.command, args: spawn.args, env: { ...process.env, ...(spawn.env ?? {}) }, stderr: "pipe" });
  const client = new Client({ name: "bench", version: "0" });
  const stderrChunks = [];
  const t0 = Date.now();
  await client.connect(transport);
  transport.stderr?.on("data", (d) => { if (stderrChunks.length < 200) stderrChunks.push(String(d)); });
  const tools = (await client.listTools()).tools.map((t) => t.name);
  const startup_ms = Date.now() - t0;
  console.error(`[${c.name}] up in ${startup_ms} ms, ${tools.length} tools`);

  const results = [];
  for (const task of buildTasks(c)) {
    const src = task.raw ? task.file : `/data/${task.file}`;
    const call = task.task === "robust" ? c.tasks[task.via](src, task) : c.tasks[task.task](src, task);
    const rec = { task: task.task, file: task.file, tool: call.tool, ok: false, wall_ms: 0, peak_mem_mb: 0, response_bytes: 0, text_chars: 0, images: [], est_tokens: 0 };
    const stop = { done: false };
    const memP = spawn.docker ? dockerPeakMemory(cname, stop) : Promise.resolve(0);
    const start = Date.now();
    let result;
    try {
      result = await withTimeout(client.callTool({ name: call.tool, arguments: call.args }), CALL_TIMEOUT_MS, `${c.name} ${call.tool} ${task.file}`);
      rec.wall_ms = Date.now() - start;
      rec.is_error = Boolean(result.isError);
      rec.response_bytes = JSON.stringify(result).length;
      const text = textOf(result);
      rec.text_chars = text.length;
      rec.images = await imagesOf(result);
      rec.est_tokens = textTokens(rec.text_chars) + rec.images.reduce((a, i) => a + imageTokens(i.width, i.height), 0);
      rec.has_structured = result.structuredContent !== undefined;
      rec.ok = !result.isError;
      if (result.isError) rec.error = text.slice(0, 300);
      // quality
      if (task.task === "transcript" && rec.ok) {
        const hyp = c.parse.transcriptText(result) ?? "";
        rec.quality = { wer: wer(task.truth.text, hyp), hyp_chars: hyp.length, language: c.parse.language?.(result), language_ok: c.parse.language ? String(c.parse.language(result) ?? "").toLowerCase().startsWith(task.truth.lang) : undefined };
      }
      if (task.task === "language" && rec.ok) {
        const lang = c.parse.detectedLanguage?.(result) ?? c.parse.language?.(result);
        rec.quality = { language: lang, language_ok: String(lang ?? "").toLowerCase().startsWith(task.truth) };
      }
      if (task.task === "scenes" && rec.ok) {
        const cuts = c.parse.cuts(result) ?? [];
        rec.quality = { ...cutScore(task.truth.cuts, cuts, task.truth.tolerance_s), cuts_detected: cuts.slice(0, 40) };
      }
      if (task.task === "ocr" && rec.ok) {
        const hyp = c.parse.ocrText(result, task) ?? "";
        rec.quality = { cer: cer(task.truth, hyp), hyp_chars: hyp.length };
      }
      if (task.task === "frames" && rec.ok) {
        const times = c.parse.frameTimes?.(result);
        rec.quality = { images: rec.images.length, ...(times ? { mean_abs_dev_s: round(times.reduce((a, t, i) => a + Math.abs(t - (task.timestamps[i] ?? t)), 0) / Math.max(1, times.length)) } : {}) };
      }
      if (task.task === "overview" && rec.ok) {
        rec.quality = { images: rec.images.length, pixels: rec.images.reduce((a, i) => a + i.width * i.height, 0) };
      }
      if (task.task === "robust") {
        // graceful = a tool result (error or not) without the server dying; crash = exception/timeout
        rec.quality = { graceful: true, is_error: Boolean(result.isError), text: text.slice(0, 160) };
        rec.ok = true;
      }
    } catch (error) {
      rec.wall_ms = Date.now() - start;
      rec.error = String(error?.message ?? error).slice(0, 300);
      rec.ok = false;
      if (task.task === "robust") rec.quality = { graceful: false, text: rec.error };
    } finally {
      stop.done = true;
      rec.peak_mem_mb = round(await memP, 1);
    }
    results.push(rec);
    console.error(`[${c.name}] ${rec.task.padEnd(10)} ${task.file.padEnd(28)} ${rec.ok ? "ok " : "ERR"} ${String(rec.wall_ms).padStart(7)} ms ${rec.quality ? JSON.stringify(rec.quality).slice(0, 90) : rec.error ?? ""}`);
  }
  // liveness after the robustness cases
  let alive = true;
  try { await withTimeout(client.listTools(), 30000, "liveness"); } catch { alive = false; }
  await client.close().catch(() => undefined);
  return { name: c.name, image: spawn.image ?? spawn.command, tools, startup_ms, alive_after_suite: alive, results, stderr_tail: stderrChunks.slice(-5).join("").slice(-1500) };
}

/* ------------------------------------------------------------------- main */
const selected = candidates.filter((c) => ONLY.length === 0 || ONLY.includes(c.name));
const report = { meta: { date: new Date().toISOString(), host: hostname(), cpus: cpus().length, cpu: cpus()[0]?.model, mem_gb: round(totalmem() / 1024 ** 3, 1), fixtures: FIXTURES, docker: DOCKER.join(" ") }, candidates: [] };
for (const c of selected) {
  try {
    report.candidates.push(await runCandidate(c));
  } catch (error) {
    console.error(`[${c.name}] FAILED to run: ${error?.message ?? error}`);
    report.candidates.push({ name: c.name, failed: String(error?.message ?? error) });
  }
}
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(report, null, 2));
console.error(`wrote ${OUT}`);
