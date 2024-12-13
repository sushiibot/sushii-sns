FROM oven/bun:1.1.38-debian

# Install curl
RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY ./package.json ./bun.lockb ./

# Install dependencies
RUN bun install --frozen-lockfile --production

COPY . ./

HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD [ "curl", "-f" "http://localhost:8080/v1/health" ]

USER bun
EXPOSE 8080/tcp
ENTRYPOINT [ "bun", "run", "./src/index.ts" ]
