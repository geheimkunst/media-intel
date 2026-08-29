# Ernte: agentische Medien-Projekte

> Stand 29-08-2026. Auftrag: populäre Open-Source-Projekte finden, die für agentische Nutzung gedacht sind, und daraus Fähigkeiten, Tool-Designs, Prompts und Heuristiken für media-intel ernten.
>
> **Methode und Verifikationsstand.** Stern- und Aktivitätszahlen stammen aus der GitHub-REST-API, abgerufen am 29-08-2026 (`search/repositories` und `repos/{owner}/{repo}`, Feld `pushed_at`). READMEs wurden roh von `raw.githubusercontent.com` gezogen und ausgewertet, nicht aus dem Gedächtnis zitiert. Preise stammen von den Anbieter-Seiten, abgerufen am 29-08-2026. ffmpeg-Defaults wurden lokal gegen ffmpeg 8.1.2 geprüft. Die vier bereits analysierten Referenz-Repos (dymoo/media-understanding, guimatheus92/mcp-video-analyzer, bradautomates/claude-video, taoufik123-collab/claude-watch) sind hier bewusst nicht erneut aufgeführt, sie tauchen nur als Vergleichspunkt auf.
>
> Hinweis zur Toolchain: `gh` scheitert in dieser Umgebung an einem ungültigen `GITHUB_TOKEN`. Alle Aufrufe liefen als `env -u GITHUB_TOKEN gh api ...`.

---

## 1. MCP-Server für Medien

### 1.1 Die relevanten Server

