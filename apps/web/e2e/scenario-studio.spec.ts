import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Scenario Studio journey (AI-first creation): library → Create scenario → one brief → review and apply →
 * two manual edits + a lock → a targeted follow-up that respects both → validation link → YAML/JSON and
 * form agree → preview without publishing → reload keeps draft + conversation → Create Scenario (v1) →
 * a session pinned to v1 → AI edit → Publish Changes (v2) → the session still counts against v1.
 * Then the same Studio at phone width.
 *
 * Runs against the local simulator drafter (no AI provider key), so the assistant is deterministic.
 * Run: E2E_WEB_URL=http://localhost:3101 E2E_CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npx playwright test e2e/scenario-studio.spec.ts
 */
test.setTimeout(240_000);

const SHOTS = join(__dirname, '..', 'test-results', 'studio-journey');
mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });

const BRIEF =
  'A 20-minute behavioral interview for a senior product manager role. Ask about stakeholder management. Never ask about salary. Require human review.';

async function signup(page: Page) {
  const email = `e2e-studio-${Date.now()}@test.local`;
  const res = await page.request.post('/api/auth/signup', { data: { email, password: `pw-${Date.now()}-studio`, name: 'Studio E2E' } });
  expect(res.ok()).toBeTruthy();
  const me = await (await page.request.get('/api/auth/me')).json();
  return me.workspaces[0].id as string;
}

async function send(page: Page, message: string) {
  const before = await page.getByTestId('studio-exchange').count();
  await page.getByLabel('Message the assistant').fill(message);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('studio-exchange')).toHaveCount(before + 1, { timeout: 30_000 });
  return page.getByTestId('studio-exchange').last();
}

const saved = (page: Page) => expect(page.getByTestId('save-state')).toHaveText('All changes saved', { timeout: 15_000 });

