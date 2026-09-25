/**
 * QA end-to-end journeys (docs/QA_REPORT.md). Run against a seeded database with the API and web servers up:
 *   E2E_WEB_URL=http://localhost:3202 E2E_API_URL=http://localhost:4202 \
 *   E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/conversaforge_qa \
 *   npx playwright test e2e/journeys.spec.ts
 * Screenshots go to $QA_SHOTS (default test-results/qa-shots).
 */
import { test, expect, request, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';

const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:3000';
const API = process.env.E2E_API_URL ?? 'http://localhost:4000';
const DB = process.env.E2E_DATABASE_URL ?? '';
const PASSWORD = 'demo-password-123';
const SHOTS = process.env.QA_SHOTS ?? join(__dirname, '..', 'test-results', 'qa-shots');
const CACHE = join(__dirname, '..', 'node_modules', '.cache', 'cf-e2e');
const RUN = Date.now().toString(36);
mkdirSync(SHOTS, { recursive: true });
mkdirSync(CACHE, { recursive: true });

test.describe.configure({ mode: 'serial' });

type Role = 'owner' | 'admin' | 'creator' | 'reviewer' | 'learner';

function sql(query: string): string {
  if (!DB) throw new Error('E2E_DATABASE_URL not set');
  return execFileSync('psql', [DB, '-tAc', query], { encoding: 'utf8' }).trim();
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

/** Cookie storage state for an email, logging in at most once per cache lifetime (login is rate limited). */
async function stateFor(email: string, password = PASSWORD): Promise<string> {
  const file = join(CACHE, `qa-${email.replace(/[^a-z0-9]/gi, '_')}.json`);
  if (existsSync(file)) {
    const c = await request.newContext({ baseURL: WEB, storageState: file });
    const ok = (await c.get('/api/auth/me')).ok();
    await c.dispose();
    if (ok) return file;
  }
  const c = await request.newContext({ baseURL: WEB });
  const res = await c.post('/api/auth/login', { data: { email, password } });
  if (!res.ok()) throw new Error(`login ${email} failed: ${res.status()} ${await res.text()}`);
  await c.storageState({ path: file });
  await c.dispose();
  return file;
}
const roleEmail = (r: Role) => `${r}@demo.test`;

async function apiAs(email: string): Promise<APIRequestContext> {
  return request.newContext({ baseURL: WEB, storageState: await stateFor(email), extraHTTPHeaders: { origin: WEB } });
}

async function ctxAs(browser: Browser, email: string, opts: Parameters<Browser['newContext']>[0] = {}): Promise<BrowserContext> {
  return browser.newContext({ storageState: await stateFor(email), ...opts });
}

/** Collects console errors, page errors and failed API calls for a page. */
function watch(page: Page) {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') {
      const t = m.text();
      // Expected browser noise: aborted fetches during navigation, HMR, favicon.
      if (/Failed to load resource: the server responded with a status of 40[134]/.test(t)) return;
      if (/favicon|webpack-hmr|Download the React DevTools/.test(t)) return;
      problems.push(`console: ${t.slice(0, 300)}`);
    }
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 300)}`));
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('/api/') && r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.request().method()} ${u}`);
  });
  return problems;
}

let seed: { workspaceId: string; wsIdOf: Record<string, string> } | null = null;
async function seedInfo() {
  if (seed) return seed;
  const a = await apiAs(roleEmail('owner'));
  const me = await (await a.get('/api/auth/me')).json();
  const ws = me.workspaces.find((w: any) => w.slug === 'acme-training') ?? me.workspaces.find((w: any) => w.kind === 'ORGANIZATION');
  seed = { workspaceId: ws.id, wsIdOf: {} };
  await a.dispose();
  return seed;
}

async function scenarioByName(a: APIRequestContext, ws: string, name: string) {
  const list = await (await a.get(`/api/workspaces/${ws}/scenarios`, { params: { q: name, limit: 50 } })).json();
  return (list.data as any[]).find((s) => s.name === name);
}

/** Participant flow: intro → consent → device check → live call, then typed mode. */
async function joinTyped(page: Page, opts: { record?: boolean } = {}) {
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Before we start').waitFor();
  await page.getByLabel(/I understand I’m talking with an AI/).check();
  const rec = page.getByLabel('Record audio of this call');
  if (await rec.count()) {
    if (opts.record === false) await rec.uncheck();
    else await rec.check();
  }
  await page.getByRole('button', { name: 'Agree and continue' }).click();
  await page.getByRole('button', { name: /Allow microphone/ }).click();
  await page.getByRole('button', { name: 'Join the call' }).click();
  await page.getByTestId('call-status').filter({ hasText: 'Live' }).waitFor({ timeout: 30_000 });
  const mode = await page.getByTestId('voice-mode').innerText();
  if (!/Typed/.test(mode)) await page.getByRole('button', { name: 'Switch to typing' }).click();
  await expect(page.getByTestId('voice-mode')).toContainText('Typed');
  await expect.poll(() => savedAgentTurns(page), { timeout: 30_000 }).toBeGreaterThan(0);
}

async function savedAgentTurns(page: Page) {
  return page.locator('[data-testid="transcript"] li[data-speaker="AGENT"][data-status="saved"]').count();
}
const ended = (page: Page) => page.getByTestId('end-screen').isVisible().catch(() => false);

