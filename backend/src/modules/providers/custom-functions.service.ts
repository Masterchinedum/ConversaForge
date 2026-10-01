import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type CustomFunction } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit/audit.service';
import type { Principal } from '../../common/auth/principal';
import { userIdOf } from '../../common/auth/principal';
import { CryptoService } from '../../common/crypto/crypto.service';
import { Errors } from '../../common/http/errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { validateArgs, validateParametersSchema } from './json-schema';
import { defaultGuardDeps, guardedRequest, normalizeHost, SsrfError, validateOutboundUrl, type GuardDeps } from './ssrf-guard';

export const MAX_FUNCTION_TIMEOUT_MS = 15_000;
export const MAX_FUNCTION_RESPONSE_BYTES = 64 * 1024;
export const SIGNATURE_HEADER = 'X-ConversaForge-Signature';
export const MAX_FUNCTIONS_PER_WORKSPACE = 100;

/** Headers users may not set (transport-level or ours). */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
  'expect',
  'x-conversaforge-signature',
  'x-conversaforge-timestamp',
  'x-conversaforge-function',
]);

const HeaderName = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/, 'Invalid header name');
const HeaderValue = z.string().max(4096).refine((v) => !/[\r\n\0]/.test(v), 'Header values cannot contain line breaks');

const hostEntry = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(\*\.)?[a-z0-9.-]{1,253}$/, 'Invalid host');

export const CustomFunctionInput = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{1,63}$/, 'Name must be snake_case: lowercase letters, digits and underscores, starting with a letter (2–64 chars)'),
  description: z.string().trim().min(1).max(1000),
  parametersSchema: z.record(z.unknown()),
  url: z.string().trim().max(2048),
  method: z.enum(['GET', 'POST']).default('POST'),
  /** Plain header map. On update, a value of "••••" (or omitting the key with keepHeaders) keeps the stored value. */
  headers: z.record(HeaderName, HeaderValue).optional(),
  allowedHosts: z.array(hostEntry).max(10).optional(),
  timeoutMs: z.number().int().min(500).max(MAX_FUNCTION_TIMEOUT_MS).default(8000),
  enabled: z.boolean().default(true),
});
export type CustomFunctionInput = z.infer<typeof CustomFunctionInput>;
export const CustomFunctionPatch = CustomFunctionInput.partial();
export type CustomFunctionPatch = z.infer<typeof CustomFunctionPatch>;

export const MASK = '••••';

export interface ExecuteContext {
  sessionId?: string | null;
  scenarioVersionId?: string | null;
  /** Tool call id from the model; with sessionId, a ToolEvent RESULT/ERROR is logged (idempotently). */
  toolCallId?: string | null;
  /** Set false when the caller (runtime) logs its own ToolEvent. Default: log when sessionId + toolCallId are given. */
  logToolEvent?: boolean;
  /** Dry run from the settings page (recorded in the audit log, not as a ToolEvent). */
  test?: boolean;
}

export interface ExecuteResult {
  ok: boolean;
  status: number | null;
  result?: unknown;
  error?: string;
  errorCode?: string;
  durationMs: number;
  functionName?: string;
}

/**
 * Workspace custom functions: HTTPS webhooks the agent can call as tools.
 * Execution is server-side only, SSRF-guarded and HMAC-signed.
 */
@Injectable()
export class CustomFunctionsService {
  private readonly logger = new Logger('CustomFunctions');
  /** Overridable in tests (e.g. to reach a local TLS server). */
  guardDeps: GuardDeps = defaultGuardDeps;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  // ───────────────────────────── Contract for the runtime (B) ─────────────────────────────

