# Ernte: Basis-Werkzeuge und Bibliotheken der Media-Welt

> Stand 29-08-2026. Auftrag: konkrete Fähigkeiten finden, die media-intel noch nicht nutzt oder unterschätzt.
> Methode: Doku gelesen UND lokal gegengeprüft. Jede Zeile, die mit "gemessen" markiert ist, wurde am 29-08-2026 auf diesem Rechner ausgeführt, nicht aus dem Gedächtnis zitiert.

## 0. Prüfstand und Ausgangslage

| Werkzeug | Lokal vorhanden | Version (gemessen 29-08-2026) |
|---|---|---|
| ffmpeg / ffprobe | ja, `/opt/homebrew/bin` | 8.1.2 |
| yt-dlp | ja | 2026.07.04 (PyPI aktuell: 2026.8.19) |
| tesseract | ja | 5.5.3, leptonica 1.87.0, 163 Sprachen inkl. `deu` |
| exiftool | ja | 13.55 |
| scenedetect | ja, `~/.local/bin` | PySceneDetect 0.7.1 |
| sox | ja | vorhanden |
| Node | ja | v22.23.0 |
| whisper-cli, mediainfo, fpcalc, aubio | **nein** | über Homebrew nachrüstbar, siehe unten |
| swiftc | ja | Command Line Tools, macOS 26.6 |

Alle 18 geprüften ffmpeg-Filter (`scdet`, `silencedetect`, `blackdetect`, `freezedetect`, `cropdetect`, `ebur128`, `loudnorm`, `volumedetect`, `thumbnail`, `tile`, `signalstats`, `idet`, `astats`, `showspectrumpic`, `showwavespic`, `blackframe`, `entropy`, `photosensitivity`) sind im Build vorhanden.

**Erster harter Fund, betrifft die Roadmap direkt:** `drawtext` ist im Homebrew-ffmpeg **nicht** enthalten (`Unknown filter 'drawtext'`, keine `--enable-libfreetype` in der Build-Konfiguration). Roadmap Phase 1, Punkt 2 plant "Timestamp-Overlay" auf Einzelframes. Das geht mit diesem ffmpeg nicht. Vorhanden sind `drawbox`, `drawgrid`, `pad`, `overlay`. Konsequenz: Overlay in Node über `sharp` (SVG-Composite) bauen, nicht über ffmpeg. Siehe Thema 6.

Referenzmaterial für alle Messungen: 5 Minuten, 1280x720, 30 fps, h264, 107 MB, synthetisch erzeugt.

---

## 1. ffmpeg und ffprobe: Analyse-Modi, die strukturierte Ausgaben fast gratis liefern

Der Kern-Trick für media-intel: Analyse-Filter schreiben ihre Befunde als **Frame-Metadaten** (`lavfi.*`). Mit `metadata=mode=print:file=-` bzw. `ametadata=...` landen sie maschinenlesbar auf stdout, ohne dass ein Bild oder Ton geschrieben wird (`-f null -`). Damit wird aus jedem Filter ein Datenlieferant.

