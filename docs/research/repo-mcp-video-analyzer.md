# mcp-video-analyzer: Tiefgehende Repo-Analyse

## 1. Steckbrief

**Repo:** `guimatheus92/mcp-video-analyzer`  
**Lizenz:** MIT  
**Sprache/Stack:** Node.js 22.12+, TypeScript, FastMCP 4.16+  
**Letzte Aktivität:** 29-08-2026 (v0.10.0 released 19-08-2026)  
**Größe:** 194 Dateien, 56 Commits  
**Einstiegspunkt:** CLI + MCP Server (stdio) + Agent Skill  

**Features:** Frame-Extraction, Transkription (Whisper/OpenAI API), OCR (Tesseract), Metadaten, Kommentare, Kapitel, Timeline, AI-Zusammenfassung  
**Plattformen:** YouTube, Loom, TikTok, Instagram, Vimeo, X, Twitch, Dailymotion, Facebook, direktURLs, lokale Dateien  
**Lizenz-Text:** MIT, Copyright (c) 2026 Guilherme Matheus  

---

## 2. Architektur

### Verzeichnisstruktur
```
src/
  ├── tools/               (10 MCP-Tools + Tests)
  │   ├── analyze-core.ts  (624 Zeilen, Orchestrierung)
  │   ├── analyze-video.ts (73 Zeilen, Wrapper)
  │   ├── analyze-videos.ts (151 Zeilen, Batch)
  │   ├── analyze-moment.ts (215 Zeilen, Zeitfenster-Analyse)
  │   ├── get-frames.ts    (224 Zeilen, Szenen-Erkennung)
  │   ├── get-frame-at.ts  (156 Zeilen, Single-Frame)
  │   ├── get-frame-burst.ts (186 Zeilen, Burst N Frames)
  │   ├── get-transcript.ts (151 Zeilen, + Retry-Logik)
  │   ├── get-metadata.ts  (89 Zeilen)
  │   └── frame-options.ts (29 Zeilen, Typ-Definitionen)
  │
  ├── processors/          (Audio, Bild, VTT)
  │   ├── audio-transcriber.ts
  │   ├── image-optimizer.ts
  │   └── vtt-parser.ts
  │
  ├── adapters/            (Plattform-Unterstützung)
  │   ├── loom.adapter.ts
  │   ├── ytdlp.adapter.ts (YouTube, Instagram, TikTok, ...)
  │   └── ytdlp-output-template.ts
  │
  ├── utils/               (Hilfsfunktionen)
  │   ├── cache.ts         (persistent Cache-Verwaltung)
  │   ├── warnings.ts      (Fehlerbehandlung + Meldungen)
  │   └── ytdlp.ts         (yt-dlp CLI-Wrapper)
  │
  ├── config/
  │   └── [Konfigurationsquellen]
  │
  └── index.ts             (MCP Server-Einstieg)

Dockerfile                 (Multi-Stage Build)
skills/video/SKILL.md      (Agent-Skill-Vertrag)
AGENTS.md                  (Agent-Anleitung)
```

### Transport-Modelle
1. **Stdio MCP:** FastMCP, Einstieg via `npx mcp-video-analyzer@latest` (Dockerfile, Node-Module)
2. **CLI (one-shot):** `npx mcp-video-analyzer analyze "<url>"` → JSON zu stdout
3. **Agent Skill:** `npx skills add guimatheus92/mcp-video-analyzer` → Fallback zu CLI, wenn kein MCP

### Abhängigkeiten (7 Haupt + 11 Dev)
**Hauptabhängigkeiten:**
- `fastmcp` (4.16.5) — MCP-Server-Implementierung
- `ffmpeg-static` (5.3.0) — gebündelt, keine System-FFmpeg nötig
- `sharp` (0.35.3) — Bildoptimierung (JPEG, PNG)
- `tesseract.js` (7.0.0) — OCR in Browser/Node
- `puppeteer-core` (25.8.0) — Chrome-Fallback für Frame-Extraction
- `cheerio` (1.2.0) — HTML-Parsing (YouTube-Seite, Kommentare)
- `zod` (4.3.6) — Input-Validierung

**External (nicht als Dependency):**
- `yt-dlp` (CLI, pip install) — **erforderlich** für Platform-URLs, optional für alles andere
- `openai-whisper` (CLI, pip install) oder `whisper-ctranslate2` — Transkription
- `OPENAI_API_KEY` (Env) — alternative zu CLI/HF
- Chrome/Chromium — Fallback-Frame-Extraction, optional

---

## 3. Tool-Inventar