| Projekt | Stars | Sprache | Was es kann | Was wir übernehmen | Quelle + Datum |
|---|---|---|---|---|---|
| [jordanrendric/claude-video-vision](https://github.com/jordanrendric/claude-video-vision) | 1275 | TypeScript | Claude-Code-Plugin mit 6 MCP-Tools: `video_watch`, `video_analyze`, `video_detail`, `video_info`, `video_configure`, `video_setup`. Drei Audio-Backends (Gemini, lokales Whisper, OpenAI), Frames immer per ffmpeg. | **Provenienz-Feld** `transcription_source` (`youtube_subtitles`, `youtube_auto_captions`, ...). **Setup-Tool** als eigenes Tool statt README-Prosa. **Drill-down-Tool** (`video_detail`) auf gecachte Momente. Konfig-Defaults `frame_resolution: 512`, `max_frames: 100`, `default_fps: "auto"`. | GitHub-API + README, 07-08-2026 letzter Push, abgerufen 29-08-2026 |
| [oxbshw/watch-skill](https://github.com/oxbshw/watch-skill) | 321 | Python | 39 MCP-Tools plus CLI, REST-API und Adapter für LangChain, CrewAI, OpenAI Agents SDK, LlamaIndex, AutoGen. Vier Modi: Watch, Watch live, Remember, Verify, Operate. | **Vier Ehrlichkeits-Regeln** (siehe 6.2): Identität folgt den Bytes, nicht dem Pfad; ein konfigurierter API-Key ist keine Zustimmung; ein fehlendes Urteil ist `inconclusive`, kein `pass`; Fähigkeiten werden gemessen, nicht behauptet (`capture-capabilities`). | README, letzter Push 29-08-2026 |
| [mupozg823/timecode-agent](https://github.com/mupozg823/timecode-agent) | 53 | Python | 28 Kommandos, darunter `ingest`, `brief`, `capture`, `keyframes`, `filmstrip`, `highlights`, `scenes`, `ocr`, `faces`, `diarize`, `beats`, `export`, `clip`, `wiki`. Append-only Evidence-Ledger, EDL/FCPXML/OTIO-Export. | **Transcript-first plus Lazy Visual Verification** als Architekturprinzip. Konkrete Defaults: `keyframes --budget 12`, `--min-gap 1.0`, `filmstrip -n 9 --cols 3`, `highlights --top 5 --window 0.5`, `scenes --threshold 0.3`, Schärfe-Gate über Sobel-Kantenenergie im Fenster `±0.3 s`. | README, letzter Push 06-08-2026 |
| [kevinwatt/yt-dlp-mcp](https://github.com/kevinwatt/yt-dlp-mcp) | 276 | TypeScript | yt-dlp-Wrapper mit Präfix `ytdlp_` für alle Tools (`ytdlp_list_subtitle_languages`, `ytdlp_download_video_subtitles`, ...). Kommentar-Abruf mit `root_threads`, `reply_comments`, `markdown_tree`. | **Namens-Präfix gegen Kollisionen** in Multi-Server-Setups. **Pagination-Felder** `has_more`, `next_offset`, `response_format`. | README, letzter Push 11-08-2026 |
| [kimtaeyoon83/mcp-server-youtube-transcript](https://github.com/kimtaeyoon83/mcp-server-youtube-transcript) | 586 | TypeScript | Der meistgenutzte reine Transkript-Server. Parameter `include_timestamps`, `max_tokens`, `strip_ads`; zusätzlich `analyze_video`. | **`max_tokens` als Tool-Parameter** (nicht nur Server-Config) und **`strip_ads`** als Reinigungs-Schalter. | README, letzter Push 21-07-2026 |
| [samson-art/transcriptor-mcp](https://github.com/samson-art/transcriptor-mcp) | 19 | TypeScript | `get_transcript`, `get_raw_subtitles`, `get_available_subtitles`, `get_video_chapters`, `get_video_frame`, `get_video_info`, `get_playlist_transcripts`, `search_videos`. | **Sauberste Pagination im Feld:** `start_offset`, `end_offset`, `response_limit`, `next_cursor`, `is_truncated`, `total_length`. Genau das Muster, das ein langes Transkript agentenfreundlich macht. | README, letzter Push 27-08-2026 |
| [sunriseapps/imagesorcery-mcp](https://github.com/sunriseapps/imagesorcery-mcp) | 328 | Python | 17 Bild-Tools: `blur`, `crop`, `detect`, `draw_*`, `fill`, `find`, `get_metainfo`, `ocr`, `overlay`, `resize`, `rotate`, plus `config`. | **`find` als semantische Bildsuche** und **`get_metainfo`** als billiger Vorab-Schritt. Bestätigt unser `probe_media` vor allem anderen. | README, letzter Push 19-05-2026 |
| [Battam1111/omniseek](https://github.com/Battam1111/omniseek) | 47 | Python | Perception-MCP mit `omniseek_view` (Bilder, Dokumentfiguren, Video-Frames), `omniseek_transcribe` (lokal, zweisprachig, nach Zeitstempel schneidbar), plus Evidenzgraph. | **`transcribe` sliceable by timestamp** als Erstbürger-Parameter, nicht als Nachgedanke. Bearer-Token wird beim ersten Start ausgegeben, nicht in eine Datei geschrieben. | README, letzter Push 25-08-2026 |
| [0xchamin/mcptube](https://github.com/0xchamin/mcptube) | 152 | Python | `add_video`, `ask_video`, `ask_videos`, `classify_video`, `discover_videos`, `generate_report`, `get_frame`, `get_frame_by_query`, `wiki_*`. | **`get_frame_by_query`**: Frame per Beschreibung statt per Zeitstempel holen. Interessante Ergänzung zu `get_frames(timestamps[])`. | README, letzter Push 13-04-2026 |
| [shadoprizm/videolens](https://github.com/shadoprizm/videolens) | 3 | Python | `analyze_video`, `ask_video`, `get_frames`, `get_timeline`, `get_transcript`, `list_cached`, `production_recipe`. | **`get_timeline`** als eigenes Tool (Timeline getrennt vom Transkript) und **`list_cached`** als Cache-Introspektion für den Agenten. | README, letzter Push 20-08-2026 |
| [KyaniteLabs/kinocut](https://github.com/KyaniteLabs/kinocut) | 128 | Python | 196 MCP-Tools / 167 CLI-Kommandos für Video-Schnitt. Dry-run-Plan (`video_intent`, `workflow-plan --dry-run`), Receipts, Lineage, `video_review_run` mit blackdetect und LUFS. | **Plan-vor-Mutation** (`--dry-run --save-plan`) und **Review-Gate** vor Freigabe. Die Tool-Zahl selbst ist eine Warnung, siehe "Nicht übernehmen". | README, letzter Push 25-08-2026 |
| [video-creator/ffmpeg-mcp](https://github.com/video-creator/ffmpeg-mcp) | 144 | Python | `get_video_info`, `clip_video`, `concat_videos`, `extract_frames_from_video`, `overlay_video`, `scale_video`, `find_video_path`, `play_video`. | **`find_video_path`**: Der Agent muss den Pfad nicht raten. Für uns relevant, wenn `source` mehrdeutig ist. | README, letzter Push 20-05-2026 |
| [misbahsy/video-audio-mcp](https://github.com/misbahsy/video-audio-mcp) | 83 | Python | 22 Schnitt-Tools plus `health_check` und `remove_silence`. | **`health_check` als Tool** (Binaries, Versionen). **`remove_silence`** als Konzept für unsere Stille-Erkennung. | README, letzter Push 24-05-2025 |
| [arcaputo3/mcp-server-whisper](https://github.com/arcaputo3/mcp-server-whisper) | 57 | Python | `transcribe_audio`, `transcribe_with_enhancement`, `chat_with_audio`, `compress_audio`, `convert_audio`, `list_audio_files`, `get_latest_audio`. | **`compress_audio` als eigenes Tool**, weil die 25-MB-Grenze der APIs sonst hart zuschlägt. **`get_latest_audio`** als Bequemlichkeits-Einstieg. | README, letzter Push 02-05-2026 |
| [montezuma-p/harken](https://github.com/montezuma-p/harken) | 12 | Rust | Ein 13-MB-Binary, `transcribe_file`, `transcribe_status`, `transcribe_whatsapp_export`. | **`transcribe_status`**: getrennte Status-Abfrage für lange Läufe, das arme-Leute-Tasks-Muster. | README, letzter Push 25-08-2026 |
| [mudassar531/hearsay](https://github.com/mudassar531/hearsay) | 18 | Python | "crawl4ai für Video und Audio", saubere Transkripte mit `word_timestamps`. | Positionierung: ein Tool, ein Zweck. Wort-Zeitstempel als Default, nicht als Option. | README, letzter Push 26-08-2026 |
| [supadata-ai/mcp](https://github.com/supadata-ai/mcp) | 62 | TypeScript | Offizieller Anbieter-Server für Video- und Web-Scraping. | Referenz für den bezahlten Fallback-Pfad, wenn yt-dlp an einer Plattform scheitert. | GitHub-API, letzter Push 09-06-2026 |

### 1.2 Was diese Liste über den Markt sagt

Es gibt sehr viele Transkript-Server (mindestens 15 mit YouTube-Fokus) und sehr wenige, die Bild und Ton zusammen budgetiert an ein Modell liefern. Der eigentliche Wettbewerb für media-intel sind claude-video-vision (1275 Sterne, TypeScript, MCP) und watch-skill (321 Sterne, Python, 39 Tools). Beide sind jünger als sechs Monate. Das Feld ist offen, aber nicht leer.

Zweite Beobachtung: die Server mit den meisten Sternen sind die einfachsten. `mcp-server-youtube-transcript` hat drei Parameter und 586 Sterne, kinocut hat 196 Tools und 128 Sterne.

---

## 2. Agent-Skills, Plugins und Prompt-Muster

| Projekt | Stars | Sprache | Was es kann | Was wir übernehmen | Quelle + Datum |
|---|---|---|---|---|---|
| [danielmiessler/Fabric](https://github.com/danielmiessler/Fabric) | 43555 | Go | 255 Patterns, davon 25 medien-nah: `extract_wisdom` (plus `_agents`, `_dm`, `_nometa`, `_with_attribution`), `create_video_chapters`, `youtube_summary`, `summarize_lecture`, `extract_videoid`, `extract_latest_video`, `summarize_micro`. | **Die Sektionsstruktur von `extract_wisdom`** als Report-Vorlage: SUMMARY (25 Wörter), IDEAS (20 bis 50, je exakt 16 Wörter), INSIGHTS (10 bis 20), QUOTES (15 bis 30, wörtlich, mit Sprecher), HABITS, FACTS, REFERENCES, ONE-SENTENCE TAKEAWAY (15 Wörter), RECOMMENDATIONS. **Feste Wortzahlen sind der Trick**, sie verhindern Geschwafel. Aus `create_video_chapters`: der Prompt nennt explizit das Eingabe-Zeitformat `HH:MM:SS.mmm` und weist darauf hin, dass es nicht das Ausgabeformat ist. | Repo-Tree + `data/patterns/*/system.md`, abgerufen 29-08-2026 |
| [michalparkola/tapestry-skills](https://github.com/michalparkola/tapestry-skills) | 530 | Shell | Claude-Code-Skills, die Quellen herunterladen (Artikel, PDFs, YouTube-Transkripte) und in eine Wissensablage schreiben. | Trennung Skill (Wohin schreiben) und Werkzeug (Wie extrahieren). Bestätigt unsere Entscheidung, Obsidian-Logik nicht in den Server zu legen. | GitHub-API, letzter Push 11-03-2026 |
| [JimmySadek/youtube-fetcher-to-markdown](https://github.com/JimmySadek/youtube-fetcher-to-markdown) | 461 | HTML | Claude-Code-Skill: YouTube-Video zu Obsidian-fähigem Markdown mit vollen Metadaten. | Der Metadaten-Block (Kanal, Datum, Dauer, URL, Kapitel) gehört in `structuredContent`, damit ein Skill ihn ohne Parsing rendern kann. | GitHub-API, letzter Push 03-08-2026 |
| [andrewii23/ii23-skills](https://github.com/andrewii23/ii23-skills) | 9 | Python | `video-understand`: packt Frames in Kachelbilder, gepaart mit Zeitstempel-Transkript. Belegt seine Zahlen. | **Die wichtigste einzelne Erkenntnis dieser Recherche**, siehe Abschnitt 3.2. Plus die Regel: Zeitstempel im Antworttext werden aus `manifest.json` gelesen, nie aus dem Bild abgelesen. | README und `docs/video-understand.md`, letzter Push 12-08-2026 |
| [charlesdove977/watchvideo](https://github.com/charlesdove977/watchvideo) | 16 | JavaScript | Lokaler Video-Analyzer als Skill. Schreibt einen Ordner mit `transcript.md`, `analysis.md`, `hook-rewrites.md`, `media/`, `audio/` (16 kHz mono, im Hook-Modus auf 20 s getrimmt), `frames/` (Contact Sheets). Eigene Frameworks für Hook-Taxonomie und Format-Klassifikation. | **Der Hook-Modus:** nur die ersten 20 Sekunden, ein einziges Contact Sheet. Für Social-Media-Analyse der mit Abstand billigste sinnvolle Lauf. Und die Trennung `frameworks/` (Analysemethode) von `templates/` (Ausgabeform). | README, letzter Push 18-08-2026 |
| [drpwchen/lecture-to-notes](https://github.com/drpwchen/lecture-to-notes) | 100 | Python | Vorlesungsaufnahmen zu strukturierten, belegten Notizen plus synchronem HTML-Viewer (Video, Transkript, Notizen nebeneinander). | Der Viewer als Nebenprodukt: eine einzelne HTML-Datei, die Transkript und Video koppelt, ist die billigste Form von Nachprüfbarkeit. Kandidat für einen Skill, nicht für den Server. | GitHub-API, letzter Push 07-08-2026 |
| [jftuga/transcript-critic](https://github.com/jftuga/transcript-critic) | 35 | Shell | Claude-Code-Skill: whisper.cpp-Transkription plus strukturierte kritische Analyse. | Bestätigt whisper.cpp als Skill-taugliche Basis ohne Python-Abhängigkeiten. | GitHub-API, letzter Push 30-04-2026 |
| [calesthio/generative-media-skills](https://github.com/calesthio/generative-media-skills) | 141 | Python | Skills für Bild, Video, Audio, Voice. | Gegenrichtung (Erzeugung statt Verstehen). Für uns nur als Abgrenzung relevant. | GitHub-API, letzter Push 14-07-2026 |
| [ur-grue/autopunk-media-skills](https://github.com/ur-grue/autopunk-media-skills) | 27 | Python | 400+ Skills und 9 Agenten für Medienberufe (Journalismus, Produktion, Podcast). | Beleg dafür, dass die Zielgruppe existiert. Kein technischer Ertrag. | GitHub-API, letzter Push 30-07-2026 |
| [chubbyguan/chubbyskills](https://github.com/chubbyguan/chubbyskills) | 649 | Python | 13 Skills für chinesische Plattformen, "Untertitel zuerst, GPU-frei". | Der explizite Verkaufspunkt "Untertitel zuerst, damit keine GPU nötig ist" ist genau unsere Backend-Kette A7. Gute Bestätigung. | GitHub-API, letzter Push 19-08-2026 |
| [joeseesun/qiaomu-anything-to-notebooklm](https://github.com/joeseesun/qiaomu-anything-to-notebooklm) | 5843 | Python | Claude-Skill, der Mehrquellen-Inhalte für NotebookLM aufbereitet. | Der sternstärkste Medien-Skill überhaupt. Lehre: der Wert liegt im Zielformat, nicht in der Extraktion. | GitHub-API, letzter Push 28-04-2026 |

Obsidian-Plugins mit Video-Ingest existieren zahlreich (TubeSage, Lumen YouTube, obsidian-tubescribe und ein Dutzend weitere), alle unter 10 Sternen. Kein Muster, das wir brauchen. Der Markt hat sich von Obsidian-Plugins zu Agent-Skills verschoben.

---

## 3. Video-Modelle und lokale Runtimes

### 3.1 Wer kann was

| Projekt | Stars | Sprache | Video-Fähigkeit | Empfohlene Abtastung | Quelle + Datum |
|---|---|---|---|---|---|
| [QwenLM/Qwen3-VL](https://github.com/QwenLM/Qwen3-VL) | 19858 | Jupyter | Video nativ. Frames oder Videodatei, Zeitstempel werden aus der Abtastrate abgeleitet. `resized_height`/`resized_width` runden auf Vielfache von 32 (Qwen3-VL) bzw. 28 (Qwen2.5-VL); alternativ `min_pixels`/`max_pixels`. | `sample_fps: 1` in den Beispielen. Unter vLLM: **Default `fps=2` mit `do_sample_frames=True`**, konfigurierbar über `extra_body`. Der Qwen2.5-VL-Repo leitet inzwischen auf Qwen3-VL um. | README, letzter Push 30-01-2026 |
| [Blaizzy/mlx-vlm](https://github.com/Blaizzy/mlx-vlm) | 5437 | Python | Bild, Audio und Video auf Apple Silicon. | Empfohlene Praxis in der Literatur: 1 fps oder Shot-Detection als Abtastregel; naives Frame-für-Frame sprengt Tokens und I/O. | GitHub-API, letzter Push 28-08-2026; [MACGPU-Analyse 2026](https://macgpu.com/en/blog/2026-0409-mac-multimodal-mlx-resolution-batch-remote-node-matrix.html) |
| [ollama/ollama](https://github.com/ollama/ollama) | 179706 | Go | **Kein natives Video.** Bilder als base64 im `images`-Array an `/api/chat`. Mehrbild-Unterstützung modellabhängig. | Für uns heißt das: Ollama bekommt Grids, keine Videos. Genau unser Design. | GitHub-API, letzter Push 29-08-2026; [DeepWiki Multimodal](https://deepwiki.com/ollama/ollama/7.3-multimodal-and-vision-support) |
| [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) | 126193 | C++ | Multimodal über mtmd, Bilder. Video nur als Frame-Folge. | Grids. | GitHub-API, letzter Push 29-08-2026 |
| [vllm-project/vllm](https://github.com/vllm-project/vllm) | 90385 | Python | Video-Eingabe für Qwen3-VL über `--media-io-kwargs '{"video": {"num_frames": -1}}'`, fps per Request steuerbar. | Der einzige lokale Runtime im Feld mit echter fps-Steuerung pro Anfrage. | Qwen3-VL-README, abgerufen 29-08-2026 |
| [OpenGVLab/InternVL](https://github.com/OpenGVLab/InternVL) | 10147 | Python | Video über Frame-Folgen. | Letzter Push 22-09-2025, das Projekt ist eingeschlafen. Nicht einplanen. | GitHub-API, abgerufen 29-08-2026 |
| [NVlabs/VILA](https://github.com/NVlabs/VILA) | 3859 | Python | Video (NVILA-Linie). | Letzter Push 12-03-2026. Kein aktives Ökosystem für unsere Zwecke. | GitHub-API |
| [huggingface/smollm](https://github.com/huggingface/smollm) | 3886 | Python | SmolVLM, sehr kleine Modelle. | Kandidat für OCR und Kachel-Beschreibung auf schwacher Hardware. | GitHub-API, letzter Push 26-05-2026 |
| [DAMO-NLP-SG/Video-LLaMA](https://github.com/DAMO-NLP-SG/Video-LLaMA) | 3139 | Python | Audio-visuell. | Letzter Push 04-06-2024. Historisch. | GitHub-API |
| [allenai/molmo](https://github.com/allenai/molmo) | 929 | Python | Bild, Pointing. | Letzter Push 12-12-2024. Historisch. | GitHub-API |

### 3.2 Die Grid-Mathematik, und warum sie unsere Defaults bestimmt

Das ist der wichtigste Fund der Recherche. Drei Quellen greifen ineinander.

**Anthropic Vision, Stand 29-08-2026.** Claude sieht Bilder in 28x28-Pixel-Kacheln. Ein Bild kostet `ceil(Breite/28) * ceil(Höhe/28)` visuelle Tokens. Es gibt zwei Auflösungsstufen:

| Stufe | Modelle | Max. lange Kante | Max. visuelle Tokens |
|---|---|---|---|
| High-Resolution | Claude 4.7 und neuer | 2576 px | 4784 |
| Standard | alle anderen | 1568 px | 1568 |

Größere Bilder werden vor der Verarbeitung herunterskaliert. Belegte Beispielwerte: 1920x1080 wird auf Standard-Stufe zu 1456x819 (1560 Tokens), auf High-Resolution nicht skaliert (2691 Tokens). 3840x2160 wird auf High-Resolution zu 2576x1449 (4784 Tokens). Grenzen pro Anfrage: 100 Bilder bei 200k-Kontext, sonst 600; ab 21 Bildern gilt eine strengere Kantengrenze (jede Kante unter 2000 px halten). Maximale Bildgröße 10 MB base64, maximale Kantenlänge 8000 px. ([Vision-Doku](https://platform.claude.com/docs/en/build-with-claude/vision), abgerufen 29-08-2026)

**Der gemessene Ertrag (ii23-skills).** 64 Frames einzeln gelesen kosten rund 12.500 Tokens; dieselben 64 Frames als ein Grid kosten rund 1.900 Tokens. Das ist etwa Faktor 7. Ein 24-Minuten-Video kostet so rund 13k Tokens für volle visuelle Abdeckung, ein 67-Minuten-Film rund 15k.

Diese Zahl lässt sich mit der Kachel-Formel nachrechnen: 64 Frames zu 512x288 kosten je `ceil(512/28) * ceil(288/28) = 19 * 11 = 209` Tokens, zusammen 13.376. Ein Grid mit langer Kante 1568 kostet 1560. Faktor 8,6. Die Größenordnung stimmt, die Behauptung ist belastbar.

**Die Auflösungsregel.** ii23 formuliert sie am schärfsten: *"The cell count is a resolution decision, not a cost one."* Weil das Bild ohnehin auf die lange Kante der Stufe skaliert wird, kostet ein Grid ungefähr gleich viel, egal wie viele Kacheln es enthält. Mehr Kacheln sind in Tokens gratis und werden in Auflösung pro Kachel bezahlt.

| `cells` | px pro Kachel bei 1568 | px pro Kachel bei 2576 | Wofür |
|---|---|---|---|
| 64 (8x8) | ~196 | ~322 | Handlung, Szeneninventar, Zusammenfassung. Bei ii23 der Default |
| 16 (4x4) | ~392 | ~644 | Bildschirmtext lesen, UI-Beschriftungen, Player-Zeitanzeige |

Gemessene Grenzen bei ii23 auf einer 24-Minuten-Folge in 720p: 36 und 64 Kacheln blieben voll lesbar, 100 trug die Handlung noch. Die veröffentlichte Forschung ist konservativer, gemessen an älteren, kleineren Modellen: [IG-VLM](https://arxiv.org/abs/2403.18406) sieht das Optimum bei 6 Kacheln pro Grid, [Video Panels](https://arxiv.org/html/2509.23724v2) bei 2x2 mit Abfall ab 4x4.

**Frame-Budget statt Grid-Budget.** ii23 begrenzt den Lauf über ein Frame-Budget von 512 Frames (Default). Ohne Begrenzung erzeugten 67 Minuten bei fester Abtastrate 193 Grids, rund 359k Tokens für ein Video. Mit dem Budget: 512 Frames zu 64 Kacheln sind maximal 8 Grids. Ein 24-Minuten-Video ergibt rund 7 Grids.

**ffmpeg-Defaults, lokal geprüft gegen ffmpeg 8.1.2 am 29-08-2026.** Der `tile`-Filter hat `layout` Default `6x5`, dazu `margin`, `padding`, `color` (Default schwarz), `overlap`, `init_padding`. Der `scdet`-Filter hat `threshold` Default 10 (Bereich 0 bis 100) und `sc_pass`. PySceneDetect setzt `detect-threshold` auf 12 und warnt, dass Werte unter 8 bei niedrigen Bitraten Probleme machen; für schnelle Schnitte empfiehlt es `detect-content` oder `detect-adaptive` ([scenedetect.com/cli](https://www.scenedetect.com/cli/)).

---

## 4. Cloud-APIs mit Video und Audio

Alle Preise abgerufen am 29-08-2026 von den Anbieterseiten.

| Anbieter, Modell | Preis | Wort-Zeitstempel | Diarisierung | Spracherkennung | Quelle |
|---|---|---|---|---|---|
| **Groq** `whisper-large-v3-turbo` | 0,04 $/h | ja (`timestamp_granularities: ["word","segment"]`) | nein | ja (`language` optional) | [console.groq.com/docs/speech-to-text](https://console.groq.com/docs/speech-to-text) |
| **Groq** `whisper-large-v3` | 0,111 $/h, WER 10,3 % | ja | nein | ja | wie oben |
| **Deepgram** Nova-3 monolingual | 0,0043 $/min = 0,258 $/h | ja | ja (inklusive) | ja (Nova-3 Multilingual) | [deepgram.com/pricing](https://deepgram.com/pricing) |
| **Deepgram** Nova-3 multilingual | 0,0052 $/min = 0,312 $/h | ja | ja | ja | wie oben |
| **Deepgram** Whisper Large | 0,0048 $/min = 0,288 $/h | ja | ja | ja | wie oben |
| **AssemblyAI** Universal-3.5 Pro | 0,21 $/h, 18 Sprachen, Code-Switching | ja | ja (beste im Programm) | ja | [assemblyai.com/pricing](https://www.assemblyai.com/pricing) |
| **AssemblyAI** Universal-2 | 0,15 $/h, 99 Sprachen | ja | ja | ja | wie oben |
| **ElevenLabs** Scribe v2 | 0,22 $/h, 90+ Sprachen, >98 % Genauigkeit | ja | ja, bis 32 Sprecher | ja (smart language detection) | [elevenlabs.io/pricing/api](https://elevenlabs.io/pricing/api) |
| **ElevenLabs** Scribe v2 Realtime | 0,39 $/h, ~150 ms Latenz | ja | nein angegeben | ja | wie oben |
| **OpenAI** `gpt-transcribe` | 0,0045 $/min = 0,27 $/h | ja | nein | ja | [developers.openai.com/api/docs/pricing](https://developers.openai.com/api/docs/pricing) |
| **OpenAI** `gpt-4o-mini-transcribe` | 1,25 $/1M in, ~0,003 $/min = 0,18 $/h | ja | nein | ja | wie oben |
| **OpenAI** `gpt-4o-transcribe-diarize` | 2,50 $/1M in, ~0,006 $/min = 0,36 $/h | ja | **ja** | ja | wie oben |
| **OpenAI** Whisper (`whisper-1`) | 0,006 $/min = 0,36 $/h | ja | nein | ja | wie oben |
| **Google** `gemini-3.5-transcribe` | Free Tier kostenlos; bezahlt 2,00 $/1M oder ~0,003 $/min = 0,18 $/h | ja | **ja** | ja, plus Custom-Vocabulary-Biasing | [ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing) |
| **Google** Gemini Video nativ | rund **300 Tokens pro Sekunde Video** bei Default-Auflösung, **100 Tokens/s** bei niedriger Auflösung. Abtastung 1 fps. Max. 1 h bei Default, 3 h bei niedriger Auflösung im 1M-Kontext. Eingabe: File API 20 GB bezahlt / 2 GB frei; Inline unter 100 MB; YouTube-URLs (nur öffentlich, Free Tier max. 8 h/Tag, bis 10 Videos pro Anfrage ab Gemini 2.5) | n. a. | n. a. | n. a. | [Video understanding](https://ai.google.dev/gemini-api/docs/video-understanding) |
| **Mistral** Voxtral | Apache-2.0-Gewichte (Voxtral Small/Mini 3B), API über Studio; lokal über vLLM mit OpenAI-kompatiblem `audio.transcriptions` | ja | nein | ja (`language`) | [docs.mistral.ai/capabilities/audio](https://docs.mistral.ai/capabilities/audio/) |
| **Anthropic** Files API | kein natives Audio oder Video; Bilder per `file_id`, sonst base64 oder URL | n. a. | n. a. | n. a. | [Vision-Doku](https://platform.claude.com/docs/en/build-with-claude/vision) |

**Die entscheidende Rechnung.** Ein Zehn-Minuten-Video an Gemini nativ kostet 600 s x 300 Tokens = 180.000 Tokens. Dasselbe Video über unseren Grid-Pfad kostet rund 3 Grids (etwa 5k visuelle Tokens) plus Transkript. Das ist rund Faktor 35. Natives Video ist bequem, aber es ist nicht der billige Weg, und für unser Kostenprofil ist es der falsche Default.

**Der billigste bezahlte Transkript-Pfad** ist Groq `whisper-large-v3-turbo` mit 0,04 $/h, rund fünfmal billiger als der nächste Anbieter. Für Diarisierung ist Deepgram Nova-3 (0,258 $/h inklusive) das beste Preis-Leistungs-Verhältnis, für schwierige Sprachen ElevenLabs Scribe v2 (0,22 $/h, 32 Sprecher).

**Harte Grenzen, die man einbauen muss.** Groq: 25 MB im Free Tier, 100 MB im Dev Tier, Mindestabrechnung 10 Sekunden, nur die erste Tonspur wird transkribiert. Deshalb hat `mcp-server-whisper` ein eigenes `compress_audio`-Tool, und deshalb trimmt `watchvideo` auf 16 kHz mono.

---

## 5. Pipeline-Projekte, deren Heuristiken wir ernten

| Projekt | Stars | Sprache | Was es kann | Was wir übernehmen | Quelle + Datum |
|---|---|---|---|---|---|
| [yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp) | 187685 | Python | Downloader für über 1800 Plattformen. | Bleibt optionale Abhängigkeit (A10). | GitHub-API, letzter Push 27-08-2026 |
| [openai/whisper](https://github.com/openai/whisper) | 108110 | Python | Referenzmodell. | Modellnamen und Sprachcodes als Vokabular. | letzter Push 28-07-2026 |
| [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) | 53274 | C++ | `whisper-cli` als Binary, Metal und CUDA. | Unser lokaler Default (Roadmap Phase 1, `ggml-base-q5_1`). | letzter Push 29-08-2026 |
| [mifi/lossless-cut](https://github.com/mifi/lossless-cut) | 43285 | TypeScript | Verlustfreies Schneiden ohne Re-Encoding. | Das Prinzip: für Ausschnitte `-c copy` statt Re-Encode. Für `fetch_media` und Clip-Extraktion relevant. | letzter Push 21-08-2026 |
| [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper) | 25132 | Python | CTranslate2-Backend. | Alternative, falls whisper.cpp auf einer Zielmaschine fehlt. Achtung: letzter Push 19-11-2025, das Projekt ist ruhig. | letzter Push 19-11-2025 |
| [m-bain/whisperX](https://github.com/m-bain/whisperX) | 23797 | Python | Wort-genaue Zeitstempel per Forced Alignment plus Diarisierung. | **Der Alignment-Gedanke:** Whisper-Segmente sind ungenau, ein zweiter Alignment-Pass macht sie wortgenau. Für `analyze_moment` und Zitat-Extraktion der Unterschied zwischen brauchbar und nicht. | letzter Push 13-07-2026 |
| [chidiwilliams/buzz](https://github.com/chidiwilliams/buzz) | 21185 | Python | Offline-Transkription mit GUI. | Modellauswahl-Heuristik nach RAM (auch in claude-video-vision als `whisper_model: "auto"`). | letzter Push 28-08-2026 |
| [SubtitleEdit/subtitleedit](https://github.com/SubtitleEdit/subtitleedit) | 14000 | C# | Untertitel-Editor, sehr viele Formate. | Referenz für SRT/VTT-Randfälle (überlappende Zeiten, Zeilenumbrüche, BOM). | letzter Push 29-08-2026 |
| [MahmoudAshraf97/whisper-diarization](https://github.com/MahmoudAshraf97/whisper-diarization) | 5632 | Notebook | Whisper plus Sprecher-Diarisierung. | Beleg, dass lokale Diarisierung machbar, aber ein eigenes Projekt ist. Wir kaufen sie ein. | letzter Push 15-08-2026 |
| [Breakthrough/PySceneDetect](https://github.com/Breakthrough/PySceneDetect) | 5132 | Python | Schnitterkennung: `detect-content`, `detect-adaptive`, `detect-threshold` (Default 12). | Die **Wahlregel**: `detect-threshold` für Ab- und Überblendungen nach Schwarz, `detect-content`/`detect-adaptive` für schnelle Schnitte ohne klare Grenzen. Diese Regel gehört in die Beschreibung von `get_scenes`. | [scenedetect.com/cli](https://www.scenedetect.com/cli/) |
| [WyattBlue/auto-editor](https://github.com/WyattBlue/auto-editor) | 5098 | Nim | Automatischer Stille-Schnitt. Default `--edit audio:threshold=0.04,stream=all`, `--margin 0.2s`. dB-Einheiten (`audio:-19dB`). Kombinierbar (`--edit "(or audio:0.03 motion:0.06)"`), `--edit motion:threshold=0.02`. | **Die Defaults direkt:** Schwelle 0,04 (bzw. rund -28 dB), Rand 0,2 s vor und nach jedem Schnitt. Und das Konzept `motion` als zweite Schnittachse, für Screen-Recordings interessanter als Audio. | README, letzter Push 25-08-2026 |
| [Anil-matcha/AI-Youtube-Shorts-Generator](https://github.com/Anil-matcha/AI-Youtube-Shorts-Generator) | 4763 | Python | Opus-Clip-Alternative: Langform zu vertikalen Clips. | Highlight-Auswahl per Transkript plus Audio-Energie. Bestätigt timecode-agents `highlights --top 5 --window 0.5`. | letzter Push 29-07-2026 |
| [jianfch/stable-ts](https://github.com/jianfch/stable-ts) | 2282 | Python | Stabilere Whisper-Zeitstempel, Forced Alignment, Audio-Indexierung. | Alternative zu whisperX, wenn keine GPU da ist. | letzter Push 30-05-2026 |
| [NotJoeMartinez/yt-fts](https://github.com/NotJoeMartinez/yt-fts) | 1812 | Python | Volltext- und Semantiksuche über Kanal-Transkripte in SQLite. `yt-fts diagnose` prüft die Installation gegen eine Test-URL. | **`diagnose` als Erstklass-Kommando.** Ein Werkzeug, das sich selbst prüfen kann, spart dem Agenten drei Fehlversuche. Analog `--jobs` Default 8 für parallele Downloads. | README, letzter Push 22-01-2026 |
| [HKUDS/VideoAgent](https://github.com/HKUDS/VideoAgent) | 1769 | Python | Agentisches Framework für Video-Verstehen, -Schnitt und -Neuproduktion. | Referenz-Architektur für die Orchestrierung. README nicht abrufbar (404 auf HEAD), nur Metadaten geprüft. | GitHub-API, letzter Push 22-07-2026 |
| [video-db/Director](https://github.com/video-db/Director) | 1521 | Python | Video-Agent-Framework mit Agenten pro Aufgabe. | Kommerzieller Gegenentwurf (VideoDB als Backend). Für uns nur Abgrenzung. | letzter Push 23-01-2026 |
| [iejMac/video2dataset](https://github.com/iejMac/video2dataset) | 663 | Python | Große Video-Datensätze aus URLs. | Letzter Push 30-07-2024. Historisch, keine Ernte. | GitHub-API |
| [microsoft/DeepVideoDiscovery](https://github.com/microsoft/DeepVideoDiscovery) | 414 | Python | Deep-Research-artiges QA über lange Videos. | Muster: iteratives Nachfragen statt einmaliger Vollanalyse. Passt zu Lazy Visual Verification. | letzter Push 03-11-2025 |
| [Leon1207/Video-RAG-master](https://github.com/Leon1207/Video-RAG-master) | 455 | Python | NeurIPS-2025-Arbeit, visuell ausgerichtetes Retrieval über Video. | Nur als Beleg, dass Video-RAG ein eigenes Feld ist. Nicht in den Server. | letzter Push 26-06-2026 |

---

## 6. Agent-Ergonomie

### 6.1 Wie die besten Server Bilder liefern

Die Konvergenz ist eindeutig, drei Regeln:

1. **Ein Grid statt n Bilder.** Belegt mit Faktor 7 bis 8 (Abschnitt 3.2). Alle ernstzunehmenden Projekte tun das inzwischen: ii23 `video-understand`, watchvideo (Contact Sheets), timecode-agent (`filmstrip`), claude-watch.
2. **Die lange Kante auf die Modellgrenze legen, nicht darüber.** Alles über 1568 px (Standard) bzw. 2576 px (High-Resolution) wird ohnehin skaliert und kostet nur Bytes im Transport.
3. **Zeitstempel niemals aus dem Bild ablesen.** Das Overlay ist eine Sehhilfe für Menschen. Die maßgebliche Zeit steht in `structuredContent` (bei ii23: `manifest.json`). Ein Modell, das eine Zeit aus einem 196-px-Kachelrand abliest, rät.

Zusätzlich: JPEG-Kompression schadet Text. Anthropic warnt ausdrücklich, dass mehrfache verlustbehaftete Durchgänge Artefakte erzeugen, die Text unlesbar machen. claude-video-vision hat deshalb `frame_format: png` als Option speziell für Screen-Recordings. Das übernehmen wir.

### 6.2 Wie sie Kontext begrenzen

| Muster | Wer | Konkret |
|---|---|---|
| Cursor-Pagination auf Text | transcriptor-mcp | `start_offset`, `end_offset`, `response_limit`, `next_cursor`, `is_truncated`, `total_length` |
| Offset-Pagination | yt-dlp-mcp | `has_more`, `next_offset`, `response_format` |
| Token-Budget als Tool-Parameter | mcp-server-youtube-transcript | `max_tokens`, `strip_ads` |
| Frame-Budget statt Grid-Zahl | ii23-skills | Default 512 Frames, daraus folgt die Grid-Zahl |
| Zeichen-Budget | media-understanding (Referenz) | `max_total_chars` |
| Fokus statt Dichte | claude-video, watchvideo | `--start`/`--end` mit dichterem Budget im Fenster, Deckel 2 fps |

Für die Spec 2026-07-28 gilt: `resource_link` statt Inline-Bild ist der richtige Weg, sobald mehr als ein Grid entsteht. Der Agent lädt dann nur das Grid, das er wirklich braucht. Keiner der untersuchten Server nutzt das schon; das ist eine echte Lücke, die media-intel besetzen kann.

### 6.3 Wie sie lange Läufe handhaben

Schwach. Der Stand der Technik ist `transcribe_status` (harken) als getrennte Abfrage und `watch-skill loop viewer <loop_id>` für Lauf-Historie. Niemand nutzt MCP Tasks aus der Spec 2026-07-28. Zweite echte Lücke.

### 6.4 Vier Ehrlichkeitsregeln, die wir uns aneignen sollten

Aus watch-skill, wörtlich sinngemäß:

- **Identität folgt den Bytes, nicht dem Pfad.** Wird `demo.mp4` überschrieben, antwortet die nächste Frage `stale`, nicht mit den Frames von gestern. Das ist genau unser content-adressierter Cache (A8), aber als sichtbares Ergebnisfeld statt als stiller Cache-Miss.
- **Ein konfigurierter API-Key ist keine Zustimmung.** `watch-skill plan` druckt jede Netzwerk-Aktion, bevor ein Lauf eine ausführt.
- **Ein fehlendes Urteil ist kein Bestehen.** Keine Frames, kein OCR, Modell nicht erreichbar, Zeitüberschreitung: alles `inconclusive`. Nur eine bestandene deterministische Prüfung ergibt `pass`.
- **Keine Fähigkeit behaupten, die nicht geprüft wurde.** `capture-capabilities` sagt, was die Maschine wirklich kann, und ob die Antwort gemessen oder nur vermutet wurde.

---

## 7. Verwertung: Top-10 konkrete Übernahmen für media-intel

| # | Übernahme | Art | Konkreter Wert | Phase | Quelle |
|---|---|---|---|---|---|
| 1 | **`get_video_grids` bekommt `cells` statt `tile_width`.** Die lange Kante des Grids wird auf die Modellstufe gelegt (`grid_long_edge`, Default 1568, Option 2576), die Kachelzahl steuert nur die Auflösung pro Kachel. | Parameter + Default | `cells: 64` (8x8, ~196 px/Kachel) als Default für Handlung und Inventar; `cells: 16` (4x4, ~392 px) für Bildschirmtext. `grid_long_edge: 1568 \| 2576` | 1 | ii23-skills, Anthropic Vision-Doku |
| 2 | **Budget ist ein Frame-Budget, kein Grid-Budget.** `max_frames` (Default 512) statt `max_grids`; die Grid-Zahl folgt aus `ceil(max_frames / cells)`. | Parameter + Default | `max_frames: 512` deckelt einen 67-Minuten-Film bei 8 Grids. Ohne Deckel: 193 Grids, rund 359k Tokens. | 1 | ii23-skills |
| 3 | **Zeitstempel sind Daten, kein Bildinhalt.** Jedes Grid liefert in `structuredContent` ein `manifest` mit `{grid_index, cell_index, t_s, source_frame}`. Das gebrannte Overlay bleibt, aber die Tool-Beschreibung sagt ausdrücklich: Zeiten aus dem Manifest lesen, nie aus dem Bild. | Tool-Design + Prompt | Ein Satz in der Tool-Description, ein Feld im Output-Schema. | 1 | ii23-skills |
| 4 | **`get_transcript` bekommt Cursor-Pagination und ein Provenienz-Feld.** | Parameter + Output | `response_limit`, `next_cursor`, `is_truncated`, `total_length`, `start_offset`, `end_offset`; dazu `transcription_source: "embedded_subtitles" \| "sidecar_vtt" \| "ytdlp_manual" \| "ytdlp_auto" \| "whisper_cpp" \| "openai" \| "groq"`. | 1 | transcriptor-mcp, claude-video-vision |
| 5 | **`doctor` als eigenes Tool.** Prüft ffmpeg, ffprobe, yt-dlp, whisper-cli, tesseract mit Version und Pfad, meldet Cache-Größe und, für jede Fähigkeit, ob sie gemessen oder nur vermutet ist. | Neues Tool | Ein Aufruf statt drei Fehlversuche. Ergebnis fließt in `probe_media.suggested_next`. | 1 | watch-skill (`capture-capabilities`), yt-fts (`diagnose`), video-audio-mcp (`health_check`), claude-video-vision (`video_setup`) |
| 6 | **PNG-Option für Screen-Recordings.** `frame_format: "jpeg" \| "png" \| "webp"`, Default jpeg, aber `probe_media` schlägt png vor, wenn es ein Screen-Recording erkennt (hohe Kantenschärfe, niedrige Bewegung, 16:10 oder 16:9 in Desktop-Auflösung). | Parameter + Heuristik | Verlustbehaftete Kompression macht kleinen UI-Text unlesbar; Anthropic warnt explizit davor. | 1 | claude-video-vision, Anthropic Vision-Doku |
| 7 | **Transcript-first plus Lazy Visual Verification** wird das Ablaufmuster von `understand_media`: erst Transkript und deterministische Platzierungssignale (Szenen, Audio-Energie, Stille), dann Grids nur für die Fenster, die eine Aussage visuell belegen müssen. | Architektur | Spart bei sprachlastigem Material (Vorträge, Voice Notes, Meetings) den größten Teil der visuellen Tokens. | 2 | timecode-agent, microsoft/DeepVideoDiscovery |
| 8 | **Geprüfte Defaults für `get_scenes` und `analyze_moment`.** | Defaults | Szenen: ffmpeg `scdet threshold=10` (0 bis 100), Fallback gleichmäßig; Wahlregel aus PySceneDetect in die Tool-Beschreibung. Stille: Schwelle 0,04 linear (rund -28 dB), Rand 0,2 s vor und nach jedem Segment. Highlights: RMS-Fenster 0,5 s, Top 5 Peaks. Frame-Auswahl: `min_gap 1.0 s`, Schärfe-Gate über Sobel-Kantenenergie aus 3 Kandidaten im Fenster `±0,3 s`. | 2 | ffmpeg 8.1.2 lokal geprüft, PySceneDetect, auto-editor, timecode-agent |
| 9 | **MCP-Prompts nach fabric-Bauart.** Vier Vorlagen: `tldr`, `key_moments`, `quotables`, `hook_breakdown`. Feste Wortzahlen im Prompt, Zeitformat explizit benannt, Zitate wörtlich mit Sprecher. | Prompt | Aus `extract_wisdom`: SUMMARY 25 Wörter, IDEAS je exakt 16 Wörter, QUOTES wörtlich mit Sprecher, ONE-SENTENCE TAKEAWAY 15 Wörter. Aus `create_video_chapters`: Eingabe-Zeitformat `HH:MM:SS.mmm` explizit nennen und vom Ausgabeformat unterscheiden. Aus watchvideo: Hook-Modus als eigener Lauf über die ersten 20 Sekunden mit genau einem Contact Sheet. | 2 | Fabric (43555 Sterne), watchvideo |
| 10 | **Kosten-Preflight mit belegter Preistabelle und Zustimmungsregel.** Vor jedem bezahlten Aufruf wird die geschätzte Summe gegen `MEDIA_INTEL_MAX_COST_USD` (Default 0,10) geprüft und im Ergebnis genannt. Ein gesetzter Key allein löst keinen bezahlten Aufruf aus. Ergebnisse ohne Urteil heißen `inconclusive`, nicht `ok`. | Heuristik + Ehrlichkeit | Preisstand 29-08-2026: Groq turbo 0,04 $/h (billigster Pfad), OpenAI `gpt-4o-mini-transcribe` 0,18 $/h, Deepgram Nova-3 0,258 $/h (Diarisierung inklusive), ElevenLabs Scribe v2 0,22 $/h (32 Sprecher). Gemini nativ kostet 300 Tokens pro Sekunde Video und ist damit kein Default. | 2 | watch-skill, Anbieter-Preisseiten |

**Zwei Lücken, die niemand besetzt (Phase 3, aber jetzt planen).** Erstens: `resource_link` statt Inline-Bild, sobald mehr als ein Grid entsteht. Zweitens: MCP Tasks für `understand_media` und `get_transcript` oberhalb einer Dauerschwelle. Beides steht in der Spec 2026-07-28, und keiner der 16 untersuchten Server nutzt es. Das ist der klarste Differenzierungspunkt für media-intel.

---

## 8. Nicht übernehmen

| Sache | Wer macht es | Warum nicht |
|---|---|---|
| **196 MCP-Tools** | kinocut | Ein `search_tools`-Tool als Gegenmittel gegen die eigene Tool-Zahl ist Symptombehandlung. Die sternstärksten Server im Feld haben drei bis acht Tools. Unsere acht bleiben acht. |
| **Video-Schnitt und Rendering** | kinocut, video-audio-mcp, hyperframes (43040 Sterne), FableCut, ClipForge | Anderes Produkt. Verstehen und Erzeugen teilen sich nur ffmpeg, sonst nichts. Wer schneiden will, nimmt kinocut oder LosslessCut. |
| **Eigener Vektor-Index und RAG im Server** | mcptube (`wiki_*`), omniseek (Evidenzgraph), timecode-agent (`wiki`, `index`), sift-video | Akasha ist die Gedächtnisschicht dieses Systems. Ein zweiter Index im Medienserver wäre eine konkurrierende Wahrheit. `list_cached` als reine Introspektion reicht. |
| **Obsidian- und Vault-Schreiblogik** | claude-watch, JimmySadek, tapestry-skills, ein Dutzend Obsidian-Plugins | Gehört in den Skill, nicht in den Server. Der Server liefert `structuredContent`, der Skill entscheidet über Zielformat und Ablageort. Bestätigt durch die Beobachtung, dass der sternstärkste Medien-Skill (5843) genau das tut und nichts extrahiert. |
| **Statischer Corpus-Browser, HTML-Viewer, Wiki-Seiten** | timecode-agent, watch-skill (`viewer`), lecture-to-notes | Schöne Nebenprodukte, aber sie machen aus einem Werkzeug eine Anwendung. Falls gewünscht: eigener Skill, der aus `structuredContent` eine HTML-Datei baut. |
| **Browser-Steuerung, Screen-Capture, Desktop-Aufnahme** | watch-skill (`Operate`), deskmate, nuphus-mcp, markupr | Eigene Sicherheits- und Berechtigungsdomäne. Wir verarbeiten Dateien und URLs, wir nehmen nichts auf. |
| **Gemini natives Video als Default-Pfad** | claude-video-vision (als Backend-Option) | 300 Tokens pro Sekunde Video sind rund Faktor 35 gegenüber dem Grid-Pfad. Als optionales Backend für "ich brauche wirklich jede Sekunde" vertretbar, als Default falsch. |
| **Eigene Diarisierung** | whisper-diarization (5632 Sterne), whisperX | Ein eigenes Projekt mit eigenen Modellgewichten. Wir kaufen sie ein: Deepgram Nova-3 (inklusive, 0,258 $/h), ElevenLabs Scribe v2 (32 Sprecher), `gpt-4o-transcribe-diarize`, `gemini-3.5-transcribe`. |
| **Shorts- und Clip-Erzeugung** | AI-Youtube-Shorts-Generator (4763), podcli, ClipPulse | Die Highlight-Heuristik ernten wir (Übernahme 8), die Erzeugung nicht. Vertikaler Schnitt, Face-Tracking und eingebrannte Untertitel sind Produktionsarbeit. |
| **`faster-whisper` als lokaler Default** | ii23-skills, viele | Letzter Push 19-11-2025. whisper.cpp wurde am 29-08-2026 gepusht und braucht kein Python. Bleibt bei A2 und der Roadmap. |
| **InternVL, Molmo, Video-LLaMA, video2dataset als Bausteine** | diverse Forschungsrepos | Letzte Pushes zwischen 06-2024 und 09-2025. Eingeschlafen. Für einen Server, der drei Jahre laufen soll, ungeeignet. |

---

## 9. Offene Punkte

- **HKUDS/VideoAgent** (1769 Sterne, letzter Push 22-07-2026) konnte nicht gelesen werden, `README.md` liefert auf `HEAD` einen 404. Nur Metadaten geprüft. Lohnt einen zweiten Blick, es ist das sternstärkste rein agentische Video-Framework im Feld.
- **Die Auflösungsstufe des Zielmodells ist zur Laufzeit unbekannt.** `grid_long_edge` muss deshalb ein Parameter mit Default 1568 sein (der sichere Wert), plus ein Hinweis in `warnings`, wenn ein Grid mit 2576 an ein Standard-Modell ginge. Alternativ per `MEDIA_INTEL_GRID_LONG_EDGE`.
- **Die 7x-Zahl von ii23** ist mit der aktuellen Kachelformel nachgerechnet und plausibel (Faktor 8,6 bei 512x288-Frames), aber nicht auf unserem eigenen Material gemessen. Vor dem Festschreiben der Defaults sollte Phase 1 eine Messung auf einer echten deutschen Voice Note und einem Screen-Recording machen.