| Werkzeug | Fähigkeit | CLI-Aufruf (gemessen) | Ausgabeformat | media-intel-Tool | Aufwand | Lizenz | Quelle |
|---|---|---|---|---|---|---|---|
| `scdet` | Schnitt-Erkennung mit Score pro Frame | `ffmpeg -i v.mp4 -vf "scdet=t=10,metadata=mode=print:file=-" -f null -` | `lavfi.scd.time`, `lavfi.scd.score`, `lavfi.scd.mafd` je Frame | `get_scenes` | S | LGPL/GPL | [ffmpeg-filters 11.224](https://ffmpeg.org/ffmpeg-filters.html), 29-08-2026 |
| `select=gt(scene,..)` | Alternative Schnitt-Erkennung, gibt nur Wechsel-Frames aus | `-vf "select='gt(scene,0.3)',showinfo"` | `showinfo`-Zeilen mit `pts_time` | `get_scenes`, `get_video_grids` | S | LGPL | [ffmpeg-filters 20.17](https://ffmpeg.org/ffmpeg-filters.html), 29-08-2026 |
| `silencedetect` | Stille-Karte über die ganze Datei | `-af "silencedetect=n=-40dB:d=0.8"` | `silence_start`, `silence_end`, `silence_duration` (Log + `lavfi.silence_*`) | `get_transcript`, `analyze_moment` | S | LGPL | [ffmpeg-filters 8.107](https://ffmpeg.org/ffmpeg-filters.html), 29-08-2026 |
| `blackdetect` | Schwarzbild-Intervalle, findet Kapitelgrenzen und Werbebrüche | `-vf blackdetect=d=1:pic_th=0.98` | `black_start`, `black_end`, `black_duration`, dazu `lavfi.black_start/end` | `get_scenes` | S | LGPL | [ffmpeg-filters 11.12](https://ffmpeg.org/ffmpeg-filters.html), 29-08-2026 |
| `freezedetect` | Standbild-Intervalle, bei Screen-Recordings der Marker für "nichts passiert" | `-vf freezedetect=n=-60dB:d=1` | `lavfi.freezedetect.freeze_start/duration/end` | `get_scenes`, `get_video_grids` | S | LGPL | [ffmpeg-filters 11.105](https://ffmpeg.org/ffmpeg-filters.html), 29-08-2026 |
| `cropdetect` | Erkennt Letterbox und tatsächliche Bildfläche | `-vf cropdetect=limit=24:round=2:reset=0` | Log-Zeile `crop=W:H:X:Y` | `get_frames`, `get_video_grids` | S | LGPL | [ffmpeg-filters 11.48](https://ffmpeg.org/ffmpeg-filters.html), 29-08-2026 |
| `ebur128` | Lautheit nach EBU R128: I, LRA, True Peak | `-af ebur128=framelog=quiet:peak=true -f null -` | Summary-Block: `I: -21.8 LUFS`, `LRA: 9.5 LU`, `True peak: -17.7 dBFS` | `probe_media`, `analyze_audio` | S | LGPL | [ffmpeg-filters 20.10](https://ffmpeg.org/ffmpeg-filters.html), 29-08-2026 |
| `loudnorm` (Messmodus) | Dieselben Werte **als JSON**, ohne eigenes Parsen | `-af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null -` | echtes JSON: `input_i`, `input_tp`, `input_lra`, `input_thresh`, `target_offset` | `probe_media`, `analyze_audio` | **S, bestes Preis-Leistung** | LGPL | gemessen 29-08-2026 |
| `volumedetect` | Mittlere und Spitzenlautstärke plus Histogramm | `-af volumedetect -f null -` | `mean_volume: -23.3 dB`, `max_volume: -17.7 dB` | `probe_media` | S | LGPL | [ffmpeg-filters 8.121](https://ffmpeg.org/ffmpeg-filters.html), 29-08-2026 |
| `astats` | Rauschboden, Crest-Faktor, Flat-Faktor, Dynamikumfang, Nulldurchgänge | `-af astats` oder `astats=metadata=1` | Textblock je Kanal, optional `lavfi.astats.*` | `probe_media` (Audio-Qualitätsurteil) | S | LGPL | [ffmpeg-filters 8.59](https://ffmpeg.org/ffmpeg-filters.html), 29-08-2026 |
| `thumbnail` | Wählt den repräsentativsten Frame je n-Frame-Block | `-vf "thumbnail=25,scale=160:90,tile=4x2"` | Bild | `get_video_grids` | S | LGPL | [ffmpeg-filters 11.255](https://ffmpeg.org/ffmpeg-filters.html), 29-08-2026 |
| `tile` | Contact Sheet, Optionen `layout`, `nb_frames`, `margin`, `padding`, `color`, `overlap` | `-vf "fps=16/300,scale=320:-1,tile=4x4" -frames:v 1 grid.jpg` | ein JPEG (gemessen: 77 KB für 4x4) | `get_video_grids` | S, bereits geplant | LGPL | [ffmpeg-filters 11.256](https://ffmpeg.org/ffmpeg-filters.html), 29-08-2026 |
| `signalstats` | Helligkeits- und Farbstatistik je Frame (YMIN, YAVG, YMAX, YDIF, Perzentile) | `-vf "signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=-"` | `lavfi.signalstats.YAVG=122.107` je Frame | `get_scenes` (Hell-/Dunkel-Verlauf), `get_video_grids` | M | LGPL | [ffmpeg-filters 11.236](https://ffmpeg.org/ffmpeg-filters.html), 29-08-2026 |
| `idet` | Interlace-Erkennung, warnt vor Kammartefakten | `-vf idet -frames:v 50 -f null -` | Zähler `Single frame` / `Multi frame` je Typ | `probe_media` (Warnung) | S | LGPL | [ffmpeg-filters 11.136](https://ffmpeg.org/ffmpeg-filters.html), 29-08-2026 |
| `showwavespic` | Wellenform des ganzen Tracks als **ein Bild** | `-lavfi "showwavespic=s=800x200:split_channels=1" -frames:v 1 wave.png` | PNG (gemessen: 1,2 KB) | `analyze_audio`, `understand_media` | S | LGPL | [ffmpeg-filters 20.30](https://ffmpeg.org/ffmpeg-filters.html), 29-08-2026 |
| `showspectrumpic` | Spektrogramm des ganzen Tracks als ein Bild | `-lavfi showspectrumpic=s=800x400 -frames:v 1 spec.png` | PNG (gemessen: 71 KB) | `analyze_audio` | S | LGPL | [ffmpeg-filters 20.27](https://ffmpeg.org/ffmpeg-filters.html), 29-08-2026 |
| `-skip_frame nokey` | Nur Keyframes dekodieren, extrem schnell | `ffmpeg -skip_frame nokey -i v.mp4 -vf "scale=320:-1,tile=6x5" -an -fps_mode passthrough kf%02d.jpg` | Bilder | `get_video_grids` (Schnellpfad) | S | LGPL | [ffmpeg-filters, Beispiel bei `tile`](https://ffmpeg.org/ffmpeg-filters.html), 29-08-2026 |
| `-ss` **vor** `-i` | Input-Seek statt Output-Seek | `ffmpeg -ss 280 -i long.mp4 -frames:v 1 a.jpg` | Bild | `get_frames`, `analyze_moment` | S | LGPL | [ffmpeg.html](https://ffmpeg.org/ffmpeg.html), gemessen 29-08-2026 |
| `ffprobe -show_packets` | Keyframe-Zeitstempel ohne Dekodierung | `ffprobe -select_streams v:0 -show_entries packet=pts_time,flags -of csv=p=0 v.mp4 \| grep ",K"` | CSV, Zeilen mit Flag `K` | `get_scenes`, `get_frames` (Snap auf Keyframe) | S | LGPL | [ffprobe.html](https://ffmpeg.org/ffprobe.html), gemessen 29-08-2026 |
| `ffprobe -count_frames` | Exakte Framezahl statt Schätzung | `ffprobe -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -of json` | `{"nb_read_frames":"250"}` | `probe_media` | S, **aber teuer** (dekodiert alles) | LGPL | gemessen 29-08-2026 |
| `ffprobe -show_chapters` | Kapitelmarken aus dem Container | `ffprobe -show_chapters -of json v.mp4` | JSON mit `start_time`, `end_time`, `tags.title` | `probe_media`, `understand_media` | S | LGPL | gemessen 29-08-2026 |
| Untertitel-Extraktion | Eingebettete Spur direkt als SRT auf stdout | `ffmpeg -i sub.mkv -map 0:s:0 -f srt -` | SRT-Text | `get_transcript` (Stufe 1 der Kette) | S | LGPL | gemessen 29-08-2026 |

### Gemessene Laufzeiten (5 Minuten, 720p, 107 MB, 29-08-2026)

| Operation | Zeit | Bewertung |
|---|---|---|
| `-ss 280` **vor** `-i`, ein Frame | **0,14 s** | Input-Seek |
| `-ss 280` **nach** `-i`, ein Frame | **4,43 s** | Output-Seek, Faktor 32 langsamer |
| 16 Einzelframes über 16 Prozessaufrufe, `-ss` vor `-i` | **1,28 s** | schnellster Weg zu verstreuten Frames |
| Contact Sheet 4x4 über `fps=16/300` in einem Aufruf | **2,99 s** | dekodiert die ganze Datei, langsamer als 16 Seeks |
| Keyframe-Grid über `-skip_frame nokey` | **0,24 s** | mit Abstand am schnellsten |
| `scdet` über die ganze Datei | 4,06 s | Volldekodierung, akzeptabel |
| `silencedetect` + `ebur128` + `astats` in **einem** Durchlauf, `-vn` | **1,10 s** | drei Analysen zum Preis von einer |
| Audio als 16 kHz mono PCM extrahieren (Whisper-Vorstufe) | 0,16 s | |

**Die wichtigste Erkenntnis dieses Abschnitts:** Die geplante Grid-Erzeugung über `fps=N/dauer` ist der langsamste der drei Wege. Für ein Contact Sheet sollte media-intel N Zeitpunkte berechnen, N Prozesse mit `-ss` **vor** `-i` starten und die Kacheln in Node zusammensetzen, oder für den Schnellpfad `-skip_frame nokey` nehmen. Und: Audio-Analysen gehören in **eine** Filterkette, nicht in drei Aufrufe.

---

## 2. yt-dlp 2026

| Fähigkeit | CLI-Aufruf | Ausgabeformat | media-intel-Tool | Aufwand | Quelle |
|---|---|---|---|---|---|
| Nur ein Ausschnitt herunterladen | `--download-sections "*10:15-inf"`, mehrfach nutzbar, `*` = Zeitbereich, negative Zeiten zählen vom Ende, `*from-url` liest Start/Ende aus der URL | Datei | `fetch_media`, `analyze_moment` | S | [README](https://github.com/yt-dlp/yt-dlp#readme), 29-08-2026 |
| Untertitel mit Sprachwahl | `--write-subs --write-auto-subs --sub-langs "de,en" --sub-format "srt/vtt/best" --skip-download` | Sidecar-Dateien | `get_transcript` Stufe 1 | S | README, 29-08-2026 |
| Untertitel auflisten ohne Download | `--list-subs` | Text | `probe_media` für URLs | S | README, 29-08-2026 |
| SponsorBlock | `--sponsorblock-mark all,-preview` bzw. `--sponsorblock-remove default`. Kategorien: `sponsor, intro, outro, selfpromo, preview, filler, interaction, music_offtopic, hook, poi_highlight, chapter` | Kapitelmarken oder geschnittene Datei | `get_scenes`, `understand_media` | S | README, 29-08-2026 |
| Metadaten ohne Download | `-J` (`--dump-single-json`) bzw. `-j` (`--dump-json`) | JSON | `probe_media` für URLs | S | README, 29-08-2026 |
| **Heatmap "most replayed"** | im `-J`-JSON enthalten | **gemessen an Big Buck Bunny: Liste mit 100 Einträgen `{start_time, end_time, value}`** | `get_scenes`, `understand_media` | **S** | gemessen 29-08-2026, Feld dokumentiert in [extractor/common.py](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/common.py) |
| Kapitel | Feld `chapters` im JSON, `--split-chapters`, `--remove-chapters REGEX` | JSON-Liste bzw. Dateien | `probe_media`, `get_scenes` | S | README + gemessen 29-08-2026 |
| Kommentare | `--write-comments`, Feld `comments` | JSON | optional, hoher Umfang | M | gemessen 29-08-2026 |
| Live-Status | Feld `live_status`: `is_live`, `is_upcoming`, `was_live`, `not_live` | JSON | `probe_media` Warnung | S | common.py, 29-08-2026 |
| Livestreams | `--live-from-start`, `--wait-for-video MIN-MAX` | Datei | Phase 3 | L | gemessen 29-08-2026 |
| Freie Feldausgabe | `-O "%(duration)s %(chapters)#j"`, Konverter `j` = JSON, `l` = Liste, `D` = Dezimalsuffixe, `B` = Bytes | Text | `probe_media` (billiger als volles `-J`) | S | README, 29-08-2026 |
| Extractor-Argumente | `--extractor-args "youtube:player-client=tv,mweb;formats=incomplete"` | steuert Formatliste | `fetch_media` Fallback bei Extraktionsfehlern | M | README, 29-08-2026 |
| Cookies | `--cookies FILE` (Netscape-Format) oder `--cookies-from-browser` | | `fetch_media`, nur per Datei (Architektur A10) | S | README, 29-08-2026 |
| Drosselung und Robustheit | `-r 4.2M`, `--throttled-rate 100K`, `-R 10`, `--retry-sleep exp=1`, `--sleep-interval`, `-N` Fragmentparallelität | | `fetch_media` Defaults | S | gemessen 29-08-2026 |
| Minimaler Download | Nur Audio: `-f ba/bestaudio` oder `-x --audio-format wav`. Kleinste Auflösung für Frames: `-f "wv*[height<=360]+ba/w"` | | `fetch_media`, `get_transcript` | S | README (Formatauswahl), 29-08-2026 |
| Playlists | `--flat-playlist`, `-I 1:5`, `--lazy-playlist`, `--break-on-existing` | | Phase 2 | M | gemessen 29-08-2026 |

**Node-Wrapper (npm-Daten vom 29-08-2026):**

| Paket | Version | Downloads/Woche | Lizenz | Urteil |
|---|---|---|---|---|
| `youtube-dl-exec` | 3.1.13 | 64.172 | MIT | Lädt eine eigene yt-dlp-Binary mit. Bequem, aber Version driftet gegen das System. |
| `ytdlp-nodejs` | 3.4.5 | 7.148 | MIT | Klein, wenig verbreitet, dünne Basis. |
| **direkter Prozess über `execa`** | execa 10.0.1 | 168 Mio. | MIT | **Empfehlung.** media-intel hält yt-dlp laut A10 ohnehin optional und braucht `--print`-Feinsteuerung. Ein Wrapper bringt keinen Nutzen, kostet aber eine Abhängigkeit und eine zweite Binary. |

---

## 3. ASR lokal 2026

| Werkzeug | Version | Wort-Timestamps | Sprecher | Deutsch | Apple Silicon | Linux-CPU | Lizenz | Stars | Quelle |
|---|---|---|---|---|---|---|---|---|---|
| **whisper.cpp** (`whisper-cli`) | brew 1.9.2, Repo aktiv (Push 29-08-2026) | ja: `-ml 1` (max-len 1 Zeichen), `-sow`, `--dtw MODEL` für Token-Timestamps | rudimentär: `-di` (Stereo), `-tdrz` (tinydiarize, nur `small.en-tdrz`) | ja, `-l de` oder `-l auto`, `-dl` nur erkennen | ja, Metal und Core ML | ja | MIT | 53,3k | [Repo](https://github.com/ggml-org/whisper.cpp), Flags aus [examples/cli/cli.cpp](https://github.com/ggml-org/whisper.cpp/blob/master/examples/cli/cli.cpp), 29-08-2026 |
| faster-whisper | PyPI 1.2.1, letzter Push 19-11-2025 | ja, `word_timestamps=True` | nein | ja | ja (CTranslate2, CPU) | ja | MIT | 25,1k | [Repo](https://github.com/SYSTRAN/faster-whisper), 29-08-2026 |
| WhisperX | PyPI 3.8.6 | ja, per wav2vec2-Alignment (genauer als Whisper selbst) | ja, über pyannote | ja | teilweise, CUDA-orientiert | ja, langsam | BSD-2, Diarisierungsmodelle CC-BY-4.0 | 23,8k | [Repo](https://github.com/m-bain/whisperX), 29-08-2026 |
| NVIDIA Parakeet TDT 0.6B v3 | HF-Modell | ja, char/word/segment über NeMo `timestamps=True` | nein | **ja, 25 europäische Sprachen inkl. de, automatische Spracherkennung** | über NeMo oder sherpa-onnx | ja | **cc-by-4.0** | NeMo 18,4k | [HF-Modellkarte](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), 29-08-2026 |
| NVIDIA Canary 1B v2 | HF-Modell | ja | nein | ja | schwer | ja | cc-by-4.0 | | [HF-API](https://huggingface.co/nvidia/canary-1b-v2), 29-08-2026 |
| sherpa-onnx | PyPI 1.13.6 | modellabhängig | Sprecher-ID separat | modellabhängig | ja, ONNX Runtime | ja | Apache-2.0 | 14,5k | [Repo](https://github.com/k2-fsa/sherpa-onnx), 29-08-2026 |
| Moonshine | PyPI `moonshine-voice` 0.1.5 | begrenzt | nein | mehrsprachig, Qualität für Deutsch nicht geprüft | ja | ja, sehr leicht | MIT (auch Gewichte) | 11,0k | [Repo](https://github.com/usefulsensors/moonshine), 29-08-2026 |
| Kyutai STT | Repo 3,0k, letzter Push 26-01-2026 | ja, streaming | semantische VAD | **nein, nur `stt-1b-en_fr` und `stt-2.6b-en`** | ja | ja | cc-by-4.0 (Modelle) | 3,0k | [Repo](https://github.com/kyutai-labs/delayed-streams-modeling), 29-08-2026 |
| Mistral Voxtral Mini 3B | HF `Voxtral-Mini-3B-2507` | über Transkriptions-API | nein | ja | schwer, 3B | GPU nötig | **apache-2.0** | | [HF-Modellkarte](https://huggingface.co/mistralai/Voxtral-Mini-3B-2507), 29-08-2026 |
| Vosk | Repo 15,1k | ja | nein | ja, eigenes de-Modell | ja | ja, sehr leicht | Apache-2.0 | 15,1k | [Repo](https://github.com/alphacep/vosk-api), 29-08-2026 |
| **Silero VAD** | PyPI 6.2.1 | Sprachsegmente statt Wörter | nein | sprachunabhängig | ja | ja | **MIT** | 10,1k | [Repo](https://github.com/snakers4/silero-vad), 29-08-2026 |
| pyannote.audio | PyPI 4.0.7 | nein | **ja, das Referenzwerkzeug** | sprachunabhängig | ja | ja | Code MIT, Modell `speaker-diarization-3.1` MIT aber **`gated: auto`** (HF-Token nötig) | 10,5k | [Repo](https://github.com/pyannote/pyannote-audio), [HF-API](https://huggingface.co/pyannote/speaker-diarization-3.1), 29-08-2026 |

### whisper.cpp Modellgrößen (offizielle Tabelle, 29-08-2026)

`tiny` 75 MiB, `base` 142 MiB, `small` 466 MiB, `medium` 1,5 GiB, `large-v3` 2,9 GiB, **`large-v3-turbo` 1,5 GiB**, **`large-v3-turbo-q5_0` 547 MiB**, `small.en-tdrz` 465 MiB (Sprecherwechsel-Marker).
Quelle: [models/README.md](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md), 29-08-2026.

### Empfehlung für deutsche Voice-Notes

Die Roadmap setzt `ggml-base-q5_1` als Default. Das ist für Deutsch zu klein. Deutsche Sprachnotizen mit Fachbegriffen brauchen mindestens `small`, besser `large-v3-turbo-q5_0` (547 MiB, deutlich schneller als `large-v3` bei nahezu gleicher Qualität).

**Kette, die ich empfehle:**

1. `--vad` in whisper-cli einschalten. whisper.cpp hat Silero-VAD **eingebaut** (`--vad`, `-vm`, `-vt`, `-vsd`, `-vspd`). Das schneidet Stille weg, bevor das Modell rechnet, und verhindert die typischen Whisper-Halluzinationen in stillen Passagen. Kein zusätzliches Werkzeug nötig.
2. Modell `large-v3-turbo-q5_0`, `-l de`, `-oj` bzw. `-ojf` für JSON.
3. Wort-Timestamps über `-ml 1 -sow`, oder Token-Timestamps über `--dtw large.v3.turbo`.
4. Sprecher nur, wenn wirklich gebraucht: WhisperX oder pyannote, beides mit HF-Token-Gate. Für Voice-Notes des Betreibers (eine Stimme) ist das unnötig.

Parakeet v3 ist die interessanteste Alternative: 600M Parameter, 25 Sprachen, automatische Spracherkennung, Wort-Timestamps, cc-by-4.0. Aber der Weg dorthin geht über NeMo (schwer) oder sherpa-onnx (ONNX, leicht). Für Phase 3 als zweites Backend prüfen, nicht für Phase 1.

---

## 4. Szenen, Shots und Frame-Deduplikation

| Werkzeug | Fähigkeit | CLI-Aufruf | Ausgabeformat | media-intel-Tool | Aufwand | Lizenz | Quelle |
|---|---|---|---|---|---|---|---|
| **PySceneDetect 0.7.1** | 5 Detektoren: `detect-content` (HSL-Differenz), `detect-adaptive` (rollendes Mittel, robust gegen Schwenks), **`detect-hash` (perzeptuelles Hashing)**, `detect-hist` (YUV-Histogramm), `detect-threshold` (Ein-/Ausblendungen) | `scenedetect -i v.mp4 -o out detect-adaptive list-scenes -f scenes.csv` | CSV mit `Scene Number, Start Frame, Start Timecode, Start Time (seconds), End Frame, ..., Length (seconds)`, dazu Timecode-Liste auf stdout | `get_scenes` | M (Python-Abhängigkeit) | BSD-3 | [scenedetect.com/cli](https://www.scenedetect.com/docs/latest/cli.html), gemessen 29-08-2026 |
| PySceneDetect `save-images` | Repräsentative Bilder je Szene | `... detect-content list-scenes save-images` | JPEGs | `get_video_grids` | M | BSD-3 | gemessen 29-08-2026 |
| PySceneDetect `-s stats.csv` | Metrik je Frame zum Kalibrieren der Schwelle | `scenedetect -i v.mp4 --stats s.csv detect-adaptive` | CSV mit `content_val` | Tuning | S | BSD-3 | Doku, 29-08-2026 |
| ffmpeg `scdet` | siehe Thema 1 | | Metadaten | `get_scenes` | **S, keine Python-Abhängigkeit** | LGPL | 29-08-2026 |
| TransNetV2 | Neuronale Shot-Boundary-Erkennung, bestes F1 auf ClipShots/BBC/RAI | Python-Inferenz, TF oder PyTorch | Wahrscheinlichkeit je Frame | nicht empfohlen | L | MIT | [Repo](https://github.com/soCzech/TransNetV2), **letzter Push 04-12-2023, kalt**, 1,0k Stars, 29-08-2026 |
| `imagehash` (Python) | aHash, pHash, dHash, wHash, colorhash, crop-resistant | `imagehash.phash(Image.open(f))` | 64-Bit-Hash | Frame-Dedup | M (Python) | BSD-2, PyPI 4.3.2 | [Repo](https://github.com/JohannesBuchner/imagehash), 29-08-2026 |
| **`sharp-phash` (npm)** | pHash in Node auf Basis von sharp | `phash(buffer)` | Hash-String | **Frame-Dedup in `get_video_grids`** | **S, kein Python** | MIT, v2.2.0, 168.602/Woche | [npm](https://www.npmjs.com/package/sharp-phash), 29-08-2026 |
| `blockhash-core` (npm) | Blockhash-Algorithmus auf Rohpixeln | | Hash | Alternative | S | MIT, v0.1.0, 99.194/Woche | [npm](https://www.npmjs.com/package/blockhash-core), 29-08-2026. Referenz-Repo `commonsmachinery/blockhash-js` ist mit Push 27-07-2020 **kalt**. |
| `imghash` (npm) | pHash/aHash/dHash über sharp | | Hash | Alternative | S | MIT, v1.1.4, 71.857/Woche | [npm](https://www.npmjs.com/package/imghash), 29-08-2026 |

**Urteil:** Für media-intel reicht `scdet` plus `blackdetect` plus `freezedetect`. Alle drei sind Prozessaufrufe ohne zusätzliche Laufzeit im Sinne von A2, und alle drei liefern strukturierte Metadaten. PySceneDetect wäre eine Python-Abhängigkeit für einen Zugewinn an Genauigkeit, den nur Videoschnitt-Anwendungen brauchen. `detect-hash` ist trotzdem bemerkenswert: es zeigt, dass perzeptuelles Hashing als Schnitterkennung taugt, und genau dafür sollte media-intel es in Node einsetzen, nämlich um **doppelte Kacheln aus Contact Sheets zu werfen**. Bei Screen-Recordings mit langen Standbildern spart das direkt Vision-Tokens.

---

## 5. OCR

| Werkzeug | Fähigkeit | CLI-Aufruf | Ausgabeformat | Aufwand | Lizenz | Quelle |
|---|---|---|---|---|---|---|
| **tesseract 5.5.3** | 163 Sprachen lokal installiert, `--oem 1` LSTM, `--psm` Seitensegmentierung | `tesseract bild.png - -l deu --psm 6 tsv` | **TSV mit `left,top,width,height,conf,text` je Wort**, dazu `hocr` (bbox), `alto` (XML), `pdf`, `txt` | **S, bereits installiert** | Apache-2.0, 76,2k Stars | [tessdoc](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html), gemessen 29-08-2026 |
| Apple Vision über Swift-CLI | `VNRecognizeTextRequest`, `recognitionLevel = .accurate`, `recognitionLanguages` | selbst kompilierte ~20-Zeilen-Binary | JSON mit Text, Konfidenz und **normalisierten Boxen 0..1** | M einmalig, dann S | Systembestandteil, nur macOS | gemessen 29-08-2026 |
| `ocrmac` | Python-Hülle um dieselbe Vision-API | `ocrmac.OCR('x.png', language_preference=['de-DE'])` | Liste aus Text, Konfidenz, Box | S, aber Python | MIT, PyPI 1.0.1, 540 Stars | [Repo](https://github.com/straussmaximilian/ocrmac), 29-08-2026 |
| PaddleOCR | Dokumenten-KI-Pipeline, sehr stark bei Tabellen | Python | JSON | L (schwere Abhängigkeiten) | Apache-2.0, PyPI 3.7.0, 88,4k Stars | [Repo](https://github.com/PaddlePaddle/PaddleOCR), 29-08-2026 |
| Surya | Sehr gute Layout- und Leseordnung | `surya_ocr PFAD` | JSON | L | **Code Apache-2.0, Gewichte modifizierte AI-Pubs-OpenRail-M: frei nur unter 5 Mio. USD Umsatz und Funding** | [README](https://github.com/datalab-to/surya), 29-08-2026. Korrektur zu früherer Notiz: die Grenze ist 5 Mio., nicht 2 Mio. |
| docTR | End-to-End-OCR, TF und PyTorch | Python | JSON | L | Apache-2.0, PyPI 1.1.0, 6,3k Stars | [Repo](https://github.com/mindee/doctr), 29-08-2026 |
| RapidOCR | ONNX Runtime, leichtgewichtig, `pip install rapidocr onnxruntime` | Python | JSON | M | Apache-2.0, PyPI 3.9.2, 7,6k Stars | [Repo](https://github.com/RapidAI/RapidOCR), 29-08-2026 |

### Messung: deutscher Bildschirmtext (gemessen 29-08-2026)

Testbild 900x220, drei Zeilen mit Umlauten, ß und einem Code-Schnipsel.

| Werkzeug | Ergebnis | Zeit |
|---|---|---|
| `tesseract -l deu --psm 6` | `Fehler in Zeile 42: Größe überschritten` / `const größe = await fetchGrößen(userld);` / `Straße 7, Grün, Übung, weiß` | **0,05 s** |
| `tesseract -l eng --psm 6` | `Gr6éRe Uberschritten`, `StraRe 7, Grin, Ubung, wei` | 0,05 s |
| Apple Vision (Swift) | alle drei Zeilen korrekt bis auf `Ubung` statt `Übung`, Konfidenz 1,0, Boxen normalisiert | 1,71 s erster Lauf, Kompilat einmalig 20,9 s |

Fehler in beiden: `userld` statt `userId`, die klassische l/I-Verwechslung.

**Urteil:** tesseract mit **korrekt gesetzter Sprache** ist für Screen-Recordings mit Code und UI-Text schnell, genau und ohne jede zusätzliche Installation nutzbar. Der Sprachparameter ist nicht optional, sondern der entscheidende Hebel: mit `-l eng` auf deutschem Text zerfällt das Ergebnis. media-intel muss die OCR-Sprache aus der Konfiguration ziehen und, wenn ein Transkript existiert, aus dessen erkannter Sprache ableiten. Apple Vision ist die bessere zweite Meinung bei schwierigen Screenshots, aber macOS-only und damit kein Default für ein Open-Source-Projekt. Die schweren Modelle (PaddleOCR, Surya, docTR) lohnen sich für Dokumentenverarbeitung, nicht für Videoframes.

---

## 6. Metadaten, Fingerprints und Bildoperationen in Node

| Werkzeug | Fähigkeit | CLI-Aufruf | Ausgabeformat | media-intel-Tool | Aufwand | Lizenz | Quelle |
|---|---|---|---|---|---|---|---|
| **exiftool 13.55** | Alle Metadaten, gruppiert; bei Video GPS, Aufnahmegerät, Erstellungsdatum, Rotation | `exiftool -j -g1 v.mp4` | JSON nach Gruppen | `probe_media` (Anreicherung) | S, installiert | GPL/Artistic, 5,0k Stars | [exiftool.org](https://exiftool.org/), gemessen 29-08-2026 |
| MediaInfo | Container- und Codec-Details, Ausgabeformate JSON/XML/EBUCore | `brew install media-info` | Text/JSON | **nicht nötig** | S | BSD-2, brew 26.05 | [mediaarea.net](https://mediaarea.net/en/MediaInfo), 29-08-2026. Der exakte JSON-Schalter wurde in diesem Lauf **nicht** primär verifiziert. |
| chromaprint / `fpcalc` | Akustischer Fingerabdruck, findet identische und nahezu identische Aufnahmen | `fpcalc -json -length 120 datei.mp3`, weitere Optionen `-algorithm`, `-overlap`, `-rate`, `-channels`, `-raw` | JSON mit `duration` und `fingerprint` | Cache-Dedup, Duplikaterkennung | M, nicht installiert | LGPL-2.1-or-later, brew 1.6.1, 1,4k Stars | [Repo](https://github.com/acoustid/chromaprint), Optionen aus `src/cmd/fpcalc.cpp`, 29-08-2026 |
| **sharp / libvips** | Resize, Composite, SVG-Overlay, Rohpixel, Format-Konvertierung, alles ohne ffmpeg | Node-API: `sharp(buf).composite([{input: svgBuffer}]).toFile(...)` | Bild-Buffer | **`get_frames` Timestamp-Overlay, `get_video_grids` Kachel-Montage** | **S, Node-nativ** | Apache-2.0, npm 0.35.4, 93,5 Mio. Downloads/Woche, 32,6k Stars | [sharp.pixelplumbing.com](https://sharp.pixelplumbing.com/api-composite/), 29-08-2026 |

**Das ist die Antwort auf den `drawtext`-Fund.** media-intel braucht für Timestamp-Overlays keinen ffmpeg-Filter. `sharp` rendert einen SVG-Textblock und legt ihn per `composite()` auf den Frame. Das ist plattformunabhängig, hängt nicht am ffmpeg-Build des Nutzers und erlaubt zusätzlich, die Kacheln eines Contact Sheets selbst zu montieren, statt sie ffmpeg zu überlassen. Damit fällt der Zwang weg, alle Kacheln in einem Dekodierlauf zu erzeugen, und der schnelle Weg über N Seeks wird nutzbar.

Eine Einschränkung, die man kennen muss: `sharp` ist eine native Abhängigkeit mit vorkompilierten Binaries. Das widerspricht Entscheidung A2 nicht direkt (A2 betrifft ffmpeg-Bindings), aber es ist eine Abwägung, die in `architecture.md` gehört.

---

## 7. Audio-Analyse für Musik

| Werkzeug | Fähigkeit | CLI-Aufruf | Ausgabeformat | Aufwand | Lizenz | Quelle |
|---|---|---|---|---|---|---|
| ffmpeg `ebur128` / `loudnorm` | Lautheit I, LRA, True Peak | siehe Thema 1 | Text bzw. JSON | **S, schon da** | LGPL | gemessen 29-08-2026 |
| aubio | `aubioonset` (Onsets), `aubiotrack` (Beats), `aubiopitch` (Grundfrequenz), `aubionotes` (MIDI-artige Noten), `aubiomfcc`, `aubiocut` (schneidet an Onsets), `aubioquiet` | `aubio onset datei.wav -M 30ms`, `aubio pitch datei.wav -m mcomb` | Zeitstempel je Zeile | S, `brew install aubio` | **GPL-3.0-or-later**, brew 0.4.9, 3,8k Stars | [aubio.org/manual](https://aubio.org/manual/latest/cli.html), 29-08-2026 |
| librosa | `librosa.beat.beat_track` (BPM + Beat-Frames), `librosa.onset.onset_detect`, Chroma-Features als Basis für Tonart | Python | numpy-Arrays | M, Python | ISC, PyPI 1.0.0, 8,6k Stars | [librosa.org/doc/latest/api/beat.html](https://librosa.org/doc/latest/api/beat.html), 29-08-2026 |
| Essentia | `RhythmExtractor2013` liefert **`bpm`, `ticks`, `confidence`**, dazu `KeyExtractor` (Tonart und Skala mit Stärke), `PercivalBpmEstimator`, `Danceability`, `LoudnessEBUR128` | Python oder C++ | Werte | M, Python | **AGPL-3.0**, PyPI 2.1b6.dev1438, 3,7k Stars | [essentia.upf.edu](https://essentia.upf.edu/reference/std_RhythmExtractor2013.html), 29-08-2026 |
| keyfinder-cli / libKeyFinder | Tonart-Erkennung, DJ-tauglich | `keyfinder-cli datei.wav` | Tonart als Text | M, selbst bauen | **GPL-3.0-or-later**, brew `libkeyfinder` 2.2.8, Repo 181 Stars | [Repo](https://github.com/EvanPurkhiser/keyfinder-cli), 29-08-2026 |
| demucs | Stem-Trennung in Drums, Bass, Vocals, Other; `--two-stems=vocals` für Karaoke-Modus | `python3 -m demucs --two-stems=vocals datei.mp3` | WAV je Stem | **L, GPU-nah, minutenlang** | MIT, PyPI 4.1.0, 3,1k Stars | [Repo](https://github.com/adefossez/demucs), 29-08-2026 |

**Lohnt ein `analyze_audio`-Tool?** Ja, aber nur in einer schlanken Form. Der Sprung von "nichts" auf "Lautheit, Spitzenpegel, Rauschboden, Dynamikumfang, Stille-Karte, Wellenform als Bild" kostet **einen einzigen ffmpeg-Aufruf und 1,10 Sekunden für 5 Minuten Material** (gemessen). Das ist die günstigste neue Fähigkeit im ganzen Bericht.

BPM und Tonart sind eine andere Kategorie. Beide brauchen eine Fremdabhängigkeit, und die guten Kandidaten sind lizenzrechtlich unbequem: aubio ist GPL-3, Essentia ist AGPL-3, libKeyFinder ist GPL-3. Für ein Open-Source-Projekt unter permissiver Lizenz heißt das: nur als **optionale externe Binary** aufrufen, nie als Bibliothek einbinden. Prozessaufruf ist hier nicht nur bequem, sondern die lizenzrechtlich saubere Grenze. Demucs gehört nicht in einen MCP-Server, dessen Aufrufe synchron sind.

---

## Verwertung: Top 10 Fähigkeiten, die media-intel übernehmen sollte

### Phase 1

**1. `-ss` immer vor `-i` setzen, und Frames über N Prozesse holen statt über `fps=`.**
Gemessen: 0,14 s gegen 4,43 s für einen Frame bei Sekunde 280. 16 verstreute Frames über 16 Prozesse dauern 1,28 s, ein Contact Sheet über `fps=16/300` dagegen 2,99 s. Das ist keine Feinoptimierung, sondern der Unterschied zwischen einem responsiven und einem trägen Tool. Betrifft `get_frames`, `get_video_grids`, `analyze_moment`.

**2. Timestamp-Overlay über `sharp` statt `drawtext`.**
`drawtext` fehlt im Homebrew-ffmpeg (verifiziert). Roadmap Phase 1 Punkt 2 ist in der geplanten Form nicht lauffähig. `sharp` rendert SVG-Text und komponiert ihn auf den Frame, plattformunabhängig und ohne Abhängigkeit vom ffmpeg-Build des Nutzers. Als Nebeneffekt kann media-intel die Kacheln selbst montieren und damit Empfehlung 1 auch für Grids nutzen.

**3. `--vad` in whisper-cli einschalten, Default-Modell auf `large-v3-turbo-q5_0` heben.**
whisper.cpp bringt Silero-VAD mit (`--vad`, `-vt`, `-vsd`, `-vspd`). Das schneidet Stille vor der Inferenz weg, beschleunigt und verhindert Halluzinationen in Pausen. Der geplante Default `ggml-base-q5_1` (142 MiB Basis) ist für deutsche Sprachnotizen zu schwach; `large-v3-turbo-q5_0` kostet 547 MiB und liefert deutlich mehr. Wort-Timestamps über `-ml 1 -sow`, JSON über `-oj`.

**4. Untertitel-Extraktion und Kapitel in `probe_media` und `get_transcript` verdrahten.**
`ffmpeg -i datei -map 0:s:0 -f srt -` schreibt eine eingebettete Spur direkt auf stdout, verifiziert. `ffprobe -show_chapters -of json` liefert Kapitel als JSON, verifiziert. Beides ist Stufe 1 der in A7 beschriebenen Kette und kostet nichts. `probe_media` sollte zusätzlich melden, welche Untertitelspuren und Kapitel existieren, damit der Agent gar nicht erst transkribieren lässt.

**5. Audio-Kennzahlen in einem Durchlauf: `silencedetect` + `ebur128` + `astats`, dazu `loudnorm` mit `print_format=json`.**
Gemessen: 1,10 s für 5 Minuten, alle drei Filter in einer Kette mit `-vn -f null -`. Ergebnis ist eine Stille-Karte plus Lautheit plus Rauschboden. `loudnorm=...:print_format=json` liefert dieselben Lautheitswerte als fertiges JSON, ohne Log-Parsing. Gehört in `probe_media` als optionales `deep`-Flag und ist die Grundlage von `analyze_audio`.

### Phase 2

**6. `get_scenes` aus drei ffmpeg-Filtern bauen, nicht aus PySceneDetect.**
`scdet` liefert `lavfi.scd.time` und `lavfi.scd.score` je Schnitt, `blackdetect` liefert Schwarzblenden (verifiziert: `black_start:10 black_end:15 black_duration:5`), `freezedetect` liefert Standbilder (verifiziert: `freeze_start: 5`). Zusammen ergibt das eine Schnittliste plus die für Screen-Recordings entscheidende Information, wo nichts passiert. Keine Python-Abhängigkeit, im Sinne von A2. Zusätzlich `ffprobe -show_packets` für Keyframe-Zeitstempel ohne Dekodierung, damit `get_frames` auf Keyframes einrasten kann.

**7. yt-dlp-Heatmap als Signal für interessante Stellen nutzen.**
Verifiziert am 29-08-2026: `yt-dlp -J` liefert für YouTube-Videos ein `heatmap`-Feld mit 100 Einträgen der Form `{start_time, end_time, value}`. Das ist die Publikumsmeinung darüber, welche Stellen wiederholt angesehen werden, kostenlos und ohne Download. Für `understand_media` und `get_video_grids` ist das eine bessere Abtast-Heuristik als gleichmäßige Verteilung. Dazu `chapters` und SponsorBlock-Kategorien (`sponsor`, `intro`, `outro`, `selfpromo`, `hook`, `poi_highlight`) als weitere Struktur, ebenfalls gratis.

**8. Frame-Deduplikation über pHash vor dem Bau des Contact Sheets.**
`sharp-phash` (MIT, 168k Downloads/Woche) hasht die Kacheln in Node, ohne Python. Nahezu identische Kacheln fliegen raus und werden durch Frames aus unterabgetasteten Bereichen ersetzt. Bei Screen-Recordings mit langen statischen Passagen ist das direkt gesparter Vision-Token-Verbrauch, also genau das Ziel von Entscheidung A9. PySceneDetect zeigt mit `detect-hash`, dass der Ansatz für Schnitterkennung trägt.

**9. OCR-Sprache erzwingen und Wortboxen ausliefern.**
Gemessen: derselbe deutsche Text liefert mit `-l deu` ein sauberes Ergebnis und mit `-l eng` unbrauchbaren Zeichensalat. `tesseract bild.png - -l deu --psm 6 tsv` gibt Wortboxen mit Konfidenz in 0,05 s. `extract_text` sollte die Sprache aus der Konfiguration oder aus der vom Transkript erkannten Sprache setzen, das TSV parsen und Boxen plus Konfidenz im `structuredContent` zurückgeben, damit ein Agent Fundstellen im Bild verorten kann. Niedrige Konfidenz gehört in `warnings`.

**10. `analyze_audio` als schlankes eigenes Tool, mit Wellenform als Bild.**
`showwavespic` erzeugt die Wellenform des ganzen Tracks als ein PNG von 1,2 KB (gemessen), `showspectrumpic` das Spektrogramm mit 71 KB. Für einen Agenten ist ein Bild der Lautstärke über die Zeit oft aussagekräftiger als eine Zahlenliste, und es kostet einen Bruchteil eines Frames an Vision-Tokens. Zusammen mit den Werten aus Empfehlung 5 ergibt das ein vollständiges `analyze_audio` ohne jede neue Abhängigkeit.

### Phase 3, bewusst zurückgestellt

- **Parakeet TDT 0.6B v3** als zweites ASR-Backend über sherpa-onnx. 25 Sprachen inklusive Deutsch, automatische Spracherkennung, Wort-Timestamps, cc-by-4.0. Attraktiv, aber ein zweiter Modell-Stack.
- **Sprecher-Diarisierung** über WhisperX oder pyannote. Beide brauchen ein HF-Token (`speaker-diarization-3.1` ist `gated: auto`), was Entscheidung A11 zum Key-Handling berührt. Für Ein-Sprecher-Voice-Notes ohne Nutzen.
- **BPM und Tonart** über aubio oder Essentia, ausschließlich als optionale externe Binary. aubio ist GPL-3, Essentia AGPL-3, libKeyFinder GPL-3. Ein Prozessaufruf hält die Lizenzgrenze sauber, ein Bibliotheks-Einbau nicht.
- **chromaprint `fpcalc`** für Duplikaterkennung im Cache, wenn dieselbe Aufnahme über verschiedene Quellen hereinkommt. LGPL-2.1, `-json`-Ausgabe.
- **Demucs** gehört nicht in einen synchronen MCP-Server.

### Ausdrücklich nicht empfohlen

- **TransNetV2**: letzter Commit 04-12-2023, kalt.
- **`blockhash-js` (Original-Repo)**: letzter Commit 27-07-2020, kalt. Das npm-Paket `blockhash-core` lebt, `sharp-phash` ist die bessere Wahl.
- **Node-Wrapper für yt-dlp**: `execa` plus direkter Prozessaufruf ist präziser steuerbar und bringt keine zweite Binary mit.
- **MediaInfo**: liefert gegenüber `ffprobe` plus `exiftool` nichts Entscheidendes hinzu.
- **PaddleOCR, Surya, docTR** für Videoframes: schwere Abhängigkeiten für ein Dokumentenproblem, das media-intel nicht hat. Bei Surya zusätzlich die Gewichte-Lizenz beachten (frei nur unter 5 Mio. USD Umsatz und Funding).

---

## Anhang: offene Punkte und Unschärfen

1. Der exakte JSON-Schalter von MediaInfo wurde in diesem Lauf nicht aus einer Primärquelle verifiziert. Da MediaInfo ohnehin nicht empfohlen wird, ist das folgenlos.
2. Die Qualität von Moonshine für Deutsch wurde nicht gemessen, nur die Lizenz (MIT, auch für die Gewichte) und die Verfügbarkeit.
3. `faster-whisper` hatte am 29-08-2026 seit dem 19-11-2025 keinen Push mehr. Das Projekt ist nicht tot, aber die Frequenz ist gegenüber whisper.cpp (Push am selben Tag) deutlich niedriger.
4. Alle Laufzeitmessungen stammen von synthetischem Material (`testsrc2` mit `sine`). Reale Videos mit hoher Bewegungsdichte dekodieren langsamer; die Verhältnisse zwischen den Verfahren bleiben davon unberührt.
5. Die Heatmap-Prüfung lief gegen ein einzelnes YouTube-Video. Das Feld existiert laut `extractor/common.py` generell, ist aber nicht bei jedem Video gefüllt, und `automatic_captions` war bei diesem Video leer.
