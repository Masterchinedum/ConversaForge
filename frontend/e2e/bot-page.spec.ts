import { expect, test } from '@playwright/test';
import { apiClient, scenarioContext, sql } from './helpers';

/**
 * Meeting agent bot page (/bot/<sessionId>#t=<token>, opened by Recall output media). Recall is not
 * contacted: the MeetingBot row is written directly and moved from JOINING to IN_CALL, as the status poll
 * would. The page must wait silently while the bot is outside the meeting, then start the session and let
 * the persona greet once it is admitted, and report what it heard to the session timeline.
 * Needs E2E_DATABASE_URL (psql). Run:
 *   E2E_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/conversaforge E2E_WEB_URL=http://localhost:3101 \
 *   E2E_CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npx playwright test e2e/bot-page.spec.ts
 */
test.setTimeout(120_000);

test('agent bot page waits outside the meeting and greets once admitted', async ({ page }) => {
  // Setup through the API as the seeded demo creator (the bot page itself only uses the session token).
  const a = await apiClient();
  const { workspaceId: ws } = await scenarioContext();
  const created = await (await a.post(`/api/workspaces/${ws}/scenarios`, { data: { source: 'template', templateKey: 'behavioral-interview', name: `Bot page check ${Date.now()}` } })).json();
  const scenarioId = created.scenario.id as string;
  expect((await a.post(`/api/workspaces/${ws}/scenarios/${scenarioId}/publish`, { data: {} })).ok()).toBeTruthy();
  const s = await (await a.post(`/api/workspaces/${ws}/scenarios/${scenarioId}/sessions`, { data: {} })).json();
  const sessionId = s.sessionId as string;
  // Meeting-bot sessions are consented when the bot is sent; do the same for this self-run session.
  const consent = await a.post(`/api/runtime/sessions/${sessionId}/consent`, { headers: { Authorization: `Bearer ${s.sessionToken}` }, data: { recordAudio: false, recordVideo: false, analysis: true } });
  expect(consent.ok()).toBeTruthy();
  const botId = `e2ebot${Date.now().toString(36)}`;
  sql(`INSERT INTO "MeetingBot" (id, "workspaceId", "scenarioId", provider, "meetingUrl", status, "sessionId", mode, "updatedAt") VALUES ('${botId}', '${ws}', '${scenarioId}', 'recall', 'https://meet.google.com/abc-defg-hij', 'JOINING', '${sessionId}', 'agent', now())`);

  // Recall's bot browser: getUserMedia is the meeting audio (silent here) and autoplay is allowed.
  await page.addInitScript(() => {
    const Ctor = (window as any).AudioContext;
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new Ctor();
      await ctx.resume().catch(() => undefined);
      const dest = ctx.createMediaStreamDestination();
      const src = ctx.createConstantSource();
      src.offset.value = 0;
      src.connect(dest);
      src.start();
      return dest.stream;
    };
  });
  await page.goto(`/bot/${sessionId}#t=${encodeURIComponent(s.sessionToken)}`);
  await expect(page.getByText('Waiting to be let into the meeting…')).toBeVisible();
  await page.waitForTimeout(4000);
  expect(sql(`SELECT state FROM "Session" WHERE id='${sessionId}'`)).toBe('READY');

  // Admitted → the page starts the session within a few seconds, without anyone speaking.
  sql(`UPDATE "MeetingBot" SET status='IN_CALL' WHERE id='${botId}'`);
  await expect.poll(() => sql(`SELECT state FROM "Session" WHERE id='${sessionId}'`), { timeout: 20_000 }).toMatch(/ACTIVE|CONNECTING/);
  await expect.poll(() => sql(`SELECT count(*) FROM "TranscriptTurn" WHERE "sessionId"='${sessionId}' AND speaker='AGENT'`), { timeout: 30_000 }).not.toBe('0');

  const events = sql(`SELECT payload->>'event' || ':' || coalesce(payload->'data'->>'trigger', payload->'data'->>'audioContext', '') FROM "SessionEvent" WHERE "sessionId"='${sessionId}' AND type='bot.page' ORDER BY "createdAt"`).split('\n');
  expect(events[0]).toBe('loaded:running');
  expect(events).toContain('start:admitted');
  expect(events.some((e) => e.startsWith('level:'))).toBe(true);
});
