/**
 * Live participant experience against the REAL API (workstream B runtime + simulator LLM).
 * Headless Chromium has no working Web Speech recognition, so turns are typed; the microphone is
 * a fake device (so recording uploads are exercised).
 *
 *   E2E_WEB_URL=http://localhost:3103 E2E_API_URL=http://localhost:4103 \
 *   E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/conversaforge npx playwright test
 */
import { expect, test, type Page } from '@playwright/test';
import { agentTurns, createSession, DATABASE_URL, joinCall, savedTexts, sql } from './helpers';

const consoleErrors: string[] = [];
function trackConsole(page: Page) {
  consoleErrors.length = 0;
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
}

async function typeTurn(page: Page, text: string) {
  const before = await agentTurns(page);
  const input = page.getByTestId('typed-input');
  await expect(input).toBeEnabled();
  await input.fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
  // Our turn is saved exactly once, then the agent answers.
  await expect(page.locator('[data-testid="transcript"] li[data-speaker="PARTICIPANT"][data-status="saved"]', { hasText: text })).toHaveCount(1);
  await expect.poll(() => agentTurns(page), { timeout: 30_000 }).toBeGreaterThan(before);
}

function expectNoDuplicates(texts: string[]) {
  const seen = new Set<string>();
  for (const t of texts) {
    expect(seen.has(t), `duplicate transcript row: ${t}`).toBe(false);
    seen.add(t);
  }
}

test('missing token shows guidance', async ({ page }) => {
  await page.goto('/live/does-not-exist');
  await expect(page.getByRole('heading', { name: 'Missing session link' })).toBeVisible();
});

test('invalid token shows a friendly error', async ({ page }) => {
  const { sessionId } = await createSession();
  await page.goto(`/live/${sessionId}#t=cfs_invalidinvalidinvalidinvalid`);
  await expect(page.getByRole('heading', { name: 'This link is not valid' })).toBeVisible();
  // The fragment is stripped from the URL.
  expect(page.url()).not.toContain('#t=');
});

test('full session: intro → consent → devices → typed turns → reconnect → refresh → end', async ({ page }) => {
  trackConsole(page);
  const { sessionId, sessionToken } = await createSession();
  await page.goto(`/live/${sessionId}?return=${encodeURIComponent('/w/x/learn')}#t=${sessionToken}`);
  // Intro
  await expect(page.getByRole('heading', { name: 'Behavioral interview' })).toBeVisible();
  expect(page.url()).not.toContain(sessionToken);
  await expect(page.getByText('Simulated session.')).toBeVisible();

  await joinCall(page, { recordAudio: true });
  await expect(page.getByTestId('recording-indicator')).toBeVisible();

  // Headless Chromium: switch to typing (browser recognition does not work headless).
  const mode = await page.getByTestId('voice-mode').innerText();
  if (!/Typed/.test(mode)) await page.getByRole('button', { name: 'Switch to typing' }).click();
  await expect(page.getByTestId('voice-mode')).toContainText('Typed');

  // The simulated agent opens the conversation.
  await expect.poll(() => agentTurns(page), { timeout: 30_000 }).toBeGreaterThan(0);

  await typeTurn(page, 'Hi Alex, thanks for having me. I am a backend engineer with six years of experience.');
  await typeTurn(page, 'Last year I led the migration of our billing system to event sourcing, which cut incidents by half.');

  // ── Reconnect: drop the socket, send a final while disconnected (queued), verify it is delivered once.
  await page.evaluate(() => (window as any).__cfLive.drop());
  await expect(page.getByTestId('call-status')).toHaveText(/Reconnecting|Connecting/);
  const queuedText = 'This answer was sent while the connection was down.';
  await page.evaluate((text) => {
    const conn = (window as any).__cfLive.conn;
    conn.send({ type: 'participant.final', clientTurnId: 'e2e-queued-1', text, source: 'typed' });
  }, queuedText);
  await expect(page.getByTestId('call-status')).toHaveText('Live', { timeout: 30_000 });
  await expect(page.locator('[data-testid="transcript"] li[data-status="saved"]', { hasText: queuedText })).toHaveCount(1, { timeout: 20_000 });
  // Resend the same clientTurnId (as a flaky reconnect would): the server dedupes it.
  await page.evaluate((text) => {
    const conn = (window as any).__cfLive.conn;
    conn.send({ type: 'participant.final', clientTurnId: 'e2e-queued-1', text, source: 'typed' });
  }, queuedText);
  await page.waitForTimeout(1500);
  await expect(page.locator('[data-testid="transcript"] li', { hasText: queuedText })).toHaveCount(1);
  expectNoDuplicates(await savedTexts(page));

  // Let the recorder produce a couple of 5 s parts before the refresh.
  await page.waitForTimeout(11_000);
  if (DATABASE_URL) {
    const parts = Number(sql(`select count(*) from "MediaUploadPart" p join "MediaAsset" a on a.id = p."assetId" where a."sessionId" = '${sessionId}'`));
    expect(parts).toBeGreaterThanOrEqual(2);
  }

  // ── Page refresh mid-call → resume.
  const beforeReload = await savedTexts(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Rejoin your conversation' })).toBeVisible();
  await page.getByRole('button', { name: /Allow microphone/ }).click();
  await page.getByRole('button', { name: 'Rejoin call' }).click();
  await expect(page.getByTestId('call-status')).toHaveText('Live', { timeout: 30_000 });
  await expect.poll(async () => (await savedTexts(page)).length).toBeGreaterThanOrEqual(beforeReload.length);
  expectNoDuplicates(await savedTexts(page));
  const mode2 = await page.getByTestId('voice-mode').innerText();
  if (!/Typed/.test(mode2)) await page.getByRole('button', { name: 'Switch to typing' }).click();
  await typeTurn(page, 'After the refresh I can keep talking. I think that is all from me.');

  // ── End the call.
  await page.getByTestId('end-call').click();
  await page.getByTestId('confirm-end').click();
  await expect(page.getByTestId('end-screen')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'View your feedback' })).toHaveAttribute('href', `/report/${sessionId}`);
  await expect(page.getByRole('link', { name: 'Back to course' })).toHaveAttribute('href', '/w/x/learn');

  if (DATABASE_URL) {
    await expect
      .poll(() => sql(`select state from "Session" where id = '${sessionId}'`), { timeout: 15_000 })
      .toBe('COMPLETED');
    const turns = sql(`select count(*) || ':' || count(distinct seq) from "TranscriptTurn" where "sessionId" = '${sessionId}'`);
    const [n, distinct] = turns.split(':');
    expect(n).toBe(distinct);
    const dupClient = sql(`select count(*) from (select "clientTurnId" from "TranscriptTurn" where "sessionId" = '${sessionId}' and "clientTurnId" is not null group by 1 having count(*) > 1) x`);
    expect(dupClient).toBe('0');
    // Recording assets were completed (one per page load that recorded).
    await expect
      .poll(() => sql(`select count(*) from "MediaAsset" where "sessionId" = '${sessionId}' and kind = 'RECORDING_AUDIO' and status <> 'UPLOADING'`), { timeout: 20_000 })
      .not.toBe('0');
  }

  // Reopening the finished session shows the end screen, not the call.
  await page.goto(`/live/${sessionId}`);
  await expect(page.getByTestId('end-screen')).toBeVisible();
  expect(consoleErrors.filter((e) => !/Failed to load resource|favicon/i.test(e))).toEqual([]);
});

