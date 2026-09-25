/**
 * Tool panels against the real API. Participant-openable tools (notepad, document upload, whiteboard)
 * go through the server end to end. Agent-only tools (cards, multiple choice, timer) are never invoked
 * by the local simulator LLM, so we inject `tool.present` frames into the real WebSocket
 * (page.routeWebSocket proxies to the API) to verify rendering and the `tool.response` the UI sends.
 */
import { expect, test, type WebSocketRoute } from '@playwright/test';
import { createSession, DATABASE_URL, joinCall, sql, toolsScenarioId } from './helpers';

test('tool panels: notepad, upload, whiteboard (real) + cards, multiple choice, timer (injected)', async ({ page }) => {
  const scenarioId = await toolsScenarioId();
  const { sessionId, sessionToken } = await createSession(scenarioId);

  const sent: any[] = [];
  let pageSide: WebSocketRoute | null = null;
  await page.routeWebSocket(/\/ws\/session$/, (ws) => {
    pageSide = ws;
    const server = ws.connectToServer();
    ws.onMessage((m) => {
      try {
        sent.push(JSON.parse(String(m)));
      } catch {
        /* ignore */
      }
      server.send(m);
    });
  });

  await page.goto(`/live/${sessionId}#t=${sessionToken}`);
  await joinCall(page, { recordAudio: false });
  const panel = page.getByRole('complementary');

  // ── Notepad (participant-opened, synced with tool.update)
  await panel.getByRole('button', { name: 'Open notepad' }).click();
  const notepad = panel.locator('[data-tool="notepad"]');
  await expect(notepad).toBeVisible();
  await notepad.getByLabel('Notepad').fill('1. Load balancer\n2. API tier\n3. Postgres');
  await expect.poll(() => sent.some((m) => m.type === 'tool.update' && /Postgres/.test(m.data?.content ?? ''))).toBe(true);
  if (DATABASE_URL) {
    await expect
      .poll(() => sql(`select "runtimeState"::text from "Session" where id = '${sessionId}'`))
      .toContain('Postgres');
  }

  // ── Document upload (multipart → server extracts text → SYSTEM turn)
  await panel.getByRole('button', { name: 'Upload a document' }).click();
  const upload = panel.locator('[data-tool="document_upload"]');
  await upload.getByLabel('Choose a file').setInputFiles({ name: 'resume.txt', mimeType: 'text/plain', buffer: Buffer.from('Jane Doe — Staff engineer. Built payments at scale.') });
  await upload.getByRole('button', { name: 'Upload' }).click();
  await expect(upload.getByText('Uploaded resume.txt')).toBeVisible();
  await expect(page.locator('[data-testid="transcript"] li[data-speaker="SYSTEM"]', { hasText: 'resume.txt' })).toHaveCount(1);
  // Client-side validation: wrong type / too large never reach the server.
  // (the tool is answered now, so check validation on a fresh one below via injected present)

  // ── Whiteboard: draw + describe + share
  await panel.getByRole('button', { name: 'Open whiteboard' }).click();
  const wb = panel.locator('[data-tool="whiteboard"]');
  const canvas = wb.locator('canvas');
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 80, { steps: 8 });
  await page.mouse.up();
  await wb.getByLabel(/Describe your sketch/).fill('Clients -> LB -> 3 API nodes -> Postgres primary + replica');
  await wb.getByRole('button', { name: 'Share sketch' }).click();
  await expect(wb.getByText('✓ Shared')).toBeVisible();
  await expect(page.locator('[data-testid="transcript"] li[data-speaker="SYSTEM"]', { hasText: 'Postgres primary' })).toHaveCount(1);
  const wbUpdate = sent.find((m) => m.type === 'tool.update' && typeof m.data?.sketch === 'string');
  expect(wbUpdate?.data.sketch.startsWith('data:image/jpeg;base64,')).toBe(true);

  // ── Injected agent tools
  const inject = (msg: unknown) => pageSide!.send(JSON.stringify(msg));
  inject({ type: 'tool.present', tool: { toolCallId: 'inj_card', toolId: 'cards', title: 'Case prompt', args: { title: 'Design a URL shortener', body: '100M new URLs/day.\nRead-heavy.' } } });
  inject({
    type: 'tool.present',
    tool: { toolCallId: 'inj_mc', toolId: 'multiple_choice', title: 'Quick check', args: { question: 'Which store fits best?', options: ['Postgres', 'DynamoDB', 'Redis only'] } },
  });
  inject({ type: 'tool.present', tool: { toolCallId: 'inj_timer', toolId: 'timer', title: 'Prep time', args: { seconds: 90, label: 'Think about the data model' } } });
  await expect(panel.getByText('Design a URL shortener')).toBeVisible();
  await expect(panel.locator('[data-tool="timer"]')).toContainText(/1:(29|30)/);
  const mc = panel.locator('[data-tool="multiple_choice"]');
  await mc.getByLabel('DynamoDB').check();
  await mc.getByRole('button', { name: 'Submit answer' }).click();
  await expect(mc.getByText('Answer submitted')).toBeVisible();
  expect(sent.find((m) => m.type === 'tool.response' && m.toolCallId === 'inj_mc')?.result).toMatchObject({ selected: [1], answers: ['DynamoDB'] });

  // Agent-drawn diagram (whiteboard with nodes/edges) renders as an accessible SVG.
  inject({
    type: 'tool.present',
    tool: {
      toolCallId: 'inj_wb',
      toolId: 'whiteboard',
      title: 'Architecture',
      args: { title: 'Architecture', nodes: [{ id: 'lb', label: 'Load balancer' }, { id: 'api', label: 'API' }, { id: 'db', label: 'Postgres' }], edges: [{ from: 'lb', to: 'api' }, { from: 'api', to: 'db', label: 'SQL' }] },
    },
  });
  await expect(panel.getByRole('img', { name: /Architecture\. 3 boxes: Load balancer, API, Postgres/ })).toBeVisible();

  // tool.close removes the card
  inject({ type: 'tool.close', toolCallId: 'inj_card' });
  await expect(panel.getByText('Design a URL shortener')).toHaveCount(0);

  // Upload validation on an injected document_upload tool (never reaches the server)
  inject({ type: 'tool.present', tool: { toolCallId: 'inj_doc', toolId: 'document_upload', title: 'Upload', args: { prompt: 'Upload your design doc' } } });
  const doc2 = panel.locator('[data-tool="document_upload"]').filter({ hasText: 'Upload your design doc' });
  await doc2.getByLabel('Choose a file').setInputFiles({ name: 'x.png', mimeType: 'image/png', buffer: Buffer.from([1, 2, 3]) });
  await expect(doc2.getByText('Please choose a PDF, plain-text or Markdown file.')).toBeVisible();
  await doc2.getByLabel('Choose a file').setInputFiles({ name: 'big.txt', mimeType: 'text/plain', buffer: Buffer.alloc(11 * 1024 * 1024, 97) });
  await expect(doc2.getByText(/too large/)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('tools.png'), fullPage: true });
});
