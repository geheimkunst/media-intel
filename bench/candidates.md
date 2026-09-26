# Referenz-Kandidaten: Bau, Start, Tool-Schnittstellen, Stolpersteine

Stand 29-08-2026. Alles aus dem Quellcode belegt, nicht aus den READMEs.
Repos unter `<reference-clones>/`:

| Repo | Origin | HEAD |
|---|---|---|
| media-understanding | github.com/dymoo/media-understanding | `a37ce99` (07-04-2026) |
| mcp-video-analyzer | github.com/guimatheus92/mcp-video-analyzer | `aa7409b` (23-08-2026) |
| claude-video | github.com/bradautomates/claude-video | `83da59f` (30-06-2026) |
| claude-watch | github.com/taoufik123-collab/claude-watch | `7711231` (24-07-2026) |

Umgebung des Laufs: Debian x86_64, 4 Cores, 8 GB, kein Netz, Fixtures schreibgeschützt unter `/data`, Cache unter `/cache`.

---

## 1. media-understanding (dymoo, Node/TS, MCP stdio)

### 1.1 Bauen und Starten

```bash
# Kontext = Repo-Root, Dockerfile im Root
docker buildx build --platform linux/amd64 -t media-understanding:bench \
  <reference-clones>/media-understanding
```

`buildx` bzw. BuildKit ist Pflicht: `Dockerfile:5` deklariert `ARG TARGETARCH` ohne Default und die `case`-Verzweigung beim yt-dlp-Download bricht mit `Unsupported TARGETARCH:` ab, wenn der klassische Builder die Variable leer lässt. Ersatzweise `--build-arg TARGETARCH=amd64`.

Offizielles Image aus `.github/workflows/release.yml`: `ghcr.io/dymoo/media-understanding:latest` bzw. `:1.1.0` und `:1.1`, gebaut nur für `linux/amd64`.

**Startfalle:** Der `ENTRYPOINT` ist `supergateway` und startet einen HTTP-Server auf Port 8000 (`Dockerfile:70-71`), nicht stdio. Für den Benchmark muss der Entrypoint überschrieben werden:

```bash
docker run -i --rm --network none \
  -v "$FIXTURES:/data:ro" -v "$CACHE:/cache" \
  -e XDG_CACHE_HOME=/cache -e MEDIA_UNDERSTANDING_MODEL=base-q5_1 \
  --entrypoint node media-understanding:bench dist/mcp.js
```

Beim Start schreibt der Server eine Zeile auf stderr (`yt-dlp detected` oder `not found`, `src/mcp.ts:36-40`). Da yt-dlp im Image liegt, registriert er zusätzlich `fetch_ytdlp` (offline nutzlos, taucht aber in `tools/list` auf).

### 1.2 Env-Variablen und Modellablage

| Variable | Default | Wirkung |
|---|---|---|
| `MEDIA_UNDERSTANDING_MODEL` | `base.en-q5_1` | Whisper-Modellname (`src/media.ts:809`) |
| `XDG_CACHE_HOME` | im Image `/opt/media-understanding-cache` | Wurzel des Modellverzeichnisses |
| `MEDIA_UNDERSTANDING_MAX_CHARS` | 32000 | Transkript-Kappung |
| `MEDIA_UNDERSTANDING_MAX_GRIDS` | 6 | Grid-Anzahl |
| `MEDIA_UNDERSTANDING_DISABLE_HW` | ungesetzt | `1` erzwingt den Software-Adapter (`src/accel.ts:558`) |
| `SKIP_MODEL_DOWNLOAD` | ungesetzt | nur beim Install, überspringt den postinstall-Download |

Modellpfad: `${XDG_CACHE_HOME}/media-understanding/models/ggml-<model>.bin` (`src/media.ts:208-217`, Dateiname aus `node-av`, `dist/api/utilities/whisper-model.js:234`).

**Der Build lädt ein Modell.** `package.json` hat `postinstall: node scripts/install-node-av.mjs && node scripts/download-whisper-model.mjs`; letzteres zieht `base.en-q5_1` (rund 57 MB) nach `/opt/media-understanding-cache/media-understanding/models`. Fehlt ein Modell zur Laufzeit, lädt `node-av` es von Hugging Face nach, offline also Fehlschlag.

