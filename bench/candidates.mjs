/**
 * Candidate adapters. Each maps the benchmark tasks onto the candidate's tools
 * and tells the runner where text, cuts, and timestamps live in its results.
 * `spawn` returns how to start the stdio server (inside Docker on the VPS).
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

/** Try to pull JSON out of a text block (candidates that return JSON as text). */
function jsonFromText(result) {
  const text = (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
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

function mediaIntel(name, whisperModel) {
  return {
    name,
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

/* Reference candidates: filled from bench/candidates.md (exact tool names and result shapes). */

const mediaUnderstanding = {
  name: "media-understanding",
  spawn: (ctx) => dockerSpawn(ctx, "media-understanding:bench", {
    MEDIA_UNDERSTANDING_MODEL: "base-q5_1",
    MEDIA_UNDERSTANDING_CACHE_DIR: "/cache",
    XDG_CACHE_HOME: "/cache",
    HOME: "/cache",
  }),
  tasks: {
    probe: (src) => ({ tool: "probe_media", args: { file_path: src } }),
    transcript: (src) => ({ tool: "get_transcript", args: { file_path: src, format: "json" } }),
    frames: (src, t) => ({ tool: "get_frames", args: { file_path: src, timestamps: t.timestamps } }),
    overview: (src) => ({ tool: "get_video_grids", args: { file_path: src } }),
  },
  parse: {
    transcriptText: (r) => {
      const j = jsonFromText(r);
      if (Array.isArray(j)) return j.map((s) => s.text ?? "").join(" ");
      if (j?.segments) return j.segments.map((s) => s.text ?? "").join(" ");
      if (j?.transcript) return typeof j.transcript === "string" ? j.transcript : (j.transcript.segments ?? []).map((s) => s.text).join(" ");
      return (r?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
    },
    language: (r) => jsonFromText(r)?.language,
    frameTimes: () => undefined,
  },
};

const videoAnalyzer = {
  name: "mcp-video-analyzer",
  spawn: (ctx) => dockerSpawn(ctx, "mcp-video-analyzer:bench", {
    WHISPER_MODEL: "base",
    HOME: "/cache",
    XDG_CACHE_HOME: "/cache",
  }),
  tasks: {
    probe: (src) => ({ tool: "get_metadata", args: { url: src } }),
    transcript: (src) => ({ tool: "get_transcript", args: { url: src } }),
    frames: (src, t) => ({ tool: "get_frame_at", args: { url: src, timestamp: t.timestamps[0] } }),
    overview: (src) => ({ tool: "get_frames", args: { url: src } }),
    scenes: (src) => ({ tool: "get_frames", args: { url: src } }),
    ocr: (src, t) => ({ tool: "analyze_video", args: { url: src, fields: ["ocr"] } }),
  },
  parse: {
    transcriptText: (r) => {
      const j = jsonFromText(r);
      const segs = j?.transcript ?? j?.segments ?? j;
      if (Array.isArray(segs)) return segs.map((s) => s.text ?? "").join(" ");
      if (typeof segs === "string") return segs;
      return (r?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
    },
    language: (r) => jsonFromText(r)?.language,
    cuts: (r) => {
      const j = jsonFromText(r);
      const frames = j?.frames ?? j;
      return Array.isArray(frames) ? frames.map((f) => f.timestamp ?? f.t ?? f.time).filter((x) => typeof x === "number") : [];
    },
    ocrText: (r) => {
      const j = jsonFromText(r);
      const ocr = j?.ocr ?? j?.frames;
      if (Array.isArray(ocr)) return ocr.map((f) => f.ocr ?? f.text ?? "").join("\n");
      return typeof ocr === "string" ? ocr : "";
    },
    frameTimes: (r) => {
      const j = jsonFromText(r);
      const t = j?.timestamp ?? j?.frame?.timestamp;
      return typeof t === "number" ? [t] : undefined;
    },
  },
};

export const candidates = [
  mediaIntel("media-intel", "ggml-large-v3-turbo-q5_0.bin"),
  mediaIntel("media-intel-base", "ggml-base-q5_1.bin"),
  mediaUnderstanding,
  videoAnalyzer,
];
