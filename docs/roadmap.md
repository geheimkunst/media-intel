# Roadmap media-intel

> Stand 29-08-2026, 16:30, nach zweiter Research-Runde. Jede Phase endet mit grünem `npm run typecheck && npm test && npm run build`, einem README-Eintrag pro Tool und einem Test mit echtem Material von Yunus. Tool-Details: `docs/capabilities.md`.

## Phase 0: Fundament (erledigt 29-08-2026)

- [x] Recherche Runde 1: vier Repos, MCP-Spec 2026-07-28, SDK v2 (`docs/research/repo-*.md`, `tech-landscape-2026.md`)
- [x] Recherche Runde 2: Toolchain, agentisches Ökosystem, Lücken, ffmpeg-Spike (`docs/research/harvest-*.md`, `spike-ffmpeg-filters.md`)
- [x] Architektur, Fähigkeiten-Karte, Entscheidungen A1 bis A20
- [x] Scaffold: TS strict, vitest, SDK v2, execa, synthetische Fixtures
- [x] `probe_media` Basis: 14 Tests grün, stdio-Smoke-Test

## Phase 1: MVP, lokal nutzbar

Reihenfolge nach Abhängigkeit. Block A ist Fundament (seriell), Block B ist parallelisierbar (ein Agent pro Tool), Block C Integration.

**Block A, Fundament (seriell, etwa 40 min):**
1. `src/cache.ts`: Fingerprint (Größe, mtime, erste und letzte 64 KiB, bei URLs Hash), Verzeichnis `~/.cache/media-intel/<hash>/`, Sidecars, Modus 0700, TTL 14 Tage und Obergrenze 5 GiB beim Start
2. `src/ffmpeg.ts` erweitern: `runFfmpeg` mit Prozessgruppe und Timeout, Parser für `silencedetect`, `scdet`, `blackdetect`, `freezedetect`, `ebur128`, `loudnorm`-JSON; `extractFrame(source, t_s, {format, width, crop})` mit `-ss` vor `-i`
3. `src/contracts.ts`: Typen und Helfer für Untrusted-Text-Umrandung, Pagination-Felder, Manifest, Budget-Prüfung
4. `src/binaries.ts`: Auffinden und Versionsprüfung von ffmpeg, ffprobe, yt-dlp, whisper-cli, tesseract; Grundlage für `doctor`
5. `doctor`-Tool (klein, direkt in Block A, weil alle anderen Tools es nutzen)

**Block B, Tools (parallel):**
6. `get_frames`: Timestamps, `frame_format` jpeg/png/webp, `max_width` (0 = original), optionaler `region`-Crop, Overlay per `sharp` (Default aus), Manifest
7. `get_video_grids`: `cells` 64, `grid_long_edge` 1568/2576, `max_frames` 512, `window`, Dauer-Heuristik für Abtastung, pHash-Dedup, Montage per `sharp`, Manifest, Pagination
8. `get_transcript`: Kette eingebettet > Sidecar > yt-dlp-Untertitel > whisper-cli (`--vad`, `-oj`, Wort-Timestamps optional, Modell aus Env, Default `large-v3-turbo-q5_0`) > OpenAI/Groq mit Cost-Preflight (Code aus dem Fork `feat/openai-backend` übernehmen); `window`, `format`, Cursor-Pagination, `transcription_source`, `language`, Untrusted-Umrandung
9. `detect_language`: whisper-cli auf 30 s Ausschnitt; Ergebnis fließt in `get_transcript` und `extract_text`
10. `fetch_media`: yt-dlp mit `--no-playlist`, `--download-sections`, Untertitel mit Sprachwahl, Formatwahl klein für Frames, nur Audio für Transkription, Infojson im Cache, Cookies nur aus Datei
11. `get_engagement`: liest Infojson (via `yt-dlp -J` ohne Download), Metriken, Kapitel, Heatmap, SponsorBlock, Top-Kommentare mit `max_comments` 50 und Umrandung
12. `extract_text`: tesseract `tsv`, Sprache `deu+eng` oder aus `detect_language`, kein Downscaling, Region-Crop, Wortboxen und Konfidenz, niedrige Konfidenz als Warnung
13. `probe_media` um `deep: true` erweitern (Stille-Karte, Lautheit, Rauschboden in einer Filterkette) und Untertitelspuren plus Kapitel in `suggested_next` einbeziehen

