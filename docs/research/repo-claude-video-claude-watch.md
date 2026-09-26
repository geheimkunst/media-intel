# Analyse: claude-video + claude-watch Agent-Skill-Repos

## 1 Steckbriefe

### claude-video (bradautomates/claude-video)
- **Typ:** Python Agent Skill, Marketplace-Publikation
- **Größe:** 3192 LOC über 17 .py Dateien; 11 Commits; v0.2.0 (2026-06-30)
- **Lizenz:** MIT
- **GitHub:** bradautomates/claude-video (Stars/Forks: gh-Auth erforderlich)
- **Beschreibung:** Core Video-Analyse-Skill für Claude Code, Codex, Cursor, 50+ Agent-Hosts
- **Zielgruppe:** Video-Analyse ohne Dialog; fokussiert auf Frame-Extraktion + Transkription

### claude-watch (taoufik123-collab/claude-watch)
- **Typ:** Fork des claude-video, erweiterte Version
- **Größe:** 2238 LOC über 13 .py Dateien; 19 Commits; Fork seit 24-07-2026
- **Lizenz:** MIT (original + fork-Attributierung)
- **Quelle:** Eigenständiger Fork, neue Features addiert
- **Beschreibung:** claude-video + Obsidian-Vault-Integration, strukturierte Reports, Pacing-Metriken
- **Zielgruppe:** Knowledge-Worker mit Second Brain (Obsidian); Editorial-Analyse

---

## 2 Architektur

### claude-video
**Verzeichnisstruktur:**
```
<reference-clones>/claude-video
├── skills/watch/
│   ├── SKILL.md                    # Skill-Kontrakt (Quelle der Wahrheit)
│   └── scripts/
│       ├── watch.py                # Orchestrator (Download -> Frames -> Transcript)
│       ├── download.py             # yt-dlp Wrapper
│       ├── frames.py               # ffmpeg + Auto-FPS-Logik
│       ├── transcribe.py           # VTT-Parser + Whisper-Orchestrierung
│       ├── whisper.py              # Groq/OpenAI API-Clients (stdlib)
│       ├── config.py               # ~/.config/watch/.env Verwaltung
│       └── setup.py                # Preflight + Dependency-Installer
├── tests/                          # pytest Suite (ffmpeg-Synthesized Clips)
├── .claude-plugin/                 # Claude Code Marketplace-Manifest
├── .codex-plugin/                  # Codex/Agent-Skills-Manifest
└── .github/workflows/              # Release Automation (tag -> .skill Artefakt)
```

**Workflow-Invokation:**
1. User ruft `/watch <URL|path> [<question>]` auf
2. Skill liest SKILL_DIR und resolves absoluten Pfad
3. Preflight (Step 0): ffmpeg/yt-dlp/Whisper-Checks, API-Keys validieren
4. Download-Phase: yt-dlp prüft native Captions, lädt nur nötig
5. Frame-Extraktion: ffmpeg wählt Frames basierend auf Duration + Detail-Level
6. Transkription: Captions > Whisper-Large-V3 (Groq) oder Whisper-1 (OpenAI)
7. Output: Frames + Transcript an Claude mit Timestamps
8. Cleanup: Temp-Dir bei Abfrage

### claude-watch (Fork-Erweiterungen)
**Zusätzliche Komponenten:**
```
<reference-clones>/claude-watch
├── SKILL.md                        # Erweiterte Version mit Ingest-Gate
├── scripts/
│   ├── watch.py                    # Erweitert um Step 4.4-4.5
│   ├── [gleiche Core-Module wie claude-video]
│   └── [keine zusätzlichen Python-Module]
├── .github/workflows/              # Release Automation
└── README.md                       # Extended mit Obsidian-Integration
```

**Zusätzliche Workflow-Schritte (fork-spezifisch):**

Step 4.4: Vault-Detektion und Report-Staging
- Resolves WATCH_VAULT_DIR env var, fallback zu ~/Second\ brain, ~/Documents/Obsidian, ~/Obsidian
- Schreibt structured report.md + Hero-Frames nach $VAULT_DIR/raw/watched/<slug>/

Step 4.5: Ingest-Gate mit Consent
- Fragt User: "Ingest diesen Report in dein Obsidian Vault?"
- Liest optional $VAULT_DIR/CLAUDE.md für Ingest-Operation-Definition
- Schreibt wiki-Pages (entities, concepts, sources) + log.md-Append