### 1.3 Fixierung auf ggml-base-q5_1

`base-q5_1` ist ein gültiger Modellname der `node-av`-Liste (`WHISPER_MODELS`), Datei `ggml-base-q5_1.bin`, Quelle `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin`.

Vorbereitung einmalig mit Netz, danach läuft der Bench offline:

```bash
mkdir -p "$CACHE/media-understanding/models"
curl -fsSL -o "$CACHE/media-understanding/models/ggml-base-q5_1.bin" \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin
```

Dann im Container `XDG_CACHE_HOME=/cache` und `MEDIA_UNDERSTANDING_MODEL=base-q5_1` setzen. Der Wert ist der reine Modellname, ohne `ggml-`-Präfix und ohne `.bin`.

Das multilinguale Modell ist hier zwingend, nicht nur der Fairness wegen: `transcribeAudio` setzt `language: "auto"` fest (`src/media.ts:842`), und der Default `base.en-q5_1` ist ein Englisch-Modell. Deutsche Fixtures liefern damit Müll.

### 1.4 Backend

whisper.cpp als GGML über `node-av` (`WhisperTranscriber`, `src/media.ts:839-854`). Das native Addon kommt vorkompiliert aus `@seydx/node-av-linux-x64` (`node-av.node.zip` wird vom Install-Skript entpackt, kein Compiler nötig), die FFmpeg-Bibliotheken lädt `node-av/dist/ffmpeg/install.js` beim Install von GitHub Releases (Jellyfin-Build, `linux-x64`). Läuft auf x86 ohne GPU; `accel.ts` probiert Hardware-Backends und fällt auf Software zurück, `MEDIA_UNDERSTANDING_DISABLE_HW=1` spart die Probe.

### 1.5 Tool-Schnittstellen

Registrierung in `src/mcp.ts:445-490`. Kein `outputSchema`, also **kein `structuredContent`**, alles liegt in `content[]`.

**(a) Transkript: `get_transcript`**
`{ file_path: string (Pflicht), model?: string, max_chars?: int (32000), format?: "text"|"srt"|"json" ("text"), start_sec?: number, end_sec?: number }`
Ergebnis: ein einziger `content[].type="text"`-Block.
* `text`: Zeilen `[12.3–14.5] Text`, Sekunden mit einer Nachkommastelle.
* `srt`: Standard-SRT, `HH:MM:SS,mmm`.
* `json`: `{"segments":[{"start":12300,"end":14500,"text":"..."}]}`, **Millisekunden als Ganzzahl** (`src/mcp-format.ts:135-146`).
Keine Sprachangabe im Ergebnis, also keine Sprach-Erkennung ableitbar.

**(b) Einzelframes: `get_frames`**
`{ file_path: string, timestamps: number[] (Sekunden, min 1, max 20), max_total_chars?: int (48000) }`
Ergebnis pro Frame: Textzeile `Frame at 00:00:12.000 (12.000s)`, danach `{type:"image", data:<base64>, mimeType:"image/jpeg"}`. Am Ende ein Text-Summary. Der Zeitstempel ist zusätzlich **ins Bild eingebrannt** (schwarzer Balken unter dem Frame, `HH:MM:SS.mmm`, `src/media.ts:320-347`).

**(c) Übersicht: `get_video_grids`**
`{ file_path, max_grids?, start_sec? (0), end_sec?, sampling_strategy?: "uniform"|"scene" ("uniform"), scene_threshold?: 0..1, frame_interval?: int (300), seconds_per_frame?, seconds_per_grid?, cols?: 1..8 (4, Portrait 3), rows?: 1..8 (4, Portrait 3), aspect_mode?: "contain"|"cover", thumb_width?: int (480, Portrait 120), max_total_chars? (48000) }`
Ergebnis: Intro-Text, dann je Grid ein Text `Grid 1/3 covers 0.000s-9.966s. Tile timestamps: 00:00:00.000, ...` plus ein JPEG-Kontaktbogen. Kacheln tragen die eingebrannten Zeitstempel.

