# Analyse der vier Referenz-Projekte

> Stand 29-08-2026. Synthese aus den Einzelberichten in `docs/research/` (dort stehen Dateipfade, Code-Zitate und Quellen). Repos liegen geklont unter `<reference-clones>/`.

## 1. Steckbriefe

| Projekt | Typ | Stack | Umfang | Aktivität | Tests | Lizenz |
|---|---|---|---|---|---|---|
| dymoo/media-understanding | MCP-Server | Node 22, TS, `@modelcontextprotocol/sdk` 1.27, node-av, whisper.cpp-Modelle | 4,8k LOC, 6 Tools | 21 Commits, letzter 07-04-2026, v1.1.0 | 62 Tests, 4 Suiten | MIT |
| guimatheus92/mcp-video-analyzer | MCP-Server + CLI + Skill | Node 22, TS, FastMCP 4.16, yt-dlp, Whisper CLI/OpenAI/HF, tesseract.js | 194 Dateien, 8 Tools | 56 Commits, letzter 27-08-2026, v0.10.0 | vorhanden, CodeQL in CI | MIT |
| bradautomates/claude-video | Agent Skill | Python stdlib, yt-dlp, ffmpeg, Groq/OpenAI Whisper | 3,2k LOC, 17 Dateien | 11 Commits, v0.2.0 30-06-2026 | 17 pytest-Dateien | MIT |
| taoufik123-collab/claude-watch | Skill-Fork | wie oben plus Obsidian-Ingest | 2,2k LOC | 19 Commits, 24-07-2026 | keine | MIT |

Lokaler Sonderfall: `<local-fork>/media-understanding` ist ein Fork von media-understanding auf Branch `feat/openai-backend` (2 Commits voraus: OpenAI-Audio-Backend, Cost-Preflight, Cache-Key-Fix). Er läuft bereits auf dem eigenen VPS als Connector `media.mcp.geheimkunst.eu`.

## 2. Was jedes Projekt wirklich kann

### media-understanding (Dymoo)
Drei Stufen: `probe_media` (nur Header, 50 ms), `understand_media` (Transkript plus Keyframe-Grids in einem Aufruf, budgetgesteuert), Präzisionswerkzeuge (`get_transcript` mit Zeitfenster und Format text/srt/json, `get_video_grids`, `get_frames` mit Timestamp-Overlay, `fetch_ytdlp`). Besonderheiten: Vision-Token-Budget `max_total_chars`, Hardware-Erkennung für whisper.cpp (Metal/CUDA/CPU) mit stillem Fallback, Decoding über node-av statt ffmpeg-Prozess, Docker-Image auf GHCR.

Schwächen: Cache-Key ohne Backend/Modell (im Fork gefixt), keine Sprach-Erkennung (englische Quantisierungs-Modelle), keine Untertitel-Nutzung, kein Szenen-Erkennen, kein OCR, Whisper-Modell wird per postinstall geladen, SDK v1.

### mcp-video-analyzer (Matheus)
Das reifste der vier. Acht Tools von `get_metadata` (ohne Download) über `get_transcript` (native Captions vor Whisper, drei Backends mit Retry) bis `analyze_video` (Transkript plus Szenen-Frames plus OCR plus Timeline) und `analyze_moment` (Burst-Frames um einen Zeitpunkt). Acht Plattform-Adapter (YouTube, Loom, TikTok, Instagram, Vimeo, X, Twitch, Facebook) mit Fallback-Ketten. Persistenter Cache pro URL-Hash mit Sidecar-Dateien (VTT, JSON), Modus 0700. `warnings[]` statt Exceptions, mit Handlungsanweisung. Läuft als MCP (stdio), CLI und Agent Skill aus derselben Codebasis. Vier Security-Fixes aus CodeQL in v0.10.

Schwächen: Cache ohne TTL, yt-dlp de facto Pflicht, OCR nur tesseract.js (WASM, langsam, Sprachdaten on-demand), Stille-Erkennung nur in den ersten zwei Minuten, Frame-Downscaling auf 800 px zerstört Text in Screenshots.

### claude-video (Bonanno)
Kein Server, sondern ein Skill: Claude ruft `watch.py`, das yt-dlp, ffmpeg und Groq/OpenAI-Whisper orchestriert. Wertvoll ist weniger der Code als die Heuristik: Frame-Budget nach Dauer (bis 30 s: 30 Frames, bis 1 min: 40, bis 3 min: 60, bis 10 min: 80, darüber 100), Captions vor Whisper (kostenlos zuerst), Szenenwechsel mit Fallback auf gleichmäßige Abtastung, Frame-Deduplikation, 512 px Default. Gute Tests.

