# NanoClaw Orchestrator Container
#
# Runs the main NanoClaw process that connects to messaging channels
# and spawns agent containers for message processing.
#
# SUB-CONTAINERS
# --------------
# NanoClaw spawns Docker containers ("agent containers") for each message.
# These are sibling containers on the host Docker daemon, NOT nested containers.
# This requires:
#   1. The Docker socket mounted: -v /var/run/docker.sock:/var/run/docker.sock
#   2. The working directory path must match between host and container,
#      because sub-container volume mounts reference host paths.
#      Use: -v ${PWD}:${PWD} -w ${PWD}
#   3. The agent container image (nanoclaw-agent:latest) must be built on the
#      host first: ./container/build.sh
#
# See docker-compose.yml for the recommended way to run this.

FROM node:22-slim

# Install Docker CLI (not the daemon — we use the host's Docker via socket mount)
RUN apt-get update && apt-get install -y \
    ca-certificates \
    curl \
    gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production dependencies (better-sqlite3 needs build tools in node:22-slim)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Copy container build context (agent-runner source is mounted into sub-containers)
COPY container/ ./container/

# Create runtime directories (overridden by bind mounts at runtime)
RUN mkdir -p store data groups/main groups/global

ENTRYPOINT ["node", "dist/index.js"]