| Tool | Input | Output | Use-Case | Status |
|------|-------|--------|----------|--------|
| `analyze_video` | URL/Path + options | metadata + transcript + frames + OCR + timeline | Full-Analyse | 624 LOC, komplett getestet |
| `analyze_videos` | sources[] + concurrency | array von Ergebnissen | Batch-Processing | 151 LOC, resumable |
| `analyze_moment` | URL + timeRange [start,end] | Burst-Frames + Transkript-Snippet + OCR | Deep-Dive ein. Zeitfenster | 215 LOC |
| `get_transcript` | URL + lang/model | transcript[] (native/Whisper/HF) | Nur Transkript | Retry-Logik eingebaut |
| `get_metadata` | URL | title, duration, uploader, views, date, chapters, comments | Metadaten ohne Download | Leicht |
| `get_frames` | URL + detail/threshold | frames[] mit timestamps + JPEG | Szenen-basiert (scene-change) | Adaptive Frame-Budget |
| `get_frame_at` | URL + timestamp | single JPEG | Exakter Frame | Einfach |
| `get_frame_burst` | URL + time + count | N Frames um Zeitpunkt | Motion/Animation | 186 LOC |

**Frame-Optionen:**
- `detail`: brief (0 frames), standard (adaptive 12-60), detailed (60 fixed)
- `maxWidth`: 800 px default (Kontext-Sparsamkeit), 0 = original
- `threshold`: 0.1 (Scene-Change-Sensitivität für ffmpeg-Szenen)
- `skipFrames`: Cache-Schlüssel + Analysis-Sidecar

---

## 4. Was ist wirklich gut (übernehmenswert)

### 4.1 Robuste Fehlerbehandlung
**Datei:** `src/utils/warnings.ts`, `src/tools/get-transcript.ts`

Nicht "Exception werfen", sondern Fehler + Actionable Hints in `warnings[]`:
- yt-dlp nicht installiert → "Install mit `pip install yt-dlp`"
- Whisper-Schlüssel fehlt → "Set `OPENAI_API_KEY` oder installiere CLI"
- Silent Audio erkannt → "Expected content (keine Sprache), kein Fehler"
- yt-dlp Exit-Code + stderr → in warnings[], nicht crash

```javascript
// Beispiel aus get-transcript.ts:
if (!transcriptJson) {
  warnings.push({
    code: 'NO_TRANSCRIPT_BACKEND',
    message: 'No Whisper backend configured. Install openai-whisper or set OPENAI_API_KEY.'
  });
  return { transcript: [], warnings };
}
```

**Lerneffekt:** Alles was partiell misslingen kann sollte `warnings[]` füllen, nicht Exception werfen. Exit-Code 0 bei Partial-Success, nur 1 bei Hard-Fail.

### 4.2 Security-First CodeQL + Dependabot
**Datei:** `.github/workflows/security.yml`, v0.10.0 Release

4 CodeQL-Alerts geschlossen in einer Release:
1. **js/sql-injection** (taint-flow ffmpeg-Befehlszeile) → Command nicht mehr in warnings geleckt
2. **js/unterminated-html-tag** (parseVtt) → Regex verfeinert für `</script>` Edge-Case
3. **js/file-system-race** (tmpdir + sidecar write) → atomic write mit `wx` Flag statt TOCTOU
4. **js/predictable-tmp-location** (golden-clips + persistentCacheDir) → Umzug in per-user cache dir

Vorher: test golden-clips in `/tmp/mcp-video-analyzer/test-golden/` (shareable),  
Nachher: `node_modules/.cache/golden-clips` (checkoutspezifisch, Mode 0700)

**Lerneffekt:** Nicht "SecurityAlert → Checkbox → ignore" sondern Root-Cause-Fix. Die Lösungen sind oft architektonisch wertvoll.

### 4.3 Caching + Sidecar-Pattern
**Datei:** `src/utils/cache.ts`, `src/processors/analysis-sidecar.ts`

Zwei-Stufen Cache:
1. **Persistent (per-URL):** `MCP_CACHE_DIR/<url-hash>/frames/*.jpg`, `.vtt`, `.json`  
   → API nicht aufgerufen, wenn Cache-Hit  
   → Env-var statt hardcoded `/tmp`, Mode 0700
2. **Sidecar-Dateien:** `.vtt` + `.json` liegen lokal, wiederverwendbar mit `skipFrames`

Workaround für externe GPU-Whisper-Pipeline:  
- Ext. Whisper schreibt `.vtt` parallel → mcp-video-analyzer prüft existsSync(), nutzt sie
- Atomic create-exclusive write (`wx`-flag), EEXIST wird als "schon erstellt" behandelt

