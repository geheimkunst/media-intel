# media-intel

A consolidated [MCP](https://modelcontextprotocol.io) server for media understanding: probe, transcribe, sample frames, detect scenes, read on-screen text. Built on the MCP TypeScript SDK v2 (spec 2026-07-28).

Status: **v0.1.0, first tool shipped.** `probe_media` is implemented, tested and runs over stdio. See `docs/roadmap.md` for what comes next.

## Why

Existing servers each cover a slice: one does budget-aware keyframe grids, another does multi-platform download plus OCR, the agent skills know good heuristics but are not servers. media-intel merges the patterns that proved useful (three-tier tools, captions before Whisper, `warnings[]` with hints, content-addressed cache, cost preflight) into one server with structured output and no native Node bindings.

## Requirements

- Node.js 22 or newer
- FFmpeg 6 or newer (`ffprobe` and `ffmpeg` on `PATH`, or set `MEDIA_INTEL_FFPROBE` / `MEDIA_INTEL_FFMPEG`)
- Optional, used by later tools: `yt-dlp`, `whisper-cli` (whisper.cpp), `tesseract`

## Quickstart

```bash
git clone <repo-url> media-intel
cd media-intel
npm install
npm run build
node dist/cli.js --help
```

Register with Claude Code:

```bash
claude mcp add media-intel -- node /absolute/path/to/media-intel/dist/cli.js
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "media-intel": {
      "command": "node",
      "args": ["/absolute/path/to/media-intel/dist/cli.js"]
    }
  }
}
```

Smoke test without a client:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"probe_media","arguments":{"source":"/path/to/file.mp4"}}}' \
  | node dist/cli.js
```

## Tools

| Tool | Status | What it does |
|---|---|---|
| `probe_media` | shipped | Decode-free inspection: kind, container, duration, resolution, fps, codecs, audio layout, subtitles, chapters, tags, warnings, `suggested_next` |
| `get_frames` | planned | Exact-timestamp JPEGs with overlay |
| `get_video_grids` | planned | Contact sheets sampled by duration, vision-token budgeted |
| `get_transcript` | planned | Embedded captions, then local whisper.cpp, then OpenAI API with cost preflight; `window` and `format` (text/srt/json) |
| `fetch_media` | planned | yt-dlp wrapper with cache (video, audio, subtitles, thumbnail) |
| `understand_media` | planned | One-call orchestration under `max_total_chars` |
| `get_scenes` | planned | Cut list, shot metrics, hook window |
| `extract_text` | planned | OCR on frames |
| `analyze_moment` | planned | Burst frames plus transcript slice around a timestamp |

### `probe_media`

Input:

```json
{ "source": "/absolute/path/to/file.mp4" }
```

`source` accepts an absolute path, a `file://` URL, or a direct `http(s)` URL to a media file. Platform pages (YouTube and friends) will go through `fetch_media` once it lands.

Output (`structuredContent`, validated against the advertised `outputSchema`):

```json
{
  "source": "/abs/clip.mp4",
  "source_kind": "file",
  "kind": "video",
  "container": "mov,mp4,m4a,3gp,3g2,mj2",
  "duration_s": 3,
  "size_bytes": 42301,
  "bit_rate": 112802,
  "video": { "codec": "h264", "profile": "High", "width": 320, "height": 240, "fps": 10, "frame_count": 30, "pixel_format": "yuv420p", "bit_rate": 35213 },
  "audio": { "codec": "aac", "sample_rate": 44100, "channels": 1, "channel_layout": "mono", "bit_rate": 69171 },
  "subtitles": [],
  "chapters": [],
  "tags": { "title": "Fixture Clip", "encoder": "Lavf62.12.102" },
  "stream_counts": { "video": 1, "audio": 1, "subtitle": 0, "other": 0 },
  "warnings": [],
  "suggested_next": ["get_transcript", "get_video_grids", "get_frames"]
}
```

The text block carries a one-line summary for humans:

```
video | mov,mp4,m4a,3gp,3g2,mj2 | 0:03 | 320x240@10fps h264 | audio aac 44100Hz 1ch | 41.3 KiB | "Fixture Clip"
Suggested next: get_transcript, get_video_grids, get_frames
```

Errors come back as tool results with `isError: true` and a `Hint:` line, for example `source_not_found`, `ffprobe_missing`, `ffprobe_failed`, `ffprobe_timeout`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `MEDIA_INTEL_FFPROBE` | `ffprobe` | ffprobe binary |
| `MEDIA_INTEL_FFMPEG` | `ffmpeg` | ffmpeg binary |
| `MEDIA_INTEL_CACHE_DIR` | `$XDG_CACHE_HOME/media-intel` or `~/.cache/media-intel` | derived artifacts |
| `MEDIA_INTEL_PROCESS_TIMEOUT_MS` | `120000` | timeout per external process |
| `MEDIA_INTEL_WARN_FILE_SIZE_BYTES` | `4 GiB` | probe warns above this size |
| `MEDIA_INTEL_WARN_DURATION_SECONDS` | `3 h` | probe warns above this duration |

Secrets for paid backends (later phases) are read from the environment; run the server through a launcher that injects them (for example `op run`), never write them into config files.

## Development

```bash
npm install
npm run typecheck
npm test          # vitest, uses synthetic fixtures in tests/fixtures
npm run build
npm run dev       # tsx src/cli.ts (stdio)
```

Fixtures are generated with ffmpeg (`tests/fixtures/`): a 3 s test-pattern mp4 with a sine tone, a 2 s mono wav, a 64x48 png. Tests exercise the pure tool function and the full MCP round trip through an in-memory transport.

Design notes, decisions and the roadmap live in `docs/`. Deep dives into the four reference projects (dymoo/media-understanding, guimatheus92/mcp-video-analyzer, bradautomates/claude-video, taoufik123-collab/claude-watch) are in `docs/research/`.

## License

MIT
