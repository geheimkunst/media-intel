# Fähigkeiten-Karte media-intel

> Stand 29-08-2026, nach der zweiten Research-Runde (`docs/research/harvest-*.md`, `spike-ffmpeg-filters.md`). Jede Zeile: was der Agent können soll, welches Tool es liefert, womit, in welcher Phase. Aufwand S = Stunden, M = ein Tag, L = mehrere Tage.

## 1. Tool-Inventar (Ziel)

| Tool | Stufe | Liefert | Womit | Phase | Aufwand | Status |
|---|---|---|---|---|---|---|
| `doctor` | 0 | Welche Binaries in welcher Version da sind, Cache-Größe, welche Fähigkeit geprüft oder nur vermutet ist | Prozessaufrufe `--version` | 1 | S | offen |
| `probe_media` | 1 | kind, Dauer, Streams, Untertitelspuren, Kapitel, Tags, Warnungen, `suggested_next`; mit `deep: true` Stille-Karte, Lautheit, Rauschboden | ffprobe; ffmpeg `silencedetect` + `ebur128` + `astats` in einer Kette (1,1 s für 5 min) | 1 | S | Basis fertig, `deep` offen |
| `fetch_media` | 1 | lokale Pfade für Video, Audio, Untertitel (manuell und auto, Sprachwahl), Thumbnail, Infojson; `--download-sections` für Ausschnitte, kleinste Auflösung für Frames | yt-dlp als Prozess, `--no-playlist` erzwungen, Cookies nur aus Datei | 1 | M | offen |
| `get_engagement` | 1 | view/like/comment_count, Kapitel, Heatmap "most replayed" (100 Einträge), SponsorBlock-Kategorien, optional Top-Kommentare (max 50) | dieselbe Infojson aus `yt-dlp -J`, kein Download | 1 | S | offen |
| `get_transcript` | 3 | Segmente mit Zeit, Format text/srt/json, `window`, Cursor-Pagination, `transcription_source`, erkannte Sprache | Kette: eingebettete Spur (`ffmpeg -map 0:s`) > Sidecar-VTT > yt-dlp-Untertitel > whisper-cli (`--vad`, `-oj`, `-ml 1` für Wort-Timestamps, Default `large-v3-turbo-q5_0`) > OpenAI/Groq mit Cost-Preflight | 1 | M | offen |
| `detect_language` | 3 | Sprache der ersten 30 s, Konfidenz | whisper-cli Sprach-Erkennung auf Ausschnitt | 1 | S | offen |
| `get_frames` | 3 | Einzelbilder zu Timestamps, `frame_format` jpeg/png/webp, optional Region-Crop, Timestamp-Overlay | ffmpeg mit `-ss` vor `-i` (0,14 s statt 4,4 s), ein Prozess pro Frame; Overlay per `sharp` (drawtext fehlt im Homebrew-Build) | 1 | S | offen |
| `get_video_grids` | 3 | Contact Sheets mit `cells` (Default 64) und `grid_long_edge` (1568, Option 2576), `max_frames` (Default 512), Manifest `{grid, cell, t_s}` im structuredContent, Pagination | Frames einzeln holen, pHash-Dedup (`sharp-phash`), Montage in `sharp` | 1 | M | offen |
| `extract_text` | 3 | OCR-Text mit Wortboxen und Konfidenz, Sprache erzwungen (`deu+eng`), kein Downscaling, Region-Crop | tesseract `tsv` (0,05 s pro Bild), ffmpeg `crop` | 1 | S | offen |
| `understand_media` | 2 | Transkript zuerst, dann Grids nur für Fenster, die visuell belegt werden müssen (Transcript-first plus Lazy Visual Verification), unter `max_total_chars` | Orchestrierung der Stufe-3-Tools, Heatmap und Szenen als Platzierungssignal | 2 | M | offen |
| `get_scenes` | 3 | Schnittliste mit Score, Schwarzblenden, Standbilder, Schnitte/min, mittlere Shot-Länge, Hook-Fenster 0 bis 10 s | ffmpeg `scdet` (threshold 10) + `blackdetect` + `freezedetect`; Keyframe-Zeiten aus `ffprobe -show_packets`; Fallback gleichmäßig | 2 | S | offen |
| `analyze_moment` | 3 | Burst-Frames um einen Zeitpunkt, Transkript-Ausschnitt, OCR optional | `get_frames` + `get_transcript` + `extract_text` | 2 | S | offen |
| `diff_frames` | 3 | Rechtecke, in denen sich zwischen zwei Zeitpunkten etwas geändert hat, optional Diff-Bild | `pixelmatch` (reines JS) | 2 | S | offen |
| `analyze_audio` | 3 | Lautheit (LUFS, LRA), Stille-Karte, Rauschboden, Wellenform und Spektrogramm als Bild | ffmpeg `ebur128`, `loudnorm print_format=json`, `showwavespic` (1,2 KB PNG), `showspectrumpic` | 2 | S | offen |
| `get_speakers` | 3 | Sprecher-Segmente `speaker_id, start_s, end_s` | `sherpa-onnx` als optionales Binary, sonst bezahlte API mit Diarisierung | 2 | M | offen |
| `probe_image` | 1 | EXIF/GPS, pHash, QR/Barcodes | `exiftool-vendored`, `sharp-phash`, `zxing-wasm` | 2 | S | offen |
| `media_search` | 4 | Volltext über alle Transkripte im Cache, später semantisch | `node:sqlite` FTS5 (in Node 22.23 vorhanden), später `sqlite-vec` + `@huggingface/transformers` | 2 | M | offen |
| `list_cached` | 0 | Was im Cache liegt, mit Fingerprint und Alter | Cache-Index | 2 | S | offen |
| MCP-Prompts | | `tldr`, `key_moments`, `quotables`, `hook_breakdown` mit festen Wortzahlen und explizitem Zeitformat | fabric-Muster | 2 | S | offen |

