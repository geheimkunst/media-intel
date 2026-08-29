# media-understanding Repo Analyse

## 1. Steckbrief

**Projekt:** @dymoo/media-understanding  
**Stack:** Node.js 22+, TypeScript, MCP SDK 1.27.1  
**Lizenz:** MIT (Copyright 2025 dymoo)  
**Aktivität:** Aktiv entwickelt, Docker + GHCR Releases, 62 Tests  
**Repo:** https://github.com/dymoo/media-understanding  
**NPM:** @dymoo/media-understanding v1.1.0

Dieser MCP-Server transkribiert Audio/Video/Bilder und extrahiert Inhalte für LLMs: Transkripte (Text/SRT/JSON), Keyframe-Grids, einzelne Frames, Metadaten.

### Größenordnungen
- Codebase: ~4.8k Zeilen TypeScript (ohne node_modules, Tests)
- Tests: 4 Suites mit 62+ Tests (1981 Zeilen gesamt)
- Hauptmodule: media.ts (1086 Z), mcp.ts (564 Z), accel.ts (599 Z)
- Fokus: Robust, budget-aware, multi-backend

---

## 2. Architektur

### Drei-Tier-Ansatz
1. **Probe Tier** (`probe_media`) — 50ms Header-Scan, Metadaten, kein Heavy Work
2. **Understand Tier** (`understand_media`) — volle Analyse in einem Call
3. **Precision Tier** — exakte Frame/Transcript-Fenster bei Bedarf

### Einstiegspunkte
- **CLI:** `dist/cli.js` — schneller Probe für Agenten (Agent-Stub)
- **MCP Server:** `dist/mcp.js` — MCP-Transport (stdio), registriert 6 Tools
- **Library:** `dist/index.js` — TypeScript-Export für direkte Integration

### Kernmodule

| Modul | Zeilen | Aufgabe |
|-------|--------|---------|
| **media.ts** | 1086 | Audio/Video-Dekoding (node-av), Whisper-Transkription, Grid-Extraktion, OpenAI-Backend |
| **mcp.ts** | 564 | MCP-Server Setup, Tool-Registrierung, Request-Verarbeitung |
| **accel.ts** | 599 | Hardware-Beschleunigung (Metal/CUDA/DirectX), Fallback auf CPU |
| **mcp-handlers.ts** | 748 | Tool-Implementierungen (probe, understand, get_transcript, get_frames, get_video_grids, fetch_ytdlp) |
| **youtube.ts** | 391 | yt-dlp Integration (URL zu lokalen Dateien) |
| **mcp-budget.ts** | 100+ | Token-Budget-Enforcement, Vision-Token-Schätzung |
| **mcp-format.ts** | 100+ | Output-Formatierung (Grids, Transkripte, Frames) |
| **mcp-preflight.ts** | 100+ | Größen-/Dauer-Sicherheitschecks |
| **cli.ts** | 116 | CLI-Entry-Point mit formatiertem JSON-Output |

### Dependency-Stack

**Production:**
- `@modelcontextprotocol/sdk` — MCP-Server-Framework
- `node-av` — FFmpeg/Whisper via native bindings (cross-plattform via optionalDependencies)
- `sharp` — Bild-Resizing (Grid-Thumbnails)
- `file-type` — Media-Type-Detection
- `zod` — Schema-Validierung (Tool-Inputs)
- `@plussub/srt-vtt-parser` — SRT/VTT-Parsing

**Optional (per Plattform):**
- `@seydx/node-av-{darwin,linux,win32}-{arm64,x64}` — native FFmpeg/Whisper Bindings

**Dev:** TypeScript 5.9, ESLint, Prettier, Node Types

---

## 3. MCP-Tool-Inventar

| Tool | Input | Output | Besonderheit |
|------|-------|--------|--------------|
| **probe_media** | file_path/URL | type, duration, resolution, codecs, size | Schnell (50ms), kein Decoding |
| **understand_media** | file_path/URL, [fmt, model, backend] | metadata + transcript + keyframe grids (interleaved) | Full one-file analysis, budget-aware |
| **get_transcript** | file_path/URL, [window, format] | Segments (text/srt/json) mit Timestamps | Format-Optionen (text/srt/json), time-window Filter |
| **get_video_grids** | file_path/URL, [max_grids, thumb_width] | Array von JPEG Contact Sheets | Budget-aware, auto-fits Grids |
| **get_frames** | file_path/URL, timestamps[] | JPEG-Array mit Timestamp-Overlay | Exact moments, 1 JPEG pro Timestamp |
| **fetch_ytdlp** | URL, [what] | cache_paths (subtitles, video, audio, thumbnail) | yt-dlp nur, wenn installiert; cached |

**Budget-System:** Jedes Tool respektiert `max_total_chars` (Vision-Token-Budget). Preflight-Checks für Dateigröße (>10GB Warn) und Dauer (>2h Warn).

---

## 4. Stärken und Übernahmewert

