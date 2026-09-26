# Architektur media-intel

> Stand 29-08-2026, 16:30 (nach zweiter Research-Runde). Entscheidungen mit Begründung; wer eine ändert, ändert hier den Eintrag. Tool-Details und Defaults: `docs/capabilities.md`.

## 1. Entscheidungen

| # | Entscheidung | Begründung |
|---|---|---|
| A1 | **TypeScript, Node 22+, `@modelcontextprotocol/server` 2.0** | Einziges Tier-1-SDK mit vollständiger Spec 2026-07-28 (verifiziert: Paket 2.0.0 auf npm, Spec-URL live). Drei der vier Referenz-Projekte sind Node; Hosting-Bridge auf dem eigenen VPS ist Node. Python wäre für Whisper-Bindings bequemer, aber die Transkription läuft ohnehin in Kindprozessen oder über HTTP-APIs. |
| A2 | **ffmpeg/ffprobe/yt-dlp/whisper-cli/tesseract als Prozesse via execa, keine nativen Node-Bindings** | Überall installierbar, keine postinstall-Kompilate, kein Node-ABI-Bruch (auf dem VPS mit better-sqlite3 erlebt). Ausnahme: `sharp` (vorgebaute Binaries, breit genutzt) für Bildmontage und Overlay. |
| A3 | **stdio ist der primäre Transport, Streamable HTTP ist ein Adapter** | Lokal (Claude Code, Desktop, Hermes) läuft stdio. Für claude.ai-Connectoren übernimmt die vorhandene VPS-Bridge (`mcp-new`) OAuth 2.1 mit Google-Login und RFC-8707-Audience. Eigener HTTP-Einstieg mit `@modelcontextprotocol/node` in Phase 3, Auth bleibt außerhalb des Kerns. |
| A4 | **Jedes Tool hat `outputSchema` und liefert `structuredContent` plus einen Textblock** | Agenten bekommen maschinenlesbare Felder, Menschen eine Zeile. Das SDK validiert die Ausgabe vor dem Senden. |
| A5 | **Fehler sind Tool-Ergebnisse mit `isError`, `code` und `Hint:`**, nie Protokollfehler | Der Agent kann reagieren. Ergebnisse ohne Urteil heißen `inconclusive`, nie `ok`. |
| A6 | **Kein Roots, kein Sampling, kein MCP-Logging** | Seit 2026-07-28 deprecated (SEP-2577). Logs gehen auf stderr. |
| A7 | **Transkriptions-Kette: eingebettete Spur, Sidecar, yt-dlp-Untertitel, whisper-cli lokal, bezahlte API** | Kostenlos zuerst. `detect_language` vor der Modellwahl. Lokaler Default `large-v3-turbo-q5_0` mit `--vad`; `base` ist für deutsche Voice-Notes zu schwach. Bezahlte Aufrufe nur nach Cost-Preflight. |
| A8 | **Cache content-addressiert** unter `~/.cache/media-intel/<hash>/`, Sidecars, TTL 14 Tage, Obergrenze 5 GiB, Modus 0700 | Schlüssel = Datei-Fingerprint (Größe, mtime, erste und letzte 64 KiB) oder URL-Hash, plus Backend und Modell. Cache-Pfade nie aus Eingabe-Strings bauen. |
| A9 | **Frames als Grid, Einzelframes nur auf Anfrage; Frames einzeln mit `-ss` vor `-i` holen, Montage in `sharp`** | 64 Frames als ein Grid kosten bei Claude rund 1.900 Tokens statt 12.500 einzeln. `-ss` vor `-i` ist 30-mal schneller als `fps=`-Filter (0,14 s gegen 4,4 s pro Frame, gemessen). Montage in Node erlaubt pHash-Dedup und Heatmap-gesteuerte Abtastung. |
| A10 | **yt-dlp optional**, nur in `fetch_media` und `get_engagement`; `--no-playlist` erzwungen, Cookies nur aus Datei | Fehlt es, meldet das Tool einen Hint; alles andere läuft mit lokalen Dateien. Playlists würden 400 Videos laden. |
| A11 | **Keine Secrets in Config-Dateien, Launcher injiziert sie**; Ausgaben und stderr maskieren bekannte Env-Werte | Keys kommen über `op read` in die Umgebung. Ein gesetzter Key allein löst keinen bezahlten Aufruf aus. |
| A12 | **Grid-Parameter `cells` (64) und `grid_long_edge` (1568, Option 2576), Budget als `max_frames` (512)** | Claude rechnet in 28-px-Kacheln mit Deckel 1568 px lange Kante (2576 bei neueren Modellen). Kachelzahl steuert Auflösung pro Kachel, nicht Kosten. 512 Frames deckeln einen 67-Minuten-Film bei 8 Grids. |
| A13 | **Zeit ist Daten: Manifest `{grid, cell, t_s}` im `structuredContent`, Overlay optional** | `drawtext` fehlt im Homebrew-ffmpeg; ein deterministisches Raster plus Manifest reicht. Overlay per `sharp` nur auf Wunsch. Tool-Beschreibung sagt: Zeiten aus dem Manifest lesen, nie aus dem Bild. |
| A14 | **Untrusted-Text-Vertrag**: Text aus Medien steht in Feldern mit `source_trust: "untrusted"`, im Textblock zwischen festen Markern, 20.000 Zeichen pro Feld | Transkript, OCR, Untertitel, Kommentare sind Fremdeingabe (Prompt-Injection). Keins der vier Referenz-Projekte tut das. |
| A15 | **Zeitfenster-Pagination als Vertrag** (`total_duration_s`, `window_start_s`, `window_end_s`, `has_more`, `next_window`) | Deckt lange Podcasts ohne MCP Tasks ab. Tasks kommen in Phase 3 nur für `understand_media`. |
| A16 | **`doctor`-Tool vor allem anderen** | Ein Aufruf statt drei Fehlversuche; Ergebnis fließt in `suggested_next`. Muster aus vier Referenz-Servern. |
| A17 | **Szenen aus ffmpeg (`scdet`, `blackdetect`, `freezedetect`), nicht PySceneDetect** | Filter im Build vorhanden und lokal verifiziert, keine Python-Kette. |
| A18 | **OCR mit tesseract, Sprache erzwungen (`deu+eng`), kein Downscaling, Region-Crop, TSV mit Boxen** | `-l eng` liefert auf deutschem Text Salat (gemessen); Downscaling auf 800 px zerstört Terminal-Text (mcp-video-analyzer-Schwäche). PaddleOCR, Surya, docTR sind Dokumenten-Werkzeuge mit schweren Abhängigkeiten. |
| A19 | **Kein zweiter Wissensindex**: `media_search` ist FTS5 über den Transkript-Cache (Introspektion), keine RAG-Schicht | Akasha ist die Gedächtnisschicht des Systems. Ein Vektor-Index im Medienserver wäre eine konkurrierende Wahrheit. |
| A20 | **Gemini-Video nativ nur als Option, nie Default** | 300 Tokens pro Sekunde Video, rund Faktor 35 gegenüber dem Grid-Pfad. |
| A21 | **Bezahlte Provider: OpenAI `whisper-1` und ElevenLabs Scribe (`scribe_v2`); Groq gestrichen (29-08-2026)** | Scribe: 90+ Sprachen (Deutsch laut Anbieter unter 5 % WER), Diarisierung bis 32 Sprecher, 0,22 $/h gegenüber 0,36 $/h bei OpenAI, 3 GB und 10 h pro Datei, Auth per Header `xi-api-key`. Groq war billiger, aber ohne Sprecher und mit 25-MB-Grenze. Die API liefert Wörter, `wordsToSegments` baut Segmente (Sprecherwechsel, Pause über 1 s, Satzende, 200 Zeichen, 12 s). Sprachcodes kommen als ISO-639-3 und werden auf ISO-639-1 abgebildet. |