test('Scenario Studio: create with AI, edit, lock, refine, publish v1 and v2', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const ws = await signup(page);

  // 1. Library → Create scenario opens the Studio directly.
  await page.goto(`/w/${ws}/scenarios`);
  await page.getByTestId('create-scenario').click();
  await page.waitForURL(`**/w/${ws}/scenarios/new`);
  await expect(page.getByRole('heading', { name: 'Scenario Studio' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Describe the scenario you want' })).toBeVisible();
  await expect(page.getByTestId('studio-primary')).toHaveText('Create Scenario');
  await expect(page.getByTestId('studio-primary')).toBeDisabled();
  await shot(page, '01-empty-studio');

  // 2. One natural-language brief → a coherent proposal; the draft is stored and the URL points at it.
  const first = await send(page, BRIEF);
  await page.waitForURL(new RegExp(`/w/${ws}/scenarios/(?!new)[a-z0-9]+$`));
  const scenarioId = page.url().split('/').pop()!;
  await expect(first.getByTestId('assistant-reply')).toContainText('I drafted a 20-minute behavioral interview for the senior product manager role');
  for (const p of ['basics.name', 'basics.publicDescription', 'basics.participantInstructions', 'instructions.aiInstructions', 'conversation.agenda', 'rubric', 'basics.targetDurationMinutes']) {
    await expect(first.getByTestId(`change-${p}`)).toBeVisible();
  }
  await expect(page.getByTestId('ai-mark-basics.name')).toHaveText('AI suggestion');
  await shot(page, '02-first-proposal');
  await first.getByRole('button', { name: /Apply all/ }).click();
  await expect(first.getByText(/Applied: \d+ changes/)).toBeVisible();
  await expect(page.getByTestId('ready')).toContainText('Ready to create');
  const nameInput = page.locator('#field-basics-name input');
  await expect(nameInput).toHaveValue('Behavioral interview for the senior product manager role');
  await expect(page.getByTestId('scenario-title')).toHaveText('Behavioral interview for the senior product manager role');
  await shot(page, '03-applied');

  // 3. Two manual edits and one lock.
  const manualInstructions = 'You will meet Priya, a hiring manager. Take a breath before answering; this is practice.';
  await page.locator('#field-basics-participantInstructions textarea').fill(manualInstructions);
  await page.locator('#field-persona-name input').fill('Priya');
  await page.getByTestId('lock-basics.name').click();
  await expect(page.getByTestId('lock-basics.name')).toHaveAttribute('aria-pressed', 'true');
  await saved(page);

  // 4. A targeted follow-up respects the lock and the manual edits.
  const follow = await send(page, 'Make it 15 minutes');
  await expect(follow.getByTestId('change-basics.targetDurationMinutes')).toContainText('20 → 15');
  await expect(follow.getByTestId('change-conversation.ending')).toBeVisible();
  for (const p of ['basics.name', 'basics.participantInstructions', 'persona.name', 'rubric', 'conversation.agenda']) await expect(follow.getByTestId(`change-${p}`)).toHaveCount(0);
  const leftAlone = follow.getByTestId('assistant-left-alone');
  await expect(leftAlone).toContainText('Kept (locked): Name');
  await expect(leftAlone).toContainText('Participant instructions');
  await expect(leftAlone).toContainText('Persona name');
  await expect(follow.getByTestId('assistant-reply')).toContainText('Everything else is unchanged');
  await shot(page, '04-follow-up');
  await follow.getByRole('button', { name: /Apply all/ }).click();
  await expect(follow.getByText(/Applied: \d+ change/)).toBeVisible();
  await expect(nameInput).toHaveValue('Behavioral interview for the senior product manager role');
  await expect(page.locator('#field-basics-participantInstructions textarea')).toHaveValue(manualInstructions);
  await expect(page.locator('#field-persona-name input')).toHaveValue('Priya');
  // Sections the assistant changed open automatically.
  await expect(page.getByTestId('section-conversation').getByRole('button').first()).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#field-basics-targetDurationMinutes input')).toHaveValue('15');

  // 5. Validation errors link to the field.
  const publicDescription = page.locator('#field-basics-publicDescription textarea');
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
  await expect(page.getByTestId('ready')).toBeVisible();
  await saved(page);

  // 6. YAML/JSON edits the same draft.
  await page.getByRole('tab', { name: 'YAML / JSON' }).click();
  const yaml = page.getByLabel('Scenario YAML/JSON');
  await expect(yaml).toContainText('targetDurationMinutes: 15');
  await expect(yaml).toContainText('name: Priya');
  await yaml.fill((await yaml.inputValue()).replace(/tone: .*/, 'tone: calm and encouraging'));
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByText('Applied to the draft')).toBeVisible();
  await page.getByRole('tab', { name: 'Form' }).click();
  await expect(page.locator('#field-instructions-tone input')).toHaveValue('calm and encouraging');
  await saved(page);

  // 7. Preview reflects the draft and publishes nothing.
  await page.getByRole('tab', { name: 'Preview' }).click();
  await expect(page.getByText('Previewing never publishes anything')).toBeVisible();
  await expect(page.getByText(manualInstructions)).toBeVisible();
  await expect(page.getByText(/with Priya/)).toBeVisible();
  await shot(page, '06-preview');
  const versionsBefore = await (await page.request.get(`/api/workspaces/${ws}/scenarios/${scenarioId}/versions`)).json();
  expect(versionsBefore.data).toEqual([]);

  // 8. Leaving and returning keeps the draft and the conversation.
  await page.goto(`/w/${ws}/scenarios`);
  await expect(page.getByText('Behavioral interview for the senior product manager role').first()).toBeVisible();
  await page.goto(`/w/${ws}/scenarios/${scenarioId}`);
  await expect(page.getByTestId('studio-exchange')).toHaveCount(2);
  await expect(page.getByTestId('user-message').first()).toHaveText(BRIEF);
  await expect(page.locator('#field-persona-name input')).toHaveValue('Priya');
  await expect(page.getByTestId('lock-basics.name')).toHaveAttribute('aria-pressed', 'true');

  // 9. Create Scenario → version 1.
  await page.getByTestId('studio-primary').click();
  await expect(page.getByText('Scenario created — version 1 is live')).toBeVisible();
  await expect(page.getByTestId('deploy-tab')).toContainText('Version 1 published');
  await expect(page.getByTestId('studio-primary')).toHaveText('Publish Changes');
  await shot(page, '07-created-v1');

  // A participant session started now is tied to version 1.
  const session = await page.request.post(`/api/workspaces/${ws}/scenarios/${scenarioId}/sessions`, { data: {} });
  expect(session.ok()).toBeTruthy();

  // 10. A later AI edit → Publish Changes → version 2; the session stays on version 1.
  await page.getByRole('tab', { name: 'Form' }).click();
  const tweak = await send(page, 'Add a question about prioritization');
  await expect(tweak.getByTestId('change-conversation.agenda')).toBeVisible();
  await tweak.getByRole('button', { name: /Apply all/ }).click();
  await expect(tweak.getByText(/Applied: 1 change/)).toBeVisible();
  await saved(page);
  await page.getByTestId('studio-primary').click();
  await page.getByLabel('Change note').fill('Adds a prioritization topic');
  await page.getByRole('dialog').getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published version 2')).toBeVisible();
  const versions = await (await page.request.get(`/api/workspaces/${ws}/scenarios/${scenarioId}/versions`)).json();
  expect(versions.data.map((v: { version: number; sessionCount: number }) => [v.version, v.sessionCount])).toEqual([
    [2, 0],
    [1, 1],
  ]);
  const v1 = await (await page.request.get(`/api/workspaces/${ws}/scenarios/${scenarioId}/versions/${versions.data[1].id}`)).json();
  expect(JSON.stringify(v1.config)).not.toContain('rioritization');
  await expect(page.getByTestId('version-1')).toContainText('1 session');
  await shot(page, '08-published-v2');

  // Classic editor works on the same draft.
  await page.getByRole('button', { name: 'Classic' }).click();
  await page.waitForURL(/view=classic/);
  await expect(page.getByRole('tab', { name: 'Advanced' })).toBeVisible();
  await expect(page.getByTestId('scenario-title')).toHaveText('Behavioral interview for the senior product manager role');
});

test('Scenario Studio at phone width: chat and configuration switch without losing state', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const ws = await signup(page);
  await page.goto(`/w/${ws}/scenarios/new`);
  await expect(page.getByRole('heading', { name: 'Describe the scenario you want' })).toBeVisible();

  // Something typed in the configuration survives switching panes.
  await page.getByRole('tab', { name: 'Configuration' }).click();
  await page.locator('#field-basics-name input').fill('Phone-width draft');
  await page.getByRole('tab', { name: 'AI chat' }).click();
  await page.getByLabel('Message the assistant').fill('A 10-minute sales discovery call with a skeptical CFO about our analytics product');
  await page.getByRole('tab', { name: 'Configuration' }).click();
  await expect(page.locator('#field-basics-name input')).toHaveValue('Phone-width draft');
  await page.getByRole('tab', { name: 'AI chat' }).click();
  await expect(page.getByLabel('Message the assistant')).toHaveValue(/skeptical CFO/);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const ex = page.getByTestId('studio-exchange').first();
  await expect(ex.getByTestId('assistant-proposal')).toBeVisible({ timeout: 30_000 });
  // The creator typed the name, so the assistant keeps it.
  await expect(ex.getByTestId('change-basics.name')).toHaveCount(0);
  await shot(page, '09-mobile-chat');
  await ex.getByRole('button', { name: /Apply all/ }).click();
  await expect(ex.getByText(/Applied: \d+ changes/)).toBeVisible();

  // The configuration pane shows the result; nothing overflows horizontally.
  await page.getByRole('tab', { name: 'Configuration' }).click();
  await expect(page.locator('#field-basics-name input')).toHaveValue('Phone-width draft');
  await expect(page.getByTestId('ready')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, '10-mobile-config');

  // Validation links switch to the configuration pane.
  await page.getByRole('tab', { name: 'AI chat' }).click();
  await page.getByRole('tab', { name: 'Configuration' }).click();
  await page.locator('#field-basics-publicDescription textarea').fill('');
  await page.getByRole('tab', { name: 'AI chat' }).click();
  await page.getByTestId('issues-toggle').click();
  await page.getByTestId('issues-panel').getByRole('button', { name: /Public description/ }).click();
  await expect(page.locator('#field-basics-publicDescription textarea')).toBeFocused();
});
