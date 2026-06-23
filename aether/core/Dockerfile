# Build from the aether/ ROOT:  docker build -f core/Dockerfile -t aether/core .
FROM python:3.13-slim
WORKDIR /app
COPY core ./core
RUN useradd --create-home aether && mkdir -p /app/core/workspace && chown -R aether /app
WORKDIR /app/core
ENV NODE_ENV=production AETHER_LOG_JSON=true PYTHONUNBUFFERED=1
USER aether
# The core runs on the stdlib alone; `-m aether_core` resolves from this cwd.
CMD ["python", "-m", "aether_core", "run"]