### claude-watch (Fork)
Erweitert claude-video um "Hook-Mikroskop" (0 bis 10 s mit 2 fps und Wort-Timestamps), Pacing-Metriken (Schnitte/min, Shot-Länge; Motion nur Stub), strukturierten `report.md` mit Markern (TL;DR, Key Moments, Quotables, Entities) und Obsidian-Ingest mit Consent-Gate. Keine Tests, Pfade hart codiert. Die Editorial-Perspektive (Content-Analyse statt nur Transkript) ist die eigentliche Idee.

## 3. Muster, die sich bewährt haben (übernehmen)

1. **Drei Stufen** probe, understand, precision (media-understanding). Agenten wählen das billigste Werkzeug, das reicht.
2. **Captions vor Whisper** (mcp-video-analyzer, claude-video). Spart Geld und Zeit, ist bei YouTube meist besser als Whisper-base.
3. **Budget als Eingabe, nicht als Nebenwirkung** (`max_total_chars`, adaptives Frame-Budget nach Dauer).
4. **`warnings[]` plus `hint`** statt Exceptions für alles, was der Agent selbst reparieren kann.
5. **Content-addressierter Cache mit Sidecars** (Hash von Datei oder URL, Backend und Modell im Schlüssel).
6. **Szenenwechsel mit Fallback** auf gleichmäßige Abtastung bei statischen Clips.
7. **Cost-Preflight** vor jedem bezahlten Backend-Aufruf (Fork).
8. **Hardware-Erkennung still** (Metal/CUDA/CPU), kein Nutzer-Rauschen.
9. **Eine Codebasis, drei Oberflächen** (MCP, CLI, Skill).

## 4. Was fehlt in allen vieren (Marktlücke)

- Kein Projekt nutzt die MCP-Spec 2026-07-28: kein `outputSchema`/`structuredContent`, keine Tasks für lange Läufe, kein Streamable HTTP mit Auth.
- Kein Projekt hat Sprach-Erkennung mit Modellwahl (deutsch vs. englisch).
- Szenen-Erkennung nur als ffmpeg-Threshold, keine Shot-Metriken außer dem Stub in claude-watch.
- OCR entweder gar nicht oder nur WASM-Tesseract; keine VLM-OCR-Option.
- Kein Projekt kombiniert Transkript, Szenen, OCR und strukturierte Ausgabe in einem Server mit sauberem Schema.
- Kein Projekt hat Cache-TTL oder Größenlimit.

## 5. Was bewusst nicht übernommen wird

- node-av als Decoder (media-understanding): native Binärabhängigkeit mit postinstall, bricht bei Node-Versionswechsel (auf dem VPS bereits erlebt mit better-sqlite3). ffmpeg als Prozess ist überall vorhanden und stabil.
- Browser-Cookie-Scraping für yt-dlp (mcp-video-analyzer): Plattform-Falle, stattdessen `cookies.txt` per Konfiguration.
- Obsidian-Ingest im Server (claude-watch): Domänenlogik gehört in einen Skill oder Prompt, nicht in den Server.
- Eigene OAuth-Schicht im Kern: der eigene VPS hat eine generische Bridge (`mcp-new`), die jeden stdio-Server zu einem OAuth-2.1-Connector macht. Auth bleibt dort.
- Postinstall-Modell-Downloads: Modelle werden explizit geholt, nie beim `npm install`.

## 6. Nutzer und Use-Cases

| Nutzer | Use-Case | Muss | Kann |
|---|---|---|---|
| Agent-Betreiber (Mensch und Hermes-Agent) | Voice-Notes und Screen-Recordings verstehen, YouTube-Talks zusammenfassen | probe, transcript (deutsch), frames, fetch | Szenen, OCR |
| Entwickler | Bug-Repro-Video analysieren, Meeting-Aufzeichnung protokollieren | transcript mit Timestamps, frame_at | OCR für Code/Fehlertexte |
| Content-Creator, Sales | Konkurrenz-Reels sezieren, Hook-Analyse, Pacing | scenes, hook-window, transcript | Report-Prompt |
| Enterprise-Hosting | Mehrere Nutzer über HTTP, Kostenkontrolle | Streamable HTTP, Cost-Preflight, Tasks | Auth-Bridge |

Must-Have für den MVP: `probe_media`, `get_transcript` (Captions, dann lokales Whisper, dann API), `get_frames`, `get_video_grids`, `fetch_media`. Nice-to-Have: `get_scenes`, `extract_text` (OCR), `analyze_moment`, `understand_media` als Orchestrierung, Prompts für Report-Vorlagen.
