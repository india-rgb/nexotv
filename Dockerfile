FROM node:22-alpine

WORKDIR /app

# Build tools for native modules (better-sqlite3)
RUN apk add --no-cache python3 build-base

# Install a pinned pnpm version so future pnpm releases do not change the
# required Node.js version during Docker builds.
RUN npm install -g pnpm@10.34.1

# Install ALL workspace deps (backend native modules + frontend Vue toolchain)
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/
RUN pnpm install --ignore-scripts=false

# Remove build tools after native compilation
RUN apk del python3 build-base

# Build frontend (Vue + Vite)
COPY packages/frontend/ ./packages/frontend/
RUN pnpm --filter @nexotv/frontend build

# Build backend (TypeScript)
COPY packages/backend/ ./packages/backend/
RUN pnpm --filter @nexotv/backend build

# Create runtime directories.
# `config/` is mounted by compose at runtime and is not required at build time.
RUN mkdir -p /app/config /app/data

EXPOSE 7000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD wget -qO- http://localhost:7000/health || exit 1

CMD ["node", "packages/backend/dist/server.js"]
