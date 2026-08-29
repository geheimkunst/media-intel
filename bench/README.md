# media-intel Benchmark (Stufe 1: offline, containerisiert, bekannte Wahrheit)

## Was gemessen wird

| Aufgabe | Fixture | Wahrheit | Metrik |
|---|---|---|---|
| Transkript | `speech-*.m4a` (de/en, sauber, Rauschen, Musikbett, 60 s Langfassung) | gesprochener Text (macOS `say`) | WER, Sprache erkannt, Wanduhr, Textzeichen |
| OCR | `ocr-*.png`, `ocr-video.mp4` bei 1,5 / 4,5 / 7,5 s | gerenderter Text (sharp/SVG) | CER, Wanduhr |
| Szenen | `cuts-10.mp4` (10 harte Schnitte), `fades-3.mp4` (3 Blenden) | Schnittzeiten aus der Konstruktion | Precision, Recall, F1 (Toleranz 0,25 s bzw. 0,6 s) |
| Frames | `frames-60s.mp4` bei 5 Zeitpunkten | angeforderte Zeit | Abweichung, Bildgröße, geschätzte Vision-Tokens, Wanduhr |
| Übersicht | `frames-60s.mp4` "ganzes Video abdecken" | keine | Bildanzahl, Pixel, geschätzte Vision-Tokens, Bytes, Wanduhr |
| Probe | alle Dateien | keine | Wanduhr, strukturierte Ausgabe ja/nein |
| Robustheit | `corrupt.mp4`, `empty.mp4`, `silent.wav`, `noaudio.mp4`, private URL, Pfad-Traversal | erwartetes Verhalten | sauberer Fehler / Absturz / Hänger |

Token-Schätzung nach Anthropic: lange Kante auf 1568 px begrenzt, dann Pixel/750; Text Zeichen/4.

## Fairness

- Alle Kandidaten laufen im eigenen Docker-Container auf demselben VPS (4 Cores, 8 GB), seriell, ohne Netz, Fixtures schreibgeschützt unter `/data`.
- Transkription mit demselben Whisper-Modell (`ggml-base-q5_1`, multilingual) für alle; media-intel zusätzlich mit `large-v3-turbo-q5_0`, getrennt ausgewiesen.
- Verglichen wird die Aufgabe, nicht der Tool-Name. Kann ein Kandidat eine Aufgabe nicht, steht "n/a", nicht 0.
- Skills (claude-video, claude-watch) sind keine Server; sie treten nur mit ihren Skripten bei Frames an.

## Ausführen

```bash
node bench/make-fixtures.mjs                 # macOS (say), erzeugt bench/fixtures + truth.json
bash bench/run-vps.sh                        # rsync, Images bauen, Lauf, Ergebnisse zurückholen
node bench/report.mjs bench/results/<lauf>.json   # Markdown-Tabellen
```

Ergebnisse: `bench/results/*.json`, Bericht: `docs/benchmarks/`.