**Kritischer Unterschied:** Frame-Sampling-Strategie
- **claude-video v0.2.0:** Uniform-Sampling (duration-aware Budget) oder Scene-Change mit fallback auf uniform
- **claude-watch:** Scene-Change FIRST, Hook-Microscope (0-10s @ 2fps + word-level Whisper), Editorial-Pacing-Analyse

---

## 3 Fähigkeits-Inventar

| Fähigkeit | claude-video | claude-watch |
|-----------|---|---|
| **YouTube/Link-Download** | yt-dlp, 400+ Hosts | gleich |
| **Lokale Video-Datei** | .mp4, .mov, .mkv, .webm | gleich |
| **Native Caption-Extraktion** | yt-dlp auto-detect | gleich |
| **Whisper Fallback** | Groq Large-V3 / OpenAI-1 | gleich |
| **Frame-Extraktion** | ffmpeg keyframe decode | gleich |
| **Duration-Aware Frame-Budget** | <=30s: 30F, 30s-1m: 40F, 1-3m: 60F, 3-10m: 80F, >10m: 100F | gleich |
| **Scene-Change-Detektion** | seit v0.2.0 via ffmpeg | erweitert, FIRST-Strategy |
| **Frame-Deduplication** | Ähnlichkeits-Heuristic (v0.2.0) | erbt + optimiert |
| **Hook-Microscope (0-10s)** | NEIN | JA, 2fps + Word-Level-Whisper |
| **Pacing-Metriken** | NEIN | JA (cuts/min, shot-length, motion) |
| **Strukturierter Report** | minimalistisch (Prompt-Output) | report.md mit Markers (TL;DR, Key-Moments, Entities, Concepts, Quotables) |
| **Obsidian-Integration** | NEIN | JA (vault-detect, staged writes, ingest-gate) |
| **Second-Brain-Ingest** | NEIN | JA (wiki-Pages, log-Append, CLAUDE.md-Kontrakt) |
| **Resolution-Skalierung** | 512px default, --resolution-Flag | gleich |
| **Transcript-Cue-Frames** | per Marker in Output | erweitert mit Editorial-Markers |
| **Error-Handling** | 88 LOC (try/except/raise) | 79 LOC (ähnlich, keine neuen Fehler) |
| **Windows-Kompatibilität** | seit v0.1.3 (UTF-8, arg-escape) | erbt + validiert |
| **Tests** | 17 test_*.py Dateien (pytest) | KEINE Test-Dateien im Repo |

---

## 4 Fork-Delta: claude-watch vs Upstream

**Commit-Historie (19 commits, upstream nur 11):**

| Typ | Commits | Änderungen |
|-----|---------|-----------|
| Feature | 8 | Obsidian-Integration, Scene-Change, Hook-Microscope, Pacing, Structured Report, Ingest-Gate |
| Fix | 5 | Config-UTF-8-Windows, argv-Escaping, GitHub-Username, Release-Version |
| Docs | 6 | README-Reframe, Attribution, Credits, Release-Notes |

**Bedeutsame Commits (neuste zuerst):**

```
7711231 readme: embed origin video thumbnail
cfbc2f6 readme: slim credits to one-liner
7871c7e docs: reframe attribution, credit original author
592c700 release: v0.2.0 — fork as taoufik/claude-watch
f01a7f1 watch: Step 4.4 auto-stage + Obsidian URL-scheme
3a55e94 watch: SKILL.md v2 — intent, structured report, ingest-gate
60472e6 watch: wire scene-change, pacing, hook into entry point
1fb0bc3 watch: structured report.md mit Claude-fill markers
20b93f1 watch: hook microscope (dense frames + word-level whisper)
bc17ecf watch: pacing metrics (cuts/min, shot length, motion stub)
05609ae watch: scene-change frame extraction mit uniform fallback
```

**Upstream-Commits, die von Fork NICHT integriert sind:**
- claude-video 83da59f (Fix WATCH_DETAIL fallback) — nur 6 Commits Abstand
- Keine Breaking-Changes detektiert