**(d) Szenen/Schnitte: nicht vorhanden.** Es gibt kein Tool, das eine Cut-Liste zurückgibt. `sampling_strategy:"scene"` in `get_video_grids` und `understand_media` wählt Frames an Szenenwechseln aus; die Zeiten stehen nur als Kachel-Zeitstempel im Text. Als Notbehelf für die Cut-Metrik auswertbar, aber es ist eine Frame-Auswahl, keine Schnitterkennung.

**(e) OCR: nicht vorhanden.**

**(f) Probe: `probe_media`**
`{ paths: string | string[] (Pfade oder Globs), max_files?: int (50, hart 200) }`
Ergebnis: **Klartext**, kein JSON: `Probed N file(s): ...` plus je Datei ein Block `File:/Type:/Duration:/Resolution:/FPS:/Video codec:/Audio codec:/Sample rate:/Channels:/Size:/Acceleration:`.

Zusätzlich vorhanden: `understand_media` (Transkript und Grids in einem Aufruf) sowie `fetch_ytdlp`.

### 1.6 Stolpersteine

* Beliebige absolute Pfade sind erlaubt, es gibt keine Sandbox; `expandPaths` löst Globs mit `fs.promises.glob` auf.
* Harte Grenzen (`src/mcp-preflight.ts`): Datei über 10 GB wird abgelehnt, `get_transcript` über 4 h, `understand_media` über 2 h.
* Budget: `max_total_chars` (48000) zählt Text und Base64 zusammen. Bei `get_frames` wirft ein zu großes Bild einen Fehler, bei `get_video_grids` wird nur abgeschnitten, wenn `max_grids` nicht gesetzt ist.
* Bilder kommen immer inline als Base64, nie als Dateipfad.
* Transkripte werden im Prozess nach SHA-256-Fingerprint gecacht, wiederholte Läufe auf derselben Datei sind also nicht mehr repräsentativ für die Wanduhr.

---

## 2. mcp-video-analyzer (guimatheus92, Node/TS, FastMCP stdio)

### 2.1 Bauen und Starten

```bash
docker build -t mcp-video-analyzer:bench \
  <reference-clones>/mcp-video-analyzer
docker run -i --rm --network none -v "$FIXTURES:/data:ro" -v "$CACHE:/cache" \
  -e MCP_CACHE_DIR=/cache mcp-video-analyzer:bench
```

Kein offizielles Image: `.github/workflows/` hat nur `ci.yml`, `codeql.yml`, `security.yml`, keinen GHCR-Push. Vertrieben wird npm `mcp-video-analyzer@0.10.0` bzw. `npx` über `smithery.yaml`. `ENTRYPOINT ["node","dist/index.js"]` ohne Argument startet direkt den stdio-Server (`src/index.ts:22-24`), das ist der Normalfall, kein Override nötig.

Der Build lädt kein Modell, aber `npm rebuild ffmpeg-static` zieht das ffmpeg-Binary (Netz beim Build). `ffprobe` fehlt bewusst, Metadaten werden aus dem stderr von `ffmpeg -i` geparst (`src/processors/frame-extractor.ts:124-132`).

### 2.2 Env-Variablen

`MCP_CACHE_DIR` (im Image `/tmp/mcp-video-analyzer-cache`), `MCP_FRAME_MAX_WIDTH` (800), `MCP_FRAME_JPEG_QUALITY`, `MCP_OCR_PREPROCESS`, `MCP_WRITE_SIDECARS`, `WHISPER_MODEL` (`tiny`), `WHISPER_LANGUAGE`, `WHISPER_PROMPT`, `WHISPER_BIN`, `WHISPER_DEVICE`, `WHISPER_COMPUTE`, `WHISPER_BEAM_SIZE`, `WHISPER_WORD_TIMESTAMPS`, `WHISPER_HF_MODEL`, `OPENAI_API_KEY`, `TWELVELABS_API_KEY`, `YTDLP_COOKIES*`, `XDG_CACHE_HOME`.

Cache-Wurzel: `MCP_CACHE_DIR` gewinnt vor `XDG_CACHE_HOME` vor `$HOME/.cache`, danach wird immer `mcp-video-analyzer/<segment>` angehängt (`src/utils/temp-files.ts:51-92`).

### 2.3 Whisper-Backend und die ggml-Frage