**Block C, Integration (seriell):**
14. Review-Durchlauf: Konventionen, Schemas, Sicherheits-Checkliste Punkte 1 bis 14 als Tests
15. CLI `media-intel <tool> <source> [--json]` über dieselben Funktionen
16. README: Quickstart, Tool-Tabelle, Config, Beispiele; `docs/` nachziehen
17. Abnahme mit echtem Material: eine deutsche Voice-Note ohne API-Key (braucht `brew install whisper-cpp` plus Modell), ein Screen-Recording mit Terminal-Text, ein YouTube-Video mit Kapiteln

## Phase 2: Verstehen statt nur extrahieren

1. `get_scenes`: `scdet` + `blackdetect` + `freezedetect`, Keyframes aus `-show_packets`, Metriken, Hook-Fenster, Fallback gleichmäßig
2. `understand_media`: Transcript-first, Platzierungssignale (Szenen, Stille, Heatmap), Grids nur für Belegfenster, `max_total_chars`
3. `analyze_moment`, `diff_frames` (pixelmatch), `analyze_audio` (Wellenform und Spektrogramm als Bild)
4. `get_speakers` über `sherpa-onnx` oder bezahlte API
5. `probe_image` (exiftool-vendored, sharp-phash, zxing-wasm)
6. `media_search` mit `node:sqlite` FTS5 über den Transkript-Cache, `list_cached`
7. MCP-Prompts `tldr`, `key_moments`, `quotables`, `hook_breakdown`
8. Abnahme: ein Reel mit Hook-Analyse, ein 60-Minuten-Podcast mit Kapiteln und Suche

## Phase 3: Betrieb

1. MCP Tasks für `understand_media` oberhalb einer Dauerschwelle; `resource_link` ab zwei Grids
2. Streamable HTTP über `@modelcontextprotocol/node`, stateless, Spec-Vorgaben (Origin, Bind 127.0.0.1, kein Token-Passthrough)
3. Docker-Image (ffmpeg mit freetype, yt-dlp, whisper-cli, tesseract), GHCR, CodeQL, Dependabot, `snyk/agent-scan`
4. Deploy auf hermes-vps per `mcp-new`, Ablösung des media-understanding-Forks
5. Veröffentlichung: npm `npx media-intel`, `server.json` für die offizielle MCP-Registry, `.mcpb` für Claude Desktop, Icons (Checkliste in `harvest-gaps.md` Abschnitt 10)
6. Optional: Parakeet über sherpa-onnx als zweites lokales ASR, `fpcalc` für Cache-Duplikate, BPM/Tonart über aubio als externes Binary

## Zeitplan

| | seriell | parallel (Block B als Workflow oder Team) |
|---|---|---|
| Phase 1 | 5 bis 7 h | etwa 2,5 h Wanduhr |
| Deploy VPS | 30 min plus 2 Klicks (Google-Redirect-URI, Connector) | gleich |
| Phase 2 | 5 bis 7 h | etwa 2,5 h |
| Phase 3 | 3 bis 4 h | etwa 2 h |

## Offene Entscheidungen (User)

- Bestehenden `media`-Connector auf hermes-vps ersetzen oder parallel betreiben, bis Phase 1 abgenommen ist?
- Bezahlte Backends: OpenAI und Groq (billigster Pfad, 0,04 $/h) reichen für Phase 1; Deepgram oder ElevenLabs erst mit `get_speakers`?
- Repository-Name und Sichtbarkeit auf GitHub (Vorschlag `geheimkunst/media-intel`)
- Phase 1 Block B als Workflow starten? Startsignal: "use a workflow"
