import { expect, test } from '@playwright/test';

/**
 * Workstream A journey: create → assistant draft → edit → validate → publish → version history → rollback,
 * plus preview, YAML editing and the galleries.
 * Run: WEB_URL=http://localhost:3101 PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx playwright test e2e/scenarios.spec.ts
 */
const WEB = process.env.WEB_URL ?? 'http://localhost:3000';

test.use({
  baseURL: WEB,
  // The preinstalled Chromium may be newer than this Playwright build; allow overriding the binary.
  launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
});
test.setTimeout(180_000);

test('scenario authoring journey', async ({ page }) => {
  const email = `e2e-a-${Date.now()}@test.local`;
  const signup = await page.request.post('/api/auth/signup', { data: { email, password: 'password1234', name: 'E2E Creator' } });
  expect(signup.ok()).toBeTruthy();
  const me = await (await page.request.get('/api/auth/me')).json();
  const ws = me.workspaces[0].id as string;

  // Library → new blank scenario
  await page.goto(`/w/${ws}/scenarios`);
  await page.getByTestId('new-scenario').click();
  await page.getByRole('dialog').getByLabel('Name').fill('E2E discovery call');
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await page.waitForURL(new RegExp(`/w/${ws}/scenarios/[a-z0-9]+$`));
  await expect(page.getByTestId('scenario-title')).toHaveText('E2E discovery call');
  const scenarioId = page.url().split('/').pop()!;

  // Lock the name, then ask the drafting assistant (local simulator)
  await page.getByRole('tab', { name: 'Advanced' }).click();
  await page.getByTestId('lock-basics.name').click();
  await expect(page.getByTestId('save-state')).toHaveText('All changes saved');
  await page.getByLabel('What should change?').fill('a 15-minute sales discovery call with a skeptical CFO about our analytics product');
  await page.getByRole('button', { name: 'Propose changes' }).click();
  const proposal = page.getByTestId('assistant-proposal');
  await expect(proposal).toBeVisible();
  await expect(proposal.getByText('Simulated drafter')).toBeVisible();
  await expect(proposal.getByText('basics.name', { exact: true })).toHaveCount(0);
  await proposal.getByRole('button', { name: /Apply selected/ }).click();
  await expect(page.getByText('All changes applied')).toBeVisible();
  await expect(page.getByTestId('scenario-title')).toHaveText('E2E discovery call');
  await expect(page.getByText('Ready to publish.')).toBeVisible();

  // Manual edit with autosave
  const personaName = page.locator('#field-persona-name input');
  await personaName.fill('Dana');
  await expect(page.getByTestId('save-state')).toHaveText('All changes saved', { timeout: 10_000 });

  // Break the rubric → validation error → normalize fixes it
  await page.getByLabel('Criterion 1 weight').fill('90');
  await expect(page.getByText(/Criterion weights must sum to 100/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Normalize to 100' }).click();
  await expect(page.getByText('Ready to publish.')).toBeVisible();
  await expect(page.getByTestId('save-state')).toHaveText('All changes saved', { timeout: 10_000 });

  // Validate (server) and publish v1
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByText(/Valid — /)).toBeVisible();
  await page.getByTestId('publish').click();
  await page.getByLabel('Change note').fill('First version');
  await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published version 1')).toBeVisible();

  // Edit + publish v2
  await personaName.fill('Dana W');
  await expect(page.getByTestId('save-state')).toHaveText('All changes saved', { timeout: 10_000 });
  await page.getByTestId('publish').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published version 2')).toBeVisible();

  // Versions: diff and rollback to v1 (creates v3)
  await page.getByRole('tab', { name: /Versions/ }).click();
  await expect(page.getByTestId('version-2')).toContainText('Latest');
  await page.getByTestId('version-1').getByRole('button', { name: 'Diff vs latest' }).click();
  await expect(page.getByTestId('diff')).toContainText('persona.name');
  page.once('dialog', (d) => d.accept());
  await page.getByTestId('version-1').getByRole('button', { name: 'Rollback to this version' }).click();
  await expect(page.getByText('Rolled back — published version 3')).toBeVisible();
  await expect(page.getByTestId('version-3')).toContainText('rollback of v1');
  await expect(page.getByTestId('version-3')).toContainText('Latest');

  // Preview shows the participant view and the compiled prompt
  await page.getByRole('tab', { name: 'Preview' }).click();
  await expect(page.getByText('What participants see')).toBeVisible();
  await expect(page.getByText('Dana opens with')).toBeVisible(); // v1 persona name after rollback
  await expect(page.getByText('Compiled system prompt')).toBeVisible();

  // YAML editing: invalid values are rejected inline, valid ones applied
  await page.getByRole('tab', { name: 'YAML / JSON' }).click();
  const yaml = page.getByLabel('Scenario YAML/JSON');
  const text = await yaml.inputValue();
  await yaml.fill(text.replace(/targetDurationMinutes: \d+/, 'targetDurationMinutes: soon'));
  await expect(page.getByText('Schema errors')).toBeVisible();
  await yaml.fill(text.replace('name: E2E discovery call', 'name: E2E discovery call (yaml)'));
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByTestId('scenario-title')).toHaveText('E2E discovery call (yaml)');

  // Library shows the scenario with unpublished changes
  await page.goto(`/w/${ws}/scenarios`);
  const row = page.getByRole('row', { name: /E2E discovery call \(yaml\)/ });
  await expect(row).toContainText('Published v3');
  await expect(row).toContainText('Unpublished changes');

  // Workspace gallery → template → editor
  await page.goto(`/w/${ws}/gallery`);
  await expect(page.getByRole('heading', { name: 'Starter templates' })).toBeVisible();
  await page.getByTestId('gallery-card-coaching-session').getByRole('button', { name: 'Use template' }).click();
  await page.waitForURL(/\/scenarios\/[a-z0-9]+$/);
  await expect(page.getByTestId('scenario-title')).toHaveText('Active listening coaching');

  // Public gallery renders templates without login-only data
  await page.goto('/gallery');
  await expect(page.getByText('Practice conversations with AI')).toBeVisible();
  await expect(page.getByTestId('gallery-card-behavioral-interview')).toBeVisible();
  expect(scenarioId).toBeTruthy();
});
