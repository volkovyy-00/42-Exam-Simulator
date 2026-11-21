# grader-dispatcher. Build context: repo root.
FROM docker:28-cli AS dockercli

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY package.json package-lock.json ./
COPY contract/package.json contract/
COPY grader/dispatcher/package.json grader/dispatcher/
RUN npm ci --omit=dev --workspace grader/dispatcher --include-workspace-root=false
COPY contract contract
COPY grader/dispatcher grader/dispatcher
ENV NODE_ENV=production DISPATCHER_HOST=0.0.0.0 DISPATCHER_PORT=9000 CONTENT_DIR=/content
EXPOSE 9000
# Runs as root to reach /var/run/docker.sock. It never runs student code itself.
CMD ["node", "grader/dispatcher/src/server.ts"]
