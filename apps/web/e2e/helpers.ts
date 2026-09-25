import { request, type APIRequestContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:4000';
export const DATABASE_URL = process.env.E2E_DATABASE_URL ?? '';
const EMAIL = process.env.E2E_EMAIL ?? 'creator@demo.test';
const PASSWORD = process.env.E2E_PASSWORD ?? 'demo-password-123';
const WORKSPACE_SLUG = process.env.E2E_WORKSPACE_SLUG ?? 'acme-training';
const SCENARIO_NAME = process.env.E2E_SCENARIO_NAME ?? 'Behavioral interview';

let api: APIRequestContext | null = null;
let ctx: { workspaceId: string; scenarioId: string } | null = null;

// Login is rate limited; reuse the session cookie across runs (node_modules/.cache is git-ignored).
const AUTH_CACHE = join(__dirname, '..', 'node_modules', '.cache', 'cf-e2e', `.e2e-auth-${EMAIL.replace(/[^a-z0-9]/gi, '_')}.json`);

/** Logged-in API client (seeded demo creator; see apps/api/prisma/seed.ts). */
export async function apiClient() {
  if (api) return api;
  if (existsSync(AUTH_CACHE)) {
    const cached = await request.newContext({ baseURL: API_URL, storageState: AUTH_CACHE });
    if ((await cached.get('/api/auth/me')).ok()) return (api = cached);
    await cached.dispose();
  }
  api = await request.newContext({ baseURL: API_URL });
  const res = await api.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
  if (!res.ok()) throw new Error(`login failed: ${res.status()} ${await res.text()}`);
  mkdirSync(dirname(AUTH_CACHE), { recursive: true });
  await api.storageState({ path: AUTH_CACHE });
  return api;
}

export async function scenarioContext() {
  if (ctx) return ctx;
  const a = await apiClient();
  const me = await (await a.get('/api/auth/me')).json();
  const ws = me.workspaces.find((w: any) => w.slug === WORKSPACE_SLUG) ?? me.workspaces[0];
  const list = await (await a.get(`/api/workspaces/${ws.id}/scenarios`)).json();
  const sc = (list.data ?? list).find((s: any) => s.name === SCENARIO_NAME && s.status === 'PUBLISHED') ?? (list.data ?? list)[0];
  ctx = { workspaceId: ws.id, scenarioId: sc.id };
  return ctx;
}

const TOOLS_SCENARIO_NAME = 'E2E tools scenario (ws-c)';
const TOOL_IDS = ['end_session', 'whiteboard', 'notepad', 'document_upload', 'multiple_choice', 'cards', 'timer'];

/** A published scenario with every participant tool enabled (duplicated from the system-design template). */
export async function toolsScenarioId(): Promise<string> {
  const a = await apiClient();
  const { workspaceId } = await scenarioContext();
  const list = await (await a.get(`/api/workspaces/${workspaceId}/scenarios`, { params: { limit: 100 } })).json();
  const rows: any[] = list.data ?? list;
  const existing = rows.find((s) => s.name === TOOLS_SCENARIO_NAME && s.status === 'PUBLISHED');
  if (existing) return existing.id;
  const source = rows.find((s) => s.name === 'System design interview') ?? rows[0];
  const created = await (await a.post(`/api/workspaces/${workspaceId}/scenarios`, { data: { source: 'duplicate', scenarioId: source.id, name: TOOLS_SCENARIO_NAME } })).json();
  const id = created.scenario.id;
  const detail = await (await a.get(`/api/workspaces/${workspaceId}/scenarios/${id}`)).json();
  const patch = await a.patch(`/api/workspaces/${workspaceId}/scenarios/${id}/draft`, {
    data: {
      revision: detail.draft.revision,
      patch: [{ path: 'tools.enabled', value: TOOL_IDS.map((toolId) => ({ toolId, enabled: true, config: {}, usageHint: '' })) }],
    },
  });
  if (!patch.ok()) throw new Error(`draft patch failed: ${await patch.text()}`);
  const pub = await a.post(`/api/workspaces/${workspaceId}/scenarios/${id}/publish`, { data: {} });
  if (!pub.ok()) throw new Error(`publish failed: ${await pub.text()}`);
  return id;
}

/** Create a participant session via the member self-run endpoint (workstream B). */
export async function createSession(scenarioOverride?: string): Promise<{ sessionId: string; sessionToken: string; workspaceId: string }> {
  const a = await apiClient();
  const ctx = await scenarioContext();
  const workspaceId = ctx.workspaceId;
  const scenarioId = scenarioOverride ?? ctx.scenarioId;
  const res = await a.post(`/api/workspaces/${workspaceId}/scenarios/${scenarioId}/sessions`, { data: {} });
  if (!res.ok()) throw new Error(`create session failed: ${res.status()} ${await res.text()}`);
  return { ...(await res.json()), workspaceId };
}

export function sql(query: string): string {
  if (!DATABASE_URL) throw new Error('E2E_DATABASE_URL not set');
  return execFileSync('psql', [DATABASE_URL, '-tAc', query], { encoding: 'utf8' }).trim();
}

/** Intro → consent → device check → call screen, choosing typed input once the call is live. */
export async function joinCall(page: Page, opts: { recordAudio?: boolean } = {}) {
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Before we start').waitFor();
  await page.getByLabel(/I understand I’m talking with an AI/).check();
  const rec = page.getByLabel('Record audio of this call');
  if (opts.recordAudio === false) await rec.uncheck();
  else await rec.check();
  await page.getByRole('button', { name: 'Agree and continue' }).click();
  await page.getByRole('button', { name: /Allow microphone/ }).click();
  await page.getByRole('button', { name: 'Join the call' }).click();
  await page.getByTestId('call-status').filter({ hasText: 'Live' }).waitFor({ timeout: 30_000 });
}

export async function agentTurns(page: Page) {
  return page.locator('[data-testid="transcript"] li[data-speaker="AGENT"][data-status="saved"]').count();
}

export async function savedTexts(page: Page) {
  return page.locator('[data-testid="transcript"] li[data-status="saved"]').allInnerTexts();
}

/** Mint a `cfe_` embed token (workstream E) as the host's backend would (here: creator cookie auth). */
export async function mintEmbedToken(allowedOrigins: string[], participant: Record<string, string> = {}): Promise<string> {
  const a = await apiClient();
  const { workspaceId, scenarioId } = await scenarioContext();
  const res = await a.post(`/api/workspaces/${workspaceId}/access-tokens`, {
    data: { scenarioId, purpose: 'EMBED', allowedOrigins, participant, expiresInSeconds: 3600 },
  });
  if (!res.ok()) throw new Error(`mint failed: ${res.status()} ${await res.text()}`);
  return (await res.json()).token;
}
