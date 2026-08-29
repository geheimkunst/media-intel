import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../src/config.js";
import { MediaIntelError } from "../src/errors.js";
import {
  classifyElevenLabsError,
  ELEVENLABS_STT_URL,
  toIso6391,
  transcribeWithElevenLabs,
  wordsToSegments,
  type ElevenLabsWord,
} from "../src/backends/transcribe/elevenlabs.js";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServer } from "../src/server.js";

const fixtures = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");
const tone = join(fixtures, "tone.wav");
let scratch: string;
let config: Config;
const savedKey = process.env.ELEVENLABS_API_KEY;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "media-intel-elevenlabs-"));
  config = { ...loadConfig(), cacheDir: join(scratch, "cache") };
});

afterAll(async () => {
  if (savedKey === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = savedKey;
  await rm(scratch, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const w = (text: string, start: number, end: number, extra: Partial<ElevenLabsWord> = {}): ElevenLabsWord => ({ text, start, end, type: "word", logprob: -0.01, ...extra });
const sp = (start: number, end: number, speaker?: string): ElevenLabsWord => ({ text: " ", start, end, type: "spacing", ...(speaker ? { speaker_id: speaker } : {}) });

const twoSpeakers: ElevenLabsWord[] = [
  w("Hallo", 0.1, 0.4, { speaker_id: "speaker_0" }),
  sp(0.4, 0.45, "speaker_0"),
  w("Welt.", 0.45, 0.9, { speaker_id: "speaker_0" }),
  sp(0.9, 1.0, "speaker_0"),
  { text: "(laughter)", start: 1.0, end: 1.5, type: "audio_event", speaker_id: "speaker_0" },
  sp(1.5, 2.0, "speaker_1"),
  w("Ja", 2.0, 2.2, { speaker_id: "speaker_1" }),
  sp(2.2, 2.25, "speaker_1"),
  w("genau", 2.25, 2.6, { speaker_id: "speaker_1" }),
];

// Fits inside the 2 s tone.wav fixture, so the window filter of get_transcript keeps both speakers.
const twoSpeakersShort: ElevenLabsWord[] = [
  w("Hallo", 0.1, 0.4, { speaker_id: "speaker_0" }),
  sp(0.4, 0.45, "speaker_0"),
  w("Welt", 0.45, 0.9, { speaker_id: "speaker_0" }),
  sp(0.9, 1.1, "speaker_1"),
  w("Ja", 1.1, 1.3, { speaker_id: "speaker_1" }),
  sp(1.3, 1.35, "speaker_1"),
  w("genau", 1.35, 1.7, { speaker_id: "speaker_1" }),
];

describe("wordsToSegments", () => {
  it("joins words with spacing tokens and applies the window offset", () => {
    const segs = wordsToSegments([w("Hallo", 0.1, 0.4), sp(0.4, 0.45), w("Welt", 0.45, 0.9)], { offsetS: 10 });
    expect(segs).toEqual([{ start_s: 10.1, end_s: 10.9, text: "Hallo Welt" }]);
  });

  it("splits on speaker change, keeps the label and inlines audio events", () => {
    expect(wordsToSegments(twoSpeakers)).toEqual([
      { start_s: 0.1, end_s: 1.5, text: "Hallo Welt. (laughter)", speaker: "speaker_0" },
      { start_s: 2, end_s: 2.6, text: "Ja genau", speaker: "speaker_1" },
    ]);
  });

  it("splits on pauses longer than one second", () => {
    const segs = wordsToSegments([w("eins", 0, 0.3), sp(0.3, 0.4), w("zwei", 2.0, 2.3)]);
    expect(segs.map((s) => s.text)).toEqual(["eins", "zwei"]);
  });

  it("splits at sentence ends once a segment is long enough and never exceeds the hard cap", () => {
    const words: ElevenLabsWord[] = [];
    let t = 0;
    for (let i = 0; i < 40; i++) {
      words.push(w(i % 10 === 9 ? "wort." : "wort", t, t + 0.2));
      t += 0.2;
      words.push(sp(t, t + 0.05));
      t += 0.05;
    }
    const segs = wordsToSegments(words);
    expect(segs.length).toBeGreaterThan(1);
    for (const s of segs) expect(s.text.length).toBeLessThanOrEqual(200);
    expect(segs.map((s) => s.text).join(" ")).toBe(words.filter((x) => x.type === "word").map((x) => x.text).join(" "));
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.start_s).toBeGreaterThanOrEqual(segs[i - 1]!.end_s);
  });

  it("keeps languages without spacing tokens intact and tolerates missing timestamps", () => {
    const segs = wordsToSegments([w("今日", 0, 0.3), w("は", 0.3, 0.4), { text: "晴れ", type: "word", logprob: -0.1, start: null, end: null }]);
    expect(segs).toEqual([{ start_s: 0, end_s: 0.4, text: "今日は晴れ" }]);
  });

  it("returns nothing for spacing-only input", () => {
    expect(wordsToSegments([sp(0, 0.1), sp(0.1, 0.2)])).toEqual([]);
  });
});

describe("toIso6391", () => {
  it("maps Scribe ISO-639-3 codes to the ISO-639-1 codes the rest of the server uses", () => {
    expect(toIso6391("deu")).toBe("de");
    expect(toIso6391("ENG")).toBe("en");
    expect(toIso6391("de")).toBe("de");
    expect(toIso6391("yue")).toBe("yue");
  });
});

describe("transcribeWithElevenLabs (fetch mocked at the boundary)", () => {
  it("posts a multipart form with xi-api-key and maps words, language, speakers and cost", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key-1234567890";
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        const body = {
          language_code: "deu",
          language_probability: 0.98,
          text: "Hallo Welt. (laughter) Ja genau",
          words: twoSpeakers,
          audio_duration_secs: 3,
          transcription_id: "tr_123",
        };
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );

    const result = await transcribeWithElevenLabs(config, tone, { language: "de", startSeconds: 0.5, endSeconds: 2, diarize: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ELEVENLABS_STT_URL);
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["xi-api-key"]).toBe("test-key-1234567890");
    expect(headers.Authorization).toBeUndefined();
    const form = calls[0]!.init.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v2");
    expect(form.get("language_code")).toBe("de");
    expect(form.get("diarize")).toBe("true");
    expect(form.get("timestamps_granularity")).toBe("word");
    expect(form.get("tag_audio_events")).toBe("true");
    const file = form.get("file");
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe("audio.wav");
    expect((file as Blob).size).toBeGreaterThan(1000);

    expect(result.language).toBe("de");
    expect(result.language_confidence).toBeCloseTo(0.98);
    expect(result.model).toBe("scribe_v2");
    expect(result.transcription_id).toBe("tr_123");
    expect(result.segments).toEqual([
      { start_s: 0.6, end_s: 2, text: "Hallo Welt. (laughter)", speaker: "speaker_0" },
      { start_s: 2.5, end_s: 3.1, text: "Ja genau", speaker: "speaker_1" },
    ]);
    expect(result.cost_estimate_usd).toBeCloseTo((3 / 3600) * 0.22, 6);
  });

  it("honours MEDIA_INTEL_ELEVENLABS_MODEL and omits language_code for auto", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key-1234567890";
    let form: FormData | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        form = init?.body as FormData;
        return new Response(JSON.stringify({ language_code: "en", language_probability: 1, text: "hi", words: [w("hi", 0, 0.2)] }), { status: 200 });
      }),
    );
    const result = await transcribeWithElevenLabs({ ...config, elevenlabsModel: "scribe_v1" }, tone, { language: "auto" });
    expect(form?.get("model_id")).toBe("scribe_v1");
    expect(form?.get("language_code")).toBeNull();
    expect(form?.get("diarize")).toBe("false");
    expect(result.model).toBe("scribe_v1");
    expect(result.segments).toEqual([{ start_s: 0, end_s: 0.2, text: "hi" }]);
  });

  it("fails with elevenlabs_no_key without a key and never calls fetch", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    await expect(transcribeWithElevenLabs(config, tone, {})).rejects.toMatchObject({ code: "elevenlabs_no_key" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("surfaces API errors with the status and redacts the key", async () => {
    process.env.ELEVENLABS_API_KEY = "secret-key-xyz-1234";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: { status: "invalid_api_key", message: "key secret-key-xyz-1234 rejected" } }), { status: 401 })),
    );
    const err = await transcribeWithElevenLabs(config, tone, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaIntelError);
    expect((err as MediaIntelError).code).toBe("elevenlabs_invalid_api_key");
    expect((err as MediaIntelError).message).toContain("401");
    expect((err as MediaIntelError).message).not.toContain("secret-key-xyz-1234");
    expect((err as MediaIntelError).hint).toContain("ELEVENLABS_API_KEY");
  });

  it("maps quota_exceeded (seen live: 401 with detail.status) to its own code and hint", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key-1234567890";
    const body = { detail: { type: "invalid_request", code: "quota_exceeded", message: "This request exceeds your quota of 40000. You have 0 credits remaining.", status: "quota_exceeded" } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 401 })));
    const err = (await transcribeWithElevenLabs(config, tone, {}).catch((e: unknown) => e)) as MediaIntelError;
    expect(err.code).toBe("elevenlabs_quota_exceeded");
    expect(err.message).toContain("0 credits remaining");
    expect(err.hint).toContain("credits");
    expect(classifyElevenLabsError(500, "<html>gateway</html>").code).toBe("elevenlabs_api_error");
    expect(classifyElevenLabsError(422, JSON.stringify({ detail: "model_id invalid" })).message).toContain("model_id invalid");
  });

  it("reports elevenlabs_empty when the API returns no words", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key-1234567890";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ language_code: "eng", language_probability: 0.5, text: "", words: [] }), { status: 200 })));
    await expect(transcribeWithElevenLabs(config, tone, {})).rejects.toMatchObject({ code: "elevenlabs_empty" });
  });
});

