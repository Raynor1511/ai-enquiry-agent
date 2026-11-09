# Build from the repository root (the image needs seed/data):
#   docker build -f mcp-server/Dockerfile -t harbourline-mcp .

FROM node:22-alpine AS build
WORKDIR /app/mcp-server
COPY mcp-server/package.json mcp-server/package-lock.json ./
RUN npm ci
COPY mcp-server/tsconfig.json mcp-server/tsconfig.build.json ./
COPY mcp-server/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    HOST=0.0.0.0 \
    PORT=3333 \
    SEED_DATA_DIR=/app/seed/data
WORKDIR /app/mcp-server
COPY --from=build /app/mcp-server/node_modules ./node_modules
COPY --from=build /app/mcp-server/dist ./dist
COPY mcp-server/package.json ./
COPY seed/data /app/seed/data
USER node
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:3333/health || exit 1
CMD ["node", "dist/index.js"]
