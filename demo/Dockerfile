# The live demo page (docs/demo.md). Build from the repository root:
#   docker build -f demo/Dockerfile -t harbourline-demo .
FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY demo/package.json demo/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY demo/server.mjs ./
COPY demo/lib ./lib
COPY demo/public ./public
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/demo/healthz || exit 1
CMD ["node", "server.mjs"]
