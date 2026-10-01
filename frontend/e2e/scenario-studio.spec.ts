import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Scenario Studio journey (AI-first creation):
 * library → Create Scenario dialog → one brief → the agent drafts the whole scenario in steps →
 * two manual edits + a lock → a targeted follow-up that respects both → a Flash-mode request against the
 * locked name → validation link → YAML/JSON and form agree → preview without publishing → reload keeps
 * draft + conversation → Create Scenario (v1) → scenario page → a session pinned to v1 → AI edit →
 * Save Changes (v2) → the session still counts against v1 → Sessions/Analytics tabs → Legacy editor.
 * Then the same Studio at phone width.
 *
 * Runs against the local simulator (no AI provider key), so the agent is deterministic and fast.
 * Screenshots of each step: apps/web/node_modules/.cache/cf-e2e/studio-journey/ (or E2E_SHOTS_DIR).
 * Run: E2E_WEB_URL=http://localhost:3101 E2E_CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npx playwright test e2e/scenario-studio.spec.ts
 */
test.setTimeout(240_000);

const SHOTS = process.env.E2E_SHOTS_DIR ?? join(__dirname, '..', 'node_modules', '.cache', 'cf-e2e', 'studio-journey');
mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });

const BRIEF = 'A 20-minute behavioral interview for a senior product manager role. Ask about stakeholder management. Never ask about salary. Require human review.';
const NAME = 'Behavioral interview for the senior product manager role';

async function signup(page: Page) {
  const email = `e2e-studio-${Date.now()}@test.local`;
  const res = await page.request.post('/api/auth/signup', { data: { email, password: `pw-${Date.now()}-studio`, name: 'Studio E2E' } });
  expect(res.ok()).toBeTruthy();
  const me = await (await page.request.get('/api/auth/me')).json();
  return me.workspaces[0].id as string;
}

/** Wait for the n-th agent run (1-based) to finish. */
async function runDone(page: Page, n: number): Promise<Locator> {
  const run = page.getByTestId('agent-run').nth(n - 1);
  await expect(run).toHaveAttribute('data-status', /DONE|CANCELLED|FAILED/, { timeout: 60_000 });
  return run;
}

async function send(page: Page, message: string) {
  await page.getByLabel('Message the assistant').fill(message);
  await page.getByLabel('Message the assistant').press('Enter');
}

const saved = (page: Page) => expect(page.getByTestId('save-state')).toHaveText(/All saved/, { timeout: 15_000 });

