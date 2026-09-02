# Ambiente determinístico pro backend: Node + python3 + ffmpeg + yt-dlp mais recente.
FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 ffmpeg ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp mais recente (standalone) — a versão bundled do pacote fica velha e é bloqueada.
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=8080 YTDLP_PATH=/usr/local/bin/yt-dlp
EXPOSE 8080
CMD ["node", "server.js"]