**Lerneffekt:** Cache-Keys mit URL-Hash, Environment-Kontrollpunkte (`MCP_CACHE_DIR`, `MCP_WRITE_SIDECARS`), Sidecar-Austausch zwischen Prozessen.

### 4.4 Adaptive Frame-Budget
**Datei:** `src/tools/frame-options.ts`, `analyze-core.ts:calculateFrameCount(duration)`

Nicht "immer 60 Frames", sondern:
- ≤30s: 12 frames (kostet sonst zu viel Context)
- 1-10 min: 24-40 frames (adaptive)
- >10 min: 60 frames (capped bei detailed, 0 bei brief)

Explizite `--max-frames` Override siegt über Defaults. **Grund:** Frame-Downscaling (800px default) spart Context, aber bei UI/Dashboard/Code macht es Text unleserlich. Flag `--max-width 0` führt zur Quell-Auflösung, kostet aber mehrfach mehr Tokens.

**Lerneffekt:** "Dense" vs. "Sparse" Sampling konfigurierbar, Budget-bewusst.

### 4.5 Multi-Plattform Adapter-Pattern
**Datei:** `src/adapters/ytdlp.adapter.ts`, `src/adapters/loom.adapter.ts`

Jede Plattform hat spezifische Fallstricke:
- **YouTube:** Captions native, aber age-restricted braucht Cookies
- **Loom:** DASH (separate Video+Audio-Streams) → nur yt-dlp kann mergen
- **TikTok/Instagram:** Private brauchen Cookies, yt-dlp fallback für CDN
- **Vimeo, X, Twitch:** Ähnliche Cookies-Anforderungen

Nicht "global yt-dlp Aufruf", sondern Adapter mit Fallback:
```typescript
// loom.adapter.ts: Erst CDN-Fallback, dann yt-dlp (frames only)
if (isLoomDASH) {
  return ytdlpDownload(url); // merges video+audio
} else {
  return loomCdnDownload(url); // works without yt-dlp
}
```

**Lerneffekt:** Adapter-Pattern für fremde APIs, Fallback-Ketten, Plattform-spezifische Workarounds.

### 4.6 Whisper Multi-Backend
**Datei:** `src/processors/audio-transcriber.ts`, README Konfiguration

Drei unabhängige Backends, in dieser Reihenfolge geprüft:
1. **CLI** (`WHISPER_BIN`, default `whisper`) → lokal, schnell, keine API-Kosten, Model/Language/Device konfigurierbar
2. **OpenAI API** (`OPENAI_API_KEY`) → beste Qualität, kostet, schneller als CLI für große Audio
3. **Hugging Face** (`WHISPER_HF_MODEL`) → lokal, Alternative zu CLI

Env-vars für jeden Backend (z.B. `WHISPER_COMPUTE=float16` nur für ctranslate2):
```
WHISPER_BIN            (path to executable)
WHISPER_MODEL          (tiny, small, medium, large)
WHISPER_LANGUAGE       (pt, en, fr, ...)
WHISPER_COMPUTE        (cuda, cpu, float16 for ctranslate2)
WHISPER_DEVICE         (cuda)
WHISPER_PROMPT         (domain glossary for proper nouns)
WHISPER_WORD_TIMESTAMPS (1 = enable)
```

Kein Hard-Fail, wenn alle drei unavailable → `warnings[]` + empty transcript.

**Lerneffekt:** Konfigurierbare Backend-Kette, Env-Gating für spezifische Parameter.

---

## 5. Schwächen, Bugs und Fehlendes

### 5.1 Abhängigkeiten ohne Fallback
- **yt-dlp:** Optional in Theorie, Praxis Platform-URLs (YouTube, TikTok, ...) kaum nutzbar ohne Installation
- **Whisper:** Alle drei Backends require external (CLI install, API-Key, oder HF model download)
- **Chrome/Chromium:** Nur Fallback für yt-dlp-Ausfallszenario, in Docker/Headless selten vorh.

Mitigation existiert (saubere Warnings), aber Erstnutzer braucht `pip install yt-dlp` + `pip install openai-whisper` = zwei Python-Dependencies neben Node.

### 5.2 Cache wird nicht geleert
**Datei:** README, Cache-Verzeichnis

> Unlike the temp dir this used to live in, nothing reaps that location, so frames persist until you delete them

Der Cache unter `~/Library/Caches/mcp-video-analyzer/<url-hash>/` wird manuell gepflegt. Keine TTL, kein Auto-Purge. Bei 1000 Videos können Gigabyte zusammenkommen.