test('Scenario Studio: create with the agent, edit, lock, refine, create v1, save v2', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const ws = await signup(page);

  // 1. Library → Create Scenario → one brief → Studio with the agent already working.
  await page.goto(`/w/${ws}/scenarios`);
  await expect(page.getByRole('heading', { name: 'Scenario Library' })).toBeVisible();
  await shot(page, '01-library');
  await page.getByTestId('create-scenario').click();
  await page.getByLabel('Describe the scenario to create').fill(BRIEF);
  await shot(page, '02-create-dialog');
  await page.getByLabel('Describe the scenario to create').press('Enter');
  await page.waitForURL(new RegExp(`/w/${ws}/scenarios/[a-z0-9]+/studio$`));
  const scenarioId = page.url().split('/').slice(-2)[0]!;
  await expect(page.getByRole('heading', { name: /Scenario Studio/ })).toBeVisible();

  // 2. The run drafts in visible steps and leaves a publishable draft.
  const first = await runDone(page, 1);
  await expect(page.getByTestId('user-message').first()).toHaveText(BRIEF);
  await expect(first.getByTestId('run-update').first()).toContainText(/Updated \d+ fields/);
  await expect(first.getByText('Now expanding the AI instructions in full', { exact: false })).toBeVisible();
  await expect(first.getByTestId('run-check').last()).toContainText('Ready to publish');
  await expect(first.getByTestId('assistant-reply')).toContainText('I drafted a 20-minute behavioral interview for the senior product manager role');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(NAME);
  await expect(page.getByTestId('ai-mark-basics.name')).toBeVisible();
  await expect(page.getByLabel('AI Instructions', { exact: true })).toHaveValue(/## FLOW/);
  await expect(page.getByTestId('studio-primary')).toHaveText(/Create Scenario/);
  await shot(page, '03-agent-drafted');

  // 3. Two manual edits and one lock.
  const manualInstructions = 'You will meet Priya, a hiring manager. Take a breath before answering; this is practice.';
  await page.getByLabel('Participant Instructions', { exact: true }).fill(manualInstructions);
  await page.getByTestId('section-behavior').getByRole('button').first().click();
  await page.locator('#field-persona-name input').fill('Priya');
  await page.getByTestId('lock-basics.name').click();
  await expect(page.getByTestId('lock-basics.name')).toHaveAttribute('aria-pressed', 'true');
  await saved(page);

  // 4. A targeted follow-up respects the lock and the manual edits.
  await send(page, 'Make it 15 minutes');
  const follow = await runDone(page, 2);
  await follow.getByTestId('run-update').first().click();
  await expect(follow.getByText('Target duration', { exact: true })).toBeVisible();
  await expect(follow.getByTestId('change-basics.targetDurationMinutes')).toContainText('20 → 15');
  for (const p of ['basics.name', 'basics.participantInstructions', 'persona.name', 'rubric', 'conversation.agenda']) await expect(follow.getByTestId(`change-${p}`)).toHaveCount(0);
  const leftAlone = follow.getByTestId('assistant-left-alone');
  await expect(leftAlone).toContainText('Kept (locked): Name');
  await expect(leftAlone).toContainText('Participant instructions');
  await expect(leftAlone).toContainText('Persona name');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(NAME);
  await expect(page.getByLabel('Participant Instructions', { exact: true })).toHaveValue(manualInstructions);
  await expect(page.locator('#field-persona-name input')).toHaveValue('Priya');
  await shot(page, '04-follow-up');

  // 5. Flash mode: one pass; a request to rename is refused because the name is locked.
  await page.getByRole('button', { name: 'Flash Mode' }).click();
  await send(page, 'Call it "Analyst screen"');
  const flash = await runDone(page, 3);
  await expect(flash.getByText('Flash Mode', { exact: true })).toBeVisible();
  await expect(flash.getByText('Now expanding the AI instructions in full', { exact: false })).toHaveCount(0);
  await expect(flash.getByTestId('assistant-reply')).toContainText('locked');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(NAME);
  await page.getByRole('button', { name: 'Flash Mode' }).click();

  // 6. Validation errors link to the field.
  const publicDescription = page.getByLabel('Public Description', { exact: true });
  const description = await publicDescription.inputValue();
  await publicDescription.fill('');
  await expect(page.getByTestId('issues-toggle')).toHaveText('1 field needs attention');
  await expect(page.getByTestId('studio-primary')).toBeDisabled();
  await page.getByTestId('issues-toggle').click();
  await expect(page.getByTestId('issues-panel')).toContainText('Public description is required');
  await shot(page, '05-validation');
  await page.getByTestId('issues-panel').getByRole('button', { name: /Public description/ }).click();
  await expect(publicDescription).toBeFocused();
  await publicDescription.fill(description);
  await saved(page);

  // 7. YAML edits the same draft.
  await page.getByRole('tab', { name: 'YAML' }).click();
  const yaml = page.getByLabel('Scenario YAML/JSON');
  await expect(yaml).toContainText('targetDurationMinutes: 15');
  await expect(yaml).toContainText('name: Priya');
  await yaml.fill((await yaml.inputValue()).replace(/tone: .*/, 'tone: calm and encouraging'));
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByText('Applied to the draft')).toBeVisible();
  await page.getByRole('tab', { name: 'Form' }).click();
  await expect(page.locator('#field-instructions-tone input')).toHaveValue('calm and encouraging');
  await saved(page);

  // 8. Preview reflects the draft and publishes nothing.
  await page.getByRole('tab', { name: 'Preview' }).click();
  await expect(page.getByRole('heading', { name: 'Live Preview' })).toBeVisible();
  await expect(page.getByTestId('studio-preview')).toContainText(manualInstructions);
  await expect(page.getByTestId('studio-preview')).toContainText('with Priya');
  await expect(page.getByRole('button', { name: 'Try Now' })).toBeDisabled();
  await shot(page, '06-preview');
  expect((await (await page.request.get(`/api/workspaces/${ws}/scenarios/${scenarioId}/versions`)).json()).data).toEqual([]);

  // 9. Leaving and returning keeps the draft and the conversation.
  await page.goto(`/w/${ws}/scenarios`);
  await expect(page.getByTestId('scenario-card').filter({ hasText: NAME })).toContainText('Draft');
  await page.goto(`/w/${ws}/scenarios/${scenarioId}/studio`);
  await expect(page.getByTestId('studio-exchange')).toHaveCount(3);
  await expect(page.getByTestId('user-message').first()).toHaveText(BRIEF);
  await expect(page.getByLabel('Participant Instructions', { exact: true })).toHaveValue(manualInstructions);
  await expect(page.getByTestId('lock-basics.name')).toHaveAttribute('aria-pressed', 'true');

  // 10. Create Scenario → version 1 → the scenario page.
  await page.getByTestId('studio-primary').click();
  await page.waitForURL(new RegExp(`/w/${ws}/scenarios/${scenarioId}$`));
  await expect(page.getByText('Scenario created — version 1 is live')).toBeVisible();
  await expect(page.getByTestId('scenario-title')).toHaveText(NAME);
  await expect(page.getByTestId('channel-cards')).toContainText('Meeting Bot');
  await expect(page.getByTestId('details-tab')).toContainText(manualInstructions);
  await expect(page.getByTestId('details-tab')).toContainText('FLOW');
  await shot(page, '07-scenario-page');

  // A participant session started now is tied to version 1.
  expect((await page.request.post(`/api/workspaces/${ws}/scenarios/${scenarioId}/sessions`, { data: {} })).ok()).toBeTruthy();

  // 11. Edit → an AI change → Save Changes → version 2; the session stays on version 1.
  await page.getByRole('link', { name: 'Edit' }).click();
  await page.waitForURL(/\/studio$/);
  await expect(page.getByTestId('studio-primary')).toHaveText(/Save Changes/);
  await send(page, 'Add a question about prioritization');
  const tweak = await runDone(page, 4);
  await tweak.getByTestId('run-update').first().click();
  await expect(tweak.getByText('Agenda', { exact: true })).toBeVisible();
  await saved(page);
  await page.getByTestId('studio-primary').click();
  await expect(page.getByText('Saved — version 2 is live for new sessions')).toBeVisible();
  const versions = await (await page.request.get(`/api/workspaces/${ws}/scenarios/${scenarioId}/versions`)).json();
  expect(versions.data.map((v: { version: number; sessionCount: number }) => [v.version, v.sessionCount])).toEqual([
    [2, 0],
    [1, 1],
  ]);
  const v1 = await (await page.request.get(`/api/workspaces/${ws}/scenarios/${scenarioId}/versions/${versions.data[1].id}`)).json();
  expect(JSON.stringify(v1.config)).not.toContain('rioritization');
  await shot(page, '08-saved-v2');

  // 12. Sessions and Analytics on the scenario page.
  await page.goto(`/w/${ws}/scenarios/${scenarioId}`);
  await page.getByRole('tab', { name: /Sessions/ }).click();
  await expect(page.getByTestId('sessions-tab').locator('tbody tr')).toHaveCount(1);
  await page.getByRole('tab', { name: 'Analytics' }).click();
  await expect(page.getByTestId('analytics-tab')).toContainText('Total Sessions');
  await expect(page.getByTestId('analytics-tab')).toContainText('Daily Sessions');
  await shot(page, '09-analytics');

  // 13. The legacy editor works on the same draft.
  await page.goto(`/w/${ws}/scenarios/${scenarioId}/studio`);
  await page.getByRole('button', { name: 'Legacy' }).click();
  await page.waitForURL(/\/legacy$/);
  await expect(page.getByRole('tab', { name: 'Advanced' })).toBeVisible();
  await expect(page.getByTestId('scenario-title')).toHaveText(NAME);
});