Bewusst nicht: Video-Schnitt, Shorts-Erzeugung, eigener Vektor-Index als zweite Wahrheit neben Akasha (nur FTS als Introspektion), Obsidian-Logik, Desktop-Aufnahme, Gemini-Video nativ als Default (300 Tokens pro Sekunde, Faktor 35 gegenüber Grids), eigene Diarisierungs-Modelle, PySceneDetect als Pflicht, node-av.

## 2. Verträge, die für alle Tools gelten

| Vertrag | Inhalt | Phase |
|---|---|---|
| Untrusted Text | Jeder Text aus einem Medium (Transkript, OCR, Untertitel, Kommentare, Titel) steht in `structuredContent` in einem Feld mit `source_trust: "untrusted"`, im Textblock zwischen festen Markern, mit Längengrenze 20.000 Zeichen pro Feld und `truncated: true` | 1 |
| Zeitfenster-Pagination | `total_duration_s`, `window_start_s`, `window_end_s`, `has_more`, `next_window` in `get_transcript`, `get_video_grids`, `get_scenes` | 1 |
| Zeit ist Daten | Timestamps stehen im Manifest, nie nur im Bild; Tool-Beschreibung sagt: Zeiten aus dem Manifest lesen | 1 |
| Budget | `max_frames` (Default 512), `max_total_chars`, `max_comments` (50), `max_chars` in OCR | 1 |
| Cost-Preflight | Vor jedem bezahlten Aufruf Schätzung gegen `MEDIA_INTEL_MAX_COST_USD` (0,10); gesetzter Key allein löst nichts aus; Schätzung steht im Ergebnis | 1 (mit erstem bezahlten Backend) |
| Fehler | `isError` mit `code` und `Hint:`; `inconclusive` statt `ok`, wenn kein Urteil möglich | 1 (fertig) |
| Sicherheit | 15-Punkte-Liste in `harvest-gaps.md` Abschnitt 9: SSRF-Block nach jedem Redirect, nur http/https/file, realpath-Prüfung, Dateityp aus Inhalt, Container-Grenzen (4 h, 20 Streams, 8K), Prozessgruppe töten, nie `shell: true`, Secrets in Ausgaben maskieren, Cache 0700 | 1 bis 3 |

## 3. Geänderte Defaults (gegenüber Architektur vom Vormittag)

| Was | Vorher | Jetzt | Grund |
|---|---|---|---|
| Whisper-Modell | `ggml-base-q5_1` | `large-v3-turbo-q5_0` (547 MiB) mit `--vad` | base ist für deutsche Voice-Notes zu schwach; VAD verhindert Halluzinationen in Pausen |
| Timestamp-Overlay | ffmpeg `drawtext` | `sharp` SVG-Composite, Default aus, Manifest ist Pflicht | drawtext fehlt im Homebrew-ffmpeg |
| Grid-Erzeugung | ffmpeg `fps=` + `tile` | Einzelframes mit `-ss` vor `-i`, Montage in `sharp` | 0,14 s gegen 4,4 s pro Frame; ermöglicht Dedup und Heatmap-Abtastung |
| Grid-Parameter | `max_grids`, `tile_width` | `cells` (64), `grid_long_edge` (1568/2576), `max_frames` (512) | Claude rechnet in 28-px-Kacheln mit Deckel 1568 px lange Kante; 64 Frames als Grid rund 1.900 Tokens statt 12.500 |
| Szenen | PySceneDetect | ffmpeg `scdet` + `blackdetect` + `freezedetect` | keine Python-Kette, Filter im Build vorhanden |
| OCR | Phase 2 | Phase 1, `deu+eng`, kein Downscaling, TSV mit Boxen | Entwickler-Use-Case (Terminal, Fehlertexte) funktioniert sonst nicht; `-l eng` liefert auf deutschem Text Salat |
| Sprach-Erkennung | Phase 2 | Phase 1 (`detect_language`) | sonst greift die Transkriptions-Kette zum falschen Modell |
| Lange Läufe | MCP Tasks in Phase 3 | Pagination in Phase 1, Tasks in Phase 3 nur für `understand_media` | Pagination deckt die meisten Fälle, kein Referenz-Server hat Tasks |
| Bilder pro Ergebnis | inline | inline bei einem Grid, `resource_link` ab zwei Grids (Phase 3) | Spec 2026-07-28, von keinem der 16 Server genutzt |

## 4. Was auf deinem Mac fehlt

| Binary | Nötig für | Installation |
|---|---|---|
| `whisper-cli` | `get_transcript` lokal, `detect_language` | `brew install whisper-cpp`, dann Modell `ggml-large-v3-turbo-q5_0.bin` nach `~/.cache/media-intel/models/` |
| `sherpa-onnx` | `get_speakers` (Phase 2) | optional, später |
| `fpcalc` | Cache-Duplikate (Phase 3) | `brew install chromaprint`, optional |

Vorhanden: ffmpeg 8.1.2 (ohne drawtext), yt-dlp 2026.07.04, tesseract 5.5.3, exiftool 13.55, scenedetect 0.7.1 (wird nicht gebraucht).
