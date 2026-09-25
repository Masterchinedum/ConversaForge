# syntax=docker/dockerfile:1.7
# ConversaForge API + worker image. Build from the repo root:
#   docker build -f infra/docker/api.Dockerfile -t conversaforge-api .
# Full bookworm image: ships OpenSSL + CA certificates (needed by Prisma engines) without apt-get.
FROM node:22-bookworm AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# Optional extra CA (TLS-intercepting build proxies): docker build --secret id=extra_ca,src=/path/ca.crt …
RUN --mount=type=secret,id=extra_ca,target=/run/secrets/extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm install --frozen-lockfile --filter @cf/api... --filter @cf/shared
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @cf/shared build && pnpm --filter @cf/api build
RUN --mount=type=secret,id=extra_ca,target=/run/secrets/extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    pnpm deploy --filter @cf/api --prod --legacy /out && cp -r apps/api/dist /out/dist && cp -r apps/api/prisma /out/prisma \
 && cd /out && npx prisma generate

FROM base AS runtime
ENV NODE_ENV=production
RUN useradd --system --uid 1001 app
WORKDIR /app
COPY --from=build --chown=app /out ./
COPY --chown=app infra/docker/api-entrypoint.sh ./entrypoint.sh
USER app
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["sh", "./entrypoint.sh"]
CMD ["api"]
