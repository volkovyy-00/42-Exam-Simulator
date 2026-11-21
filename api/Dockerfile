# Service "web": Fastify API + built SPA. Build context: repo root.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY contract/package.json contract/
COPY api/package.json api/
COPY web/package.json web/
COPY grader/dispatcher/package.json grader/dispatcher/
RUN npm ci
COPY contract contract
COPY web web
RUN npm run build -w web

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY contract/package.json contract/
COPY api/package.json api/
RUN npm ci --omit=dev --workspace api --include-workspace-root=false

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8042 DATA_DIR=/data CONTENT_DIR=/content WEB_DIST=/app/web/dist
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/package.json ./
COPY contract contract
COPY api api
COPY --from=build /app/web/dist web/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8042
CMD ["node", "api/src/server.ts"]
