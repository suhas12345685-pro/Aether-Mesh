# Build from the aether/ ROOT:  docker build -f platform/Dockerfile -t aether/platform .
FROM node:24-alpine
WORKDIR /app
COPY shared ./shared
COPY platform ./platform
RUN addgroup -S aether && adduser -S aether -G aether \
    && mkdir -p /app/data && chown -R aether:aether /app
WORKDIR /app/platform
ENV NODE_ENV=production PLATFORM_PORT=8080 PLATFORM_DB_FILE=/app/data/platform.db
USER aether
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost:8080/ready || exit 1
CMD ["node", "src/server.mjs"]
