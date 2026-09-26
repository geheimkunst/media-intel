# Roadmap media-intel

> Stand 29-08-2026, 19:30. Phasen 0 bis 3 in einem Durchlauf umgesetzt. Offen sind nur noch zwei Klicks des Betreibers und die Punkte unter "Nach dem Launch".

## Phase 0: Fundament (erledigt)

- [x] Recherche Runde 1 und 2 (`docs/research/`), Architektur A1 bis A20, Fähigkeiten-Karte
- [x] Scaffold, `probe_media`, `doctor`, Cache, Contracts, gehärtete Quelle, ffmpeg-Analyseparser

## Phase 1: MVP (erledigt, per Workflow mit 5 Bauern, 5 Reviews, 5 Fix-Runden)

- [x] `get_frames`, `get_video_grids` (cells/grid_long_edge/max_frames, pHash-Dedup, Manifest, Pagination)
- [x] `get_transcript` (eingebettet > Sidecar > whisper.cpp mit VAD > OpenAI/ElevenLabs nur mit `allow_paid` oder explizitem Backend, Cost-Preflight), `detect_language`
- [x] 29-08 (abends): ElevenLabs Scribe ersetzt Groq als zweiten bezahlten Provider (`backend=elevenlabs`, `diarize=true` für Sprecher, `MEDIA_INTEL_ELEVENLABS_MODEL`, 0,22 $/h im Preflight; Entscheidung A21)
- [x] `fetch_media`, `get_engagement` (Heatmap, Kapitel, SponsorBlock, Kommentare), `extract_text` (tesseract, volle Auflösung, Boxen)
- [x] Verträge: Untrusted-Text, Pagination, Manifest; Sicherheits-Checks (SSRF, Schema-Whitelist, realpath, Grenzen, Prozessgruppen)
- [x] Abnahme mit echtem Material: deutsche Sprachnotiz (macOS `say`, Anna) ohne API-Key korrekt transkribiert, Screen-Recording mit Terminal-Fehlertext per OCR gelesen, diff_frames und Grids stimmen

## Phase 2: Verstehen (erledigt)

- [x] `get_scenes`, `analyze_audio` (Wellenform als Bild), `diff_frames`, `analyze_moment`, `probe_image` (EXIF, pHash, QR), `list_cached`
- [x] `understand_media`: Transcript-first, Lazy Visual Verification, Entscheidungen im Ergebnis
- [x] `media_search`: FTS5 über alle Transkripte und OCR-Ergebnisse (automatisch indiziert)
- [x] Prompts `tldr`, `key_moments`, `quotables`, `hook_breakdown`

## Phase 3: Betrieb (erledigt bis auf zwei User-Klicks)

- [x] Stateless Streamable HTTP (`--http`, Host/Origin-Guards, optionaler Bearer), Dockerfile, CI (GitHub Actions)
- [x] Deploy auf dem eigenen VPS: `$HOME/dev/media-intel` (Node 24), whisper.cpp gebaut, Modell `large-v3-turbo-q5_0` plus VAD, tesseract 5.5 (deu+eng), exiftool, yt-dlp 2026.08.19
- [x] Connector via `mcp-new`: eigener Port, Resource- und Issuer-Host hinter Caddy, mcp-check 6/6 grün, bestehende Connectoren regressionsfrei
- [x] Claude Code (Mac): `media-intel` im User-Scope registriert, Status Connected; seit 29-08 abends über `~/.local/bin/media-intel-launcher` (Keys per `op read`, fail-soft)
- [x] VPS: Bridge startet über `~/.local/bin/media-intel-mcp-launcher` (liest `op.env`, Selbsttest `--check`)
- [x] VPS: `op.env` angelegt (29-08 abends), Launcher lädt ELEVENLABS_API_KEY und OPENAI_API_KEY
- [ ] **Betreiber:** ElevenLabs-Konto aufladen (0 Credits am 29-08, `quota_exceeded`); danach ist `backend=elevenlabs` sofort nutzbar
- [ ] **Betreiber:** Google Console → OAuth-Client → Redirect-URI des Issuers ergänzen
- [ ] **Betreiber:** claude.ai → Connectors → die Resource-URL hinzufügen
- [ ] Hermes: `~/.hermes/config.yaml` auf media-intel umstellen (stdio, Launcher mit `op read` für Keys, sobald bezahlte Backends gewünscht)

## Nach dem Launch

0. Aus dem Benchmark (`docs/benchmarks/2026-08-29-stufe-1.md`): Blenden-Detektor für `get_scenes` (fades 0 von 3 erkannt, mcp-video-analyzer 3 von 3), Whisper-Default nach Plattform (large nur mit Metal/CUDA), Grid-Parallelität an Kernzahl koppeln

1. `media`-Connector (media-understanding-Fork) abbauen, sobald media-intel in claude.ai läuft
2. MCP Tasks für `understand_media` oberhalb 20 min; `resource_link` ab zwei Grids
3. `get_speakers` lokal (sherpa-onnx); bezahlt liefert `get_transcript diarize=true` über ElevenLabs bereits Sprecher. Zweites lokales ASR (Parakeet), `fpcalc` für Duplikate
4. Veröffentlichung: GitHub-Repo, npm `npx media-intel`, `server.json` für die MCP-Registry, `.mcpb`
5. Bekannte Schwächen: `get_scenes` erkennt harte Bildwechsel ohne Bewegung nicht immer (scdet-Schwelle), `detect_language` liefert ohne `-dl`-Ausgabe keine Konfidenz, `looks_like_screen_recording` ist eine Heuristik

## Zeitbilanz

Geplant 12 bis 18 h seriell, gebraucht rund 5 h Wanduhr (Research 1 h, Fundament 1 h, Workflow 20 min für 5 Tools, Integration und Phase 2 plus 3 rund 2,5 h). 138 Tests grün.
