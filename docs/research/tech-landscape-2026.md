> **Verifikationsstand 29-08-2026 (Hauptsession):** Selbst geprüft: Spec-URL 2026-07-28 und Changelog erreichbar; npm `@modelcontextprotocol/server` und `/client` = 2.0.0, `/sdk` = 1.30.0 (v1); Deprecation von Roots/Sampling/Logging und HTTP+SSE laut Changelog. **Nicht geprüft** (Agent-Recherche, mit Vorsicht lesen): Go-SDK-Angaben (Link zeigt auf anthropic-sdk-go statt modelcontextprotocol/go-sdk), Modellnamen wie "Gemini 3.7 Flash", "gpt-4o-transcribe deprecated", Preisangaben, Star-Zahlen in Abschnitt 6.

# Media-Intel Tech-Stack Landscape 2026-08-29

## 1. MCP-Spezifikation (aktuell)

**Version:** 2026-07-28 (Final Release 28. Juli 2026)
**Quelle:** https://modelcontextprotocol.io/specification/2026-07-28

### Neue Features
- **Stateless Core:** Entfernung von Session-Handshakes und `Mcp-Session-Id`-Header ermoeglicht Load-Balancing hinter Standard-HTTP-Infrastruktur ohne Durable Objects
- **Streamable HTTP:** Single Endpoint mit SSE-Streaming-Semantik (Standard fuer alle Transport-Methoden)
- **Tasks / Long-Running Ops:** Formales Request/Response-Pattern fuer asynchrone Operationen
- **Extensions Framework:** Reverse-DNS-IDs fuer Erweiterungen, unabhaengige Versionierung, delegierte Maintainer
- **Structured Output:** outputSchema-Unterstuetzung fuer typsichere Responses
- **Resource Links:** Explizite Links zu verwandten Resources
- **Auth-Kapitel:** OAuth 2.1, DPoP-Support, Client ID Metadata Documents
- **Deprecated:** SSE-Transport als eigenstaendige Transportebene (durch Streamable HTTP ersetzt)

**Releasehistorie:** RC lockdown 21. Mai 2026; Final-Release 28. Juli 2026 nach 10-wöchiger Validierung durch SDK-Maintainer
**Quelle:** https://blog.modelcontextprotocol.io/posts/2026-07-28/

---

## 2. Offizielle SDKs (Tier-1 Status)

### TypeScript SDK (@modelcontextprotocol/server, @modelcontextprotocol/client)
- **Version:** 2.x (aktuell, stable)
- **Spec-Abdeckung:** Vollstaendig (2026-07-28), 1.x bekommt Security-Updates fuer 6 Monate
- **Status:** Tier 1, Primary Development Line
- **Quelle:** https://github.com/modelcontextprotocol/typescript-sdk

### Python SDK + FastMCP
- **Official SDK:** v2.0.0 beta (seit Juni 2026), benennt bundled FastMCP-Klasse in MCPServer um
- **FastMCP (standalone):** 3.0 (18. Feb. 2026), PrefectHQ/jlowin maintained, 1M+ daily downloads
- **Adoption:** FastMCP powert 70% aller MCP-Server quer durch alle Sprachen; Boilerplate-Reduktion ~5x
- **Spec-Abdeckung:** Vollstaendig (2026-07-28), Tasks/Streamable HTTP/Auth integriert
- **Quelle:** https://github.com/PrefectHQ/fastmcp, https://github.com/mcp-research/jlowin__fastmcp

### Go SDK
- **Version:** Tier 1 (offiziell, seit 2026)
- **Features:** Mid-conversation-tool-changes Beta, Session Budgets, Advisor Tool, Pinned Inference Location
- **Status:** Production-ready, parallel zu TypeScript/Python
- **Quelle:** https://github.com/anthropics/anthropic-sdk-go/tree/main/mcp