/** One typed participant turn; waits for the agent's reply (or the end screen). */
async function say(page: Page, text: string) {
  const before = await savedAgentTurns(page);
  const input = page.getByTestId('typed-input');
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await input.fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(async () => (await ended(page)) || (await savedAgentTurns(page)) > before, { timeout: 45_000 }).toBe(true);
}

/** Answers until the agent closes the call (end screen) or answers run out; then ends it manually if asked. */
async function converse(page: Page, answers: string[], opts: { endIfOpen?: boolean } = {}) {
  for (const text of answers) {
    if (await ended(page)) break;
    await say(page, text);
  }
  if (opts.endIfOpen && !(await ended(page))) {
    await page.getByTestId('end-call').click();
    await page.getByTestId('confirm-end').click();
  }
  if (opts.endIfOpen) await expect(page.getByTestId('end-screen')).toBeVisible({ timeout: 45_000 });
}

const GOOD_ANSWERS = [
  'Hi, I am a backend engineer with six years of experience building payment systems at a fintech company.',
  'Last year our checkout latency doubled before Black Friday. I was the tech lead, so I owned the fix and the rollout plan.',
  'I profiled the service, found an N+1 query in the pricing module, added a cache and a batch loader, and load tested it with production traffic replays.',
  'Latency dropped by 60 percent, we had zero incidents on Black Friday, and revenue that weekend was up 18 percent year over year.',
  'I learned to add performance budgets to CI so regressions are caught early. We now run the load test on every release.',
  'Thanks, that covers everything from my side. No further questions.',
  'Thank you, goodbye.',
];

// ─────────────────────────────────────────────────────────────────────────────
// 8. Cross-cutting: every sidebar page for every role
// ─────────────────────────────────────────────────────────────────────────────
const PAGES: Array<{ path: string; minRole: Role }> = [
  { path: '', minRole: 'learner' },
  { path: '/learn', minRole: 'learner' },
  { path: '/learn/memory', minRole: 'learner' },
  { path: '/gallery', minRole: 'learner' },
  { path: '/scenarios', minRole: 'creator' },
  { path: '/courses', minRole: 'reviewer' },
  { path: '/knowledge', minRole: 'creator' },
  { path: '/sessions', minRole: 'reviewer' },
  { path: '/analytics', minRole: 'learner' },
  { path: '/coach', minRole: 'reviewer' },
  { path: '/settings/members', minRole: 'admin' },
  { path: '/settings', minRole: 'admin' },
  { path: '/settings/branding', minRole: 'admin' },
  { path: '/settings/usage', minRole: 'admin' },
  { path: '/settings/providers', minRole: 'admin' },
  { path: '/settings/functions', minRole: 'admin' },
  { path: '/channels', minRole: 'admin' },
  { path: '/settings/developer', minRole: 'admin' },
  { path: '/settings/audit', minRole: 'admin' },
  { path: '/settings/privacy', minRole: 'admin' },
];
const RANK: Record<Role, number> = { learner: 0, reviewer: 1, creator: 2, admin: 3, owner: 4 };

test.describe('8. cross-cutting', () => {
  test.describe.configure({ mode: 'default' });
  for (const role of ['owner', 'admin', 'creator', 'reviewer', 'learner'] as Role[]) {
    test(`every page loads for ${role}`, async ({ browser }) => {
      const { workspaceId } = await seedInfo();
      const ctx = await ctxAs(browser, roleEmail(role));
      const page = await ctx.newPage();
      const problems = watch(page);
      const report: string[] = [];
      for (const p of PAGES) {
        const allowed = RANK[role] >= RANK[p.minRole];
        await page.goto(`/w/${workspaceId}${p.path}`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(300);
        const main = page.locator('main#main');
        const text = (await main.innerText().catch(() => '')).slice(0, 2000);
        const nav = page.getByRole('navigation', { name: 'Workspace' }).first();
        const inNav = await nav.getByRole('link').allInnerTexts();
        await shot(page, `x-${role}-${p.path.replace(/\//g, '_') || 'dashboard'}`);
        if (allowed) {
          if (/Something went wrong|Unhandled|Application error|Forbidden|not allowed|permission/i.test(text) && !/permission/i.test(p.path))
            report.push(`${p.path}: allowed page shows error text: ${text.slice(0, 200)}`);
        } else {
          // Not allowed: the page must not render as if usable. Expect a clear "no access" message.
          if (!/access|permission|not allowed|forbidden|admin|only|requires|role/i.test(text)) report.push(`${p.path}: disallowed page has no access message: ${text.slice(0, 160)}`);
        }
        void inNav;
      }
      // Another workspace id → not found
      await page.goto(`/w/cmthisdoesnotexist000000000/scenarios`);
      await expect(page.getByText(/Workspace not found/)).toBeVisible();
      await ctx.close();
      const all = [...report, ...problems];
      if (all.length) console.log(`[${role}]\n` + all.join('\n'));
      expect(all, all.join('\n')).toEqual([]);
    });
  }
});

export { apiAs, ctxAs, watch, shot, sql, seedInfo, scenarioByName, joinTyped, converse, stateFor, WEB, API, RUN };
void readFileSync;
void writeFileSync;
void dirname;
void createServer;
export type { Server };