Kette in `src/processors/audio-transcriber.ts:140-172`:
1. `@huggingface/transformers`, nur wenn `WHISPER_HF_MODEL` gesetzt ist. Das Paket steht **nicht** in den `dependencies`, wird dynamisch importiert und liegt im Image nicht vor.
2. `whisper`-CLI auf dem PATH (Python `openai-whisper`, alternativ `whisper-ctranslate2`), Modell über `WHISPER_MODEL`, Timeout 300 s.
3. OpenAI-API `whisper-1`, braucht `OPENAI_API_KEY`.

Das Image enthält weder Python noch `whisper`. Offline liefert `get_transcript` deshalb `transcript: []` plus die Warnung `No speech-to-text backend available`.

**`ggml-base-q5_1` ist hier nicht einstellbar**, weil das Backend kein whisper.cpp ist und keine GGML-Datei lädt. Die nächste Entsprechung wäre `WHISPER_MODEL=base` (multilinguales PyTorch-Modell, Cache `~/.cache/whisper/base.pt`), was aber ein anderes Gewicht, ein anderes Format und eine andere Laufzeitcharakteristik ist. Ohne Eingriff ins Repo (Python plus `openai-whisper` ins Image) ist die Transkript-Aufgabe für diesen Kandidaten offline nicht durchführbar. Empfehlung: als `n/a (kein ASR-Backend im Image)` ausweisen statt mit einem fremden Modell antreten zu lassen.

### 2.4 Tool-Schnittstellen

Acht Tools (`src/server.ts:63-70`). Alle antworten mit `content[]`, kein `structuredContent`; der Textblock ist stets ein `JSON.stringify(..., null, 2)`.

**(a) Transkript: `get_transcript`**
`{ url: string, options?: { model?, language?, initialPrompt? } }`
Ergebnis: `{"transcript":[{"time":"0:07","endTime"?,"speaker"?,"text":"..."}],"warnings":[]}`. Zeit ist ein **String** `M:SS` bzw. `H:MM:SS` in **ganzen Sekunden** (`formatTimestamp`), keine Millisekunden, kein Endzeitpunkt aus Whisper.

**(b) Einzelframes: `get_frame_at`**
`{ url: string, timestamp: string ("1:23", "0:05", "01:23:45"), returnBase64?: bool, maxWidth?: int }`
Ergebnis: Textblock `{"frameCount":1,"timestamp":"0:30","warnings":[]}` plus ein Bild. Nur ein Zeitpunkt pro Aufruf. Für mehrere Zeitpunkte: `get_frame_burst` `{ url, from: string, to: string, count?: 2..30 (5), returnBase64?, maxWidth? }`, gleichmäßig verteilt.
`returnBase64` ist ein toter Parameter: beide Handler destrukturieren ihn nicht und liefern immer Base64.

**(c) Viele Frames: `get_frames`**
`{ url: string, options?: { maxFrames?: 1..60 (20), threshold?: 0..1 (0.1), dense?: bool (false), maxWidth?: int } }`
Ergebnis: `{"frameCount":N,"mode":"scene"|"dense","warnings":[]}` plus N Bilder. **Kein Kontaktbogen**, sondern Einzelbilder. **Die Zeitstempel fehlen im Ergebnis**, es steht nur die Anzahl drin.

**(d) Szenen: kein eigenes Tool.** Szenenerkennung ist `ffmpeg -vf select='gt(scene,threshold)',showinfo` (`frame-extractor.ts:211-235`). Die erkannten Zeiten sind nur über `analyze_video` erreichbar, dort im Feld `frames[].time` (Format `M:SS`, ganze Sekunden). Für die Cut-Metrik also `analyze_video` mit `fields:["frames"]` verwenden, nicht `get_frames`. Auflösung von einer Sekunde ist für die 0,25-s-Toleranz des Bench grenzwertig, das gehört in den Bericht.

**(e) OCR: kein eigenes Tool.** OCR läuft nur innerhalb von `analyze_video` (`options.ocrLanguage`, Default `eng+por`) und `analyze_moment` (`ocrLanguage`). Ergebnis im JSON unter `ocrResults: [{time, text, confidence}]`, gefiltert auf `text.length > 3` und `confidence > 50` (`frame-ocr.ts:20-25`). Reine Bilddateien sind nicht adressierbar, siehe 2.5.

