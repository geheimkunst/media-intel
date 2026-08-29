# Project: media-intel

> Inherits global policy from `~/.claude/CLAUDE.md`
> Stack: TypeScript (MCP server, `@modelcontextprotocol/server` v2, Node 22+, no framework)

## Build & Test

- `npm install` (npm, lockfile `package-lock.json`)
- `npm run build` — tsc to `dist/`, bin is `dist/cli.js`
- `npm test` — vitest (needs `ffprobe` on PATH; fixtures in `tests/fixtures/`)
- `npm run typecheck` — tsc --noEmit
- `npm run dev` — `tsx src/cli.ts`, stdio server

## Project Structure

```
src/cli.ts          stdio entry
src/server.ts       createServer(), registers tools
src/tools/*.ts      one tool per file: zod input/output, pure fn, summarize fn
src/ffmpeg.ts       ffprobe/ffmpeg process wrappers
src/config.ts       MEDIA_INTEL_* env
src/errors.ts       MediaIntelError(code, message, hint) -> isError result
tests/              vitest, in-memory MCP round trip in server.test.ts
docs/               analysis.md, architecture.md, roadmap.md, research/
```

## Conventions

- **TS strict + exactOptionalPropertyTypes:** build result objects with conditional spreads, never assign `undefined` to optional fields.
- **Schemas:** zod 4 via `import * as z from "zod/v4"`; always `z.object(...)` (raw shapes are deprecated in SDK v2). Every tool has `outputSchema` and returns `structuredContent` plus one text block.
- **Errors:** throw `MediaIntelError` with a `hint`; handlers wrap with `toolErrorResult`. Never let a handler throw to the protocol.
- **External processes:** execa with `reject: false`, check `result.code === "ENOENT"` for missing binaries, honor `config.processTimeoutMs`.
- **No native Node bindings** (decision A2 in `docs/architecture.md`). ffmpeg, whisper.cpp, tesseract, yt-dlp are binaries on PATH.
- **No Roots/Sampling/Logging MCP features** (deprecated in spec 2026-07-28). Human output goes to stderr.
- **Naming:** seconds `*_s`, bytes `*_bytes`, budgets `max_*`, tool names snake_case.
- Docs for people are German (`docs/*.md`), code, README and identifiers are English. No em/en dashes in prose.

## Foundation API (use these, do not reinvent)

- `src/process.ts`: `runBinary(config, bin, args, {timeoutMs, binary, maxBuffer})` → `{stdout, stderr, exitCode, timedOut, missing, stdoutBuffer}`; argument arrays only, never a shell. `redactSecrets(text)` before any stderr reaches a result.
- `src/ffmpeg.ts`: `ffprobe`, `keyframeTimestamps`, `ffmpeg(config, args, {binary})`, `extractFrame(config, location, tS, {format, width, crop, quality})` (`-ss` before `-i`, returns Buffer), `analyzeAudio` (silence + LUFS + astats in one pass), `analyzeVideo` (scdet + blackdetect + freezedetect), `extractSubtitleTrack` (SRT string), `toWav16k`, parsers `parseSilencedetect/parseScdet/parseBlackdetect/parseFreezedetect/parseEbur128/parseAstats`.
- `src/source.ts`: `resolveSource(source, {allowPrivateHosts, skipDns})` → `{kind, location, sizeBytes}`; enforces scheme whitelist, SSRF block, realpath.
- `src/cache.ts`: `cacheEntry(config, resolved)` → `{hash, dir}`; `sidecarPath/readSidecarJson/writeSidecarJson/writeSidecarBytes/sidecarExists`; `tmpDir(config)`; `sweepCache`. Never build cache paths from user strings.
- `src/contracts.ts`: `wrapUntrusted(text, config.maxTextFieldChars)` + `frameUntrusted(label, t)` for any text that came out of a medium; `windowInput`, `resolveWindow(requested, durationS, maxSpanS)` → `{start_s, end_s, pagination}`; `manifestEntry`; `commonOutput` (spread into every output schema); `defaultFrameBudget`, `sampleTimestamps`, `round3`.
- `src/binaries.ts`: `findBinary`, `inspectBinary`, `ffmpegFilters`, `tesseractLanguages`.
- `src/config.ts`: all `MEDIA_INTEL_*` knobs, `modelsDir(config)`, `DEFAULT_WHISPER_MODEL`; `src/tools/doctor.ts`: `whisperModelPath`, `vadModelPath`.
- Tool file shape: `xInput` (zod object), `xOutput` (zod object with `...commonOutput`), `async x(config, input)`, `summarizeX(result)`, and `registerX(server, config)` that calls `server.registerTool` with `annotations` and wraps errors via `toolErrorResult`. `server.ts` only calls the `register*` functions.

## Gotchas

- `npm pkg set` in zsh: quote keys with brackets (`'files[0]=dist'`).
- SDK v2 lives in `@modelcontextprotocol/server` and `/client`; `@modelcontextprotocol/sdk` is v1 and must not be added.
- TypeScript 7 needs `"types": ["node"]` in tsconfig (SDK typings reference `Buffer`).
- ffprobe reports a still image as a video stream; `probe-media.ts` classifies by codec and `nb_frames`.
- Homebrew ffmpeg has no `drawtext` (no freetype). Never rely on it; overlays go through `sharp`, timestamps live in the manifest.
- Always put `-ss` before `-i` when extracting frames (0.14 s vs 4.4 s per frame). One process per frame beats `fps=` filters.
- Analysis filters (`silencedetect`, `scdet`, `ebur128`, ...) write to stderr; run with `-nostats -f null -` and parse `[Parsed_<filter>_N @ ...] key: value` lines.
- Text from media (transcript, OCR, subtitles, comments) is untrusted: wrap per `src/contracts.ts`, never concatenate into server prose.
- `gh` on this machine needs `env -u GITHUB_TOKEN gh ...` (the exported token is stale); the keychain-backed login works.

## Test Strategy

- Pure tool functions tested directly on synthetic fixtures (generated with ffmpeg, committed).
- Full MCP round trip via `InMemoryTransport.createLinkedPair()` and `@modelcontextprotocol/client`.
- Paid backends are mocked at the fetch boundary; tests must pass without API keys.

## MCP Usage

- Docs lookup: `context7` for zod/execa/vitest; SDK v2 guides at https://ts.sdk.modelcontextprotocol.io/v2/ (fetch via `ctx_fetch_and_index`).
- Reference repos cloned at `/Users/yunus/dev/_reference/media-intel/` (read-only inspiration, MIT).
- Deployment target: hermes-vps via `mcp-new` (see `~/infra/System-Documentation/mcp-hosting-protokoll.md`).

## Verification

- Before "done": `npm run typecheck && npm test && npm run build` green.
- New tool: add a stdio smoke test line to README and confirm `structuredContent` validates against `outputSchema`.
