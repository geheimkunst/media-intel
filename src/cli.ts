#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { sweepCache } from "./cache.js";
import { loadConfig } from "./config.js";
import { startHttp } from "./http.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

const HELP = `${SERVER_NAME} ${SERVER_VERSION}

MCP server for media understanding.

Usage:
  media-intel                      run over stdio (default; for Claude Code, Claude Desktop, Hermes)
  media-intel --http [port]        run a stateless Streamable HTTP endpoint on 127.0.0.1 (default port 3020)
  media-intel doctor               print what this installation can do and exit
  media-intel --version | --help

Environment (all optional):
  MEDIA_INTEL_FFPROBE / MEDIA_INTEL_FFMPEG / MEDIA_INTEL_YTDLP / MEDIA_INTEL_WHISPER / MEDIA_INTEL_TESSERACT
  MEDIA_INTEL_CACHE_DIR (default ~/.cache/media-intel), MEDIA_INTEL_CACHE_TTL_DAYS (14), MEDIA_INTEL_CACHE_MAX_BYTES (5 GiB)
  MEDIA_INTEL_PROCESS_TIMEOUT_MS (120000), MEDIA_INTEL_MAX_DURATION_S (4 h), MEDIA_INTEL_MAX_BYTES (20 GiB)
  MEDIA_INTEL_MAX_TEXT_FIELD_CHARS (20000), MEDIA_INTEL_MAX_COST_USD (0.10)
  MEDIA_INTEL_WHISPER_MODEL (default <cache>/models/ggml-large-v3-turbo-q5_0.bin), MEDIA_INTEL_OCR_LANGUAGES (deu+eng)
  get_transcript allow_paid=true is required before auto mode spends money on OpenAI/ElevenLabs
  MEDIA_INTEL_YTDLP_COOKIES (Netscape cookie file), OPENAI_API_KEY / ELEVENLABS_API_KEY (paid transcription)
  MEDIA_INTEL_ELEVENLABS_MODEL (scribe_v2; scribe_v1 also accepted)
  MEDIA_INTEL_HTTP_HOST (127.0.0.1), MEDIA_INTEL_HTTP_ALLOWED_HOSTS (comma list), MEDIA_INTEL_HTTP_TOKEN (static bearer)
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const first = args[0];
  if (first === "--version" || first === "-v") {
    process.stdout.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);
    return;
  }
  if (first === "--help" || first === "-h") {
    process.stdout.write(HELP);
    return;
  }

  const config = loadConfig();
  const swept = await sweepCache(config).catch(() => ({ removed: 0, freed_bytes: 0 }));
  if (swept.removed > 0) process.stderr.write(`cache sweep: removed ${swept.removed} entries, freed ${(swept.freed_bytes / 1024 ** 2).toFixed(1)} MiB\n`);

  if (first === "doctor") {
    const { doctor, summarizeDoctor } = await import("./tools/doctor.js");
    const r = await doctor(config);
    process.stdout.write(`${summarizeDoctor(r)}\n`);
    return;
  }

  const server = createServer(config);

  if (first === "--http") {
    const port = Number(args[1] ?? process.env.MEDIA_INTEL_HTTP_PORT ?? 3020);
    const host = process.env.MEDIA_INTEL_HTTP_HOST ?? "127.0.0.1";
    const allowed = (process.env.MEDIA_INTEL_HTTP_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    const token = process.env.MEDIA_INTEL_HTTP_TOKEN;
    const { url } = await startHttp(server, {
      port,
      host,
      ...(allowed.length > 0 ? { allowedHosts: allowed } : {}),
      ...(token ? { bearerToken: token } : {}),
    });
    process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} listening on ${url} (stateless Streamable HTTP${token ? ", bearer token required" : ""})\n`);
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout belongs to the protocol; anything human goes to stderr.
  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