**(f) Metadaten: `get_metadata`**
`{ url: string }`
Ergebnis: `{"metadata":{platform,title,duration,durationFormatted,url,width,height,fps,videoCodec,audioCodec,hasAudio,creationTime,fileSizeBytes},"comments":[],"chapters":[],"aiSummary":null,"warnings":[]}`.

Vollanalyse: `analyze_video` `{ url, options?: { maxFrames?, threshold?, skipFrames?, maxWidth?, detail?: "brief"|"standard"|"detailed", fields?: ("metadata"|"transcript"|"frames"|"comments"|"chapters"|"ocrResults"|"timeline"|"aiSummary")[], forceRefresh?, ocrLanguage?, model?, language?, initialPrompt? } }`. Alle Optionen liegen **unter `options`**, nicht auf oberster Ebene.

### 2.5 Stolpersteine

* **Endungs-Allowlist.** `detectPlatform` akzeptiert lokale Pfade nur, wenn die Endung in `VIDEO_EXTENSIONS` steht: `.mp4 .webm .mov .avi .mkv .m4v .wmv .flv .mpeg .mpg .m2ts .mts .3gp .ogv` (`url-detector.ts:37-52`). Damit werden `/data/speech-de-clean.m4a`, `/data/silent.wav` und alle `ocr-*.png` schon von der zod-Validierung abgelehnt. Für Audio hilft ein Remux in `.mkv`, das ändert aber die Aufgabe und muss gekennzeichnet werden. Für Bild-OCR gibt es keinen Weg.
* Nur absolute Pfade oder `file://`, relative Pfade werden abgelehnt. Sonst keine Sandbox.
* **Tesseract offline.** Der WASM-Kern kommt aus `tesseract.js-core` in `node_modules`, funktioniert offline. Die Sprachdaten holt tesseract.js von jsDelivr, **außer** `${MCP_CACHE_DIR}/mcp-video-analyzer/tessdata/<lang>.traineddata` existiert bereits (ungezippt, wird vor dem Netz geprüft). Also vorab `eng.traineddata` und `deu.traineddata` dorthin legen und `ocrLanguage:"deu+eng"` setzen, sonst schlägt OCR ohne Netz still fehl.
* Stille-Gate: mittlere Lautstärke unter oder gleich -55 dB führt zu leerem Transkript plus Warnung, kein Fehler. Betrifft `silent.wav`.
* Timeouts: Audio-Extraktion 120 s, whisper-CLI 300 s, ffmpeg-Probe 30 s.
* `analyze_video` cacht 10 Minuten, `forceRefresh: true` umgeht das.
* `puppeteer-core` ist installiert, aber ohne Chrome im Image; der Browser-Fallback greift bei lokalen Dateien ohnehin nie.

---

## 3. claude-video (Agent-Skill, Python)

Kein Server, kein Docker, kein MCP. Skripte unter `skills/watch/scripts/`. Abhängigkeiten: Python 3 **nur Standardbibliothek** (json, re, shutil, subprocess, pathlib, urllib, ssl, argparse), dazu `ffmpeg` und `ffprobe` im PATH, `yt-dlp` nur für URLs. Versionen sind nicht gepinnt, es wird `shutil.which` geprüft und sonst abgebrochen.

**Transkript: offline nicht möglich.** `whisper.py` kennt ausschließlich Groq (`whisper-large-v3`) und OpenAI (`whisper-1`) über HTTPS, Schlüssel aus Env oder `~/.config/watch/.env`. `transcribe.py` parst nur eine vorhandene WebVTT-Datei; für lokale Dateien wird gar keine Sidecar-Datei gesucht (`download.resolve_local` setzt `subtitle_path: None`). Ohne Schlüssel bleibt der Report bei "No transcript available".

**Frames, direkt aufrufbar:**

```bash
python3 skills/watch/scripts/frames.py <video> <out-dir> \
  [--fps F] [--resolution 512] [--max-frames 100] [--start T] [--end T] [--no-dedup]
```

Ausgabe: JSON auf stdout, JPEGs als `frame_%04d.jpg` im Zielverzeichnis:

