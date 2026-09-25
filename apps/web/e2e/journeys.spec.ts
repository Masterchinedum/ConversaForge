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
// 1. Creator
// ─────────────────────────────────────────────────────────────────────────────
const shared: Record<string, string> = {};

test.describe('1. creator', () => {
  test('sign up → org → scenarios (template, guided + assistant) → versions → duplicate → YAML → try it', async ({ browser }) => {
    test.setTimeout(420_000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const problems = watch(page);
    const email = `qa-creator-${RUN}@test.local`;
    shared.creatorEmail = email;

    // Sign up (UI) → personal workspace
    await page.goto('/signup');
    await page.getByLabel('Name').fill('Quinn Creator');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('qa-password-123');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForURL(/\/w\/[a-z0-9]+$/);
    await expect(page.locator('main#main')).toBeVisible();
    await shot(page, '1-01-personal-dashboard');
    const me = await (await page.request.get('/api/auth/me')).json();
    expect(me.workspaces).toHaveLength(1);
    expect(me.workspaces[0].kind).toBe('PERSONAL');
    writeFileSync(join(CACHE, `qa-${email.replace(/[^a-z0-9]/gi, '_')}.json`), JSON.stringify(await ctx.storageState()));

    // Create an organization via the workspace switcher
    await page.locator('#ws-switch').selectOption('__new');
    await page.waitForURL(/\/w\/new$/);
    await page.getByLabel(/Organization name/).fill(`QA Org ${RUN}`);
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await page.waitForURL(/\/w\/(?!new$)[a-z0-9]+$/);
    const ws = page.url().split('/').pop()!;
    shared.orgId = ws;
    await expect(page.locator('#ws-switch')).toHaveValue(ws);
    await shot(page, '1-02-org-dashboard');

    // From template
    await page.goto(`/w/${ws}/scenarios`);
    await shot(page, '1-03-scenarios-empty');
    await page.getByTestId('new-scenario').click();
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('tab', { name: 'From template' }).click();
    await dlg.getByRole('radio', { name: /Behavioral interview \(STAR\)/ }).click();
    await dlg.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/scenarios\/[a-z0-9]+$/);
    await expect(page.getByTestId('scenario-title')).toHaveText(/Behavioral interview/);
    shared.templateScenarioId = page.url().split('/').pop()!;
    await expect(page.getByText('Ready to publish.')).toBeVisible();
    await shot(page, '1-04-template-editor');
    await page.getByTestId('publish').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText('Published version 1')).toBeVisible();

    // From scratch: guided mode + drafting assistant
    await page.goto(`/w/${ws}/scenarios`);
    await page.getByTestId('new-scenario').click();
    await page.getByRole('dialog').getByLabel('Name').fill('QA sales discovery');
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/scenarios\/[a-z0-9]+$/);
    const sid = page.url().split('/').pop()!;
    shared.scratchScenarioId = sid;
    await expect(page.getByRole('button', { name: /1\. Basics/ })).toHaveAttribute('aria-current', 'step');
    await shot(page, '1-05-guided-empty');
    await page.getByLabel('What should change?').fill('a 10-minute sales discovery call with a skeptical CFO of a logistics company about our analytics product');
    await page.getByRole('button', { name: 'Propose changes' }).click();
    const proposal = page.getByTestId('assistant-proposal');
    await expect(proposal).toBeVisible();
    await shot(page, '1-06-assistant-proposal');
    await proposal.getByRole('button', { name: /Apply selected/ }).click();
    await expect(page.getByText('All changes applied')).toBeVisible();
    await expect(page.getByTestId('scenario-title')).toHaveText('QA sales discovery');
    for (const step of ['AI persona & goals', 'Conversation', 'Ending & timing', 'Feedback', 'Data to extract', 'Review & publish']) {
      await page.getByRole('button', { name: `Next: ${step}` }).click();
      await shot(page, `1-07-guided-${step.replace(/\W+/g, '-')}`);
    }
    // Break the weights on the Feedback step → publish is blocked → normalize
    await page.getByRole('button', { name: /5\. Feedback/ }).click();
    await page.getByLabel('Criterion 1 weight').fill('90');
    await expect(page.getByText(/weights must sum to 100/).first()).toBeVisible();
    await expect(page.getByTestId('save-state')).toHaveText('All changes saved', { timeout: 10_000 });
    await page.getByTestId('publish').click();
    await shot(page, '1-08-publish-blocked');
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Publish' })).toBeDisabled();
    await page.getByRole('dialog').getByRole('button', { name: /Cancel|Close/ }).first().click();
    await page.getByRole('button', { name: 'Normalize to 100' }).click();
    await expect(page.getByText('Ready to publish.').first()).toBeVisible();
    await expect(page.getByTestId('save-state')).toHaveText('All changes saved', { timeout: 10_000 });
    await page.getByRole('button', { name: 'Validate' }).click();
    await expect(page.getByText(/Valid — /)).toBeVisible();
    await page.getByTestId('publish').click();
    await page.getByLabel('Change note').fill('First version');
    await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText('Published version 1')).toBeVisible();

    // Edit & publish v2
    await page.getByRole('tab', { name: 'Advanced' }).click();
    await page.locator('#field-persona-name input').fill('Dana QA');
    await expect(page.getByTestId('save-state')).toHaveText('All changes saved', { timeout: 10_000 });
    await page.getByTestId('publish').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText('Published version 2')).toBeVisible();

    // History, diff, rollback → v3
    await page.getByRole('tab', { name: /Versions/ }).click();
    await page.getByTestId('version-1').getByRole('button', { name: 'Diff vs latest' }).click();
    await expect(page.getByTestId('diff')).toContainText('persona.name');
    await shot(page, '1-09-versions-diff');
    page.once('dialog', (d) => d.accept());
    await page.getByTestId('version-1').getByRole('button', { name: 'Rollback to this version' }).click();
    await expect(page.getByText('Rolled back — published version 3')).toBeVisible();
    await expect(page.getByTestId('version-3')).toContainText('Latest');

    // Preview
    await page.getByRole('button', { name: 'Preview' }).click();
    await expect(page.getByText('What participants see')).toBeVisible();
    await shot(page, '1-10-preview');

    // YAML export → import as a new scenario
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export YAML' }).click();
    const file = await (await dl).path();
    const yamlText = readFileSync(file!, 'utf8');
    expect(yamlText).toContain('QA sales discovery');
    await page.goto(`/w/${ws}/scenarios`);
    await page.getByTestId('new-scenario').click();
    await page.getByRole('dialog').getByRole('tab', { name: 'Import YAML/JSON' }).click();
    await page.getByRole('dialog').getByLabel('Paste YAML or JSON').fill(yamlText);
    await page.getByRole('dialog').getByLabel('Name (optional)').fill('QA imported');
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(/\/scenarios\/[a-z0-9]+$/);
    await expect(page.getByTestId('scenario-title')).toHaveText('QA imported');

    // Duplicate the original
    await page.goto(`/w/${ws}/scenarios/${sid}`);
    await page.getByRole('button', { name: 'Duplicate' }).click();
    await expect(page.getByText('Duplicated')).toBeVisible();
    await page.waitForURL((u) => !u.pathname.endsWith(sid));
    await expect(page.getByTestId('scenario-title')).toContainText('QA sales discovery');
    await page.goto(`/w/${ws}/scenarios`);
    await shot(page, '1-11-library');

    // Try it as the creator
    await page.goto(`/w/${ws}/scenarios/${sid}`);
    await page.getByRole('button', { name: /Try it/ }).click();
    await page.waitForURL(/\/live\//);
    await shot(page, '1-12-live-intro');
    await joinTyped(page, { record: false });
    await shot(page, '1-13-live-call');
    await converse(page, GOOD_ANSWERS.slice(0, 3), { endIfOpen: true });
    await shot(page, '1-14-live-end');
    await ctx.close();
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

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
