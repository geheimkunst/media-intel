# media-intel

Ein MCP-Server, der Video, Audio und Bilder für Claude lesbar macht: für Agent-Betreiber, die Voice-Notes, Screen-Recordings und Talks ohne Handarbeit auswerten wollen.

## Ergebnis
- 16 Tools in einem Server, seit 29-08-2026 in Claude Code im Einsatz (`probe_media`, `get_transcript`, `get_scenes`, `extract_text`, `understand_media`, `media_search`).
- Benchmark gegen 4 fremde Server auf 16 Fixtures, Ergebnis in `docs/benchmarks/2026-08-29-stufe-1.md`.
- Streamable-HTTP-Endpunkt hinter einer OAuth-2.1-Bridge auf einem eigenen VPS, seit 29-08-2026.

## Architektur
1. `ffprobe` liefert Metadaten, `yt-dlp` holt Quellen von Plattformen.
2. whisper.cpp erkennt Sprache und Transkript, tesseract liest Bildschirmtext.
3. Ein Cache unter `~/.cache/media-intel` hält Transkripte, Grids und einen FTS5-Index.
4. Der Server gibt jedes Ergebnis als Text plus `structuredContent` an Claude Code, Claude Desktop oder claude.ai.
5. Betrieb: stdio lokal, `--http` auf dem VPS hinter Caddy und OAuth 2.1.

## Stack
TypeScript, Node 22+, `@modelcontextprotocol/server` v2, SQLite FTS5, ffmpeg, whisper.cpp, tesseract, Docker

## Was ich selbst gebaut habe, was der Agent geschrieben hat
- Selbst: Ziel, Tool-Schnitt, Benchmark-Design, Abnahme jedes Tools im Einsatz, Deploy und Betrieb.
- Agent (Claude Code, Commit-Trailer `Co-Authored-By: Claude`): 28 von 39 Commits. Das sind `src/`, `tests/`, `bench/` und die Erstfassung von `docs/`.
- Fremd: ffmpeg, yt-dlp, whisper.cpp, tesseract als Prozesse. Ideen aus den Vergleichs-Servern in `bench/candidates.md` (alle MIT).

## Stand und Grenzen
- Stand: 26-09-2026, 16 Tools laufen lokal und auf dem VPS, Tests grün mit vitest.
- Grenzen: Blenden-Erkennung in `get_scenes` fehlt, Sprecher-Trennung nur über ElevenLabs, Dateien über 20 Minuten laufen ohne MCP-Tasks.

## Start
```bash
npm install && npm run build
node dist/cli.js doctor
```

Details zu Tools, Konfiguration und Sicherheitsmodell: `docs/reference.md`.