  /**
   * Execute a function with model-provided arguments. Never throws for execution problems — returns
   * `{ ok: false, error }` so the runtime can hand a tool error back to the model.
   * Request: POST (or GET with `?arguments=<json>`) JSON `{ arguments, context: { sessionId, workspaceId, functionName, scenarioVersionId, timestamp } }`
   * Headers: `X-ConversaForge-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>` (GET signs the query string value).
   */
  async execute(workspaceId: string, functionId: string, args: unknown, ctx: ExecuteContext = {}): Promise<ExecuteResult> {
    const started = Date.now();
    const fn = await this.prisma.customFunction.findFirst({ where: { id: String(functionId ?? ''), workspaceId, deletedAt: null } });
    if (!fn) return this.finish(workspaceId, null, ctx, args, { ok: false, status: null, error: 'Function not found', errorCode: 'not_found', durationMs: 0 });
    if (!fn.enabled && !ctx.test) {
      return this.finish(workspaceId, fn, ctx, args, { ok: false, status: null, error: 'This function is disabled', errorCode: 'disabled', durationMs: 0 });
    }
    const issues = validateArgs(fn.parametersSchema, args ?? {});
    if (issues.length) {
      return this.finish(workspaceId, fn, ctx, args, {
        ok: false,
        status: null,
        error: `Invalid arguments: ${issues.map((i) => `${i.path || '(root)'} ${i.message}`).join('; ')}`.slice(0, 1000),
        errorCode: 'invalid_arguments',
        durationMs: 0,
      });
    }

    let headers: Record<string, string> = {};
    if (fn.encryptedHeaders) {
      try {
        headers = JSON.parse(this.crypto.decrypt(fn.encryptedHeaders));
      } catch {
        return this.finish(workspaceId, fn, ctx, args, { ok: false, status: null, error: 'Stored headers could not be decrypted', errorCode: 'config', durationMs: 0 });
      }
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({
      arguments: args ?? {},
      context: {
        workspaceId,
        sessionId: ctx.sessionId ?? null,
        scenarioVersionId: ctx.scenarioVersionId ?? null,
        functionName: fn.name,
        test: !!ctx.test,
        timestamp,
      },
    });
    let url = fn.url;
    let body: string | undefined = payload;
    if (fn.method === 'GET') {
      const u = new URL(fn.url);
      u.searchParams.set('payload', payload);
      url = u.toString();
      body = undefined;
    }
    const secret = this.signingSecret(fn);
    const signature = this.crypto.hmacHex(`${timestamp}.${payload}`, secret);
    const outHeaders: Record<string, string> = {
      ...Object.fromEntries(Object.entries(headers).filter(([k]) => !RESERVED_HEADERS.has(k.toLowerCase()))),
      accept: 'application/json, text/plain;q=0.8',
      'user-agent': 'ConversaForge-Functions/1.0',
      [SIGNATURE_HEADER]: `t=${timestamp},v1=${signature}`,
      'X-ConversaForge-Function': fn.name,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    };

    try {
      const res = await guardedRequest(
        {
          url,
          method: fn.method === 'GET' ? 'GET' : 'POST',
          headers: outHeaders,
          body,
          allowedHosts: fn.allowedHosts.length ? fn.allowedHosts : [new URL(fn.url).hostname],
          timeoutMs: Math.min(fn.timeoutMs, MAX_FUNCTION_TIMEOUT_MS),
          maxResponseBytes: MAX_FUNCTION_RESPONSE_BYTES,
        },
        this.guardDeps,
      );
      const text = res.body.toString('utf8');
      const ct = String(res.headers['content-type'] ?? '');
      let result: unknown = text;
      if (/json/i.test(ct) || /^\s*[{[]/.test(text)) {
        try {
          result = JSON.parse(text);
        } catch {
          result = text;
        }
      }
      const ok = res.status >= 200 && res.status < 300;
      return this.finish(workspaceId, fn, ctx, args, {
        ok,
        status: res.status,
        ...(ok ? { result } : { error: `The endpoint returned HTTP ${res.status}`, errorCode: 'http_error', result }),
        durationMs: Date.now() - started,
      });
    } catch (e: any) {
      const err = e instanceof SsrfError ? e : new SsrfError('The request failed', 'network');
      return this.finish(workspaceId, fn, ctx, args, { ok: false, status: null, error: err.message, errorCode: err.code, durationMs: Date.now() - started });
    }
  }

  /** Tool specs for the functions a scenario version grants (enabled, same workspace). */
  async toolSpecs(workspaceId: string, functionIds: string[]) {
    if (!functionIds.length) return [];
    const rows = await this.prisma.customFunction.findMany({
      where: { workspaceId, id: { in: functionIds.slice(0, 50) }, deletedAt: null, enabled: true },
      orderBy: { name: 'asc' },
    });
    return rows.map((f) => ({ id: f.id, name: f.name, description: f.description, inputSchema: f.parametersSchema as Record<string, unknown> }));
  }

  // ───────────────────────────── CRUD ─────────────────────────────

  async list(workspaceId: string) {
    const rows = await this.prisma.customFunction.findMany({ where: { workspaceId, deletedAt: null }, orderBy: { name: 'asc' } });
    return { data: rows.map((f) => this.present(f)) };
  }

  async get(workspaceId: string, id: string) {
    return this.present(await this.find(workspaceId, id));
  }

  async create(workspaceId: string, principal: Principal | null, input: CustomFunctionInput) {
    const n = await this.prisma.customFunction.count({ where: { workspaceId, deletedAt: null } });
    if (n >= MAX_FUNCTIONS_PER_WORKSPACE) throw Errors.quota(`A workspace can have at most ${MAX_FUNCTIONS_PER_WORKSPACE} functions`);
    const data = this.validate(input);
    await this.assertNameFree(workspaceId, data.name);
    const headers = input.headers ?? {};
    const fn = await this.prisma.customFunction.create({
      data: {
        workspaceId,
        name: data.name,
        description: data.description,
        parametersSchema: data.parametersSchema as Prisma.InputJsonValue,
        url: data.url,
        method: data.method,
        encryptedHeaders: Object.keys(headers).length ? this.crypto.encrypt(JSON.stringify(cleanHeaders(headers))) : null,
        allowedHosts: data.allowedHosts,
        timeoutMs: data.timeoutMs,
        enabled: data.enabled,
        createdById: userIdOf(principal),
      },
    });
    await this.audit.log({
      workspaceId,
      principal,
      action: 'function.create',
      targetType: 'CustomFunction',
      targetId: fn.id,
      metadata: { name: fn.name, url: fn.url, method: fn.method, allowedHosts: fn.allowedHosts, headerNames: Object.keys(headers) },
    });
    return this.present(fn);
  }

  async update(workspaceId: string, principal: Principal | null, id: string, patch: CustomFunctionPatch) {
    const fn = await this.find(workspaceId, id);
    const merged = this.validate({
      name: patch.name ?? fn.name,
      description: patch.description ?? fn.description,
      parametersSchema: (patch.parametersSchema ?? fn.parametersSchema) as Record<string, unknown>,
      url: patch.url ?? fn.url,
      method: (patch.method ?? fn.method) as 'GET' | 'POST',
      // If the URL changes and hosts are not given, re-derive them from the new URL.
      allowedHosts: patch.allowedHosts ?? (patch.url && patch.url !== fn.url ? undefined : fn.allowedHosts),
      timeoutMs: patch.timeoutMs ?? fn.timeoutMs,
      enabled: patch.enabled ?? fn.enabled,
    });
    if (merged.name !== fn.name) await this.assertNameFree(workspaceId, merged.name, fn.id);

    let encryptedHeaders: string | null | undefined;
    if (patch.headers !== undefined) {
      const existing: Record<string, string> = fn.encryptedHeaders ? safeJson(this.crypto.decrypt(fn.encryptedHeaders)) : {};
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(patch.headers)) {
        // "••••" keeps the stored value for that header (UI shows masked values).
        if (v === MASK) {
          const prev = Object.entries(existing).find(([ek]) => ek.toLowerCase() === k.toLowerCase());
          if (prev) next[k] = prev[1];
        } else next[k] = v;
      }
      encryptedHeaders = Object.keys(next).length ? this.crypto.encrypt(JSON.stringify(cleanHeaders(next))) : null;
    }
    const updated = await this.prisma.customFunction.update({
      where: { id: fn.id },
      data: {
        name: merged.name,
        description: merged.description,
        parametersSchema: merged.parametersSchema as Prisma.InputJsonValue,
        url: merged.url,
        method: merged.method,
        allowedHosts: merged.allowedHosts,
        timeoutMs: merged.timeoutMs,
        enabled: merged.enabled,
        ...(encryptedHeaders !== undefined ? { encryptedHeaders } : {}),
      },
    });
    await this.audit.log({
      workspaceId,
      principal,
      action: 'function.update',
      targetType: 'CustomFunction',
      targetId: fn.id,
      metadata: {
        changed: Object.keys(patch).filter((k) => k !== 'headers'),
        headersChanged: patch.headers !== undefined,
        headerNames: patch.headers ? Object.keys(patch.headers) : undefined,
        url: updated.url,
        enabled: updated.enabled,
      },
    });
    return this.present(updated);
  }

  async remove(workspaceId: string, principal: Principal | null, id: string) {
    const fn = await this.find(workspaceId, id);
    // Free the unique name for reuse; keep the row for audit history.
    await this.prisma.customFunction.update({
      where: { id: fn.id },
      data: { deletedAt: new Date(), enabled: false, name: `${fn.name}__deleted_${fn.id}`.slice(0, 190), encryptedHeaders: null },
    });
    await this.audit.log({ workspaceId, principal, action: 'function.delete', targetType: 'CustomFunction', targetId: fn.id, metadata: { name: fn.name } });
    return { ok: true };
  }

  async test(workspaceId: string, principal: Principal | null, id: string, args: unknown) {
    const fn = await this.find(workspaceId, id);
    const res = await this.execute(workspaceId, fn.id, args, { test: true });
    await this.audit.log({
      workspaceId,
      principal,
      action: 'function.test',
      targetType: 'CustomFunction',
      targetId: fn.id,
      metadata: { ok: res.ok, status: res.status, errorCode: res.errorCode, durationMs: res.durationMs },
    });
    return res;
  }

  /** Reveal the signing secret so the receiver can verify X-ConversaForge-Signature. */
  async revealSigningSecret(workspaceId: string, principal: Principal | null, id: string) {
    const fn = await this.find(workspaceId, id);
    await this.audit.log({ workspaceId, principal, action: 'function.signing_secret.view', targetType: 'CustomFunction', targetId: fn.id });
    return { secret: this.signingSecret(fn), header: SIGNATURE_HEADER, scheme: 'v1=HMAC-SHA256(secret, `${t}.${rawBody}`) hex; t = unix seconds' };
  }

  signingSecret(fn: Pick<CustomFunction, 'id' | 'workspaceId'>): string {
    return `cffs_${this.crypto.hmac(`custom-function:${fn.workspaceId}:${fn.id}`)}`;
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private validate(input: Omit<CustomFunctionInput, 'headers' | 'allowedHosts'> & { allowedHosts?: string[] }) {
    const parsed = CustomFunctionInput.omit({ headers: true }).safeParse(input);
    if (!parsed.success) {
      throw Errors.validation('Invalid function', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    const data = parsed.data;
    const schemaIssues = validateParametersSchema(data.parametersSchema);
    if (schemaIssues.length) {
      throw Errors.validation('Invalid parameters schema', schemaIssues.map((i) => ({ path: `parametersSchema${i.path ? '.' + i.path : ''}`, message: i.message })));
    }
    let u: URL;
    try {
      u = validateOutboundUrl(data.url);
    } catch (e: any) {
      throw Errors.validation(e?.message ?? 'Invalid URL', [{ path: 'url', message: e?.message ?? 'Invalid URL' }]);
    }
    const urlHost = normalizeHost(u.hostname);
    const allowedHosts = [...new Set((data.allowedHosts?.length ? data.allowedHosts : [urlHost]).map(normalizeHost))];
    // The configured URL itself must be reachable under the allowlist.
    const matches = allowedHosts.some((h) => h === urlHost || (h.startsWith('*.') && urlHost.endsWith(h.slice(1))));
    if (!matches) throw Errors.validation('The URL host must be included in allowed hosts', [{ path: 'allowedHosts', message: `Add "${urlHost}"` }]);
    for (const h of allowedHosts) {
      if (h === '*' || h === '*.' || /^\*\.[a-z0-9-]+$/.test(h)) {
        throw Errors.validation('Wildcard hosts must include a registrable domain (e.g. *.example.com)', [{ path: 'allowedHosts', message: h }]);
      }
    }
    return { ...data, url: u.toString(), allowedHosts };
  }

  private async assertNameFree(workspaceId: string, name: string, exceptId?: string) {
    const clash = await this.prisma.customFunction.findFirst({ where: { workspaceId, name, deletedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) } });
    if (clash) throw Errors.conflict(`A function named "${name}" already exists`);
  }

  private async find(workspaceId: string, id: string) {
    if (!id || id.length > 64) throw Errors.notFound('Function');
    const fn = await this.prisma.customFunction.findFirst({ where: { id, workspaceId, deletedAt: null } });
    if (!fn) throw Errors.notFound('Function');
    return fn;
  }

  private present(fn: CustomFunction) {
    let headerNames: string[] = [];
    if (fn.encryptedHeaders) {
      try {
        headerNames = Object.keys(JSON.parse(this.crypto.decrypt(fn.encryptedHeaders)));
      } catch {
        headerNames = [];
      }
    }
    return {
      id: fn.id,
      name: fn.name,
      description: fn.description,
      parametersSchema: fn.parametersSchema,
      url: fn.url,
      method: fn.method,
      /** Header values are never returned; masked for display. */
      headers: Object.fromEntries(headerNames.map((h) => [h, MASK])),
      allowedHosts: fn.allowedHosts,
      timeoutMs: fn.timeoutMs,
      enabled: fn.enabled,
      createdAt: fn.createdAt,
      updatedAt: fn.updatedAt,
    };
  }

  private async finish(workspaceId: string, fn: CustomFunction | null, ctx: ExecuteContext, args: unknown, res: ExecuteResult): Promise<ExecuteResult> {
    const out: ExecuteResult = { ...res, functionName: fn?.name };
    if (!res.ok) this.logger.debug(`Function ${fn?.name ?? '?'} failed: ${res.errorCode}`);
    const shouldLog = ctx.logToolEvent !== false && !ctx.test && !!ctx.sessionId && !!ctx.toolCallId;
    if (shouldLog) {
      try {
        const session = await this.prisma.session.findFirst({ where: { id: ctx.sessionId!, workspaceId }, select: { id: true } });
        if (session) {
          await this.prisma.toolEvent.createMany({
            data: [
              {
                sessionId: session.id,
                toolId: fn ? `fn:${fn.name}` : `fn:${String(res.functionName ?? 'unknown')}`,
                toolCallId: String(ctx.toolCallId).slice(0, 200),
                kind: res.ok ? 'RESULT' : 'ERROR',
                actor: 'SYSTEM',
                args: (args ?? {}) as Prisma.InputJsonValue,
                result: truncateJson({ ok: res.ok, status: res.status, result: res.result, error: res.error, durationMs: res.durationMs }),
              },
            ],
            skipDuplicates: true,
          });
        }
      } catch (e: any) {
        this.logger.warn(`Could not log ToolEvent: ${e?.message}`);
      }
    }
    return out;
  }
}

function cleanHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (RESERVED_HEADERS.has(k.toLowerCase())) throw Errors.validation(`Header "${k}" cannot be set`, [{ path: `headers.${k}`, message: 'Reserved header' }]);
    out[k] = v;
  }
  if (Object.keys(out).length > 20) throw Errors.validation('At most 20 headers are allowed');
  return out;
}

function safeJson(s: string): Record<string, string> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function truncateJson(v: unknown): Prisma.InputJsonValue {
  const s = JSON.stringify(v ?? null);
  if (s.length <= 32_000) return JSON.parse(s);
  return { truncated: true, preview: s.slice(0, 32_000) };
}
