/**
 * Workstream E browser journeys: share-link landing → live, creator access page, invitations,
 * org settings pages, account. Self-contained fixtures (own org + template scenario).
 *
 *   E2E_WEB_URL=http://localhost:3105 E2E_API_URL=http://localhost:4105 \
 *   E2E_API_LOG=/path/to/api.log   # dev mail is logged there (invitation links)
 *   npx playwright test e2e/access-admin.spec.ts
 */
import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const API = process.env.E2E_API_URL ?? 'http://localhost:4000';
const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:3000';
const PASSWORD = 'e2e-password-1234';
const uid = () => Math.random().toString(36).slice(2, 8);
// A unique client IP per run so shared-dev-server rate limits (signup/login per IP) don't interfere.
const XFF = `10.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200) + 1}`;

interface Fx {
  api: APIRequestContext;
  ownerEmail: string;
  wsId: string;
  scenarioId: string;
}
let fx: Fx;

async function newApi() {
  return request.newContext({ baseURL: API, extraHTTPHeaders: { 'x-forwarded-for': XFF, origin: WEB } });
}

async function signup(api: APIRequestContext, email: string, name: string) {
  const r = await api.post('/api/auth/signup', { data: { email, password: PASSWORD, name } });
  expect(r.ok(), await r.text()).toBeTruthy();
}

async function loginPage(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/w\//);
}

test.beforeAll(async () => {
  const api = await newApi();
  const ownerEmail = `owner-${uid()}@e2e.test`;
  await signup(api, ownerEmail, 'Olivia Owner');
  const ws = await (await api.post('/api/workspaces', { data: { name: `E2E Org ${uid()}` } })).json();
  const sc = await (await api.post(`/api/workspaces/${ws.id}/scenarios`, { data: { source: 'template', templateKey: 'behavioral-interview', name: 'E2E practice' } })).json();
  const scenarioId = sc.scenario?.id ?? sc.id;
  const pub = await api.post(`/api/workspaces/${ws.id}/scenarios/${scenarioId}/publish`, { data: {} });
  expect(pub.ok(), await pub.text()).toBeTruthy();
  fx = { api, ownerEmail, wsId: ws.id, scenarioId };
});

test.use({ extraHTTPHeaders: { 'x-forwarded-for': XFF } });

test('participant opens a share link, enters identity + passcode, and lands in the live session', async ({ page }) => {
  const link = await (
    await fx.api.post(`/api/workspaces/${fx.wsId}/scenarios/${fx.scenarioId}/links`, {
      data: { label: 'E2E', passcode: 'open-sesame', allowedEmailDomains: ['acme.com'], prefilledVariables: {} },
    })
  ).json();
  const url = new URL(link.url);
  await page.goto(`${url.pathname}?var_role_title=Solutions%20Engineer`);
  await expect(page.getByRole('heading', { name: 'E2E practice' })).toBeVisible();
  await page.getByLabel('Your name').fill('Pat Participant');
  await page.getByLabel('Email').fill('pat@gmail.com');
  await page.getByLabel('Passcode').fill('open-sesame');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(/restricted to email addresses at: acme.com/)).toBeVisible();
  await page.getByLabel('Email').fill('pat@acme.com');
  await page.getByLabel('Passcode').fill('wrong');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('That passcode is not correct.')).toBeVisible();
  await page.getByLabel('Passcode').fill('open-sesame');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(/\/live\/[a-z0-9]+/);
  const sessionId = page.url().split('/live/')[1]!.split(/[?#]/)[0]!;
  const stored = await page.evaluate((id) => sessionStorage.getItem(`cf:session:${id}`), sessionId);
  expect(stored).toMatch(/^cfs_/);
  const session = await (await fx.api.get(`/api/runtime/sessions/${sessionId}`, { headers: { authorization: `Bearer ${stored}` } })).json();
  expect(session.session.id).toBe(sessionId);

  // Revoked link shows a clear message.
  await fx.api.delete(`/api/workspaces/${fx.wsId}/scenarios/${fx.scenarioId}/links/${link.id}`);
  await page.goto(url.pathname);
  await expect(page.getByText('This link is no longer active')).toBeVisible();
});