## 2. Tool-Design (Stufen)

```
Stufe 0  doctor              Binaries, Versionen, Cache, geprüfte Fähigkeiten
Stufe 1  probe_media         Header lesen; deep: Stille, Lautheit, Rauschboden       (Basis fertig)
         probe_image         EXIF, pHash, QR                                          (Phase 2)
         fetch_media         yt-dlp, Ausschnitte, Untertitel, Infojson
         get_engagement      Metriken, Kapitel, Heatmap, Kommentare ohne Download
Stufe 2  understand_media    Transcript-first, Lazy Visual Verification, budgetiert  (Phase 2)
Stufe 3  get_transcript      Kette A7, window, format, Pagination, Provenienz
         detect_language     30 s Ausschnitt
         get_frames          Timestamps, Format, Region, Overlay optional
         get_video_grids     cells, grid_long_edge, max_frames, Manifest, Dedup
         extract_text        OCR mit Boxen
         get_scenes          Schnitte, Blenden, Standbilder, Pacing, Hook          (Phase 2)
         analyze_moment      Burst plus Transkript plus OCR                        (Phase 2)
         diff_frames         Änderungsregionen                                      (Phase 2)
         analyze_audio       Lautheit, Stille, Wellenform als Bild                  (Phase 2)
         get_speakers        Diarisierung                                           (Phase 2)
Stufe 4  media_search        FTS5 über Cache; list_cached                           (Phase 2)
Prompts  tldr, key_moments, quotables, hook_breakdown                                (Phase 2)
```

Gemeinsamer Vertrag aller Tools:

