# Multi-stage build for apps/web.
#
# Stages
#   deps   — install workspace dependencies via pnpm.
#   build  — generate Prisma client + compile Next.
#   runner — minimal image that serves the built app on :3000.
#
# Build context is the repo root (see hosting/docker-compose.yml).

FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
# Workspace manifests first so `pnpm install` can be cached when only app
# code (not deps) changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/catalog/package.json ./packages/catalog/
COPY packages/db/package.json ./packages/db/
COPY packages/plot/package.json ./packages/plot/
COPY packages/plot-gen/package.json ./packages/plot-gen/
COPY packages/town-cli/package.json ./packages/town-cli/
COPY packages/types/package.json ./packages/types/
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY --from=deps /app /app
COPY . .
# Prisma client must be generated against the schema before Next compiles.
RUN pnpm --filter @town/db exec prisma generate --schema=./prisma/schema.prisma
RUN pnpm --filter @town/web build

FROM node:22-alpine AS runner
RUN corepack enable && corepack prepare pnpm@latest --activate
# Postcard renderer (@napi-rs/canvas / Skia) does its own text layout
# but resolves font families through fontconfig. Alpine ships without
# any fonts, so the town sign's fillText would render blank glyphs in
# production. Pull in fontconfig + a wide-coverage sans-serif family so
# the canvas can satisfy the "sans-serif" / "ui-sans-serif" fallback
# chain the sign uses. noto-emoji is optional, but cheap, and means
# the "→" arrow keeps rendering.
RUN apk add --no-cache fontconfig font-noto font-noto-emoji \
    && fc-cache -f
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=build /app /app
EXPOSE 3000
# Apply any pending Prisma migrations against DATABASE_URL before booting
# Next. `migrate deploy` is the production-safe runner: applies pending
# migrations only, never prompts, never resets the DB. We call prisma
# directly (not via the @town/db `db:deploy` script) because that script
# wraps in dotenv-cli -e ../../.env, and the container loads env vars from
# docker-compose, not a file.
CMD ["sh", "-c", "pnpm --filter @town/db exec prisma migrate deploy --schema=./prisma/schema.prisma && pnpm --filter @town/web start"]
