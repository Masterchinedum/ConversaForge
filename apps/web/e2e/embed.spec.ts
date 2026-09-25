/**
 * Embed SDK (public/embed.js) + /embed/frame against the real API (workstream E embed-token endpoints,
 * workstream B runtime). The host page is public/embed-example.html served from the web origin.
 */
import { expect, test } from '@playwright/test';
import { DATABASE_URL, mintEmbedToken, sql } from './helpers';

const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:3000';

test('embed: handshake, session.created, call inside the frame, host end() → session.ended', async ({ page }) => {
  const token = await mintEmbedToken([new URL(WEB).origin], { externalId: 'lms-user-42', name: 'Embedded Learner' });
  await page.goto('/embed-example.html');
  await page.getByLabel(/Embed token/).fill(token);
  await page.getByRole('button', { name: 'Start conversation' }).click();

  const log = page.locator('#log');
  await expect(log).toContainText('"type":"session.created"');
  await expect(log).toContainText('"type":"ready"');
  // The token never appears in the iframe URL.
  const src = await page.locator('#call iframe').getAttribute('src');
  expect(src).toBe(`${new URL(WEB).origin}/embed/frame`);
  expect(src).not.toContain('cfe_');

  const frame = page.frameLocator('#call iframe');
  await frame.getByRole('button', { name: 'Continue' }).click();
  await frame.getByLabel(/I understand I’m talking with an AI/).check();
  await frame.getByRole('button', { name: 'Agree and continue' }).click();
  await frame.getByRole('button', { name: /Allow microphone/ }).click();
  await frame.getByRole('button', { name: 'Join the call' }).click();
  await expect(frame.getByTestId('call-status')).toHaveText('Live', { timeout: 30_000 });
  await expect(log).toContainText('"state":"ACTIVE"');
  await expect(frame.locator('[data-testid="transcript"] li[data-speaker="AGENT"]').first()).toBeVisible({ timeout: 30_000 });

  const line = (await log.innerText()).split('\n').find((l) => l.includes('session.created'))!;
  const sessionId = JSON.parse(line.slice(line.indexOf('{'))).sessionId as string;
  if (DATABASE_URL) {
    expect(sql(`select channel from "Session" where id = '${sessionId}'`)).toBe('EMBED');
    expect(sql(`select p."externalId" from "Session" s join "Participant" p on p.id = s."participantId" where s.id = '${sessionId}'`)).toBe('lms-user-42');
  }

  await page.getByRole('button', { name: 'End', exact: true }).click();
  await expect(log).toContainText('"type":"session.ended"', { timeout: 30_000 });
  await expect(frame.getByTestId('end-screen')).toBeVisible({ timeout: 30_000 });
});

test('embed: a token not allowed on this origin is refused before a session is created', async ({ page }) => {
  const token = await mintEmbedToken(['https://customer.example']);
  const before = DATABASE_URL ? sql(`select count(*) from "Session" where channel = 'EMBED'`) : '';
  await page.goto('/embed-example.html');
  await page.getByLabel(/Embed token/).fill(token);
  await page.getByRole('button', { name: 'Start conversation' }).click();
  await expect(page.locator('#log')).toContainText('origin_not_allowed');
  await expect(page.frameLocator('#call iframe').getByText('This conversation can’t start')).toBeVisible();
  if (DATABASE_URL) expect(sql(`select count(*) from "Session" where channel = 'EMBED'`)).toBe(before);
});

test('embed frame opened directly explains itself', async ({ page }) => {
  await page.goto('/embed/frame');
  await expect(page.getByRole('heading', { name: 'Embed frame' })).toBeVisible();
});