describe("get_transcript with backend=elevenlabs over MCP", () => {
  async function connect() {
    const server = createServer(config);
    const client = new Client({ name: "test-client", version: "1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
  }

  it("advertises elevenlabs and diarize in the input schema", async () => {
    const client = await connect();
    const tools = await client.listTools();
    const tool = tools.tools.find((t) => t.name === "get_transcript");
    const schema = JSON.stringify(tool?.inputSchema);
    expect(schema).toContain('"elevenlabs"');
    expect(schema).not.toContain("groq");
    expect(schema).toContain('"diarize"');
    expect(JSON.stringify(tool?.outputSchema)).toContain('"speaker"');
  });

  it("returns elevenlabs_no_key as a tool error without a key", async () => {
    delete process.env.ELEVENLABS_API_KEY;
    const client = await connect();
    const res = await client.callTool({ name: "get_transcript", arguments: { source: tone, backend: "elevenlabs" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("elevenlabs_no_key");
  });

  it("delivers speakers through the tool when the API answers", async () => {
    process.env.ELEVENLABS_API_KEY = "test-key-1234567890";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ language_code: "deu", language_probability: 0.97, text: "x", words: twoSpeakersShort, audio_duration_secs: 2 }), { status: 200 })),
    );
    const client = await connect();
    const res = await client.callTool({ name: "get_transcript", arguments: { source: tone, backend: "elevenlabs", diarize: true, format: "json" } });
    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as { transcription_source: string; language: string; segments: { speaker?: string }[]; cost_estimate_usd?: number; warnings: string[] };
    expect(structured.transcription_source).toBe("elevenlabs");
    expect(structured.language).toBe("de");
    expect(structured.segments.map((s) => s.speaker)).toEqual(["speaker_0", "speaker_1"]);
    expect(structured.cost_estimate_usd).toBeCloseTo((2 / 3600) * 0.22, 5);
    expect(structured.warnings.some((x) => x.includes("diarize"))).toBe(false);
  });
});
