# Spike: ffmpeg-Analysefilter als Tool-Quellen (29-08-2026)

Lokal geprüft mit ffmpeg 8.1.2 (Homebrew) auf synthetischen Clips. Ziel: Welche strukturierten Ausgaben bekommt media-intel praktisch gratis aus ffmpeg, ohne weitere Abhängigkeit?

| Filter | Aufruf | Ausgabe (stderr, parsebar) | Ergebnis | Tool-Kandidat |
|---|---|---|---|---|
| `silencedetect` | `-af silencedetect=n=-40dB:d=0.3 -f null -` | `silence_start: 1` / `silence_end: 2.500062 \| silence_duration: 1.500063` | funktioniert, Sekundenwerte | `get_silence` bzw. Stille-Karte in `get_transcript` (Fenster überspringen) |
| `scdet` | `-vf scdet=threshold=10 -f null -` | `lavfi.scd.score: 32.610, lavfi.scd.time: 2` | funktioniert, ein Eintrag pro Schnitt | `get_scenes` (Schnittliste mit Score) |
| `ebur128` | `-af ebur128=framelog=quiet -f null -` | `I: -21.8 LUFS`, `LRA: 20.0 LU` | funktioniert | `analyze_audio` (Lautheit, Dynamik) |
| `tile` | `-vf fps=1,scale=160:-1,tile=3x1 -frames:v 1 -q:v 4 out.jpg` | JPEG 12 KB für 3 Kacheln | funktioniert, 334x Echtzeit | `get_video_grids` |
| `showwavespic` | `-filter_complex showwavespic=s=480x80 -frames:v 1 out.png` | PNG 493 B | funktioniert | Wellenform-Bild für den Agenten (Stille, Sprachanteile auf einen Blick) |
| `-skip_frame nokey` | `-skip_frame nokey -i in.mp4 -vsync vfr -frame_pts 1 out_%03d.jpg` | Keyframes als JPEG, 36 ms für 3 s Clip | funktioniert | schnelle Keyframe-Abtastung ohne Decoding aller Frames |

## Befund, der das Design ändert

**`drawtext` fehlt im Homebrew-ffmpeg** (Build ohne libfreetype, `ffmpeg -filters` listet den Filter nicht). Der Timestamp-Overlay aus media-understanding und mcp-video-analyzer lässt sich damit nicht über ffmpeg umsetzen. Optionen:

1. Overlay in Node mit `sharp` (SVG-Text komponieren), unabhängig vom ffmpeg-Build. Bevorzugt.
2. Kein Overlay im Bild; Timestamps stehen im Textblock und in `structuredContent` (Kachel-Index zu Sekunde). Reicht für Grids, weil das Raster deterministisch ist.
3. Eigener ffmpeg-Build mit freetype voraussetzen. Abgelehnt, Installationshürde.

Entscheid: Variante 2 als Default in Phase 1 (deterministisches Raster, Mapping im Schema), Variante 1 optional, wenn `sharp` ohnehin für Bildoperationen dazukommt.

## Parser-Regeln

- Alle Analysefilter schreiben auf stderr, `-nostats` unterdrückt die Fortschrittszeilen, `-f null -` verhindert Ausgabedateien.
- Zeilenformat `[Parsed_<filter>_<n> @ 0x…] key: value | key: value`. Ein Regex pro Filter reicht.
- `scdet` liefert Metadaten pro erkanntem Frame; Threshold 10 ist der Standardwert der Doku, für Reels eher 8, für Talking-Heads 15.
- Alle Werte in Sekunden mit Mikrosekunden-Genauigkeit; auf Millisekunden runden.