- Eingabe `source` (absoluter Pfad, `file://`, direkte http(s)-URL); Plattform-Seiten gehen erst durch `fetch_media`. Nur `http`, `https`, `file`; SSRF-Block auf private Netze nach jedem Redirect; `realpath` vor Pfadprüfung.
- Ausgabe enthält `warnings: string[]` und, wo sinnvoll, `suggested_next: string[]`.
- Zeit in Sekunden als `*_s`, Bytes als `*_bytes`, Budgets als `max_*`.
- Grenzen aus Konfiguration: Dauer 4 h, 20 Streams, 8K, `MEDIA_INTEL_MAX_BYTES`; jeder Kindprozess mit Timeout und Prozessgruppen-Kill; nie `shell: true`.

## 3. Projektstruktur

```
media-intel/
├── src/
│   ├── cli.ts              stdio-Einstieg (bin), --help/--version; Phase 1: Subcommands
│   ├── server.ts           createServer(): registriert Tools und Prompts
│   ├── config.ts           MEDIA_INTEL_* Env, Defaults, Grenzen
│   ├── errors.ts           MediaIntelError(code, message, hint), toolErrorResult
│   ├── source.ts           Pfad/URL-Auflösung, Schema-Whitelist, SSRF-Prüfung
│   ├── ffmpeg.ts           ffprobe/ffmpeg-Prozesse, Filter-Parser, extractFrame
│   ├── binaries.ts         Auffinden und Versionen externer Binaries
│   ├── cache.ts            Fingerprint, Layout, Sidecars, TTL-Sweep
│   ├── contracts.ts        Untrusted-Umrandung, Pagination, Manifest, Budget
│   ├── tools/              ein Tool je Datei: xInput, xOutput, x(config, input), summarizeX
│   ├── backends/           transcribe/{embedded,sidecar,whisper-cpp,openai,elevenlabs,cost,srt}.ts, ocr/tesseract.ts
│   └── prompts/            Phase 2
├── tests/                  vitest; fixtures/ synthetisch per ffmpeg; Sicherheitsfälle als Tests
├── docs/                   analysis, architecture, capabilities, roadmap, research/
└── dist/                   Build-Ausgabe (tsc), bin = dist/cli.js
```

Ein Tool = eine Datei mit `xInput` (zod), `xOutput` (zod), reiner Funktion `x(config, input)` und `summarizeX(result)`. Der Server verdrahtet nur. So bleiben Tools ohne MCP testbar, und die CLI ruft dieselben Funktionen.

## 4. Laufzeit und Deployment

| Ziel | Wie |
|---|---|
| Claude Code / Desktop lokal | `claude mcp add media-intel -- node <repo>/dist/cli.js`, später `npx media-intel` |
| Hermes (VPS) | stdio-Kind unter `~/.hermes/config.yaml`, Launcher setzt Keys via `op read` |
| claude.ai-Connector | `mcp-new media-intel "▶ Media Intel" --cmd node --args dist/cli.js` auf dem eigenen VPS; Bridge liefert OAuth 2.1 |
| Docker (Phase 3) | Multi-Stage-Image mit ffmpeg (mit freetype), yt-dlp, whisper-cli, tesseract; kein Modell im Image |
| Streamable HTTP direkt (Phase 3) | `@modelcontextprotocol/node`, stateless, Origin-Prüfung, Bind 127.0.0.1, `requireBearerAuth` mit externem Verifier |
| Veröffentlichung (Phase 3) | npm, offizielle MCP-Registry (`server.json`), `.mcpb` für Claude Desktop |

Voraussetzungen zur Laufzeit: Node 22+, ffmpeg 6+ auf PATH. Optional: yt-dlp, whisper-cli, tesseract, sherpa-onnx.

## 5. Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| Lange Läufe blockieren den Request | Pagination (A15) zuerst; MCP Tasks nur für `understand_media` in Phase 3 |
| Vision-Token-Explosion | Grids als Default, `max_frames`, `max_total_chars`, Dedup, Warnung im probe |
| Prompt-Injection über Medientext | Untrusted-Vertrag (A14), Längengrenzen, Kommentare gedeckelt |
| Bezahlte APIs laufen unbemerkt heiß | Cost-Preflight mit Schwellwert 0,10 $, Schätzung im Ergebnis |
| yt-dlp bricht bei Plattform-Änderungen | Optional halten, Versions-Hinweis im Fehler, `doctor` zeigt Stand |
| Native Abhängigkeiten brechen bei Node-Updates | Nur `sharp` (vorgebaut); alles andere Binaries |
| Cache füllt die Platte | TTL und Obergrenze beim Start (A8) |
| ffmpeg-Builds unterscheiden sich (drawtext fehlt) | Kein Filter, der nicht in Standard-Builds ist; `doctor` prüft Filterliste |