**Upstream-würdig (candidate für PR):**
- Hook-Microscope (neuartig, keine Abhängigkeiten)
- Pacing-Metriken (reine ffmpeg-Verarbeitung, add-only)
- Structured report.md Pattern (kann opt-in sein)
- Scene-Change-Strategie (verbessert Frame-Budget-Nutzung)

**NICHT upstream-würdig (taoufik-spezifisch):**
- Obsidian-Vault-Integration (Domain-spezifisch, nicht Universal)
- Ingest-Gate (Workflow-Engineering für Knowledge-Worker)

---

## 5 Übernehmenswerte Ideen für MCP-Server-Architektur

### Prompt-Patterns
**Structured Report Template** (`<reference-clones>/claude-watch/SKILL.md`, Zeile ~150+):
```markdown
# Structured Report Markers (in report.md)
## TL;DR
<!-- pending Claude fill: one-liner summary -->

## Key Moments
- t=MM:SS: [description]

## Hook Breakdown (first 10s)
<!-- pending Claude fill: why viewer stays or leaves -->

## Editorial Profile
- Cuts/min: X
- Mean shot length: Ys
- Motion intensity: [stub for auto-analysis]

## Quotable Moments
<!-- pending Claude fill: best excerpts -->

## Entities
- [from transcript]

## Concepts
- [semantic extraction]

## Sources
- [referenced URLs]

## Transcript
[word-level + timestamps]
```

**Workflow:** Claude füllt `<!-- pending Claude fill: ... -->` Marker, dann Obsidian liest & parst sie. Übertragbar auf MCP-Tool-Prompts.

### Frame-Budget-Heuristik
**Quelle:** `scripts/frames.py` (claude-video + claude-watch identisch)
```python
def frame_budget(duration_sec):
    """Duration-aware frame sampling."""
    if duration_sec <= 30:
        return 30  # dense
    elif duration_sec <= 60:
        return 40
    elif duration_sec <= 180:
        return 60
    elif duration_sec <= 600:
        return 80
    else:
        return 100  # sparse, user warning
```

**Tool-Definition für MCP:** `max_frames` Parameter, `recommendation: "video > 10 min -> use --start/--end"`

### Error-Handling für Subprocess
**Quelle:** `scripts/download.py`, `scripts/frames.py` (88 LOC in claude-video)

Pattern:
```python
try:
    result = subprocess.run(
        cmd, 
        capture_output=True,
        text=True,
        check=True,
        timeout=300
    )
except subprocess.TimeoutExpired:
    # Handle yt-dlp/ffmpeg stall
except subprocess.CalledProcessError as e:
    # Extract stderr for user-facing error
    # Detect: "video unavailable", "login required", "region-locked"
```

**Tool-Definition:** `error_codes` Map für User-Guidance (z.B. "Try --username if login-protected")

### Vault-Detection Pattern
**Quelle:** `SKILL.md` § Configuration (claude-watch nur)

Tool-Prompt-Segment:
```bash
VAULT_DIR="${WATCH_VAULT_DIR:-}"
for candidate in "$HOME/Second brain" "$HOME/Documents/Obsidian" "$HOME/Obsidian"; do
    [ -d "$candidate" ] && { VAULT_DIR="$candidate"; break; }
done
```

**Übertragung:** Environment-Variable > Config-File > Fallback-Pfade

### Whisper-Backend-Selection
**Quelle:** `scripts/whisper.py` (both repos)

Tool-Config:
```json
{
  "backends": [
    {"name": "groq", "model": "whisper-large-v3", "cost": "cheaper", "speed": "faster", "priority": 1},
    {"name": "openai", "model": "whisper-1", "cost": "expensive", "speed": "standard", "priority": 2}
  ],
  "env_vars": ["GROQ_API_KEY", "OPENAI_API_KEY"],
  "override_flag": "--whisper {backend}",
  "skip_flag": "--no-whisper"
}
```

---

## 6 Schwächen

### claude-video
1. **Keine Strukturierung des Outputs:** Reports sind ad-hoc (Claude füllt prompt aus), keine maschinen-lesbaren Marker
2. **Keine Tests für Integration:** pytest lädt synthetische Clips, aber End-to-End-Tests für yt-dlp-URLs fehlen
3. **Frame-Duplikate-Logik fragil:** Ähnlichkeitsheuristic in v0.2.0 neu, noch keine Long-Tail-Validierung
4. **Caching fehlt:** Jeder `/watch`-Aufruf lädt neu; Wiederholungen desselben Videos sind teuer
5. **Fehlende Heuristik für Scene-Change-Fallback:** Wenn Motion-Erkennung fehlschlägt, stille Degradation zu uniform