```json
{"meta":{"duration_seconds":60.0,"width":1280,"height":720,"codec":"h264","size_bytes":123,"has_audio":true},
 "fps":0.66,"target":40,"focused":false,"deduped_count":3,
 "frames":[{"index":0,"timestamp_seconds":0.0,"path":"/tmp/f/frame_0001.jpg","reason":"uniform"}]}
```

Der CLI-Pfad nutzt immer gleichmäßiges Sampling (`auto_fps`, gedeckelt auf `MAX_FPS = 2.0`), nicht die Szenen-Engine. Zeitstempel sind Sekunden mit zwei Nachkommastellen, nicht ins Bild eingebrannt.

**Szenen:** `extract_scene_candidates` (Schwelle 0.20) und `extract_scene_or_uniform` (fällt unter 8 Kandidaten auf uniform zurück) sind nur per Import oder über `watch.py --detail balanced|token-burner` erreichbar. `watch.py` gibt einen Markdown-Report aus, Frames als Liste `- \`pfad\` (t=MM:SS, reason=scene-change)`, also nur Sekundenauflösung.

**Einzelframes zu Zeitstempeln:** `watch.py --timestamps "3,7,12"` (Cue-Frames, `extract_at_timestamps`).

**OCR: nicht vorhanden. Metadaten:** `frames.get_metadata` über `ffprobe -print_format json`.

Stolpersteine: die Dedup-Stufe (`DEDUP_THRESHOLD 2.0`) verwirft optisch gleiche Frames und verfälscht die Frame-Zahl, `--no-dedup` schaltet sie aus. `resolve_local` warnt bei unbekannter Endung, bricht aber nicht ab; eine reine Audiodatei läuft durch und liefert null Frames.

---

## 4. claude-watch (Agent-Skill, Python)

Der ältere Vorfahre desselben Skills, Skripte direkt unter `scripts/`. Gleiche Abhängigkeiten (stdlib, ffmpeg, ffprobe, yt-dlp), gleiches Transkript-Bild: nur Groq und OpenAI, offline also nichts.

`frames.py` hat dieselbe CLI wie oben, ohne `--no-dedup` und ohne Dedup-Stufe; die Ausgabe hat statt `reason` das Feld `source`. Zusätzlich:

* `extract_scene_change(video, out_dir, scene_threshold=0.3, resolution=512, max_frames=100, uniform_fallback_min=10, start_seconds, end_seconds)`, gibt `[{index, timestamp_seconds, path, source:"scene-change"}]` zurück. **Kein CLI-Einstieg**, nur per Import. Bei weniger als 10 erkannten Frames fällt die Funktion still auf uniform zurück, was bei `cuts-10.mp4` (erste Frame plus 10 Schnitte gleich 11) knapp über der Schwelle liegt.
* `pacing.py`: `python3 scripts/pacing.py <duration-seconds> <t1> <t2> ...` liefert `{"shot_count","cuts_per_minute","mean_shot_length","median_shot_length","shots":[{"start_seconds","duration_seconds","motion_score"}]}`. Das ist reine Arithmetik über bereits bekannte Schnittzeiten, keine Erkennung.
* `report.py` baut den Markdown-Report, `select_hero_frames` wählt Schlüsselbilder.

OCR: nicht vorhanden. Metadaten: `get_metadata` wie oben.

---

## 5. Aufgabe mal Kandidat

`AUD = /data/speech-de-clean.m4a`, `VID = /data/cuts-10.mp4`. `SCRIPTS` steht für das jeweilige `scripts/`-Verzeichnis.

