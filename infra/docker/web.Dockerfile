# syntax=docker/dockerfile:1.7
# ConversaForge web image (Next.js standalone). Build from the repo root:
#   docker build -f infra/docker/web.Dockerfile -t conversaforge-web .
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
# Optional extra CA (TLS-intercepting build proxies): docker build --secret id=extra_ca,src=/path/ca.crt …
RUN --mount=type=secret,id=extra_ca,target=/run/secrets/extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile --filter @cf/web... --filter @cf/shared
COPY packages/shared packages/shared
COPY apps/web apps/web
# Public (browser) URLs are baked in at build time.
ARG NEXT_PUBLIC_API_WS_URL
ENV NEXT_PUBLIC_API_WS_URL=$NEXT_PUBLIC_API_WS_URL NEXT_OUTPUT=standalone
RUN pnpm --filter @cf/shared build && pnpm --filter @cf/web build

FROM base AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
RUN useradd --system --uid 1001 app
WORKDIR /app
COPY --from=build --chown=app /app/apps/web/.next/standalone ./
COPY --from=build --chown=app /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=app /app/apps/web/public ./apps/web/public
USER app
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