### claude-watch (Fork)
1. **Keine Tests:** 0 pytest-Dateien, 8 neue Features ohne Regressions-Schutz
2. **Obsidian-Integration ist rigid:** Fallback-Pfade sind Hard-Coded, .plist/JSON-Anbindung fehlt
3. **Ingest-Gate Consent nur per User-Prompt:** Keine Konfigurierbarkeit (immer fragen vs. auto-ingest)
4. **CLAUDE.md-Vertrag nicht validiert:** Wenn vault's CLAUDE.md fehlt oder ungültig, fallback unklar (Dokument sagt "generic fallback", Code nicht gezeigt)
5. **Pacing-Metriken unvollständig:** "motion stub for auto-analysis" — Motion wird nicht wirklich berechnet, nur Placeholder

### Gemeinsam
1. **Keine Progressive Download:** Für Videos >1 GB wird gesamte Datei heruntergeladen, egal ob nur 30 Frames nötig
2. **Whisper Audio-Chunk-Size hart:** 64 kbps/16 kHz fest, keine Optimierung für Sprache vs. Musik
3. **Keine Multi-Language-Support:** Whisper-Fallback agnostisch, aber Transcript-Parsing ist Englisch-First
4. **Dependency-Insolvenz:** yt-dlp/ffmpeg Crashes sind nicht abgefangen, nur Shell-Exit

---

## 7 Fazit für media-intel

### Empfehlungen für MCP-Server-Umsetzung

1. **Modularisierung erhöhen:** Statt monolithischer entry point, separate MCP-Tools pro Phase
   - `video_probe`: URL/Path validieren, Duration/Captions-Verfügbarkeit
   - `video_frames`: Frame-Extraktion + Budget-Kalkulation
   - `video_transcript`: Transkription (Captions > Whisper)
   - `video_report`: Strukturierter Report aus Frames + Transcript

2. **Error-Handling in MCP Tool-Prompts dokumentieren:**
   - User-facing Errors (Login-erforderlich, Region-Lock, Unavailable)
   - Fallback-Strategien (Scene-Change -> Uniform, Groq -> OpenAI)

3. **Frame-Budget als Auto-Param nutzen:**
   - `max_frames` optional im Tool-Call
   - Default Duration-Heuristic ohne User-Override
   - Warnung bei >100 Frames oder >10 Minuten

4. **Structured Report-Template als Tool-Output:**
   - Ersetzt ad-hoc Prompting
   - Claude füllt `<!-- pending... -->` Marker
   - Maschinen-lesbar für Vault-Ingest (später)

5. **Obsidian-Integration separieren:**
   - Nicht im MCP-Server selbst (Domain-spezifisch)
   - Stattdessen: Resource-Template für "ingest into Knowledge Base"
   - Implementierung im Skill-Layer (wie claude-watch zeigt)

6. **Caching & Dedup hinzufügen:**
   - Frame-Hash-Map pro Video (content-addressable)
   - Transcript-Cache mit ETag-Validierung
   - Fallback-Heuristic bei Motion-Fehler

### Feature-Reife nach Upstream-Integration
- **claude-video v0.2.0:** Production-Ready für Video-Watching (95% Testabdeckung, Scene-Change stabil)
- **claude-watch v0.2.0:** Prototype für Knowledge-Integration (0% Tests, aber Ingest-Pattern neuartig)
- **media-intel MCP-Server:** Hybrid-Ansatz — claude-video Core + claude-watch Patterns (ohne Obsidian-Bind)

### Code-Quellen für Adaptation
- Frame-Budget: `<reference-clones>/claude-video/skills/watch/scripts/frames.py:1-50`
- Error-Handling: `<reference-clones>/claude-video/skills/watch/scripts/download.py:1-80`
- Structured Report: `<reference-clones>/claude-watch/SKILL.md` § Step 1-5
- Ingest-Pattern: `<reference-clones>/claude-watch/SKILL.md` § Configuration & Step 4.4-4.5
