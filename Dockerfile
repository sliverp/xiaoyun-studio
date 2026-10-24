FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium ffmpeg fonts-noto-cjk fonts-liberation ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server ./server
COPY public ./public
COPY scripts ./scripts
COPY docs ./docs
COPY LICENSE THIRD-PARTY.md ./
RUN mkdir -p /data && chown -R node:node /data /app
USER node
ENV NODE_ENV=production STUDIO_HOST=0.0.0.0 PORT=18080 STUDIO_DATA_DIR=/data CHROMIUM_PATH=/usr/bin/chromium FFMPEG_PATH=/usr/bin/ffmpeg CHROMIUM_NO_SANDBOX=1
EXPOSE 18080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/main.mjs"]