### Architektur-Exzellenz
- **Modularisierte Handler** (mcp-handlers.ts + Submodule für Budget/Format/Preflight)  
  *Übernahme:* Pattern für separierte Concerns (validation, formatting, budget)
- **Hardware-Abstraktions-Layer** (accel.ts)  
  *Übernahme:* Fallback-Strategie Metal → CUDA → DirectX → CPU mit Runtime-Detection
- **Budget-System** (token-counting, Vision-Token-Schätzung)  
  *Übernahme:* Content-Length-Serialisierung + heuristisches Token-Limiting für grids/frames

### Testing & Qualität
- 62 Tests, davon 26 Integrationstests (yt-dlp, Whisper, OpenAI)
- Pre-commit Checks: format, lint, typecheck
- `npm run check-all` + Docker CI
- *Übernahme:* Test-Struktur für Media-Tools (accel.test, media.test, mcp.test, youtube.test)

### Praktische Features
- yt-dlp Integration (URLs statt lokale Dateien)  
  *Übernahme:* URL-zu-lokaler-Datei-Wrapper mit Cache
- CLI-Vorschau (`media-understanding <file>`) für Agent-Debugging  
  *Übernahme:* JSON-Output per CLI vor MCP
- Three-tier-Workflow (probe → understand → precision)  
  *Übernahme:* Tiered UX für Agent-Iteration

### Node-av Runtime
- Native FFmpeg + Whisper (no Python, no subprocess overhead)
- Demuxer/Decoder direkt in JS
- Model-Download via `WhisperDownloader` (caching)
- *Übernahme:* Dependency-Model (bündelt Binaries, automatisches Download-Postinstall)

---

## 5. Schwächen, Bugs, Fehlendes

### Designmängel
1. **Cache-Key-Format:** Nur `fileFingerprint`, nicht `fingerprint:backend:model` vor feat/openai-backend  
   *Fix vorhanden,* aber wurde vorher übersehen (see fork-delta)
2. **No subtitles-first path:** OpenAI hat subtitles, aber nur Text-Modus, keine Segment-Timestamps in JSON-Format  
   *Workaround:* Fallback zu WhatsApp/Gemini für Segment-Level-Kontrolle
3. **No adaptive chunking:** Lange Transkripte können Token-Budget sprengen ohne `window` param  
   *Mitigation:* Budget-Error sagt klare `max_total_chars` an

### Sicherheit / Betrieb
1. **OpenAI API-Key exposed:** env OPENAI_API_KEY im Prozess lesbar  
   *Gute Praxis:* 1Password-Launcher / op CLI statt direkt in Env (media-understanding-update skill hätte das)
2. **No request signing / logging:** OpenAI API-Calls ohne Audit-Trail  
   *Workaround:* Mit custom HTTP-Proxy loggbar (z.B. ngrok, Charles)
3. **Cost threshold nur USD:** Keine lokale Währung-Fallback oder Ratio-Anpassung  
   *Akzeptabel,* da Threshold-Env setzen kann

### Fehlende Funktionen
1. **Keine Video-Subsampling-Anweisung in Grids:** Lange Videos → viele Grids → Timeout möglich  
   *Mitigation:* `max_grids` Param + Budget-auto-fit
2. **Keine Multi-File-Batching im MCP:** Ein Tool per File (Loop ist Agents Aufgabe)  
   *By design,* Agent-native Iteration bevorzugt
3. **Keine Language-Detection:** Whisper-Modelle sind `-q5_1.en`, nicht `-en-q5_1` auto-fallback  
   *Workaround:* MEDIA_UNDERSTANDING_MODEL env setzen

### Tests
- **Keine Negativtests für große Dateien:** Mock-Datei 26MB würde 25MB-Check testen
- **Keine OpenAI-Mock:** Tests hit echte API wenn OPENAI_API_KEY gesetzt
- *Riskant für CI*, aber aktuell offline in GitHub Actions

---

## 6. Fork-Delta: feat/openai-backend

### Was wurde hinzugefügt (206 Zeilen):
1. **Backend-Abstraktion**
   - Type `TranscribeBackend = "whisper" | "openai"`
   - Env `MEDIA_UNDERSTANDING_BACKEND` steuert global

2. **OpenAI Audio API Integration** (neue Funktion `transcribeAudioOpenAI`)
   - Endpoint: https://api.openai.com/v1/audio/transcriptions
   - Models: whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe
   - FormData Upload mit Authentifizierung
   - Verbose JSON Response (segment timestamps)

3. **Cost Preflight**
   - File Size Limit: 25MB (OpenAI Constraint)
   - Duration Probe via `Demuxer.open()` (cost estimation)
   - Pricing Lookup: whisper-1=0.006 $/min, gpt-4o-mini=0.003 $/min
   - Threshold-Check: Default 0.1 USD, override via OPENAI_COST_THRESHOLD_USD
   - Gating via `OPENAI_ACCEPT_COST=1` mit User-Guidance bei Überschreitung

