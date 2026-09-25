# Third-party software

ConversaForge is proprietary. It depends on the open-source packages below (production dependencies, generated with `pnpm licenses list --prod`). All are under permissive licenses that allow commercial use; keep this file with distributions and retain upstream notices.

Notes:
- `jszip` is dual-licensed (MIT OR GPL-3.0); ConversaForge uses it under **MIT**.
- `caniuse-lite` (CC-BY-4.0) is browser-support data used at build time; attribution: Alexis Deveria, caniuse.com.
- `sharp`/libvips (LGPL) is intentionally excluded (`ignoredOptionalDependencies`; Next.js image optimization disabled).
- Docker images used at runtime (Postgres, Valkey, Caddy, Node) are separate programs under their own licenses (PostgreSQL License, BSD-3-Clause, Apache-2.0, MIT).

## (MIT AND Zlib) (1)

pako@1.0.11

## (MIT OR GPL-3.0-or-later) (1)

jszip@3.10.2

## 0BSD (1)

tslib@2.8.1

## Apache-2.0 (46)

@aws-sdk/checksums@3.1001.1, @aws-sdk/client-s3@3.1141.0, @aws-sdk/core@3.978.1, @aws-sdk/credential-provider-env@3.972.72, @aws-sdk/credential-provider-http@3.972.74, @aws-sdk/credential-provider-ini@3.973.17, @aws-sdk/credential-provider-login@3.972.79, @aws-sdk/credential-provider-node@3.972.84, @aws-sdk/credential-provider-process@3.972.72, @aws-sdk/credential-provider-sso@3.973.16, @aws-sdk/credential-provider-web-identity@3.972.78, @aws-sdk/middleware-sdk-s3@3.972.77, @aws-sdk/nested-clients@3.997.46, @aws-sdk/s3-request-presigner@3.1141.0, @aws-sdk/signature-v4-multi-region@3.996.47, @aws-sdk/token-providers@3.1138.0, @aws-sdk/types@3.974.6, @aws-sdk/xml-builder@3.972.41, @aws/lambda-invoke-store@0.3.0, @playwright/test@1.55.1, @prisma/client@6.19.3, @prisma/config@6.19.3, @prisma/debug@6.19.3, @prisma/engines-version@7.1.1-3.c2990dca591cba766e3b7ef5d9e8a84796e47ab7, @prisma/engines@6.19.3, @prisma/fetch-engine@6.19.3, @prisma/get-platform@6.19.3, @scarf/scarf@1.4.0, @smithy/core@3.35.0, @smithy/credential-provider-imds@4.5.2, @smithy/fetch-http-handler@5.8.0, @smithy/node-http-handler@4.12.1, @smithy/signature-v4@5.7.4, @smithy/types@4.19.0, @swc/helpers@0.5.15, cluster-key-slot@1.1.1, denque@2.1.0, detect-libc@2.1.2, openai@5.23.2, playwright-core@1.55.1, playwright@1.55.1, prisma@6.19.3, reflect-metadata@0.2.2, rxjs@7.8.2, swagger-ui-dist@5.32.13, typescript@5.9.3

## BSD (1)

duck@0.1.12

## BSD-2-Clause (5)

dingbat-to-unicode@1.0.2, dotenv@16.6.1, lop@0.4.2, mammoth@1.12.3, option@0.2.4

## BSD-3-Clause (7)

deepmerge-ts@8.0.2, fast-uri@3.1.8, ieee754@1.2.1, light-my-request@6.6.0, secure-json-parse@4.1.0, source-map-js@1.2.1, sprintf-js@1.0.3

## BlueOak-1.0.0 (5)

glob@13.0.6, lru-cache@11.5.3, minimatch@10.2.6, minipass@7.1.3, path-scurry@2.0.2

## CC-BY-4.0 (1)

caniuse-lite@1.0.30001812

## ISC (8)

fastq@1.20.3, inherits@2.0.4, iterare@1.2.1, picocolors@1.1.1, semver@7.8.5, setprototypeof@1.2.0, split2@4.2.0, yaml@2.9.1

## MIT (184)