test('creator manages share links, grants and tokens on the access page', async ({ page }) => {
  await loginPage(page, fx.ownerEmail);
  await page.goto(`/w/${fx.wsId}/scenarios/${fx.scenarioId}/access`);
  await expect(page.getByRole('heading', { name: /Share “E2E practice”/ })).toBeVisible();
  await page.getByRole('button', { name: 'New share link' }).click();
  await page.getByLabel('Label').fill('Browser-made link');
  await page.getByLabel('Usage').selectOption('ONE_TIME');
  await page.getByLabel('Role title (role_title)').fill('Designer');
  await page.getByRole('button', { name: 'Create link' }).click();
  const row = page.getByRole('row', { name: /Browser-made link/ });
  await expect(row).toBeVisible();
  await expect(row.getByText('(one-time)')).toBeVisible();
  await expect(row.getByText('Prefilled: role_title')).toBeVisible();

  await page.getByRole('tab', { name: /People & workspaces/ }).click();
  await page.getByLabel('Email', { exact: true }).fill(`friend-${uid()}@e2e.test`);
  await page.getByRole('button', { name: 'Grant access' }).click();
  await expect(page.getByRole('cell', { name: /friend-/ })).toBeVisible();

  await page.getByRole('tab', { name: /Embed & access tokens/ }).click();
  await page.getByRole('button', { name: 'New access token' }).click();
  await page.getByLabel('Allowed origins').fill('https://customer.example');
  await page.getByRole('button', { name: 'Create token' }).click();
  await expect(page.getByText('Copy your token now')).toBeVisible();
  await expect(page.locator('code', { hasText: /^cfe_/ }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('cell', { name: 'https://customer.example' })).toBeVisible();
});

test('invitation: invitee signs up from the invite link and joins the workspace', async ({ page }) => {
  const log = process.env.E2E_API_LOG;
  test.skip(!log, 'E2E_API_LOG not set (needed to read the dev-mail invitation link)');
  const email = `invitee-${uid()}@e2e.test`;
  const r = await fx.api.post(`/api/workspaces/${fx.wsId}/invitations`, { data: { email, role: 'CREATOR' } });
  expect(r.ok()).toBeTruthy();
  let token: string | undefined;
  for (let i = 0; i < 20 && !token; i++) {
    const text = readFileSync(log!, 'utf8');
    const idx = text.lastIndexOf(`to=${email}`);
    token = idx >= 0 ? /\/invite\/([A-Za-z0-9_-]+)/.exec(text.slice(idx))?.[1] : undefined;
    if (!token) await new Promise((res) => setTimeout(res, 250));
  }
  expect(token).toBeTruthy();
  await page.goto(`/invite/${token}`);
  await expect(page.getByRole('heading', { name: /Join E2E Org/ })).toBeVisible();
  await page.getByRole('link', { name: 'Create account' }).click();
  await page.getByLabel('Name').fill('Ivy Invitee');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /Create account/ }).click();
  await page.waitForURL(new RegExp(`/invite/${token}`));
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await page.waitForURL(new RegExp(`/w/${fx.wsId}`));
  const members = await (await fx.api.get(`/api/workspaces/${fx.wsId}/members`)).json();
  expect(members.data.find((m: any) => m.email === email)?.role).toBe('CREATOR');
});

test('org settings pages: members, branding preview, usage, audit, privacy export, account', async ({ page }) => {
  await loginPage(page, fx.ownerEmail);
  await page.goto(`/w/${fx.wsId}/settings/members`);
  await expect(page.getByRole('cell', { name: fx.ownerEmail })).toBeVisible();

  await page.goto(`/w/${fx.wsId}/settings/branding`);
  await page.getByLabel('Display name').fill('Acme Academy E2E');
  await page.getByPlaceholder('#4f46e5').first().fill('#0f766e');
  await expect(page.getByLabel('Branding preview').getByText('Acme Academy E2E')).toBeVisible();
  await page.getByRole('button', { name: 'Save branding' }).click();
  await expect(page.getByText('Branding saved')).toBeVisible();

  await page.goto(`/w/${fx.wsId}/settings/usage`);
  await expect(page.getByText('Monthly quotas')).toBeVisible();
  await page.getByLabel(/Monthly limit/).fill('500');
  await page.getByRole('button', { name: 'Save quota' }).click();
  await expect(page.getByText(/\/ 500\.0 min/)).toBeVisible();

  await page.goto(`/w/${fx.wsId}/settings/audit`);
  await expect(page.getByText('branding.updated').first()).toBeVisible();

  await page.goto(`/w/${fx.wsId}/settings/privacy`);
  await page.getByLabel('Email', { exact: true }).fill('pat@acme.com');
  await page.getByRole('button', { name: 'Start export' }).click();
  await expect(page.getByRole('button', { name: 'Download' })).toBeVisible({ timeout: 30_000 });

  await page.goto(`/w/${fx.wsId}/settings`);
  await expect(page.getByLabel('Workspace name')).toHaveValue(/E2E Org/);

  await page.goto('/account');
  await expect(page.getByText('Signed-in devices')).toBeVisible();
  await expect(page.getByText('This device')).toBeVisible();
});

test('public scenario page and landing error states', async ({ page }) => {
  await page.goto(`/p/${fx.scenarioId}`);
  await expect(page.getByText('Link not found')).toBeVisible();
  await page.goto('/r/this-link-does-not-exist-at-all-000000000000');
  await expect(page.getByText('Link not found')).toBeVisible();
});
