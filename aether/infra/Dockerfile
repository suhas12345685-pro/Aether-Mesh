# Build from the aether/ ROOT:  docker build -f infra/Dockerfile -t aether/infra .
FROM node:24-alpine
WORKDIR /app
COPY shared ./shared
COPY infra ./infra
RUN addgroup -S aether && adduser -S aether -G aether \
    && mkdir -p /app/data && chown -R aether:aether /app
WORKDIR /app/infra
ENV NODE_ENV=production INFRA_PORT=8090 INFRA_DB_FILE=/app/data/infra.db
USER aether
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost:8090/ready || exit 1
CMD ["node", "src/index.mjs"]
