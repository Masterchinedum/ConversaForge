# syntax=docker/dockerfile:1.7
# ConversaForge API + worker image. Build from this folder (backend/):
#   docker build -t conversaforge-api .
# Full bookworm image: ships OpenSSL + CA certificates (needed by Prisma engines) without apt-get.
FROM node:22-bookworm AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# Production dependencies only, with the Prisma client generated into them.
FROM base AS deps
COPY package.json pnpm-lock.yaml .npmrc ./
# Optional extra CA (TLS-intercepting build proxies): docker build --secret id=extra_ca,src=/path/ca.crt …
RUN --mount=type=secret,id=extra_ca,target=/run/secrets/extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile --prod
COPY prisma prisma
RUN npx prisma generate

FROM base AS build
COPY package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=secret,id=extra_ca,target=/run/secrets/extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
RUN useradd --system --uid 1001 app
WORKDIR /app
COPY --from=deps --chown=app /app/node_modules ./node_modules
COPY --from=build --chown=app /app/dist ./dist
COPY --chown=app package.json ./
COPY --chown=app prisma ./prisma
COPY --chown=app docker/entrypoint.sh ./entrypoint.sh
USER app
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["sh", "./entrypoint.sh"]
CMD ["api"]