test('pause and resume', async ({ page }) => {
  const { sessionId, sessionToken } = await createSession();
  await page.goto(`/live/${sessionId}#t=${sessionToken}`);
  await joinCall(page, { recordAudio: true });
  await expect(page.getByTestId('recording-indicator')).toBeVisible();
  await page.getByRole('button', { name: /Pause/ }).click();
  await expect(page.getByTestId('call-status')).toHaveText('Paused');
  await expect(page.getByTestId('typed-input')).toBeDisabled();
  // The recording indicator only shows while actually recording.
  await expect(page.getByTestId('recording-indicator')).toHaveCount(0);
  if (DATABASE_URL) await expect.poll(() => sql(`select state from "Session" where id = '${sessionId}'`)).toBe('PAUSED');
  await page.getByRole('button', { name: /Resume/ }).click();
  await expect(page.getByTestId('call-status')).toHaveText('Live');
  await expect(page.getByTestId('recording-indicator')).toBeVisible();
  await expect(page.getByTestId('typed-input')).toBeEnabled();
});

test('declining recording still allows the call and nothing is recorded', async ({ page }) => {
  const { sessionId, sessionToken } = await createSession();
  await page.goto(`/live/${sessionId}#t=${sessionToken}`);
  await joinCall(page, { recordAudio: false });
  await page.waitForTimeout(6500);
  await expect(page.getByTestId('recording-indicator')).toHaveCount(0);
  if (DATABASE_URL) expect(sql(`select count(*) from "MediaAsset" where "sessionId" = '${sessionId}'`)).toBe('0');
  await page.getByTestId('end-call').click();
  await page.getByTestId('confirm-end').click();
  await expect(page.getByTestId('end-screen')).toBeVisible({ timeout: 30_000 });
});

test('a second tab supersedes the first, which can take over', async ({ page, context }) => {
  const { sessionId, sessionToken } = await createSession();
  await page.goto(`/live/${sessionId}#t=${sessionToken}`);
  await joinCall(page, { recordAudio: false });
  const second = await context.newPage();
  await second.goto(`/live/${sessionId}`);
  await second.getByRole('button', { name: /Allow microphone/ }).click();
  await second.getByRole('button', { name: 'Rejoin call' }).click();
  await expect(second.getByTestId('call-status')).toHaveText('Live', { timeout: 30_000 });
  await expect(page.getByText('This session was opened in another tab or device.')).toBeVisible();
  await page.getByRole('button', { name: 'Continue here instead' }).click();
  await expect(page.getByTestId('call-status')).toHaveText('Live', { timeout: 30_000 });
  await expect(second.getByText('This session was opened in another tab or device.')).toBeVisible();
  await second.close();
});

test('mobile width (360px): call screen fits without horizontal scroll', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, permissions: ['microphone'] });
  const page = await ctx.newPage();
  const { sessionId, sessionToken } = await createSession();
  await page.goto(`/live/${sessionId}#t=${sessionToken}`);
  await joinCall(page, { recordAudio: false });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await ctx.close();
});
