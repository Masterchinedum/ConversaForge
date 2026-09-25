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
import { join } from 'node:path';

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
test.use({ actionTimeout: 20_000, navigationTimeout: 30_000 });

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
      if (/Failed to load resource: the server responded with a status of 4\d\d/.test(t)) return;
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
const ended = (page: Page) => page.getByTestId('end-screen').first().isVisible().catch(() => false);

/** One typed participant turn; waits for the agent's reply (or the end screen). */
async function say(page: Page, text: string) {
  const before = await savedAgentTurns(page);
  const input = page.getByTestId('typed-input');
  // The agent may be closing the call (input goes away before the end screen shows).
  const t0 = Date.now();
  await expect.poll(async () => (await ended(page)) || ((await input.count()) > 0 && (await input.isEnabled({ timeout: 500 }).catch(() => false))), { timeout: 60_000 }).toBe(true);
  if (Date.now() - t0 > 5000) console.log(`[say] waited ${Date.now() - t0} ms for input/end screen`);
  if (await ended(page)) return;
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
// State shared between journeys (persisted so a single journey can be re-run with -g after a full run).
const SHARED_FILE = join(CACHE, 'qa-shared.json');
const shared: Record<string, string> = new Proxy(existsSync(SHARED_FILE) ? JSON.parse(readFileSync(SHARED_FILE, 'utf8')) : {}, {
  set(t, k, v) {
    t[k as string] = v;
    writeFileSync(SHARED_FILE, JSON.stringify(t, null, 2));
    return true;
  },
});

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
// 2. Sharing
// ─────────────────────────────────────────────────────────────────────────────
const SUBSTANTIVE = [
  'In my last role I led a team of five engineers rebuilding our payments reconciliation service, which was failing nightly and delaying finance reports.',
  'My task was to make reconciliation finish before 6am with zero manual fixes, within one quarter, without pausing feature work for the rest of the team.',
  'I split the job into idempotent batches, added a dead letter queue, wrote a replay tool, and paired with finance every week to validate the numbers.',
  'The job now finishes in forty minutes, manual fixes went from twenty a week to zero, and finance closes the month two days earlier than before.',
  'When a teammate disagreed about the batching design, I set up a one hour spike so we could compare both approaches with real data before deciding.',
  'I learned to write the success metric down before starting, and to involve the people who consume the output from the very first week.',
];

async function finishConversation(page: Page, extra: string[] = []) {
  const answers = [...extra, ...SUBSTANTIVE, ...SUBSTANTIVE.map((a) => `Another example: ${a}`), 'No, nothing else from me. Thank you!'];
  for (const a of answers) {
    if (await ended(page)) break;
    await say(page, a);
  }
  await expect(page.getByTestId('end-screen')).toBeVisible({ timeout: 60_000 });
}

test.describe('2. sharing', () => {
  test('share link (one-time, passcode, name+email, prefilled variable) → anonymous run → report → reuse fails', async ({ browser }) => {
    test.setTimeout(420_000);
    const ws = shared.orgId!;
    const sid = shared.templateScenarioId!;
    const creator = await browser.newContext({ storageState: join(CACHE, `qa-${shared.creatorEmail!.replace(/[^a-z0-9]/gi, '_')}.json`) });
    const page = await creator.newPage();
    const problems = watch(page);

    // Participant report sections: feedback yes, scores no, transcript no.
    await page.goto(`/w/${ws}/scenarios/${sid}`);
    await page.getByRole('tab', { name: 'Advanced' }).click();
    const setToggle = async (label: string, on: boolean) => {
      const box = page.getByLabel(label, { exact: true });
      if ((await box.isChecked()) !== on) await box.click();
    };
    await setToggle('Participant can see the transcript', false);
    await setToggle('Participant can see feedback', true);
    await setToggle('Participant can see scores', false);
    await expect(page.getByTestId('save-state')).toHaveText('All changes saved', { timeout: 10_000 });
    await page.getByTestId('publish').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText('Published version 2')).toBeVisible();

    // Create the link
    await page.getByRole('link', { name: 'Share & access' }).click();
    await page.waitForURL(/\/access/);
    await shot(page, '2-01-access-empty');
    await page.getByRole('button', { name: 'New share link' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByLabel('Label').fill('QA one-time');
    await dlg.getByLabel('Usage').selectOption('ONE_TIME');
    await dlg.getByLabel('Participant identity').selectOption('NAME_EMAIL');
    await dlg.getByLabel('Passcode').fill('open-sesame');
    await dlg.getByLabel(/Role title/).fill('Staff Engineer');
    await shot(page, '2-02-link-modal');
    await dlg.getByRole('button', { name: 'Create link' }).click();
    await expect(page.getByText(/Link created/)).toBeVisible();
    const url = (await page.locator('code').filter({ hasText: '/r/' }).first().innerText()).trim();
    expect(url).toMatch(/\/r\/[A-Za-z0-9_-]+$/);
    const linkPath = new URL(url).pathname;
    await shot(page, '2-03-access-links');

    // Anonymous participant
    const anon = await browser.newContext();
    const p = await anon.newPage();
    const pProblems = watch(p);
    await p.goto(linkPath);
    await expect(p.getByRole('heading', { name: /Behavioral interview/ })).toBeVisible();
    await shot(p, '2-04-landing');
    await p.getByLabel('Your name').fill('Pat Participant');
    await p.getByLabel('Email').fill(`pat-${RUN}@example.com`);
    await p.getByLabel('Passcode').fill('wrong-code');
    await p.getByRole('button', { name: 'Continue' }).click();
    await expect(p.getByText('That passcode is not correct.')).toBeVisible();
    await p.getByLabel('Passcode').fill('open-sesame');
    await p.getByRole('button', { name: 'Continue' }).click();
    await p.waitForURL(/\/live\//);
    const sessionId = new URL(p.url()).pathname.split('/').pop()!;
    shared.sharedSessionId = sessionId;
    await shot(p, '2-05-live-intro');
    // Prefilled variable substituted (persona role mentions the role title)
    await p.getByRole('button', { name: 'Continue' }).click();
    await shot(p, '2-06-consent');
    await p.getByLabel(/I understand I’m talking with an AI/).check();
    const rec = p.getByLabel('Record audio of this call');
    if (await rec.count()) await rec.check();
    await p.getByRole('button', { name: 'Agree and continue' }).click();
    await shot(p, '2-07-device-check');
    await p.getByRole('button', { name: /Allow microphone/ }).click();
    await p.getByRole('button', { name: 'Join the call' }).click();
    await p.getByTestId('call-status').filter({ hasText: 'Live' }).waitFor({ timeout: 30_000 });
    if (!/Typed/.test(await p.getByTestId('voice-mode').innerText())) await p.getByRole('button', { name: 'Switch to typing' }).click();
    await expect.poll(() => savedAgentTurns(p), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(p.getByTestId('transcript')).toContainText(/Staff Engineer|Alex/);
    await say(p, 'Hi, thanks. I am ready to start.');
    // Vague answer → follow-up question
    await say(p, 'We did stuff with the database, kind of.');
    const last = await p.locator('[data-testid="transcript"] li[data-speaker="AGENT"][data-status="saved"]').last().innerText();
    expect(last).toMatch(/specific role|tell me a bit more|look like in practice|hardest part|specific example/i);
    await shot(p, '2-08-follow-up');
    await finishConversation(p);
    await shot(p, '2-09-end');
    // Participant report
    await p.getByRole('link', { name: 'View your feedback' }).click();
    await p.waitForURL(/\/report\//);
    await expect(p.getByRole('heading', { name: /Your feedback/ })).toBeVisible();
    await expect(p.getByText('What went well')).toBeVisible({ timeout: 90_000 });
    await expect(p.getByText('Your scores')).toHaveCount(0);
    await expect(p.getByText(/^Transcript \(/)).toHaveCount(0);
    await shot(p, '2-10-report');

    // One-time link cannot be reused
    const anon2 = await browser.newContext();
    const p2 = await anon2.newPage();
    await p2.goto(linkPath);
    await expect(p2.getByText(/already been used/)).toBeVisible();
    await shot(p2, '2-11-link-used');
    await anon2.close();
    await anon.close();

    // Public scenario via the gallery: make the scratch scenario public, publish, list it
    const pub = shared.scratchScenarioId!;
    await page.goto(`/w/${ws}/scenarios/${pub}`);
    await page.getByRole('tab', { name: 'Advanced' }).click();
    await page.locator('#field-basics-privacy select').selectOption('PUBLIC');
    await expect(page.getByTestId('save-state')).toHaveText('All changes saved', { timeout: 10_000 });
    await page.getByTestId('publish').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText(/Published version \d/)).toBeVisible();
    await page.goto(`/w/${ws}/scenarios/${pub}/access?tab=visibility`);
    await page.getByTestId('gallery-toggle').click();
    await expect(page.getByText('Listed in the public gallery')).toBeVisible();
    await shot(page, '2-12-visibility');

    const anon3 = await browser.newContext();
    const g = await anon3.newPage();
    const gProblems = watch(g);
    await g.goto('/gallery');
    await g.getByPlaceholder(/Search/).first().fill('QA sales discovery');
    const card = g.locator('article, li, div').filter({ hasText: 'QA sales discovery' }).getByRole('link', { name: /Start/ }).first();
    await expect(card).toBeVisible();
    await shot(g, '2-13-public-gallery');
    await card.click();
    await g.waitForURL(/\/p\//);
    await expect(g.getByRole('heading', { name: 'QA sales discovery' })).toBeVisible();
    await shot(g, '2-14-public-landing');
    if (await g.getByLabel('Your name').isVisible()) {
      // Submitting without the required identity gives a clear inline error
      await g.getByRole('button', { name: 'Continue' }).click();
      await expect(g.getByRole('alert').or(g.locator('[role="alert"], .text-red-700')).first()).toBeVisible();
      await shot(g, '2-15-public-landing-missing-identity');
      await g.getByLabel('Your name').fill('Gale Guest');
      if (await g.getByLabel('Email').isVisible()) await g.getByLabel('Email').fill(`gale-${RUN}@example.com`);
      await g.getByRole('button', { name: 'Continue' }).click();
    } else await g.getByRole('button', { name: 'Continue' }).click();
    await g.waitForURL(/\/live\//);
    await joinTyped(g, { record: false });
    await converse(g, ['Hi, this is a quick test run.'], { endIfOpen: true });
    await anon3.close();
    await creator.close();
    const all = [...problems, ...pProblems, ...gProblems];
    expect(all, all.join('\n')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Reviewer
// ─────────────────────────────────────────────────────────────────────────────
/** Runs a full typed session on `scenarioName` in the seeded workspace as `email`; returns the session id. */
async function runSeededSession(browser: Browser, email: string, scenarioName: string, answers: string[] = [], opts: { short?: boolean } = {}): Promise<string> {
  const { workspaceId } = await seedInfo();
  const a = await apiAs(email);
  const list = await (await a.get(`/api/workspaces/${workspaceId}/gallery`)).json();
  const sc = (list.scenarios as any[]).find((x) => x.name === scenarioName);
  if (!sc) throw new Error(`scenario ${scenarioName} not in gallery`);
  const res = await a.post(`/api/workspaces/${workspaceId}/scenarios/${sc.id}/sessions`, { data: {} });
  if (!res.ok()) throw new Error(`start failed ${res.status()} ${await res.text()}`);
  const { sessionId, sessionToken } = await res.json();
  await a.dispose();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`/live/${sessionId}#t=${sessionToken}`);
  await joinTyped(page, { record: true });
  if (opts.short) await converse(page, answers, { endIfOpen: true });
  else await finishConversation(page, answers);
  await ctx.close();
  return sessionId;
}

test.describe('3. reviewer', () => {
  test('sessions list filters → detail tabs → evidence jump → exports → reprocess → sign-off', async ({ browser }) => {
    test.setTimeout(300_000);
    const { workspaceId } = await seedInfo();
    const sessionId = await runSeededSession(browser, roleEmail('reviewer'), 'Behavioral interview', ['Hi Alex, ready when you are.']);
    shared.reviewSessionId = sessionId;
    const ctx = await ctxAs(browser, roleEmail('reviewer'));
    const page = await ctx.newPage();
    const problems = watch(page);

    await page.goto(`/w/${workspaceId}/sessions`);
    await expect(page.getByRole('link', { name: /Riley Reviewer|reviewer@demo.test/ }).first()).toBeVisible();
    await shot(page, '3-01-sessions');
    // Filters: scenario + state narrow the list, a participant search with no match shows an empty state
    await page.getByLabel('Scenario').selectOption({ label: 'Behavioral interview' });
    await page.getByLabel('Session state').selectOption('COMPLETED');
    await expect(page.getByRole('link', { name: /Riley Reviewer|reviewer@demo.test/ }).first()).toBeVisible();
    await page.getByLabel('Participant').fill('nobody-matches-this');
    await expect(page.getByText(/No sessions|No matching/i).first()).toBeVisible();
    await shot(page, '3-02-sessions-filtered-empty');

    await page.goto(`/w/${workspaceId}/sessions/${sessionId}`);
    await expect(page.getByText('Analysis in progress')).toBeHidden({ timeout: 90_000 });
    await expect(page.getByRole('heading', { name: 'Criteria' })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText('Simulated analysis').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0); // sessions.delete is admin-only
    await shot(page, '3-03-report');
    // Insufficient evidence is displayed for criteria without matches (the simulator scores by keyword overlap)
    const insufficient = await page.getByText('Not enough evidence to score').count();
    const turnLinks = page.locator('article a[href^="#turn-"]');
    if (await turnLinks.count()) {
      const href = await turnLinks.first().getAttribute('href');
      await turnLinks.first().click();
      await expect(page.getByRole('tab', { name: /Transcript/ })).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator(href!)).toBeVisible();
      await shot(page, '3-04-evidence-jump');
    }
    console.log(`[reviewer] criteria with insufficient evidence: ${insufficient}`);
    // A short, vague session: the overall score is withheld and criteria show "insufficient evidence"
    const vague = await runSeededSession(browser, roleEmail('reviewer'), 'Behavioral interview', ['Hi.', 'We did stuff, you know.'], { short: true });
    const vp = await ctx.newPage();
    await vp.goto(`/w/${workspaceId}/sessions/${vague}`);
    await expect(vp.getByText('Not enough evidence to score').first()).toBeVisible({ timeout: 90_000 });
    await shot(vp, '3-04b-insufficient-evidence');
    await vp.close();
    await page.getByRole('tab', { name: 'Recording' }).click();
    await shot(page, '3-05-recording');
    await page.getByRole('tab', { name: /Extracted data/ }).click();
    await shot(page, '3-06-extracted');
    await page.getByRole('tab', { name: /Processing/ }).click();
    await shot(page, '3-07-processing');
    await page.getByRole('button', { name: 'Reprocess all' }).click();
    await expect(page.getByText('Reprocessing started')).toBeVisible();
    await expect(page.getByText('Analysis in progress')).toBeHidden({ timeout: 90_000 });
    await expect(page.getByText('Run 2')).toBeVisible({ timeout: 90_000 });
    if (await page.getByRole('tab', { name: 'Debug events' }).count()) {
      await page.getByRole('tab', { name: 'Debug events' }).click();
      await shot(page, '3-08-debug');
    }
    // Exports
    for (const [label, ext] of [['Export PDF', 'pdf'], ['Transcript CSV', 'csv']] as const) {
      const dl = page.waitForEvent('download');
      await page.getByRole('button', { name: label }).click();
      const d = await dl;
      expect(d.suggestedFilename()).toMatch(new RegExp(`\\.${ext}$`));
      const body = readFileSync((await d.path())!);
      if (ext === 'pdf') expect(body.subarray(0, 4).toString()).toBe('%PDF');
      else expect(body.toString('utf8')).toMatch(/speaker|Speaker/);
    }
    // Human review sign-off
    await page.getByRole('tab', { name: 'Report' }).click();
    await page.getByRole('button', { name: 'Sign off review' }).click();
    await page.getByLabel('Reviewer note (optional)').fill('Checked against the transcript.');
    await page.getByRole('dialog').getByRole('button', { name: 'Sign off' }).click();
    await expect(page.getByText('Human review completed')).toBeVisible();
    await shot(page, '3-09-signed-off');
    await ctx.close();
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Admin
// ─────────────────────────────────────────────────────────────────────────────
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAGAAAAAgCAYAAADtwH1UAAAASklEQVR42u3RIQEAAAjAMBrQFEl9CIHATLzAF9k1+itMAABAAAAIAAABACAAAAQAgAAAEAAAAgBAAAAIAAABACAAAAQAgAAA0L0F6qtZWvE7jDcAAAAASUVORK5CYII=', 'base64'); // 96x32 teal
const API_LOG = process.env.QA_API_LOG ?? '';

function inviteLinkFor(email: string): string {
  // Dev mail is logged by the API: "[dev mail] to=<email> ..." followed by the text containing the link.
  if (API_LOG && existsSync(API_LOG)) {
    const log = readFileSync(API_LOG, 'utf8');
    const i = log.lastIndexOf(`to=${email}`);
    if (i >= 0) {
      const m = /\/invite\/([A-Za-z0-9_-]+)/.exec(log.slice(i, i + 4000));
      if (m) return `/invite/${m[1]}`;
    }
  }
  throw new Error('invite link not found in API log (set QA_API_LOG)');
}

test.describe('4. admin', () => {
  test('members, roles, teams, branding, quotas, audit, privacy, API keys, webhooks, providers, channels', async ({ browser }) => {
    test.setTimeout(420_000);
    const { workspaceId: ws } = await seedInfo();
    const ctx = await ctxAs(browser, roleEmail('admin'));
    const page = await ctx.newPage();
    const problems = watch(page);

    // ── Invite → accept in another context → change role
    const invitee = `qa-invitee-${RUN}@test.local`;
    await page.goto(`/w/${ws}/settings/members`);
    await page.getByRole('tab', { name: 'Invitations' }).click();
    await page.getByLabel('Email').fill(invitee);
    await page.getByLabel('Role').selectOption('CREATOR');
    await page.getByRole('button', { name: 'Send invitation' }).click();
    await expect(page.getByText(/Invitation (sent|created)/)).toBeVisible();
    await expect(page.getByRole('cell', { name: invitee })).toBeVisible();
    await shot(page, '4-01-invitations');
    const link = inviteLinkFor(invitee);
    const other = await browser.newContext();
    const ip = await other.newPage();
    const ipProblems = watch(ip);
    await ip.goto(link);
    await expect(ip.getByRole('heading', { name: /Join Acme Training/ })).toBeVisible();
    await shot(ip, '4-02-invite-landing');
    await ip.getByRole('link', { name: 'Create account' }).click();
    await ip.getByLabel('Name').fill('Ivy Invitee');
    await ip.getByLabel('Email').fill(invitee);
    await ip.getByLabel('Password').fill('qa-password-123');
    await ip.getByRole('button', { name: 'Create account' }).click();
    await ip.waitForURL(/\/invite\//);
    await shot(ip, '4-03-invite-after-signup');
    await ip.getByRole('button', { name: 'Accept invitation' }).click();
    await ip.waitForURL(new RegExp(`/w/${ws}`));
    await expect(ip.getByText('Role: creator')).toBeVisible();
    await page.getByRole('tab', { name: 'Members' }).click();
    await page.getByLabel(`Role for ${invitee}`).selectOption('REVIEWER');
    await expect(page.getByText('Role updated')).toBeVisible();
    await ip.reload();
    await expect(ip.getByText('Role: reviewer')).toBeVisible();
    await other.close();

    // ── Teams
    await page.getByRole('tab', { name: 'Teams' }).click();
    await page.getByLabel('New team name').fill(`QA team ${RUN}`);
    await page.getByRole('button', { name: 'Create team' }).click();
    await expect(page.getByText(`QA team ${RUN}`)).toBeVisible();
    await shot(page, '4-04-teams');

    // ── Branding: logo + colors, reflected on /r/<token> and /live
    await page.goto(`/w/${ws}/settings/branding`);
    await page.locator('#logo-file').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG_1PX });
    await expect(page.getByAltText('Current logo')).toBeVisible();
    await page.getByLabel('Primary color', { exact: true }).fill('#0f766e');
    await page.getByLabel('Support email').fill('help@acme.test');
    await page.getByRole('button', { name: 'Save branding' }).click();
    await expect(page.getByText(/saved/i).first()).toBeVisible();
    await shot(page, '4-05-branding');
    const a = await apiAs(roleEmail('admin'));
    const gallery = await (await a.get(`/api/workspaces/${ws}/gallery`)).json();
    const bi = (gallery.scenarios as any[]).find((x) => x.name === 'Discovery call with a skeptical CFO');
    const linkRes = await a.post(`/api/workspaces/${ws}/scenarios/${bi.id}/links`, { data: { label: `QA branding ${RUN}`, identityMode: 'NAME_EMAIL' } });
    expect(linkRes.ok(), await linkRes.text()).toBeTruthy();
    const shareUrl = new URL((await linkRes.json()).url).pathname;
    const anon = await browser.newContext();
    const rp = await anon.newPage();
    const rpProblems = watch(rp);
    await rp.goto(shareUrl);
    await expect(rp.locator('header img')).toBeVisible();
    await expect(rp.getByText('help@acme.test')).toBeVisible();
    await expect(rp.locator('main')).not.toContainText('{{'); // placeholders are filled on the landing page
    const brand = await rp.locator('main').first().evaluate((el) => getComputedStyle(el).getPropertyValue('--brand-600').trim());
    expect(brand).not.toBe('');
    await shot(rp, '4-06-branded-landing');
    const participantEmail = `pia-${RUN}@example.com`;
    shared.privacyEmail = participantEmail;
    await rp.getByLabel('Your name').fill('Pia Privacy');
    await rp.getByLabel('Email').fill(participantEmail);
    await rp.getByRole('button', { name: 'Continue' }).click();
    await rp.waitForURL(/\/live\//);
    await expect(rp.locator('img[alt]').first()).toBeVisible();
    await shot(rp, '4-07-branded-live');
    await joinTyped(rp, { record: false });
    await converse(rp, ['Hi Dana, thanks for taking the call. I run sales for a logistics analytics startup.'], { endIfOpen: true });
    await anon.close();

    // ── Usage & quotas (owner only): a tiny hard quota blocks new sessions with a clear message
    const octx = await ctxAs(browser, roleEmail('owner'));
    const op = await octx.newPage();
    const opProblems = watch(op);
    await page.goto(`/w/${ws}/settings/usage`);
    await expect(page.getByText('Only owners can change quotas.')).toBeVisible();
    await op.goto(`/w/${ws}/settings/usage`);
    await op.getByLabel('Metric').selectOption('sessions');
    await op.getByLabel(/Monthly limit/).fill('1');
    await op.getByRole('button', { name: 'Save quota' }).click();
    await expect(op.getByText('Quota saved')).toBeVisible();
    await shot(op, '4-08-quota');
    const blocked = await browser.newContext();
    const bp = await blocked.newPage();
    await bp.goto(shareUrl);
    await bp.getByLabel('Your name').fill('Quota Blocked');
    await bp.getByLabel('Email').fill(`blocked-${RUN}@example.com`);
    await bp.getByRole('button', { name: 'Continue' }).click();
    await expect(bp.getByText(/usage limit reached/)).toBeVisible();
    await shot(bp, '4-09-quota-blocked');
    await blocked.close();
    // member self-run is blocked too
    await op.goto(`/w/${ws}/gallery`);
    await op.getByRole('button', { name: 'Start' }).first().click();
    await expect(op.getByText(/quota|limit/i).first()).toBeVisible();
    await shot(op, '4-10-quota-blocked-selfrun');
    await op.goto(`/w/${ws}/settings/usage`);
    op.once('dialog', (d) => d.accept());
    await op.getByRole('button', { name: 'remove' }).first().click();
    const confirm = op.getByRole('button', { name: /^(Confirm|Remove|Yes)/ });
    if (await confirm.isVisible().catch(() => false)) await confirm.click();
    await expect(op.getByText('No quotas set — usage is unlimited.')).toBeVisible();
    await octx.close();

    // ── Audit log shows the actions
    await page.goto(`/w/${ws}/settings/audit`);
    await expect(page.getByText(/invitation\./).first()).toBeVisible();
    await expect(page.getByText(/branding/).first()).toBeVisible();
    await expect(page.getByText(/quota/).first()).toBeVisible();
    await shot(page, '4-11-audit');

    // ── Privacy: export then delete for the participant above
    await page.goto(`/w/${ws}/settings/privacy`);
    await page.getByLabel('Email', { exact: true }).fill(participantEmail);
    await page.getByRole('button', { name: 'Start export' }).click();
    await expect(page.getByText('Export started')).toBeVisible();
    await expect.poll(async () => {
      await page.reload();
      return page.getByRole('row', { name: new RegExp(`export.*${participantEmail}.*completed`, 'i') }).count();
    }, { timeout: 60_000 }).toBeGreaterThan(0);
    await page.getByLabel('Request').selectOption('DELETE');
    await page.getByLabel('Email', { exact: true }).fill(participantEmail);
    await page.getByLabel(/again to confirm/).fill(participantEmail);
    await page.getByRole('button', { name: 'Delete participant data' }).click();
    await expect(page.getByText('Deletion started')).toBeVisible();
    await expect.poll(async () => {
      await page.reload();
      return page.getByRole('row', { name: new RegExp(`delete.*${participantEmail}.*completed`, 'i') }).count();
    }, { timeout: 60_000 }).toBeGreaterThan(0);
    await shot(page, '4-12-privacy');

    // ── API keys + webhook with a test ping to a local receiver
    const received: Array<{ headers: Record<string, unknown>; body: string }> = [];
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(4299, r));
    try {
      await page.goto(`/w/${ws}/settings/developer`);
      await page.getByRole('button', { name: 'Create API key' }).click();
      await page.getByRole('dialog').getByLabel('Name').fill(`QA key ${RUN}`);
      for (const scope of ['scenarios:read', 'sessions:read', 'sessions:write']) await page.getByRole('dialog').getByRole('checkbox', { name: new RegExp(scope) }).check();
      await page.getByRole('dialog').getByRole('button', { name: 'Create key' }).click();
      const secret = (await page.getByTestId('api-key-secret').innerText()).trim();
      expect(secret).toMatch(/^cf_live_/);
      shared.apiKey = secret;
      await page.getByRole('button', { name: 'Add endpoint' }).click();
      await page.getByLabel('Endpoint URL').fill('http://localhost:4299/hook');
      await page.getByRole('button', { name: /Save|Add endpoint|Create/ }).last().click();
      await expect(page.getByTestId('webhook-secret')).toBeVisible();
      await page.getByRole('button', { name: 'Send test' }).first().click();
      await expect(page.getByText(/Ping delivered \(HTTP 200\)/)).toBeVisible({ timeout: 30_000 });
      expect(received.length).toBeGreaterThan(0);
      expect(String(received[0]!.headers['x-conversaforge-signature'])).toMatch(/t=\d+,v1=/);
      await shot(page, '4-13-developer');
    } finally {
      server.close();
    }

    // ── AI providers: simulator status; channels: not configured states
    await page.goto(`/w/${ws}/settings/providers`);
    await expect(page.getByText('Conversations and analysis are simulated')).toBeVisible();
    await shot(page, '4-14-providers');
    await page.goto(`/w/${ws}/channels`);
    await expect(page.getByText(/Not configured/).first()).toBeVisible();
    await shot(page, '4-15-channels');
    await ctx.close();
    const all = [...problems, ...ipProblems, ...rpProblems, ...opProblems];
    expect(all, all.join('\n')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Learner
// ─────────────────────────────────────────────────────────────────────────────
test.describe('5. learner', () => {
  test('course 0% → Play All → scenario via /live → 33% → link viewed → start over → 0%; coach memory', async ({ browser }) => {
    test.setTimeout(420_000);
    const { workspaceId: ws } = await seedInfo();
    const ctx = await ctxAs(browser, roleEmail('learner'));
    const page = await ctx.newPage();
    const problems = watch(page);
    page.on('dialog', (d) => d.accept());

    await page.goto(`/w/${ws}/learn`);
    await expect(page.getByText('Interview readiness').first()).toBeVisible();
    const card = page.locator('div').filter({ has: page.getByText('Interview readiness', { exact: true }) });
    const enroll = card.getByRole('button', { name: 'Enroll' }).first();
    if (await enroll.isVisible().catch(() => false)) await enroll.click();
    else await page.getByRole('link', { name: /Interview readiness/ }).first().click();
    await page.waitForURL(/\/learn\/courses\//);
    // A fresh enrollment (or a restarted one) is 0%
    const startOver = page.getByRole('button', { name: 'Start over' });
    await expect(page.getByText(/\d+% complete/)).toBeVisible();
    if ((await page.getByText(/\d+% complete/).innerText()).trim() !== '0% complete') await startOver.click(); // re-run: reset first
    await expect(page.getByText('0% complete')).toBeVisible();
    await shot(page, '5-01-course-0');
    await page.getByRole('button', { name: /Play all/i }).click();
    await page.waitForURL(/\/live\//);
    await joinTyped(page, { record: false });
    await finishConversation(page, ['Hi Alex, ready to go.']);
    await shot(page, '5-02-end-with-back');
    await page.getByRole('link', { name: 'Back to course' }).click();
    await page.waitForURL(/\/learn\/courses\//);
    await expect(page.getByText('33% complete')).toBeVisible({ timeout: 60_000 });
    await shot(page, '5-03-course-33');
    // Play All moved on to the link item and opened it in the viewer; close it and stop Play All.
    if (await page.getByRole('dialog').isVisible().catch(() => false)) {
      await shot(page, '5-03b-play-all-link-viewer');
      await page.keyboard.press('Escape');
    }
    const stop = page.getByRole('button', { name: 'Stop Play All' });
    if (await stop.isVisible().catch(() => false)) await stop.click();
    const linkItem = page.locator('li').filter({ hasText: 'Read: the STAR method' });
    await linkItem.getByRole('button', { name: 'Mark as viewed' }).click();
    await expect(page.getByText('67% complete')).toBeVisible();
    await page.getByRole('button', { name: 'Start over' }).click();
    await expect(page.getByText('0% complete')).toBeVisible();
    await shot(page, '5-04-course-start-over');

    // Coach memory: memory-enabled coaching scenario → facts under My memory → disable / clear
    await page.goto(`/w/${ws}/gallery`);
    const coach = page.locator('[data-testid^="gallery-card-"]').filter({ hasText: 'Active listening coaching' }).first();
    await coach.getByRole('button', { name: 'Start' }).click();
    await page.waitForURL(/\/live\//);
    await joinTyped(page, { record: false });
    await finishConversation(page, [
      'I want to get better at active listening in my one-on-ones with my team at work.',
      'I tend to interrupt people and jump to solutions before they finish, especially with my direct report Sam.',
    ]);
    await page.goto(`/w/${ws}/learn/memory`);
    await expect.poll(async () => {
      await page.reload();
      return page.getByText(/Nothing remembered yet/).count();
    }, { timeout: 90_000 }).toBe(0);
    await shot(page, '5-05-memory');
    await page.getByLabel('Remember things between coaching sessions').click();
    await expect(page.getByText('Memory is off')).toBeVisible();
    await page.getByRole('button', { name: 'Clear all' }).click();
    await expect(page.getByText(/Nothing remembered yet/)).toBeVisible();
    await page.getByLabel('Remember things between coaching sessions').click();
    await shot(page, '5-06-memory-cleared');
    await ctx.close();
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Knowledge
// ─────────────────────────────────────────────────────────────────────────────
/** A minimal one-page PDF with real text objects (so text extraction works). */
function makePdf(lines: string[]): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td 16 TL ${lines.map((l) => `(${l.replace(/[()\\]/g, '')}) '`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test.describe('6. knowledge', () => {
  test('upload PDF + text → processed → attach to scenario → search tester returns citations', async ({ browser }) => {
    test.setTimeout(240_000);
    const { workspaceId: ws } = await seedInfo();
    const ctx = await ctxAs(browser, roleEmail('creator'));
    const page = await ctx.newPage();
    const problems = watch(page);
    const pdfTitle = `qa-refund-policy-${RUN}.pdf`;
    await page.goto(`/w/${ws}/knowledge`);
    await shot(page, '6-01-knowledge');
    await page.getByTestId('knowledge-file-input').setInputFiles([
      {
        name: pdfTitle,
        mimeType: 'application/pdf',
        buffer: makePdf(['Acme refund policy.', 'Customers can request a full refund within 30 days of delivery.', 'Shipping fees are refunded when an order is delayed twice.']),
      },
      { name: `qa-escalation-${RUN}.txt`, mimeType: 'text/plain', buffer: Buffer.from('Escalation matrix\n\nTier 2 support handles damaged goods. Supervisors approve vouchers above 20 percent.\n') },
    ]);
    const row = (name: string) => page.getByRole('row').filter({ hasText: name });
    await expect(row(pdfTitle.replace(/\.pdf$/, '')).first()).toBeVisible();
    await expect(row(pdfTitle.replace(/\.pdf$/, '')).first()).toContainText(/Ready/, { timeout: 90_000 });
    await expect(row(`qa-escalation-${RUN}`).first()).toContainText(/Ready/, { timeout: 90_000 });
    await shot(page, '6-02-knowledge-ready');

    // Search tester returns citations
    await page.getByLabel('Query').fill('refund delayed');
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByText(/\d+ results? for “refund delayed”/)).toBeVisible();
    await expect(page.locator('li').filter({ hasText: 'Shipping fees are refunded' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(pdfTitle.replace(/\.pdf$/, '').replace(/[-]/g, '.')) }).first()).toBeVisible();
    await shot(page, '6-03-search');

    // Attach to a scenario (duplicate of a seeded one) and publish
    const a = await apiAs(roleEmail('creator'));
    const src = await scenarioByName(a, ws, 'De-escalating an upset customer');
    const dup = await (await a.post(`/api/workspaces/${ws}/scenarios`, { data: { source: 'duplicate', scenarioId: src.id, name: `QA knowledge ${RUN}` } })).json();
    await a.dispose();
    await page.goto(`/w/${ws}/scenarios/${dup.scenario.id}`);
    await page.getByRole('tab', { name: 'Advanced' }).click();
    await page.getByLabel(new RegExp(pdfTitle.replace(/\.pdf$/, '').replace(/[-]/g, '.'))).check();
    await expect(page.getByTestId('save-state')).toHaveText('All changes saved', { timeout: 10_000 });
    await page.getByTestId('publish').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByText('Published version 1')).toBeVisible();
    await page.goto(`/w/${ws}/knowledge`);
    await expect(row(pdfTitle.replace(/\.pdf$/, '')).first()).toContainText('1 scenario');
    await ctx.close();
    expect(problems, problems.join('\n')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Developer
// ─────────────────────────────────────────────────────────────────────────────
test.describe('7. developer', () => {
  test('API key → /api/v1/scenarios, /api/v1/sessions (Idempotency-Key) → session url works → /api/docs', async ({ browser }) => {
    const { workspaceId: ws } = await seedInfo();
    let key = shared.apiKey;
    if (!key) {
      const admin = await apiAs(roleEmail('admin'));
      const r = await admin.post(`/api/workspaces/${ws}/api-keys`, { data: { name: `QA dev ${RUN}`, scopes: ['scenarios:read', 'sessions:read', 'sessions:write'] } });
      expect(r.ok(), await r.text()).toBeTruthy();
      key = shared.apiKey = (await r.json()).secret;
      await admin.dispose();
    }
    const v1 = await request.newContext({ baseURL: API, extraHTTPHeaders: { authorization: `Bearer ${key}` } });
    const scen = await v1.get('/api/v1/scenarios');
    expect(scen.status(), await scen.text()).toBe(200);
    const list = (await scen.json()).data as any[];
    const target = list.find((x) => x.name === 'Behavioral interview') ?? list[0];
    expect(target).toBeTruthy();
    const sessions = await v1.get('/api/v1/sessions?limit=5');
    expect(sessions.status()).toBe(200);
    expect(Array.isArray((await sessions.json()).data)).toBe(true);
    const idem = `qa-${RUN}-crm-42`;
    const body = { scenarioId: target.id, participant: { externalId: `crm-${RUN}`, name: 'Api Person' }, variables: { role_title: 'Data engineer' }, metadata: { crm: 'opp-42' } };
    const first = await v1.post('/api/v1/sessions', { data: body, headers: { 'Idempotency-Key': idem } });
    expect(first.status(), await first.text()).toBe(201);
    const second = await v1.post('/api/v1/sessions', { data: body, headers: { 'Idempotency-Key': idem } });
    expect(second.status()).toBe(201);
    expect(second.headers()['idempotency-replayed']).toBe('true');
    const a = await first.json();
    expect((await second.json()).sessionId).toBe(a.sessionId);
    // Same key, different body → conflict
    const clash = await v1.post('/api/v1/sessions', { data: { ...body, metadata: { crm: 'other' } }, headers: { 'Idempotency-Key': idem } });
    expect(clash.status()).toBe(422);
    // Cookie auth is rejected on v1; missing key is 401
    const anon = await request.newContext({ baseURL: API });
    expect((await anon.get('/api/v1/scenarios')).status()).toBe(401);
    await anon.dispose();
    const got = await v1.get(`/api/v1/sessions/${a.sessionId}`);
    expect(got.status()).toBe(200);
    await v1.dispose();

    // The participant url from the API opens the live page
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const u = new URL(a.url);
    await page.goto(u.pathname + u.hash);
    await expect(page.getByRole('heading', { name: 'Behavioral interview' })).toBeVisible();
    await expect(page.getByText(/Data engineer/).first()).toBeVisible();
    await shot(page, '7-01-api-session-live');
    // OpenAPI UI + API guide
    await page.goto('/api/docs');
    await expect(page.getByText(/ConversaForge/).first()).toBeVisible();
    await shot(page, '7-02-swagger');
    await page.goto('/docs/api');
    await expect(page.locator('body')).toContainText(/API/);
    await shot(page, '7-03-api-guide');
    await ctx.close();
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

test.describe('8. cross-cutting (mobile, isolation)', () => {
  test('375 px: /r/<token>, /live (all phases), /report and workspace pages have no horizontal scroll', async ({ browser }) => {
    test.setTimeout(240_000);
    const { workspaceId: ws } = await seedInfo();
    const admin = await apiAs(roleEmail('admin'));
    const sc = await scenarioByName(admin, ws, 'Behavioral interview');
    const link = await (await admin.post(`/api/workspaces/${ws}/scenarios/${sc.id}/links`, { data: { label: `QA mobile ${RUN}`, identityMode: 'NAME' } })).json();
    await admin.dispose();
    const ctx = await browser.newContext({ viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const problems = watch(page);
    const overflow = async (label: string) => {
      await page.waitForTimeout(300);
      const w = await page.evaluate(() => document.documentElement.scrollWidth);
      await shot(page, `8-m-${label}`);
      expect(w, `${label}: page is ${w}px wide at 375px viewport`).toBeLessThanOrEqual(376);
    };
    await page.goto(new URL(link.url).pathname);
    await expect(page.getByRole('heading', { name: 'Behavioral interview' })).toBeVisible();
    await overflow('r-landing');
    await page.getByLabel('Your name').fill('Mo Bile');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL(/\/live\//);
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    await overflow('live-intro');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('Before we start').waitFor();
    await overflow('live-consent');
    await page.getByLabel(/I understand I’m talking with an AI/).check();
    await page.getByRole('button', { name: 'Agree and continue' }).click();
    await page.getByRole('button', { name: /Allow microphone/ }).click();
    await expect(page.getByRole('button', { name: 'Join the call' })).toBeVisible();
    await overflow('live-device');
    await page.getByRole('button', { name: 'Join the call' }).click();
    await page.getByTestId('call-status').filter({ hasText: 'Live' }).waitFor({ timeout: 30_000 });
    if (!/Typed/.test(await page.getByTestId('voice-mode').innerText())) await page.getByRole('button', { name: 'Switch to typing' }).click();
    await expect.poll(() => savedAgentTurns(page), { timeout: 30_000 }).toBeGreaterThan(0);
    await say(page, 'Hi Alex, I am a mobile engineer with a very long answer that should wrap nicely on a small screen without any horizontal scrolling at all.');
    await overflow('live-call');
    await converse(page, [], { endIfOpen: true });
    await overflow('live-end');
    await page.getByRole('link', { name: 'View your feedback' }).click();
    await page.waitForURL(/\/report\//);
    await expect(page.getByRole('heading', { name: /Your feedback/ })).toBeVisible();
    await overflow('report');
    await ctx.close();

    // Logged-in pages at 375 px
    const mctx = await ctxAs(browser, roleEmail('owner'), { viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true });
    const mp = await mctx.newPage();
    for (const path of ['', '/scenarios', '/sessions', '/learn', '/settings/members', '/settings/usage']) {
      await mp.goto(`/w/${ws}${path}`);
      await mp.waitForLoadState('networkidle');
      await mp.waitForTimeout(300);
      const w = await mp.evaluate(() => document.documentElement.scrollWidth);
      await mp.screenshot({ path: join(SHOTS, `8-m-ws${path.replace(/\//g, '_') || '_dashboard'}.png`), fullPage: true });
      expect(w, `/w/…${path} is ${w}px wide at 375px`).toBeLessThanOrEqual(376);
    }
    await mctx.close();
    expect(problems, problems.join('\n')).toEqual([]);
  });

  test('resources of another workspace are 404 (API and UI)', async ({ browser }) => {
    const { workspaceId: acme } = await seedInfo();
    const owner = await apiAs(roleEmail('owner'));
    const sc = await scenarioByName(owner, acme, 'Behavioral interview');
    const sessions = await (await owner.get(`/api/workspaces/${acme}/sessions?limit=1`)).json();
    await owner.dispose();
    // A user of another workspace (the QA creator from journey 1, or a fresh signup)
    let email = shared.creatorEmail;
    if (!email) {
      email = `qa-iso-${RUN}@test.local`;
      const c = await request.newContext({ baseURL: WEB });
      await c.post('/api/auth/signup', { data: { email, password: 'qa-password-123', name: 'Iso Late' } });
      await c.storageState({ path: join(CACHE, `qa-${email.replace(/[^a-z0-9]/gi, '_')}.json`) });
      await c.dispose();
    }
    const outsider = await request.newContext({ baseURL: WEB, storageState: join(CACHE, `qa-${email.replace(/[^a-z0-9]/gi, '_')}.json`), extraHTTPHeaders: { origin: WEB } });
    const me = await (await outsider.get('/api/auth/me')).json();
    const own = me.workspaces[0].id;
    // Direct access to the other workspace → 404 (never 403, never data)
    expect((await outsider.get(`/api/workspaces/${acme}/scenarios`)).status()).toBe(404);
    // Another workspace's ids through the outsider's own workspace → 404
    expect((await outsider.get(`/api/workspaces/${own}/scenarios/${sc.id}`)).status()).toBe(404);
    if (sessions.data?.[0]) expect((await outsider.get(`/api/workspaces/${own}/sessions/${sessions.data[0].id}`)).status()).toBe(404);
    await outsider.dispose();
    const ctx = await browser.newContext({ storageState: join(CACHE, `qa-${email.replace(/[^a-z0-9]/gi, '_')}.json`) });
    const page = await ctx.newPage();
    await page.goto(`/w/${acme}/scenarios/${sc.id}`);
    await expect(page.getByText('Workspace not found')).toBeVisible();
    await page.goto(`/w/${own}/scenarios/${sc.id}`);
    await expect(page.getByText('Scenario not found')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to scenarios' })).toBeVisible();
    await shot(page, '8-404-scenario');
    if (sessions.data?.[0]) {
      await page.goto(`/w/${own}/sessions/${sessions.data[0].id}`);
      await expect(page.getByText('Session not found')).toBeVisible();
    }
    await ctx.close();
  });
});