test('Scenario Studio at phone width: chat and configuration switch without losing state', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const ws = await signup(page);
  await page.goto(`/w/${ws}/scenarios/new`);
  await expect(page.getByRole('heading', { name: 'Describe the scenario you want' })).toBeVisible();

  // Something typed in the configuration survives switching panes; the creator's name is kept.
  await page.getByRole('tab', { name: 'Configuration' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Phone-width draft');
  await page.getByRole('tab', { name: 'AI chat' }).click();
  await page.getByLabel('Message the assistant').fill('A 10-minute sales discovery call with a skeptical CFO about our analytics product');
  await page.getByRole('tab', { name: 'Configuration' }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Phone-width draft');
  await page.getByRole('tab', { name: 'AI chat' }).click();
  await expect(page.getByLabel('Message the assistant')).toHaveValue(/skeptical CFO/);
  await page.getByLabel('Message the assistant').press('Enter');
  const run = await runDone(page, 1);
  await expect(run.getByTestId('assistant-left-alone')).toContainText('Name');
  await shot(page, '10-mobile-chat');

  await page.getByRole('tab', { name: 'Configuration' }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Phone-width draft');
  await expect(page.getByTestId('studio-primary')).toBeEnabled();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, '11-mobile-config');

  // Validation links switch to the configuration pane.
  await page.getByLabel('Public Description', { exact: true }).fill('');
  await page.getByRole('tab', { name: 'AI chat' }).click();
  await page.getByTestId('issues-toggle').click();
  await page.getByTestId('issues-panel').getByRole('button', { name: /Public description/ }).click();
  await expect(page.getByLabel('Public Description', { exact: true })).toBeFocused();
});
