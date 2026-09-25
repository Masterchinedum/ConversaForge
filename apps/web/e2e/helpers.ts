import { request, type APIRequestContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';

export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:4000';
export const DATABASE_URL = process.env.E2E_DATABASE_URL ?? '';
const EMAIL = process.env.E2E_EMAIL ?? 'creator@demo.test';
const PASSWORD = process.env.E2E_PASSWORD ?? 'demo-password-123';
const WORKSPACE_SLUG = process.env.E2E_WORKSPACE_SLUG ?? 'acme-training';
const SCENARIO_NAME = process.env.E2E_SCENARIO_NAME ?? 'Behavioral interview';

let api: APIRequestContext | null = null;
let ctx: { workspaceId: string; scenarioId: string } | null = null;

/** Logged-in API client (seeded demo creator; see apps/api/prisma/seed.ts). */
export async function apiClient() {
  if (api) return api;
  api = await request.newContext({ baseURL: API_URL });
  const res = await api.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
  if (!res.ok()) throw new Error(`login failed: ${res.status()} ${await res.text()}`);
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

/** Create a participant session via the member self-run endpoint (workstream B). */
export async function createSession(): Promise<{ sessionId: string; sessionToken: string; workspaceId: string }> {
  const a = await apiClient();
  const { workspaceId, scenarioId } = await scenarioContext();
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
