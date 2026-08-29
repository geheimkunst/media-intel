# media-intel

One [MCP](https://modelcontextprotocol.io) server for media understanding: probe, transcribe, sample frames into contact sheets, detect scenes, read on-screen text, measure audio, diff frames, pull platform metadata, and search everything you have processed. Built on the MCP TypeScript SDK v2 (spec 2026-07-28) with structured output on every tool.

No native Node bindings: ffmpeg, yt-dlp, whisper.cpp and tesseract are called as processes, so it runs wherever those binaries do.

## Requirements

| Binary | Needed for | Install |
|---|---|---|
| ffmpeg + ffprobe 6+ | everything | `brew install ffmpeg` / `apt install ffmpeg` |
| yt-dlp | `fetch_media`, `get_engagement` | `brew install yt-dlp` |
| whisper-cli (whisper.cpp) | local `get_transcript`, `detect_language` | `brew install whisper-cpp`, then download a model (below) |
| tesseract 5 + language data | `extract_text` | `brew install tesseract tesseract-lang` / `apt install tesseract-ocr tesseract-ocr-deu` |
| exiftool | EXIF/GPS in `probe_image` | `brew install exiftool` |

Node.js 22 or newer. Run `media-intel doctor` (or the `doctor` tool) to see what your installation can do.

Local Whisper model (about 550 MB, multilingual, good for German voice notes):

```bash
mkdir -p ~/.cache/media-intel/models
curl -L -o ~/.cache/media-intel/models/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
curl -L -o ~/.cache/media-intel/models/ggml-silero-v5.1.2.bin \
  https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin   # optional VAD, recommended
```

## Quickstart

```bash
git clone <repo-url> media-intel && cd media-intel
npm install && npm run build
node dist/cli.js doctor
```

Claude Code:

```bash
claude mcp add media-intel -- node /absolute/path/to/media-intel/dist/cli.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "media-intel": { "command": "node", "args": ["/absolute/path/to/media-intel/dist/cli.js"] } } }
```

Streamable HTTP (stateless, loopback, optional static bearer token; put an OAuth bridge in front for the internet):

```bash
MEDIA_INTEL_HTTP_TOKEN=change-me node dist/cli.js --http 3020   # endpoint http://127.0.0.1:3020/mcp
```

Docker (ffmpeg, yt-dlp, whisper-cli, tesseract included; models mounted):

```bash
docker build -t media-intel .
docker run -i --rm -v ~/.cache/media-intel:/cache media-intel
```

## Tools

Three tiers: probe first (cheap), then the precise tool the probe suggests, then orchestration.

| Tool | Tier | What it does |
|---|---|---|
| `doctor` | 0 | Binaries, versions, ffmpeg filters, models, OCR languages, cache, per-capability ready/partial/missing |
| `list_cached` | 0 | What is in the cache, sizes, age; optional sweep |
| `probe_media` | 1 | Kind, container, duration, streams, subtitle tracks, chapters, tags, screen-recording heuristic; `deep` adds silence map and loudness |
| `probe_image` | 1 | Format, dimensions, EXIF/GPS, perceptual hash, QR/barcodes, screenshot heuristic |
| `fetch_media` | 1 | yt-dlp download into the cache: audio, smallest video, subtitles (manual and auto), thumbnail, info; sections |
| `get_engagement` | 1 | Platform metrics, chapters, "most replayed" heatmap, SponsorBlock segments, top comments, without downloading |
| `understand_media` | 2 | One call: deep probe, transcript first, scene structure, contact sheets only when words cannot carry the content; explains every decision |
| `get_transcript` | 3 | Embedded subtitles > sidecar > yt-dlp captions > local whisper.cpp (VAD) > OpenAI whisper-1 / ElevenLabs Scribe (only with `allow_paid` or explicit backend, after cost preflight; `diarize=true` adds speaker labels via ElevenLabs); text/srt/json, time windows, pagination |
| `detect_language` | 3 | Language of the first 30 s via whisper.cpp |
| `get_frames` | 3 | Exact-timestamp frames (jpeg/png/webp), region crop, optional timestamp overlay, manifest |
| `get_video_grids` | 3 | Contact sheets: `cells` (64 default), `grid_long_edge` (1568/2576), `max_frames` (512), dedup, manifest with cell to time mapping, pagination |
| `extract_text` | 3 | OCR with tesseract at full resolution, forced language, region crop, word boxes and confidence |
| `get_scenes` | 3 | Cuts with scores, shots, black and frozen stretches, cuts per minute, hook window |
| `analyze_audio` | 3 | LUFS, loudness range, true peak, noise floor, silence map, speech segments, waveform or spectrogram image |
| `diff_frames` | 3 | What changed between two timestamps: ratio, verdict, change rectangles, diff image |
| `analyze_moment` | 3 | Burst of frames around a timestamp, transcript around it, optional OCR of the nearest frame |
| `media_search` | 4 | Full-text search (FTS5) over every transcript and OCR result in the cache |

Prompts: `tldr`, `key_moments`, `quotables`, `hook_breakdown` (fixed-shape reports that call the tools above).

Every tool returns `structuredContent` validated against its advertised `outputSchema`, plus a short text block; image tools add image blocks. Text that came out of a medium (transcripts, OCR, subtitles, comments, titles) is delivered in fields marked `source_trust: "untrusted"`, framed by `<<<MEDIA_TEXT_BEGIN untrusted>>> ... <<<MEDIA_TEXT_END>>>` and capped at `MEDIA_INTEL_MAX_TEXT_FIELD_CHARS`. Errors are tool results with `isError`, a code and a `Hint:` line.

### Example: `probe_media`

```json
{ "source": "/abs/clip.mp4" }
```

```
video | mov,mp4,m4a,3gp,3g2,mj2 | 0:03 | 320x240@10fps h264 | audio aac 44100Hz 1ch | 41.3 KiB | title="Fixture Clip"
Suggested next: get_transcript, get_video_grids, get_frames
```

`structuredContent` carries `kind`, `duration_s`, `video`, `audio`, `subtitles`, `chapters`, `tags`, `stream_counts`, `looks_like_screen_recording`, `warnings`, `suggested_next`.

### Example: grids and manifest

`get_video_grids` with `{ "source": "talk.mp4", "cells": 64 }` returns one image per grid and a manifest: `{ "grid_index": 0, "cell_index": 12, "t_s": 41.2 }`. Cells are row-major from the top-left. Read times from the manifest, never off the pixels.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MEDIA_INTEL_FFPROBE`, `MEDIA_INTEL_FFMPEG`, `MEDIA_INTEL_YTDLP`, `MEDIA_INTEL_WHISPER`, `MEDIA_INTEL_TESSERACT` | names on PATH | binaries |
| `MEDIA_INTEL_CACHE_DIR` | `~/.cache/media-intel` | derived artifacts, models, search index |
| `MEDIA_INTEL_CACHE_TTL_DAYS`, `MEDIA_INTEL_CACHE_MAX_BYTES` | 14, 5 GiB | sweep policy (runs at startup) |
| `MEDIA_INTEL_PROCESS_TIMEOUT_MS` | 120000 | per external process; yt-dlp gets 5x |
| `MEDIA_INTEL_MAX_DURATION_S`, `MEDIA_INTEL_MAX_BYTES`, `MEDIA_INTEL_MAX_STREAMS`, `MEDIA_INTEL_MAX_PIXELS` | 4 h, 20 GiB, 20, 8K | hard input limits |
| `MEDIA_INTEL_MAX_TEXT_FIELD_CHARS` | 20000 | untrusted text cap per field |
| `MEDIA_INTEL_MAX_COST_USD` | 0.10 | paid transcription refuses above this estimate |
| `MEDIA_INTEL_WHISPER_MODEL` | `<cache>/models/ggml-large-v3-turbo-q5_0.bin` | local model |
| `MEDIA_INTEL_OCR_LANGUAGES` | `deu+eng` | tesseract languages |
| `MEDIA_INTEL_YTDLP_COOKIES` | unset | Netscape cookie file (never browser cookies) |
| `OPENAI_API_KEY`, `ELEVENLABS_API_KEY` | unset | paid transcription backends; used only with `allow_paid=true` or `backend=openai\|elevenlabs`, never by a set key alone |
| `MEDIA_INTEL_ELEVENLABS_MODEL` | `scribe_v2` | ElevenLabs Scribe model (`scribe_v2` or `scribe_v1`): 0.22 USD per hour, 90+ languages, up to 32 speakers with `diarize=true`, header `xi-api-key` |
| `MEDIA_INTEL_HTTP_HOST`, `MEDIA_INTEL_HTTP_PORT`, `MEDIA_INTEL_HTTP_ALLOWED_HOSTS`, `MEDIA_INTEL_HTTP_TOKEN` | 127.0.0.1, 3020, unset, unset | `--http` mode |

Inject secrets through a launcher (for example `op run`), never into config files.

## Security model

- Only `http`, `https`, `file` and plain paths; hosts that resolve to private or loopback addresses are refused (SSRF guard); paths are symlink-resolved.
- Inputs above the duration, size, stream and resolution limits are rejected before decoding.
- Every child process gets an argument array (no shell), a timeout, and process-group termination.
- Cache paths are derived from content fingerprints, never from user strings; cache dirs are mode 0700; TTL and size cap are enforced at startup.
- Media text is untrusted and framed; paid backends run a cost preflight; known secret values are redacted from outputs.

## Development

```bash
npm install
npm run typecheck && npm test && npm run build
npm run dev            # tsx src/cli.ts (stdio)
```

Tests run offline: fixtures are synthesized with ffmpeg and sharp, external binaries are faked with small scripts, HTTP backends are stubbed. `tests/*.test.ts` also exercise the full MCP round trip through an in-memory transport and the Streamable HTTP entry.

Design notes, decisions (A1 to A20), the capability map and the roadmap live in `docs/`. Deep dives into the reference projects and the tool landscape are in `docs/research/`.

## Benchmark

`docs/benchmarks/2026-08-29-stufe-1.md` compares media-intel with dymoo/media-understanding, guimatheus92/mcp-video-analyzer and the claude-video skill in isolated Docker containers on one host, offline, against fixtures with known ground truth (WER, CER, cut precision/recall, tokens per frame, robustness). Reproduce with `node bench/make-fixtures.mjs && bash bench/run-vps.sh && node bench/report.mjs bench/results/<run>.json`.

## License

MIT
