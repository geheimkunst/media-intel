#!/usr/bin/env node
/**
 * Benchmark runner: speaks MCP over stdio to each candidate (inside Docker),
 * runs the task suite against bench/fixtures, computes quality and cost
 * metrics, writes bench/results/<stamp>.json.
 *
 * Usage: node bench/run.mjs --fixtures /abs/fixtures --cache /abs/cache [--ref /abs/ref] [--only a,b] [--docker "sudo docker"] [--out file.json]
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execa } from "execa";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
const REF = opt("ref", join(CACHE, "..", "ref"));
const DOCKER = opt("docker", "docker").split(" ");
const ONLY = opt("only", "").split(",").filter(Boolean);
const OUT = opt("out", join(here, "results", `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${hostname()}.json`));
const CALL_TIMEOUT_MS = Number(opt("timeout", "900000"));
const LOOSE_TOLERANCE_S = 1.0;
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

async function imageInfo(buf, mime) {
  try {
    const meta = await sharp(buf).metadata();
    return { width: meta.width ?? 0, height: meta.height ?? 0, bytes: buf.length, mime };
  } catch {
    return { width: 0, height: 0, bytes: buf.length, mime };
  }
}

async function imagesOf(result) {
  const out = [];
  for (const c of result?.content ?? []) {
    if (c.type !== "image" || !c.data) continue;
    out.push(await imageInfo(Buffer.from(c.data, "base64"), c.mimeType));
  }
  return out;
}

const textOf = (result) => (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout after ${ms} ms: ${label}`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function scoreQuality(c, task, result, rec) {
  const text = Array.isArray(result) ? result.map(textOf).join("\n") : textOf(result);
  if (task.task === "transcript") {
    const hyp = c.parse.transcriptText?.(result) ?? "";
    const lang = c.parse.language?.(result);
    return { wer: wer(task.truth.text, hyp), hyp_chars: hyp.length, ...(lang !== undefined ? { language: lang, language_ok: String(lang).toLowerCase().startsWith(task.truth.lang) } : {}) };
  }
  if (task.task === "language") {
    const lang = c.parse.detectedLanguage?.(result) ?? c.parse.language?.(result);
    return { language: lang, language_ok: String(lang ?? "").toLowerCase().startsWith(task.truth) };
  }
  if (task.task === "scenes") {
    const cuts = c.parse.cuts?.(result) ?? [];
    const strict = cutScore(task.truth.cuts, cuts, task.truth.tolerance_s);
    const loose = cutScore(task.truth.cuts, cuts, Math.max(task.truth.tolerance_s, LOOSE_TOLERANCE_S));
    return { ...strict, loose_precision: loose.precision, loose_recall: loose.recall, loose_f1: loose.f1, cuts_detected: cuts.slice(0, 40) };
  }
  if (task.task === "ocr") {
    const hyp = c.parse.ocrText?.(result, task) ?? "";
    return { cer: cer(task.truth, hyp), hyp_chars: hyp.length };
  }
  if (task.task === "frames") {
    const times = c.parse.frameTimes?.(result);
    const dev = times && times.length > 0 ? round(times.reduce((a, t, i) => a + Math.abs(t - (task.timestamps[i] ?? t)), 0) / times.length) : undefined;
    return { images: rec.images.length, ...(dev !== undefined ? { mean_abs_dev_s: dev } : {}) };
  }
  if (task.task === "overview") {
    return { images: rec.images.length, pixels: rec.images.reduce((a, i) => a + i.width * i.height, 0) };
  }
  if (task.task === "robust") {
    const isErr = Array.isArray(result) ? result.some((r) => r.isError) : Boolean(result?.isError);
    return { graceful: true, is_error: isErr, text: text.slice(0, 160) };
  }
  return undefined;
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

async function measure(rec, fn, containerName) {
  const stop = { done: false };
  const memP = containerName ? dockerPeakMemory(containerName, stop) : Promise.resolve(0);
  const start = Date.now();
  try {
    return await fn();
  } finally {
    rec.wall_ms = Date.now() - start;
    stop.done = true;
    rec.peak_mem_mb = round(await memP, 1);
  }
}

/* --------------------------------------------------------- MCP candidates */
async function runMcpCandidate(c) {
  const cname = `bench-${c.name}`;
  const spawn = c.spawn({ fixtures: FIXTURES, cache: join(CACHE, c.name), docker: DOCKER, name: cname });
  await mkdir(join(CACHE, c.name), { recursive: true });
  const transport = new StdioClientTransport({ command: spawn.command, args: spawn.args, env: { ...process.env, ...(spawn.env ?? {}) }, stderr: "pipe" });
  const client = new Client({ name: "bench", version: "0" });
  const stderrChunks = [];
  const t0 = Date.now();
  await withTimeout(client.connect(transport), 120000, `${c.name} connect`);
  transport.stderr?.on("data", (d) => { if (stderrChunks.length < 200) stderrChunks.push(String(d)); });
  const tools = (await client.listTools()).tools.map((t) => t.name);
  const startup_ms = Date.now() - t0;
  console.error(`[${c.name}] up in ${startup_ms} ms, ${tools.length} tools: ${tools.join(",")}`);

  const results = [];
  for (const task of buildTasks(c)) {
    const src = task.raw ? task.file : `/data/${task.file}`;
    const spec = task.task === "robust" ? c.tasks[task.via](src, task) : c.tasks[task.task](src, task);
    const rec = { task: task.task, file: task.file, ...(task.t !== undefined ? { t: task.t } : {}), ok: false, wall_ms: 0, peak_mem_mb: 0, response_bytes: 0, text_chars: 0, images: [], est_tokens: 0 };
    if (spec?.na) {
      rec.na = spec.na;
      results.push(rec);
      console.error(`[${c.name}] ${rec.task.padEnd(10)} ${task.file.padEnd(28)} n/a ${spec.na}`);
      continue;
    }
    const calls = Array.isArray(spec) ? spec : [spec];
    rec.tool = calls.map((x) => x.tool).filter((v, i, a) => a.indexOf(v) === i).join("+");
    try {
      const outs = await measure(rec, async () => {
        const acc = [];
        for (const call of calls) acc.push(await withTimeout(client.callTool({ name: call.tool, arguments: call.args }), CALL_TIMEOUT_MS, `${c.name} ${call.tool} ${task.file}`));
        return acc;
      }, cname);
      const result = calls.length === 1 ? outs[0] : outs;
      rec.is_error = outs.some((r) => r.isError);
      rec.response_bytes = outs.reduce((a, r) => a + JSON.stringify(r).length, 0);
      rec.text_chars = outs.reduce((a, r) => a + textOf(r).length, 0);
      rec.images = (await Promise.all(outs.map(imagesOf))).flat();
      rec.est_tokens = textTokens(rec.text_chars) + rec.images.reduce((a, i) => a + imageTokens(i.width, i.height), 0);
      rec.has_structured = outs.every((r) => r.structuredContent !== undefined);
      rec.ok = !rec.is_error;
      if (rec.is_error) rec.error = outs.map(textOf).join(" | ").slice(0, 300);
      if (rec.ok || task.task === "robust") rec.quality = scoreQuality(c, task, result, rec);
      if (task.task === "robust") rec.ok = true;
    } catch (error) {
      rec.error = String(error?.message ?? error).slice(0, 300);
      rec.ok = false;
      if (task.task === "robust") rec.quality = { graceful: false, text: rec.error };
    }
    results.push(rec);
    console.error(`[${c.name}] ${rec.task.padEnd(10)} ${task.file.padEnd(28)} ${rec.ok ? "ok " : "ERR"} ${String(rec.wall_ms).padStart(7)} ms ${rec.quality ? JSON.stringify(rec.quality).slice(0, 100) : rec.error ?? ""}`);
  }
  let alive = true;
  try { await withTimeout(client.listTools(), 30000, "liveness"); } catch { alive = false; }
  await client.close().catch(() => undefined);
  return { name: c.name, kind: "mcp", notes: c.notes, image: spawn.image ?? spawn.command, tools, startup_ms, alive_after_suite: alive, results, stderr_tail: stderrChunks.slice(-5).join("").slice(-1500) };
}