| Aufgabe | media-understanding | mcp-video-analyzer | claude-video | claude-watch |
|---|---|---|---|---|
| **(a) Transkript lokal** | `get_transcript`<br>`{"file_path":"/data/speech-de-clean.m4a","format":"json"}` | `get_transcript`<br>`{"url":"/data/speech-de-clean.m4a"}`<br>**wird abgelehnt** (Endung nicht in der Allowlist); auch nach Remux nach `.mkv` offline leer, kein ASR-Backend im Image | nicht offline (nur Groq/OpenAI-API) | nicht offline (nur Groq/OpenAI-API) |
| **(b) Frames zu Zeitpunkten** | `get_frames`<br>`{"file_path":"/data/cuts-10.mp4","timestamps":[5,15,30,45,55]}` | `get_frame_at`<br>`{"url":"/data/cuts-10.mp4","timestamp":"0:30"}`<br>(ein Zeitpunkt pro Aufruf, Zeit als String) | `python3 SCRIPTS/watch.py /data/cuts-10.mp4 --timestamps "5,15,30,45,55" --detail transcript` | nicht als CLI (nur `extract` gleichmäßig) |
| **(c) Übersicht / viele Frames** | `get_video_grids`<br>`{"file_path":"/data/cuts-10.mp4","cols":4,"rows":4,"thumb_width":480}`<br>(echter Kontaktbogen) | `get_frames`<br>`{"url":"/data/cuts-10.mp4","options":{"maxFrames":20,"dense":true}}`<br>(Einzelbilder, keine Zeiten im Ergebnis) | `python3 SCRIPTS/frames.py /data/cuts-10.mp4 /tmp/f --max-frames 40` | `python3 SCRIPTS/frames.py /data/cuts-10.mp4 /tmp/f --max-frames 40` |
| **(d) Schnitte** | kein Tool; nur `get_video_grids` mit `{"file_path":"/data/cuts-10.mp4","sampling_strategy":"scene","scene_threshold":0.3}`, Zeiten nur als Kachel-Labels | kein Tool; `analyze_video`<br>`{"url":"/data/cuts-10.mp4","options":{"fields":["frames"],"threshold":0.3,"detail":"standard"}}`, Zeiten in `frames[].time`, Sekundenauflösung | Import nötig: `extract_scene_candidates(..., threshold=0.20)` | Import nötig: `extract_scene_change(..., scene_threshold=0.3)`, danach `pacing.py` |
| **(e) OCR** | nicht vorhanden | kein eigenes Tool; `analyze_video`<br>`{"url":"/data/ocr-video.mp4","options":{"fields":["ocrResults"],"ocrLanguage":"deu+eng","detail":"detailed"}}`; PNG-Fixtures nicht adressierbar | nicht vorhanden | nicht vorhanden |
| **(f) Probe** | `probe_media`<br>`{"paths":"/data/speech-de-clean.m4a"}` (Klartext) | `get_metadata`<br>`{"url":"/data/cuts-10.mp4"}` (JSON); `.m4a` wird abgelehnt | `python3 SCRIPTS/frames.py` importieren oder `ffprobe` direkt | dito |

---

## 6. Korrekturen für `bench/candidates.mjs`

1. **media-understanding braucht `--entrypoint node` plus `dist/mcp.js`**, sonst startet supergateway den HTTP-Modus und der stdio-Client hängt. `dockerSpawn` unterstützt `extraArgs` und `cmd` bereits.
2. `MEDIA_UNDERSTANDING_CACHE_DIR` existiert nicht, wirkungslos. Maßgeblich ist `XDG_CACHE_HOME`; `HOME` ist nur Fallback. Modell muss unter `/cache/media-understanding/models/ggml-base-q5_1.bin` liegen.
3. media-understanding kennt keine Sprachausgabe: `parse.language` liefert immer `undefined`, und es gibt weder `scenes` noch `ocr`. Diese Aufgaben als `n/a` führen, nicht als 0.
4. mcp-video-analyzer: `analyze_video` erwartet `{"url":..., "options":{"fields":[...]}}`, nicht `fields` auf oberster Ebene, und das Feld heißt `ocrResults`, nicht `ocr`.
5. mcp-video-analyzer: `get_frame_at.timestamp` ist ein **String** (`"0:30"`), kein Zahlenwert.
6. mcp-video-analyzer `get_frames` liefert keine Zeitstempel; die `cuts`-Auswertung muss auf `analyze_video` und `frames[].time` gehen und `M:SS` in Sekunden umrechnen.
7. mcp-video-analyzer: `MCP_CACHE_DIR=/cache` setzen und `eng.traineddata` sowie `deu.traineddata` nach `/cache/mcp-video-analyzer/tessdata/` legen, sonst schlägt OCR ohne Netz fehl.
8. Audio-Fixtures und PNG-Fixtures sind für mcp-video-analyzer nicht adressierbar; der Runner sollte den Validierungsfehler als `n/a (Format nicht unterstützt)` verbuchen, nicht als Fehlschlag.
