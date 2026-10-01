import { expect, test } from '@playwright/test';

/**
 * Workstream G journeys: knowledge upload/paste → processing → search tester → detail/chunks → delete;
 * AI provider keys (status overview, add + verify, secret never shown); custom functions (schema editor,
 * validation, test runner).
 * Run: WEB_URL=http://localhost:3107 PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx playwright test e2e/knowledge-providers.spec.ts
 */
const WEB = process.env.WEB_URL ?? 'http://localhost:3000';

test.use({ baseURL: WEB });
test.setTimeout(180_000);

/** Minimal valid one-page-per-entry PDF (Helvetica text), with a correct xref table. */
function tinyPdf(pages: string[]): Buffer {
  const objs: string[] = [];
  const esc = (s: string) => s.replace(/[\\()]/g, (m) => '\\' + m);
  const n = pages.length;
  // 1 catalog, 2 pages, 3 font, then per page: page obj + content obj
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${esc(text)}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function signup(page: import('@playwright/test').Page, tag: string) {
  const email = `e2e-g-${tag}-${Date.now()}@test.local`;
  // Distinct forwarded IP per run so parallel test runs on one host don't share the signup rate limit.
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const res = await page.request.post('/api/auth/signup', { data: { email, password: 'password1234', name: 'E2E G' }, headers: { 'x-forwarded-for': ip } });
  expect(res.ok()).toBeTruthy();
  const me = await (await page.request.get('/api/auth/me')).json();
  return me.workspaces[0].id as string;
}

test('knowledge base journey', async ({ page }) => {
  const ws = await signup(page, 'kb');
  await page.goto(`/w/${ws}/knowledge`);
  await expect(page.getByRole('heading', { name: 'Knowledge' })).toBeVisible();
  await expect(page.getByText('No documents yet')).toBeVisible();

  // Upload a real PDF through the file picker.
  await page.getByTestId('knowledge-file-input').setInputFiles({
    name: 'Expense Policy.pdf',
    mimeType: 'application/pdf',
    buffer: tinyPdf(['Flights under six hours must be booked in economy class.', 'Meals are reimbursed up to sixty dollars per day with receipts.']),
  });
  // A disguised binary is rejected by content sniffing.
  await page.getByTestId('knowledge-file-input').setInputFiles({ name: 'evil.pdf', mimeType: 'application/pdf', buffer: Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]) });
  await expect(page.getByText(/Unsupported or binary file/)).toBeVisible();

  const row = page.getByRole('row', { name: /Expense Policy/ });
  await expect(row.getByText('Ready')).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText('PDF · 2 p.');

  // Paste text (Markdown).
  await page.getByRole('button', { name: 'Paste text' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Title').fill('Parking FAQ');
  await dlg.getByLabel('Format').selectOption('markdown');
  await dlg.getByLabel('Text').fill('# Visitors\n\nVisitors park in lot C next to the east entrance.');
  await dlg.getByRole('button', { name: 'Add document' }).click();
  await expect(page.getByRole('row', { name: /Parking FAQ/ }).getByText('Ready')).toBeVisible({ timeout: 30_000 });

  // Search tester with highlights + citations.
  await page.getByLabel('Query').fill('meals receipts');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('mark', { hasText: /Meals/i }).first()).toBeVisible();
  await expect(page.getByText('[doc:Expense Policy p.2]')).toBeVisible();
  await page.getByLabel('Show exactly what the agent receives').check();
  await expect(page.getByText(/QUOTED REFERENCE DATA/)).toBeVisible();

  // Detail page with chunk preview.
  await page.getByRole('link', { name: 'Expense Policy' }).first().click();
  await expect(page.getByText('Chunks (2)')).toBeVisible();
  await expect(page.getByText('page 2').first()).toBeVisible();
  await page.getByRole('link', { name: 'Knowledge' }).first().click();

  // Delete (confirm modal lists references — none here).
  await page.getByRole('row', { name: /Parking FAQ/ }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('dialog')).toContainText('No scenario references this document');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete document' }).click();
  await expect(page.getByRole('row', { name: /Parking FAQ/ })).toHaveCount(0);
});

test('AI providers and custom functions journey', async ({ page }) => {
  const ws = await signup(page, 'prov');
  await page.goto(`/w/${ws}/settings/providers`);
  await expect(page.getByTestId('cap-live_llm')).toContainText('Simulator (no key)');
  await expect(page.getByTestId('cap-telephony')).toContainText('Unavailable');

  const fakeKey = 'sk-ant-api03-e2e-not-a-real-key-QWER';
  await page.getByRole('button', { name: 'Add provider key' }).first().click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Provider').selectOption('anthropic');
  await dlg.getByLabel(/API key/).fill(fakeKey);
  await dlg.getByLabel('Live conversation model').fill('claude-sonnet-5');
  await dlg.getByRole('button', { name: 'Save & verify' }).click();
  const conn = page.getByTestId('conn-anthropic');
  await expect(conn).toBeVisible({ timeout: 20_000 });
  await expect(conn).toContainText('••••QWER');
  // Rejected by Anthropic → Invalid; if the network is unreachable it stays unverified.
  await expect(conn.getByText(/Invalid|Active \(unverified\)/)).toBeVisible();
  expect(await page.content()).not.toContain(fakeKey);

  // Custom functions.
  await page.goto(`/w/${ws}/settings/functions`);
  await page.getByRole('button', { name: 'New function' }).first().click();
  const fd = page.getByRole('dialog');
  await fd.getByLabel('Name').fill('lookup_order');
  await fd.getByLabel('Description').fill('Look up an order by id');
  await fd.getByLabel('URL').fill('https://orders.example.com/lookup');
  await fd.getByLabel('Parameters (JSON Schema)').fill('{"type":"array"}');
  await expect(fd.getByText('The root schema must have "type": "object"')).toBeVisible();
  await fd.getByLabel('Parameters (JSON Schema)').fill('{"type":"object","properties":{"orderId":{"type":"string"}},"required":["orderId"]}');
  await fd.getByRole('button', { name: 'Add header' }).click();
  await fd.getByLabel('Header name').fill('Authorization');
  await fd.getByLabel('Header value').fill('Bearer e2e-secret-token');
  await fd.getByRole('button', { name: 'Create' }).click();
  const fnRow = page.getByRole('row', { name: /lookup_order/ });
  await expect(fnRow).toBeVisible();

  // Test runner: invalid args are rejected before any request.
  await fnRow.getByRole('button', { name: 'Test' }).click();
  const tr = page.getByRole('dialog');
  await tr.getByLabel('Arguments (JSON)').fill('{"orderId": 42}');
  await tr.getByRole('button', { name: 'Send test request' }).click();
  await expect(tr.getByText(/Invalid arguments: orderId must be string/)).toBeVisible();
  await tr.getByRole('button', { name: 'Close', exact: true }).last().click();

  // Headers are masked when editing.
  await fnRow.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByRole('dialog').getByLabel('Header value')).toHaveValue('••••');
  expect(await page.content()).not.toContain('e2e-secret-token');
});
