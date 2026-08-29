#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === "--version" || arg === "-v") {
    process.stdout.write(`${SERVER_NAME} ${SERVER_VERSION}\n`);
    return;
  }
  if (arg === "--help" || arg === "-h") {
    process.stdout.write(
      `${SERVER_NAME} ${SERVER_VERSION}\n\nMCP server for media understanding. Runs over stdio.\n\n` +
        "Environment:\n" +
        "  MEDIA_INTEL_FFPROBE / MEDIA_INTEL_FFMPEG   binary paths (default: from PATH)\n" +
        "  MEDIA_INTEL_CACHE_DIR                      derived artifacts (default: ~/.cache/media-intel)\n" +
        "  MEDIA_INTEL_PROCESS_TIMEOUT_MS             external process timeout (default 120000)\n",
    );
    return;
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout belongs to the protocol; anything human goes to stderr.
  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