**Lösung im Repo:** Dokumentiert in README, nicht automatisiert.

### 5.3 Browser-Cookie Windows-Falle
**Datei:** README > Cookies

> Browser cookie extraction requires the browser to be **closed** on Windows (the cookie database is locked while it runs).

Workaround: `cookies.txt` exportieren (Browser-Extension), dann `YTDLP_COOKIES` setzen. Unpraktisch für End-User.

### 5.4 Loom DASH-Fallback begrenzt
Wenn yt-dlp nicht vorhanden ist, Loom-Videos kein Frame-Extraction (nur Metadaten + Transkript). CDN-Fallback ist "some videos", nicht "all videos".

### 5.5 Frame-Downscaling löst Kontext-Verlust aus
`--max-width 800` (default) kann bei UI/Dashboard/Code-Screenshots kleine Text unleserlich machen. Nutzer muss `--max-width 0` setzen (mehrfach höherer Kontext).

Dokumentiert, aber keine automatische Erkennung ("ist dies ein Screenshot?").

### 5.6 Silent-Audio Erkennung ist Heuristik
ffmpeg `volumedetect` (first 2 minutes) prüft auf Stille. Funktioniert, aber:
- Nur erste 2 min → Long-Form Podcast könnte später Stille haben
- Heuristik-basiert, keine ML

**Aktuell:** Funktioniert robust, aber Edge-Case dokumentiert.

### 5.7 Tesseract.js Lücken
OCR-Engine ist tesseract.js (WASM), nicht native. Fehlerquellen:
- Sprache muss passend sein (`--ocr-language deu` für Deutsch)
- Default `eng+por`, alles andere erfordert Manual
- Traineddata-Download on-demand, kann langsam sein

---

## 6. Fazit: Konsolidierung in "media-intel"

### Was sollte übernommen werden

1. **Fehlerbehandlung-Pattern:** `warnings[]` statt Exceptions, Actionable Hints
2. **Security-CodeQL-Prozess:** Alerts nicht ignorieren, Root-Cause-Fix
3. **Caching mit Sidecars:** Persistent Cache (URL-Hash), Mode 0700, Sidecar-Austausch
4. **Adapter für Plattformen:** Fallback-Ketten, yt-dlp + CDN
5. **Whisper-Backend-Kette:** CLI → OpenAI → HF, Env-Gating
6. **Frame-Budget Adaptive:** Duration-basiert, Override möglich
7. **Multi-Transport:** Stdio (MCP), CLI (one-shot), Skill (Agent-fallback)
8. **Dockerfile:** Multi-Stage, saubere Production-Image

### Was sollte NICHT übernommen werden

1. **Cache-Auto-Purge fehlt:** media-intel sollte TTL-basiertes Cleanup planen
2. **yt-dlp als Hard-Dependency:** Ziel sollte sein, Optional zu halten (mit gutem Fallback, nicht nur Warnings)
3. **Tesseract.js Abhängigkeit:** Für Server-Side OCR sollte native Tesseract oder Paddleocr in Betracht gezogen werden (WASM ist für Edge, nicht für Batch)
4. **Windows Cookie-Falle:** Architektur sollte Cookies in Config-File erfordern, nicht Browser-Scraping

### Empfehlungen für media-intel

**High Priority (Architecture):**
- Warnings-Pattern (Fehler + Hints, keine Exceptions)
- Multi-Backend-Orchestrierung (Whisper, OCR, Frame-Extraction)
- Adapter für YouTube, Loom, Instagram, etc.
- Persistent Cache (URL-Hash basiert)

**Medium Priority (Quality):**
- CodeQL-Process in CI/CD
- Dependabot für Dependencies
- Sidecar-Dateien für Reusability (VTT, JSON)

**Low Priority (Nice-to-Have):**
- Skill-Distribution (wenn Agent-native Integration geplant)
- Frame-Budget Adaptive (vs. fixed 30)

**Out-of-Scope:**
- Native Chrome Extension für Cookie-Scraping
- GPU-Whisper Integration (CLI-Flag `--compute_type` ist Workaround)
- Automatische Cache-Cleanup (Benutzer-Aufgabe)

---

**Komplexität:** 56 commits, 194 files, 10 MCP-Tools, 3 Transkriptions-Backends, 8 Video-Plattformen, 4 Security-Fixes in v0.10 = reife Production-Codebasis mit guten Patterns.

**Einstiegsbarriere:** yt-dlp + Whisper-Installation (externe Dependencies), aber gut dokumentiert. MCP-Server selbst läuft gebündelt via `npx`.

**Lizenz:** MIT, frei nutzbar.
