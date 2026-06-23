# Build from the aether/ ROOT:  docker build -f supervisor/Dockerfile -t aether/supervisor .
# The supervisor spawns Aether Core (Python) workers, so the image carries both
# the Node runtime and Python + the core package.
FROM node:24-alpine
RUN apk add --no-cache python3
WORKDIR /app
COPY shared ./shared
COPY supervisor ./supervisor
COPY core ./core
RUN addgroup -S aether && adduser -S aether -G aether && chown -R aether:aether /app
WORKDIR /app/supervisor
ENV NODE_ENV=production AETHER_CORE_CWD=/app/core PYTHON_BIN=python3 SUPERVISOR_HEALTH_PORT=8091
USER aether
EXPOSE 8091
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost:8091/health || exit 1
CMD ["node", "src/supervisor.mjs"]
