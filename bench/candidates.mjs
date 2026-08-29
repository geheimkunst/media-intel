/**
 * Candidate adapters. Each maps the benchmark tasks onto the candidate's tools
 * and tells the runner where text, cuts, and timestamps live in its results.
 * Facts about the reference candidates come from bench/candidates.md.
 *
 * A task function may return:
 *   { tool, args }            one MCP call
 *   [{ tool, args }, ...]     several calls, aggregated (wall, images, bytes)
 *   { na: "reason" }          not applicable for this candidate/file
 */

function dockerSpawn({ docker, name, fixtures, cache }, image, env = {}, extraArgs = [], cmd = []) {
  const envFlags = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return {
    command: docker[0],
    args: [...docker.slice(1), "run", "-i", "--rm", "--name", name, "--network", "none", "-v", `${fixtures}:/data:ro`, "-v", `${cache}:/cache`, ...envFlags, ...extraArgs, image, ...cmd],
    docker: true,
    image,
  };
}

const sc = (r) => r?.structuredContent ?? {};
const textOf = (r) => (r?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

/** Pull JSON out of a text block (candidates that return JSON as text). */
function jsonFromText(result) {
  const text = textOf(result);
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* ignore */ }
    }
  }
  return undefined;
}

/** "H:MM:SS.mmm" | "M:SS" | "MM:SS" → seconds */
function clockToSeconds(s) {
  const parts = String(s).trim().replace(",", ".").split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return undefined;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
const secondsToClock = (t) => {
  const s = Math.max(0, Math.round(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};
const isVideo = (src) => /\.(mp4|webm|mov|mkv|m4v)$/i.test(src);

/* ------------------------------------------------------------ media-intel */
function mediaIntel(name, whisperModel) {
  return {
    name,
    kind: "mcp",
    spawn: (ctx) => dockerSpawn(ctx, "media-intel:bench", {
      MEDIA_INTEL_CACHE_DIR: "/cache",
      MEDIA_INTEL_WHISPER_MODEL: `/cache/models/${whisperModel}`,
      MEDIA_INTEL_OCR_LANGUAGES: "deu+eng",
    }),
    tasks: {
      probe: (src) => ({ tool: "probe_media", args: { source: src } }),
      transcript: (src) => ({ tool: "get_transcript", args: { source: src, backend: "whisper", format: "json" } }),
      language: (src) => ({ tool: "detect_language", args: { source: src } }),
      frames: (src, t) => ({ tool: "get_frames", args: { source: src, timestamps: t.timestamps, frame_format: "jpeg" } }),
      overview: (src) => ({ tool: "get_video_grids", args: { source: src } }),
      scenes: (src) => ({ tool: "get_scenes", args: { source: src } }),
      ocr: (src, t) => ({ tool: "extract_text", args: t.t !== undefined ? { source: src, timestamps: [t.t] } : { source: src } }),
    },
    parse: {
      transcriptText: (r) => (sc(r).segments ?? []).map((s) => s.text).join(" "),
      language: (r) => sc(r).language,
      detectedLanguage: (r) => sc(r).language,
      cuts: (r) => (sc(r).cuts ?? []).map((c) => c.t_s),
      ocrText: (r) => (sc(r).results ?? []).map((x) => x.text?.text ?? x.text ?? "").join("\n"),
      frameTimes: (r) => (sc(r).frames ?? []).map((f) => f.t_s),
    },
  };
}

/* ---------------------------------------------------- media-understanding */
const mediaUnderstanding = {
  name: "media-understanding",
  kind: "mcp",
  notes: "whisper.cpp via node-av. On this host every get_transcript call kills the server with SIGSEGV (exit 139), reproduced with the official image ghcr.io/dymoo/media-understanding:1.1.0, with the bundled base.en-q5_1 and with base-q5_1, with and without hardware probing; transcript therefore n/a (crash) so the rest of the suite can run. No language field, no scenes tool (scene sampling of grids used as proxy), no OCR; timestamps burned into images.",
  spawn: (ctx) => dockerSpawn(ctx, "media-understanding:bench", {
    XDG_CACHE_HOME: "/cache",
    MEDIA_UNDERSTANDING_MODEL: "base-q5_1",
    MEDIA_UNDERSTANDING_DISABLE_HW: "1",
  }, ["--entrypoint", "node"], ["dist/mcp.js"]),
  tasks: {
    probe: (src) => ({ tool: "probe_media", args: { paths: src } }),
    transcript: () => ({ na: "crash: SIGSEGV in node-av whisper on this host (reproduced with official image 1.1.0)" }),
    frames: (src, t) => ({ tool: "get_frames", args: { file_path: src, timestamps: t.timestamps, max_total_chars: 600000 } }),
    overview: (src) => ({ tool: "get_video_grids", args: { file_path: src, max_total_chars: 600000 } }),
    scenes: (src) => ({ tool: "get_video_grids", args: { file_path: src, sampling_strategy: "scene", scene_threshold: 0.3, max_grids: 6, max_total_chars: 600000 } }),
  },
  parse: {
    transcriptText: (r) => {
      const j = jsonFromText(r);
      if (j?.segments) return j.segments.map((s) => s.text ?? "").join(" ");
      return textOf(r);
    },
    // Tile timestamps of scene-sampled grids stand in for a cut list (documented approximation).
    cuts: (r) => {
      const text = textOf(r);
      const out = [];
      for (const m of text.matchAll(/Tile timestamps:\s*([^\n]+)/g)) {
        for (const tok of m[1].split(",")) {
          const t = clockToSeconds(tok.trim());
          if (t !== undefined && t > 0.05) out.push(t);
        }
      }
      return [...new Set(out)].sort((a, b) => a - b);
    },
    frameTimes: (r) => {
      const text = textOf(r);
      return [...text.matchAll(/Frame at [\d:.]+ \(([\d.]+)s\)/g)].map((m) => Number(m[1]));
    },
  },
};

/* ---------------------------------------------------- mcp-video-analyzer */
const videoAnalyzer = {
  name: "mcp-video-analyzer",
  kind: "mcp",
  notes: "No ASR backend in the image (needs Python openai-whisper or an API key): transcript n/a. Only video extensions accepted: audio and PNG fixtures n/a. Times as M:SS (1 s resolution). OCR only inside analyze_video; tesseract.js with tessdata pre-placed in the cache.",
  spawn: (ctx) => dockerSpawn(ctx, "mcp-video-analyzer:bench", { MCP_CACHE_DIR: "/cache" }),
  tasks: {
    probe: (src, t) => (isVideo(src) || t?.task === "robust" ? { tool: "get_metadata", args: { url: src } } : { na: "audio not accepted (video extensions only)" }),
    transcript: (src, t) => (t?.task === "robust" ? { tool: "get_transcript", args: { url: src } } : { na: "no speech-to-text backend in the image (whisper CLI or API key required)" }),
    frames: (src, t) => t.timestamps.map((ts) => ({ tool: "get_frame_at", args: { url: src, timestamp: secondsToClock(ts) } })),
    overview: (src) => ({ tool: "get_frames", args: { url: src, options: { maxFrames: 20, dense: true } } }),
    scenes: (src) => ({ tool: "analyze_video", args: { url: src, options: { fields: ["frames"], threshold: 0.3, detail: "standard", forceRefresh: true, ocrLanguage: "deu+eng" } } }),
    ocr: (src, t) => (isVideo(src) ? { tool: "analyze_video", args: { url: src, options: { fields: ["ocrResults"], ocrLanguage: "deu+eng", detail: "detailed", forceRefresh: true } } } : { na: "image files not accepted (video extensions only)" }),
  },
  parse: {
    transcriptText: (r) => {
      const j = jsonFromText(r);
      return Array.isArray(j?.transcript) ? j.transcript.map((s) => s.text ?? "").join(" ") : "";
    },
    cuts: (r) => {
      const j = jsonFromText(r);
      const frames = j?.frames ?? [];
      return frames.map((f) => clockToSeconds(f.time)).filter((t) => typeof t === "number" && t > 0.05);
    },
    ocrText: (r, task) => {
      const j = jsonFromText(r);
      const rows = j?.ocrResults ?? [];
      if (rows.length === 0) return "";
      if (task?.t === undefined) return rows.map((x) => x.text).join("\n");
      const best = rows.reduce((b, x) => (Math.abs((clockToSeconds(x.time) ?? 0) - task.t) < Math.abs((clockToSeconds(b.time) ?? 0) - task.t) ? x : b), rows[0]);
      return best?.text ?? "";
    },
    frameTimes: (results) => (Array.isArray(results) ? results : [results]).map((r) => clockToSeconds(jsonFromText(r)?.timestamp)).filter((t) => t !== undefined),
  },
};

/* ------------------------------------------------ claude-video (script) */
const claudeVideo = {
  name: "claude-video-script",
  kind: "script",
  notes: "Agent skill, not a server: frames.py called directly (uniform sampling, stdlib Python + ffmpeg). Transcript needs Groq/OpenAI keys: n/a offline. No OCR, no scene tool via CLI.",
  // Runs inside the media-intel image (python3 + ffmpeg present), skill mounted read-only.
  run: ({ docker, fixtures, cache, ref }, task) => {
    const base = [...docker.slice(1), "run", "--rm", "--network", "none", "-v", `${fixtures}:/data:ro`, "-v", `${ref}/claude-video:/skill:ro`, "-v", `${cache}:/cache`, "--entrypoint", "python3", "media-intel:bench"];
    const outDir = `/cache/out-${task.task}-${Math.round(Math.random() * 1e6)}`;
    if (task.task === "overview") return { command: docker[0], args: [...base, "/skill/skills/watch/scripts/frames.py", `/data/${task.file}`, outDir, "--max-frames", "40", "--no-dedup"], outDir, cacheDir: cache };
    if (task.task === "frames") return { command: docker[0], args: [...base, "/skill/skills/watch/scripts/watch.py", `/data/${task.file}`, "--timestamps", task.timestamps.join(","), "--detail", "transcript", "--no-whisper"], outDir: undefined, cacheDir: cache };
    return { na: "not available via CLI" };
  },
  tasks: { overview: true, frames: true },
};

export const candidates = [
  mediaIntel("media-intel", "ggml-large-v3-turbo-q5_0.bin"),
  mediaIntel("media-intel-base", "ggml-base-q5_1.bin"),
  mediaUnderstanding,
  videoAnalyzer,
  claudeVideo,
];