/* -------------------------------------------------------- script candidates */
async function runScriptCandidate(c) {
  const cache = join(CACHE, c.name);
  await mkdir(cache, { recursive: true });
  const results = [];
  for (const task of buildTasks(c)) {
    const spec = c.run({ docker: DOCKER, fixtures: FIXTURES, cache, ref: REF }, task);
    const rec = { task: task.task, file: task.file, ok: false, wall_ms: 0, peak_mem_mb: 0, response_bytes: 0, text_chars: 0, images: [], est_tokens: 0 };
    if (spec?.na) { rec.na = spec.na; results.push(rec); continue; }
    rec.tool = spec.args.find((a) => a.endsWith(".py"))?.split("/").pop() ?? "script";
    try {
      const r = await measure(rec, () => execa(spec.command, spec.args, { reject: false, timeout: CALL_TIMEOUT_MS, all: true }), undefined);
      rec.exit_code = r.exitCode;
      rec.text_chars = (r.stdout ?? "").length;
      rec.response_bytes = (r.all ?? "").length;
      // Images: files the script wrote into its out dir (mounted at /cache/...).
      if (spec.outDir) {
        const hostDir = spec.outDir.replace(/^\/cache/, spec.cacheDir);
        try {
          for (const f of (await readdir(hostDir)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f))) {
            rec.images.push(await imageInfo(await readFile(join(hostDir, f)), "image/jpeg"));
            rec.response_bytes += rec.images.at(-1).bytes;
          }
        } catch { /* no images */ }
      } else {
        // watch.py prints a markdown report listing frame paths; count JPEGs it mentions.
        const paths = [...(r.stdout ?? "").matchAll(/`([^`]+\.jpe?g)`/g)].map((m) => m[1]);
        rec.text_chars = paths.length > 0 ? rec.text_chars : rec.text_chars;
        rec.quality = { images_listed: paths.length };
      }
      rec.est_tokens = textTokens(rec.text_chars) + rec.images.reduce((a, i) => a + imageTokens(i.width, i.height), 0);
      rec.ok = r.exitCode === 0;
      if (!rec.ok) rec.error = String(r.all ?? "").slice(-300);
      if (task.task === "overview") rec.quality = { images: rec.images.length, pixels: rec.images.reduce((a, i) => a + i.width * i.height, 0) };
      if (task.task === "frames") rec.quality = { ...(rec.quality ?? {}), images: rec.images.length };
    } catch (error) {
      rec.error = String(error?.message ?? error).slice(0, 300);
    }
    results.push(rec);
    console.error(`[${c.name}] ${rec.task.padEnd(10)} ${task.file.padEnd(28)} ${rec.ok ? "ok " : "ERR"} ${String(rec.wall_ms).padStart(7)} ms ${rec.quality ? JSON.stringify(rec.quality).slice(0, 100) : rec.error ?? ""}`);
  }
  return { name: c.name, kind: "script", notes: c.notes, tools: [], startup_ms: 0, alive_after_suite: true, results };
}

/* ------------------------------------------------------------------- main */
const selected = candidates.filter((c) => ONLY.length === 0 || ONLY.includes(c.name));
const report = { meta: { date: new Date().toISOString(), host: hostname(), cpus: cpus().length, cpu: cpus()[0]?.model, mem_gb: round(totalmem() / 1024 ** 3, 1), fixtures: FIXTURES, docker: DOCKER.join(" "), loose_tolerance_s: LOOSE_TOLERANCE_S }, candidates: [] };
for (const c of selected) {
  try {
    report.candidates.push(c.kind === "script" ? await runScriptCandidate(c) : await runMcpCandidate(c));
  } catch (error) {
    console.error(`[${c.name}] FAILED to run: ${error?.message ?? error}`);
    report.candidates.push({ name: c.name, failed: String(error?.message ?? error) });
  }
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(report, null, 2));
}
console.error(`wrote ${OUT}`);