@anthropic-ai/sdk@0.128.0, @babel/runtime@7.29.7, @borewit/text-codec@0.2.2, @fastify/accept-negotiator@2.1.0, @fastify/ajv-compiler@4.0.6, @fastify/busboy@3.2.2, @fastify/cookie@11.1.2, @fastify/cors@11.3.0, @fastify/deepmerge@3.2.1, @fastify/error@4.2.0, @fastify/fast-json-stringify-compiler@5.1.0, @fastify/formbody@8.0.2, @fastify/forwarded@3.0.2, @fastify/helmet@13.1.1, @fastify/merge-json-schemas@0.2.1, @fastify/middie@9.3.4, @fastify/multipart@9.4.0, @fastify/proxy-addr@5.1.1, @fastify/send@4.1.1, @fastify/static@10.1.4, @ioredis/commands@1.10.0, @lukeed/csprng@1.1.0, @lukeed/ms@2.0.2, @microsoft/tsdoc@0.16.0, @msgpackr-extract/msgpackr-extract-linux-x64@3.0.4, @nestjs/bull-shared@11.0.5, @nestjs/bullmq@11.0.5, @nestjs/common@11.2.6, @nestjs/core@11.2.6, @nestjs/mapped-types@2.1.1, @nestjs/platform-fastify@11.2.6, @nestjs/platform-ws@11.2.6, @nestjs/swagger@11.4.7, @nestjs/websockets@11.2.6, @next/env@15.5.26, @next/swc-linux-x64-gnu@15.5.26, @node-rs/argon2-linux-x64-gnu@2.2.1, @node-rs/argon2@2.2.1, @pinojs/redact@0.4.0, @stablelib/base64@1.0.1, @standard-schema/spec@1.1.0, @tokenizer/inflate@0.4.1, @tokenizer/token@0.3.0, @xmldom/xmldom@0.8.15, abstract-logging@2.0.1, ajv-formats@3.0.1, ajv@8.20.0, argparse@1.0.10, atomic-sleep@1.0.0, avvio@9.3.0, balanced-match@4.0.4, base64-js@0.0.8, bluebird@3.4.7, bowser@2.14.1, brace-expansion@5.0.12, brotli@1.3.3, browserify-zlib@0.2.0, bullmq@5.81.5, c12@3.1.0, chokidar@4.0.3, citty@0.1.6, client-only@0.0.1, clone@2.1.2, clsx@2.1.1, confbox@0.2.4, consola@3.4.2, content-disposition@3.0.0, cookie@1.1.1, core-util-is@1.0.3, cron-parser@4.9.0, crypto-js@4.2.0, debug@4.4.3, defu@6.1.7, depd@2.0.0, dequal@2.0.3, destr@2.0.5, dfa@1.2.0, effect@3.21.0, empathic@2.0.0, escape-html@1.0.3, exsolve@1.1.1, fast-check@3.23.2, fast-decode-uri-component@1.0.1, fast-deep-equal@3.1.3, fast-json-stringify@7.0.1, fast-querystring@1.1.2, fast-safe-stringify@2.1.1, fastify-plugin@5.1.0, fastify@5.12.5, file-type@21.3.4, find-my-way@9.7.0, fontkit@2.0.4, giget@2.0.0, helmet@8.3.0, http-errors@2.0.1, immediate@3.0.6, ioredis@5.11.1, ipaddr.js@2.5.0, isarray@1.0.0, jiti@2.7.0, jpeg-exif@1.1.4, js-yaml@5.3.0, json-schema-ref-resolver@3.0.0, json-schema-to-ts@3.1.1, json-schema-traverse@1.0.0, lie@3.3.0, linebreak@1.1.0, load-esm@1.0.3, lodash@4.18.1, luxon@3.7.2, mime@3.0.0, ms@2.1.3, msgpackr-extract@3.0.4, msgpackr@2.0.5, nanoid@3.3.19, next@15.5.26, node-abort-controller@3.1.1, node-fetch-native@1.6.7, node-gyp-build-optional-packages@5.2.2, nypm@0.6.10, object-hash@3.0.0, ohash@2.0.12, on-exit-leak-free@2.1.2, pako@0.2.9, path-is-absolute@1.0.1, path-to-regexp@8.4.2, pathe@2.0.3, pdfkit@0.17.2, perfect-debounce@1.0.0, pino-abstract-transport@3.0.0, pino-std-serializers@7.1.0, pino@10.3.1, pkg-types@2.3.3, png-js@1.1.0, postcss@8.5.28, process-nextick-args@2.0.1, process-warning@4.0.1, pure-rand@6.1.0, quick-format-unescaped@4.0.4, rc9@2.1.2, react-dom@19.1.1, react@19.1.1, readable-stream@2.3.8, readdirp@4.1.2, real-require@0.2.0, redis-errors@1.2.0, redis-parser@3.0.0, require-from-string@2.0.2, restructure@3.0.2, ret@0.5.0, reusify@1.1.0, rfdc@1.4.1, safe-buffer@5.1.2, safe-regex2@5.1.1, safe-stable-stringify@2.5.0, scheduler@0.26.0, set-cookie-parser@2.7.2, setimmediate@1.0.5, sonic-boom@4.2.1, standard-as-callback@2.1.0, standardwebhooks@1.1.1, statuses@2.0.2, string_decoder@1.1.1, strtok3@10.3.5, styled-jsx@5.1.6, swr@2.3.6, thread-stream@4.2.0, tiny-inflate@1.0.3, tinyexec@1.3.1, toad-cache@3.7.4, toidentifier@1.0.1, token-types@6.1.2, ts-algebra@2.0.0, uid@2.0.2, uint8array-extras@1.5.0, underscore@1.13.8, unicode-properties@1.4.1, unicode-trie@2.0.0, unpdf@1.8.1, use-sync-external-store@1.7.0, util-deprecate@1.0.2, ws@8.21.2, xmlbuilder@10.1.1, zod@3.25.76

## MIT-0 (1)

nodemailer@10.0.10

## Python-2.0 (1)

argparse@2.0.1

## Unlicense (1)

fast-sha256@1.3.0
