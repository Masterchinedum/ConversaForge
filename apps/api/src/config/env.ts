import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { z } from 'zod';

/** Load `.env` from the working directory (dev convenience). Real environment variables win. */
function loadDotEnv() {
  const file = process.env.ENV_FILE ?? '.env';
  if (!existsSync(file)) return;
  const parsed = parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
  for (const [k, v] of Object.entries(parsed)) if (process.env[k] === undefined) process.env[k] = v;
}

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

/**
 * All configuration comes from environment variables, validated once at boot.
 * See /.env.example for documentation of each variable.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  WEB_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
  /** Extra origins allowed for CORS / embeds (comma separated). */
  CORS_ORIGINS: z.string().default(''),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  /** 32-byte key (base64 or hex) for AES-256-GCM encryption of provider secrets. */
  ENCRYPTION_KEY: z.string().min(32),
  /** HMAC secret for signed media URLs and misc tokens. */
  SIGNING_SECRET: z.string().min(32),
  COOKIE_SECURE: bool,
  SESSION_TTL_DAYS: z.coerce.number().default(30),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool,

  // ── AI providers (all optional; workspace-level keys in ProviderConnection take precedence) ──
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_LIVE_MODEL: z.string().default('claude-opus-5'),
  ANTHROPIC_ANALYSIS_MODEL: z.string().default('claude-opus-5'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_LIVE_MODEL: z.string().default('gpt-4.1-mini'),
  OPENAI_ANALYSIS_MODEL: z.string().default('gpt-4.1'),
  OPENAI_REALTIME_MODEL: z.string().default('gpt-realtime'),
  OPENAI_TTS_MODEL: z.string().default('gpt-4o-mini-tts'),
  OPENAI_STT_MODEL: z.string().default('gpt-4o-mini-transcribe'),
  DEEPGRAM_API_KEY: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().optional(),
  /**
   * When no real provider is configured, fall back to the clearly-labeled local simulator.
   * Must be explicitly disabled in production if you never want simulated sessions.
   */
  ALLOW_SIMULATOR: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),

  // ── Telephony / meetings (optional) ──
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  RECALL_API_KEY: z.string().optional(),
  RECALL_REGION: z.string().default('us-east-1'),

  // ── Email ──
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('ConversaForge <no-reply@localhost>'),

  // ── Limits ──
  DEFAULT_MAX_SESSION_MINUTES: z.coerce.number().default(30),
  PUBLIC_RUN_RATE_LIMIT_PER_HOUR: z.coerce.number().default(20),

  // ── Billing (E) — product logic never depends on a specific payment provider ──
  /** Billing adapter id: "none" (default, no charges) or "stripe" (stub; see docs/workstreams/E-access-admin.md). */
  BILLING_PROVIDER: z.enum(['none', 'stripe']).default('none'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /** Run BullMQ workers in the API process (dev). In prod run `node dist/worker.js` separately. */
  RUN_WORKERS_IN_API: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  loadDotEnv();
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${msg}`);
  }
  cached = parsed.data;
  return cached;
}

export const env = new Proxy({} as Env, {
  get: (_t, key: string) => (loadEnv() as any)[key],
});
