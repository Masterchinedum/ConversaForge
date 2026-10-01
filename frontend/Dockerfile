# syntax=docker/dockerfile:1.7
# ConversaForge web image (Next.js standalone). Build from this folder (frontend/):
#   docker build --build-arg NEXT_PUBLIC_API_WS_URL=wss://app.example.com -t conversaforge-web .
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml .npmrc ./
# Optional extra CA (TLS-intercepting build proxies): docker build --secret id=extra_ca,src=/path/ca.crt …
RUN --mount=type=secret,id=extra_ca,target=/run/secrets/extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile
COPY . .
# Public (browser) URLs are baked in at build time.
ARG NEXT_PUBLIC_API_WS_URL
# Next.js resolves rewrite destinations at build time: where the web server proxies /api/*.
ARG API_INTERNAL_URL=http://api:4000
ENV NEXT_PUBLIC_API_WS_URL=$NEXT_PUBLIC_API_WS_URL API_INTERNAL_URL=$API_INTERNAL_URL NEXT_OUTPUT=standalone
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
RUN useradd --system --uid 1001 app
WORKDIR /app
COPY --from=build --chown=app /app/.next/standalone ./
COPY --from=build --chown=app /app/.next/static ./.next/static
COPY --from=build --chown=app /app/public ./public
USER app
EXPOSE 3000
CMD ["node", "server.js"]
