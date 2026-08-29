# media-intel: MCP server for media understanding.
# Multi-stage: build TypeScript, then a slim runtime with the external binaries
# the tools shell out to (ffmpeg with freetype, yt-dlp, whisper.cpp CLI, tesseract).
# Models are NOT baked in; mount or download them into /cache/models (see README).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM debian:bookworm-slim AS whisper
RUN apt-get update && apt-get install -y --no-install-recommends git build-essential cmake ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && git clone --depth 1 https://github.com/ggml-org/whisper.cpp /src \
    && cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
    && cmake --build /src/build --config Release -j"$(nproc)" --target whisper-cli \
    && install -m 0755 /src/build/bin/whisper-cli /usr/local/bin/whisper-cli \
    && find /src/build -name 'lib*.so*' -exec install -m 0755 {} /usr/local/lib/ \;

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    MEDIA_INTEL_CACHE_DIR=/cache \
    MEDIA_INTEL_OCR_LANGUAGES=deu+eng
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg tesseract-ocr tesseract-ocr-deu tesseract-ocr-eng python3 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod 0755 /usr/local/bin/yt-dlp
COPY --from=whisper /usr/local/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /usr/local/lib/ /usr/local/lib/
RUN ldconfig
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json README.md LICENSE ./
RUN mkdir -p /cache && chown node:node /cache
USER node
VOLUME ["/cache"]
# stdio transport: the MCP client attaches to this process's stdin/stdout.
ENTRYPOINT ["node", "dist/cli.js"]