4. **Env Vars**
   - `OPENAI_API_KEY` (erforderlich für openai backend)
   - `MEDIA_UNDERSTANDING_BACKEND` (default: "whisper")
   - `OPENAI_TRANSCRIBE_MODEL` (default: "whisper-1")
   - `OPENAI_COST_THRESHOLD_USD` (default: 0.1)
   - `OPENAI_ACCEPT_COST` (true wenn cost ok)

5. **Cache-Key-Fix**
   - Vorher: nur `fingerprint`, ignoriert backend+model
   - Nachher: `fingerprint:backend:model` → unterschiedliche Output-Formen werden getrennt gecacht

### Quality der Implementation
- Fehlerbehandlung: API-Fehler, Netzwerk-Fehler, Dateigrößen-Validierung
- User-Guidance: Detaillierte Cost-Fehler mit Alternativen (slice audio, switch backend, raise threshold)
- Fallback: Wenn Segment-Timestamps nicht verfügbar, nutzt plaintext
- *Insgesamt sehr solide*, keine offensichtlichen Bugs

### Nicht enthalten im Fork
- Tests für OpenAI Path (würde API-Key brauchen)
- GitHub Actions Anpassung für OpenAI-Tests (sind skipped)
- Dokumentation-Update (README erwähnt nur lokal Whisper)

---

## 7. Fazit: Übernahmestrategie für media-intel

### ÜBERNEHMEN

1. **Three-Tier-Architektur** (probe → understand → precision)
   - Einfachheit für Agenten, klare Iteration
   - Implementiere als Tier-1/2/3 in media-intel MCP-Tools

2. **Budget-System + Vision-Token-Schätzung**
   - Content-Längen-Serialisierung
   - Heuristische Token-Counts pro Grid/Frame-Type
   - `max_total_chars` als globales Limit

3. **Hardware-Accel-Pattern** (accel.ts)
   - Runtime-Detection (Metal/CUDA/DirectX/CPU)
   - Silent Fallback ohne User-Warning
   - Ideal für Cross-Platform (Mac/Linux/Windows)

4. **yt-dlp Integration**
   - URL-zu-Datei-Wrapper mit Cache
   - `fetch_ytdlp` als dedicated Tool (optional, yt-dlp-abhängig)

5. **mcp-handlers + Submodule Split**
   - Separate mcp-budget.ts, mcp-format.ts, mcp-preflight.ts
   - Für media-intel: eigene Modularisierung nach diesem Vorbild

### ANPASSEN

1. **Backend-Abstraction für OpenAI**
   - Übernahme: Code-Struktur aus feat/openai-backend
   - Anpassung: Mit media-intel's bestehender API-Strategie integrieren (1Password Keys, Hook-basierte Gating)
   - Erweitern: Nicht nur OpenAI, auch Gemini/ElevenLabs für Varianzen

2. **Cost-Preflight für Multi-Backend**
   - Übernahme: Threshold + Duration-Probe Pattern
   - Anpassung: Pro-Backend Pricing-Table in media-intel Config
   - Erweitern: Nutze 1Password für API-Keys (nicht Raw Env)

3. **Testing**
   - Übernahme: Test-Struktur (accel.test, media.test, mcp.test)
   - Anpassung: Media-intel's Mocking-Strategy (Fixture-Video statt Live-Download)
   - Mock OpenAI-Responses (verbose_json format) ohne API-Calls

### NICHT ÜBERNEHMEN

1. **npm Posting / GHCR CI** — media-intel hat eigene Release-Pipeline
2. **Hardcoded Pricing (whisper-1=0.006)** — nutze dynamic Preismodell (external YAML/API)
3. **Directe FormData an OpenAI** — wrapper über 1Password + HTTP-Interceptor für Audit
4. **Postinstall-Skripte für Whisper-Models** — media-intel sollte Model-Download explizit steuern

### Konkrete Nächste Schritte

1. **Fork-Code in media-intel-Backend mergen**
   - `transcribeAudioOpenAI()` zu media-intel/src/backends/openai.ts
   - Backend-Abstraction als Trait/Plugin-System (nicht if-else in media.ts)

2. **Cost-Gating Integration**
   - Nutze Hermes-Bridge für User-Approval (nicht CLI OPENAI_ACCEPT_COST Env)
   - Oder: Silent-Flag für Agent-Kontext (Agent weiß Budget selbst)

3. **Test-Expansion**
   - Fixtures: 30s MP4 + 5min Podcast (lokal)
   - Mock-OpenAI: Spy auf fetch, return fixtures
   - Coverage: probe, understand, grid, transcript, backend-switch

---

## Quellenangaben

- **Upstream:** github.com/dymoo/media-understanding (a37ce99, v1.1.0)
- **Fork:** /Users/yunus/dev/tools/media-understanding (feat/openai-backend, 2 Commits voraus)
- **Diff Analysierte:** src/media.ts, src/types.ts (206 Zeilen)
- **Docs:** README.md, AGENTS.md, src/mcp.ts, src/tests/