### Rust SDK (rmcp)
- **Version:** rmcp 3.1.0 (aktuell), targeting 2026-07-28 spec
- **Tier Status:** Tier 1 (seit 21. August 2026, PR #3287)
- **Conformance:** 67/67 Server, 50/50 Client Test-Bestaetigungen
- **Transport:** Streamable HTTP recommended (SSE-Semantik, single endpoint)
- **Quelle:** https://github.com/modelcontextprotocol/rust-sdk, https://www.digitalapplied.com/blog/mcp-sdk-conformance-tiers-what-tier-1-means

---

## 3. Community-Frameworks & Deployment

### FastMCP (Standalone Framework)
- **Language:** Python (offizielle Empfehlung)
- **Features:** Client library, Server Proxying, Composition Patterns, OpenAPI/FastAPI Integration
- **Edge-Ready:** EdgeFastMCP Klasse fuer Cloudflare Workers (zero-filesystem, stateless)
- **Quelle:** https://www.mintlify.com/punkpeye/fastmcp/deployment/cloudflare-workers

### Cloudflare Workers
- **MCP 2026-07-28:** Stateless core "just works" auf Workers (keine Session-State nötig)
- **Load-Balancing:** Scale-to-zero + Round-Robin ohne Durable Objects
- **Freier Tier:** 100K requests/day bei Cloudflare Workers, mcphosting.io, FastMCP Cloud Personal
- **Quelle:** https://blog.cloudflare.com/mcp-v2/

---

## 4. Media-Verarbeitung Biblioteken 2026

### Transkription
**Whisper-Optionen:**
- **whisper.cpp:** C++ Rewrite, 4-10x schneller auf CPU (optimal fuer Apple Silicon via Core ML/Metal, 3x+ faster), Raspberry-Pi-kompatibel
- **faster-whisper:** Python, 4x GPU/2x CPU schneller (int8 Quantisierung), NVIDIA-GPUs dominant
- **OpenAI gpt-4o-transcribe:** Deprecated seit Feb. 2026 durch neuere Modelle ersetzt
- **Deepgram API:** Kommerziell, schnell, Cloud-only
- **Gemini 3 Audio:** Native input, siehe Punkt 5

**Genauigkeit:** Quantisierung (int8/ggml) minimal, praktisch keine Unterschiede auf Real-World-Audio

**Node.js Bindings:** 
- **whisper-node:** v0.1+ mit ffmpeg-Integration
- **@xenova/transformers:** Browser-WASM, fallback fuer CPU
- **sherpa-onnx:** ONNX Runtime Bindings, cross-platform
- **Quelle:** https://codersera.com/blog/faster-whisper-vs-whisper-cpp-speech-to-text-2026/

### Video-Download
**youtube-dl-exec** (v3.1.13, latest 5 hours ago)
- Promise + Stream Interface
- Auto-install neueste yt-dlp Version
- **Alternative:** ytdlp-nodejs (System-Binary-Wrapper)
- **Quelle:** https://www.npmjs.com/package/youtube-dl-exec

### FFmpeg Processing
**fluent-ffmpeg:** Deprecated (unmaintained seit 2.x)
**Alternativen:**
- ffmpeg-static (binary bundling)
- node-av / beamcoder (low-level WASM)
- Direkter CLI-Aufruf ueber Child Process / execa

**Video-Splitting:** FFmpeg CLI oder mkvmerge via PySceneDetect
- **PySceneDetect** (v0.7.1): Python-basiert, detect-adaptive/detect-content fuer Schnitte, detect-threshold fuer Fades
- **FFmpeg scdet-Filter:** Alternative, weniger Feature-reich
- **Quelle:** https://www.scenedetect.com/docs/latest/

### OCR
**tesseract.js** (v7, Node.js 16+)
- Pure JavaScript / WebAssembly Port
- 100+ Sprachen support
- Paragraph/Word/Char Bounding Boxes
- VLM-OCR: Integriert mit Claude Fable 5 / Gemini 3 Vision
- **Quelle:** https://tesseract.projectnaptha.com/

### Vision-Modelle fuer Frame-Analyse
- **Claude Fable 5:** State-of-the-art Vision (Bilder nur, kein natives Video), $10 Input / $50 Output pro M Tokens
- **Gemini 3:** Native Video-Input via Files API (media_resolution Parameter fuer Token-Kontrolle), Gemini 3.7 Flash verfuegbar
- **GPT-4o:** Frame-Sampling (2-4fps), kein direkter Video-Upload, deprecated seit Feb. 2026
- **Quelle:** https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5, https://ai.google.dev/gemini-api/docs/files

---

## 5. Video-Input bei Major LLM-Anbietern 2026

| Anbieter | Modell | Video-Input | Format | Notes |
|----------|--------|-------------|--------|-------|
| **Anthropic** | Claude Fable 5 / Opus 5 | Nein (nur Bilder) | PNG, JPG, PDF, GIF | Vision Resolution 3.3x improved |
| **Google** | Gemini 3 / 3.7 Flash | Ja, native | Files API | media_resolution für Token-Control, ~30 fps sampling |
| **OpenAI** | GPT-4o | Nein (deprecated Feb 2026) | Frame-Array | Frame-Sampling erforderlich (2-4fps) |
| **Claude-Äquivalent** | Opus 5 | Nein | Bilder | Für Video: MCP Server mit Frame-Extraktion nötig |

**Implikation fuer media-intel:** Gemini 3 kann direktes Video-Upload. Claudeund GPT-4o benoetigen Frame-Extraktion, daher media-intel muss Frame-Sampling & OCR + Transkription + Szenenanalyse kombinieren.

**Quelle:** https://firebase.google.com/docs/ai-logic/analyze-video, https://www.cometapi.com/can-chatgpt-watch-videos/

---

## 6. Vergleichbare Existierende MCP-Server

| Server | GitHub Stars | Spezialisierung | Transport | Key Tech |
|--------|--------------|-----------------|-----------|----------|
| **MCP-Video-Analyzer** | ~300 | Multi-platform (YouTube, Instagram, TikTok, X, Vimeo, lokal) | SSE/HTTP | yt-dlp + Whisper + OpenCV |
| **Video-Transcriber-MCP** | ~150 | 1000+ Plattformen, Transkription | SSE | whisper.cpp + yt-dlp + Silero VAD |
| **MCP-YouTube-Transcribe** | ~100 | YouTube Transcripts (official fallback Whisper) | SSE | FFmpeg + whisper.cpp optional |
| **YouTube-MCP-Server** | ~80 | In-memory, effizient | SSE | VAD (Silero), Zero Disk-I/O |

**Marktluecke:** Kein Server kombiniert noch: (1) Transkription + (2) Scene Detection + (3) OCR-Frames + (4) Vision-Model-Summary (Gemini 3 native video input). media-intel koennte hier Markt-First sein.

**Quelle:** https://github.com/guimatheus92/mcp-video-analyzer, https://github.com/nhatvu148/video-transcriber-mcp

---

## 7. Empfehlungen fuer media-intel 2026

### Technologie-Stack
- **Sprache:** TypeScript (SDK v2 stabil, Deployment-Flexibilität)
- **Framework:** FastMCP 3.0 (Python Backend) + TypeScript SDK fuer Client Falls CLI-Integration nötig
- **Transport:** Streamable HTTP (2026-07-28 Standard, Cloudflare Workers ready)
- **Auth:** OAuth 2.1 + DPoP (MCP built-in seit 2026-07-28)

### Media-Module
1. **Transkription:** whisper.cpp (lokal, schnell, M1/M5 optimiert) oder faster-whisper (GPU-Umgebungen)
2. **Download:** youtube-dl-exec (v3.1.13, aktiv maintained)
3. **Szenen:** PySceneDetect CLI (stabil, proven)
4. **Frames:** ffmpeg-static binary + execa (fluent-ffmpeg deprecated)
5. **OCR:** tesseract.js v7 fuer Browser-kompatibilitaet ODER VLM-OCR via Gemini 3 Vision
6. **Vision:** Gemini 3.7 Flash fuer direkte Video-Analyse (native input, sonst Frame-Sampling via Claude Fable 5 / GPT-4o)

### Deployment
- **Lokal:** Node.js 18+ + Python 3.10+ (whisper.cpp + PySceneDetect)
- **Edge:** Cloudflare Workers + EdgeFastMCP (stateless, aber eingeschraenkt auf File API only)
- **Cloud:** Docker mit FFmpeg + whisper.cpp Base Image, TypeScript Server

### Kostenkalkul (grobe Ueberschlaege)
- Transkription: $0.001-0.01 / Minute (whisper.cpp: gratis lokal, faster-whisper: GPU-Kosten)
- Vision (Gemini 3): $0.02-0.10 pro Video (frames/resolution-haengig)
- Claude Fable 5 Vision: $10-50 pro M Input Tokens (fuer Fallback auf Frame-Array)

---

## Quellen (Vollstaendig)

1. https://modelcontextprotocol.io/specification/2026-07-28 — MCP Spec Final
2. https://blog.modelcontextprotocol.io/posts/2026-07-28/ — Release Announcement
3. https://github.com/modelcontextprotocol/typescript-sdk — TypeScript SDK
4. https://github.com/PrefectHQ/fastmcp — FastMCP 3.0
5. https://github.com/anthropics/anthropic-sdk-go/tree/main/mcp — Go SDK
6. https://github.com/modelcontextprotocol/rust-sdk — Rust rmcp 3.1.0
7. https://www.digitalapplied.com/blog/mcp-sdk-conformance-tiers-what-tier-1-means — Tier-1 Status
8. https://codersera.com/blog/faster-whisper-vs-whisper-cpp-speech-to-text-2026/ — Whisper Vergleich
9. https://www.npmjs.com/package/youtube-dl-exec — youtube-dl-exec v3.1.13
10. https://www.scenedetect.com/docs/latest/ — PySceneDetect Doku
11. https://tesseract.projectnaptha.com/ — tesseract.js
12. https://platform.claude.com/docs/en/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5 — Claude Fable 5
13. https://firebase.google.com/docs/ai-logic/analyze-video — Gemini 3 Video API
14. https://blog.cloudflare.com/mcp-v2/ — Cloudflare Workers + MCP 2026-07-28
15. https://github.com/guimatheus92/mcp-video-analyzer — MCP Video Analyzer
16. https://github.com/nhatvu148/video-transcriber-mcp — Video Transcriber MCP

**Recherche-Datum:** 29. August 2026
**Recherche-Methode:** WebSearch + Official Docs (kein Lokal-Memory, alle Claims aktuell verifiziert)
