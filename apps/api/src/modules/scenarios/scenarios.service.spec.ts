/**
 * Integration tests against a real Postgres database (default: conversaforge_test_a; override with
 * TEST_DATABASE_URL). Prepare it with:
 *   createdb conversaforge_test_a
 *   DATABASE_URL=… npx prisma db push --skip-generate && psql … -f prisma/sql/post-push.sql
 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/conversaforge_test_a';

import { defaultScenarioConfig, SCENARIO_TEMPLATES, type ScenarioConfig } from '@cf/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SimulatorProvider } from '../../common/llm/simulator.provider';
import type { Principal } from '../../common/auth/principal';
import { creatorWrittenPaths, DraftAssistantService, sanitizeProposal } from './draft-assistant.service';
import { GalleryService } from './gallery.service';
import { ScenariosService } from './scenarios.service';
import { StudioAgentService } from './studio-agent.service';

const prisma = new PrismaService();
const audit = { log: jest.fn(async () => undefined) } as any;
const llm = { resolve: async () => ({ provider: new SimulatorProvider(), model: 'local-simulator', simulated: true, source: 'simulator' }) } as any;
const usage = { assertWithinQuota: jest.fn(), recordLlm: jest.fn() } as any;
const rateLimit = { enforce: jest.fn(async () => ({ allowed: true })) } as any;
const scenarios = new ScenariosService(prisma, audit);
const assistant = new DraftAssistantService(prisma, llm, usage, rateLimit, scenarios);
const gallery = new GalleryService(prisma);
let knowledgeResults: unknown[] = [];
let knowledgeDelayMs = 0;
const knowledge = {
  search: jest.fn(async () => {
    if (knowledgeDelayMs) await new Promise((r) => setTimeout(r, knowledgeDelayMs));
    return knowledgeResults;
  }),
} as any;
const agent = new StudioAgentService(prisma, llm, usage, rateLimit, scenarios, assistant, knowledge);

const run = Date.now().toString(36);
let ws1: string;
let ws2: string;
let p1: Principal;
let p2: Principal;

async function expectCode(promise: Promise<unknown>, status: number, code?: string) {
  try {
    await promise;
  } catch (e: any) {
    expect(e.getStatus?.()).toBe(status);
    if (code) expect(e.code).toBe(code);
    return e;
  }
  throw new Error(`Expected HTTP ${status}`);
}

beforeAll(async () => {
  await prisma.$connect();
  const u1 = await prisma.user.create({ data: { email: `a1-${run}@test.local`, name: 'Author One' } });
  const u2 = await prisma.user.create({ data: { email: `a2-${run}@test.local`, name: 'Author Two' } });
  ws1 = (await prisma.workspace.create({ data: { name: 'WS One', slug: `ws1-${run}`, memberships: { create: { userId: u1.id, role: 'OWNER' } } } })).id;
  ws2 = (await prisma.workspace.create({ data: { name: 'WS Two', slug: `ws2-${run}`, memberships: { create: { userId: u2.id, role: 'OWNER' } } } })).id;
  p1 = { kind: 'user', userId: u1.id, email: u1.email, name: u1.name, authSessionId: 'x', isSuperAdmin: false };
  p2 = { kind: 'user', userId: u2.id, email: u2.email, name: u2.name, authSessionId: 'y', isSuperAdmin: false };
});

afterAll(async () => {
  await prisma.$disconnect();
});

const fromTemplate = (ws: string, p: Principal, key = 'behavioral-interview', name?: string) =>
  scenarios.create(ws, p, { source: 'template', templateKey: key, name });

describe('drafts', () => {
  it('creates a blank scenario with a draft at revision 1 that cannot be published yet', async () => {
    const d = await scenarios.create(ws1, p1, { source: 'blank', name: 'Blank one', type: 'coaching' });
    expect(d.draft.revision).toBe(1);
    expect(d.scenario.name).toBe('Blank one');
    expect(d.scenario.type).toBe('coaching');
    expect(d.scenario.slug).toBe('blank-one');
    expect(d.canPublish).toBe(false);
    expect(d.issues.some((i) => i.path === 'persona.role' && i.severity === 'error')).toBe(true);
    const again = await scenarios.create(ws1, p1, { source: 'blank', name: 'Blank one' });
    expect(again.scenario.slug).toBe('blank-one-2');
  });

  it('enforces optimistic concurrency on the draft revision', async () => {
    const d = await scenarios.create(ws1, p1, { source: 'blank', name: 'Concurrency' });
    const a = await scenarios.updateDraft(ws1, p1, d.scenario.id, { revision: 1, patch: [{ path: 'basics.name', value: 'Edit A' }] });
    expect(a.draft.revision).toBe(2);
    expect(a.scenario.name).toBe('Edit A');
    const e = await expectCode(
      scenarios.updateDraft(ws1, p1, d.scenario.id, { revision: 1, patch: [{ path: 'basics.name', value: 'Edit B' }] }),
      409,
      'revision_conflict',
    );
    expect(e.details.currentRevision).toBe(2);
    const cur = await scenarios.detail(ws1, d.scenario.id);
    expect(cur.scenario.name).toBe('Edit A');
  });

  it('stores incomplete drafts but rejects structurally invalid values and unsafe paths', async () => {
    const d = await scenarios.create(ws1, p1, { source: 'blank', name: 'Permissive' });
    const ok = await scenarios.updateDraft(ws1, p1, d.scenario.id, { revision: 1, patch: [{ path: 'persona.role', value: '' }] });
    expect(ok.draft.revision).toBe(2);
    await expectCode(scenarios.updateDraft(ws1, p1, d.scenario.id, { revision: 2, patch: [{ path: 'basics.targetDurationMinutes', value: 'soon' }] }), 422);
    await expectCode(scenarios.updateDraft(ws1, p1, d.scenario.id, { revision: 2, patch: [{ path: '__proto__.polluted', value: true }] }), 422);
    await expectCode(scenarios.updateDraft(ws1, p1, d.scenario.id, { revision: 2, patch: [{ path: 'basics.constructor.prototype.x', value: 1 }] }), 422);
    expect(({} as any).polluted).toBeUndefined();
  });

  it('preserves author prose verbatim and syncs basics to the scenario row', async () => {
    const d = await scenarios.create(ws1, p1, { source: 'blank', name: 'Prose' });
    const prose = 'Line one.\n\n   Indented   line with  double spaces.\n- bullet {{not_a_var}}\n';
    const r = await scenarios.updateDraft(ws1, p1, d.scenario.id, {
      revision: 1,
      patch: [
        { path: 'instructions.aiInstructions', value: prose },
        { path: 'basics.tags', value: ['Sales', 'sales', 'Demo '] },
        { path: 'basics.publicDescription', value: 'Public text' },
        { path: 'basics.type', value: 'demo' },
      ],
    });
    expect((r.draft.config as ScenarioConfig).instructions.aiInstructions).toBe(prose);
    expect(r.scenario.tags).toEqual(['sales', 'demo']);
    expect(r.scenario.type).toBe('demo');
    expect(r.scenario.publicDescription).toBe('Public text');
  });
});

describe('publish, versions and rollback', () => {
  it('blocks invalid drafts (missing fields, bad weights, unknown placeholders)', async () => {
    const blank = await scenarios.create(ws1, p1, { source: 'blank', name: 'Nope' });
    const e1 = await expectCode(scenarios.publish(ws1, p1, blank.scenario.id, {}), 422);
    expect(e1.details.map((i: any) => i.path)).toEqual(expect.arrayContaining(['persona.role', 'instructions.goals']));

    const t = await fromTemplate(ws1, p1);
    const cfg = t.draft.config as ScenarioConfig;
    const weights = await scenarios.updateDraft(ws1, p1, t.scenario.id, {
      revision: 1,
      patch: [{ path: 'rubric.criteria', value: cfg.rubric.criteria.map((c, i) => ({ ...c, weight: i === 0 ? 5 : c.weight })) }],
    });
    const e2 = await expectCode(scenarios.publish(ws1, p1, t.scenario.id, {}), 422);
    expect(e2.details.find((i: any) => i.path === 'rubric.criteria').message).toMatch(/sum to 100/);

    await scenarios.updateDraft(ws1, p1, t.scenario.id, {
      revision: weights.draft.revision,
      patch: [
        { path: 'rubric.criteria', value: cfg.rubric.criteria },
        { path: 'conversation.firstTurn.text', value: 'Hello {{secret_prompt}}' },
      ],
    });
    const e3 = await expectCode(scenarios.publish(ws1, p1, t.scenario.id, {}), 422);
    expect(e3.details.some((i: any) => /secret_prompt/.test(i.message))).toBe(true);
    expect((await prisma.scenarioVersion.count({ where: { scenarioId: t.scenario.id } }))).toBe(0);
  });

  it('blocks knowledge documents and custom functions from another workspace, and planned tools', async () => {
    const foreignDoc = await prisma.knowledgeDocument.create({ data: { workspaceId: ws2, title: 'Other ws doc', mimeType: 'text/plain', status: 'COMPLETED' } });
    const ownDoc = await prisma.knowledgeDocument.create({ data: { workspaceId: ws1, title: 'Own doc', mimeType: 'text/plain', status: 'COMPLETED' } });
    const foreignFn = await prisma.customFunction.create({
      data: { workspaceId: ws2, name: `fn_${run}`, description: 'x', parametersSchema: {}, url: 'https://example.com', allowedHosts: ['example.com'] },
    });
    const t = await fromTemplate(ws1, p1);
    await scenarios.updateDraft(ws1, p1, t.scenario.id, {
      revision: 1,
      patch: [
        { path: 'knowledge.documentIds', value: [ownDoc.id, foreignDoc.id] },
        { path: 'tools.customFunctionIds', value: [foreignFn.id] },
        { path: 'tools.enabled', value: [{ toolId: 'end_session' }, { toolId: 'slides', enabled: true }] },
      ],
    });
    const e = await expectCode(scenarios.publish(ws1, p1, t.scenario.id, {}), 422);
    const paths = e.details.map((i: any) => i.path);
    expect(paths).toContain('knowledge.documentIds.1');
    expect(paths).not.toContain('knowledge.documentIds.0');
    expect(paths).toContain('tools.customFunctionIds.0');
    expect(e.details.some((i: any) => /coming soon/.test(i.message))).toBe(true);
  });

  it('publishes immutable versions, rejects identical republish, and rolls back as a new version', async () => {
    const t = await fromTemplate(ws1, p1, 'price-negotiation');
    const v1 = await scenarios.publish(ws1, p1, t.scenario.id, { changeNote: 'first' });
    expect(v1.version.version).toBe(1);
    expect(v1.scenario.scenario.status).toBe('PUBLISHED');
    expect(v1.scenario.draftHasUnpublishedChanges).toBe(false);

    const e = await expectCode(scenarios.publish(ws1, p1, t.scenario.id, {}), 409, 'no_changes');
    expect(e.message).toBe('No changes since version 1');

    const edited = await scenarios.updateDraft(ws1, p1, t.scenario.id, {
      revision: v1.scenario.draft.revision,
      patch: [{ path: 'persona.name', value: 'Marcus Changed' }],
    });
    expect(edited.draftHasUnpublishedChanges).toBe(true);
    const v2 = await scenarios.publish(ws1, p1, t.scenario.id, { changeNote: 'rename persona' });
    expect(v2.version.version).toBe(2);

    const row1 = await prisma.scenarioVersion.findUniqueOrThrow({ where: { id: v1.version.id } });
    expect((row1.config as any).persona.name).toBe('Marcus Lee');
    // DB trigger: versions can never be updated.
    await expect(prisma.scenarioVersion.update({ where: { id: v1.version.id }, data: { changeNote: 'tamper' } })).rejects.toThrow(/immutable/);

    const diff = await scenarios.diff(ws1, t.scenario.id, v1.version.id, v2.version.id);
    expect(diff.changes.map((c) => c.path)).toEqual(['persona.name']);

    const rb = await scenarios.rollback(ws1, p1, t.scenario.id, v1.version.id, {});
    expect(rb.version.version).toBe(3);
    expect(rb.version.rolledBackFromVersionId).toBe(v1.version.id);
    expect(rb.version.configHash).toBe(row1.configHash);
    expect((rb.scenario.draft.config as any).persona.name).toBe('Marcus Lee');
    expect(rb.scenario.draft.revision).toBe(edited.draft.revision + 1);
    expect(rb.scenario.draftHasUnpublishedChanges).toBe(false);
    const row2 = await prisma.scenarioVersion.findUniqueOrThrow({ where: { id: v2.version.id } });
    expect((row2.config as any).persona.name).toBe('Marcus Changed');

    await expectCode(scenarios.rollback(ws1, p1, t.scenario.id, v1.version.id, {}), 409, 'no_changes');
    const versions = await scenarios.listVersions(ws1, t.scenario.id);
    expect(versions.data.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(versions.data[0]!.rolledBackFromVersion).toBe(1);
    expect(versions.data[0]!.publishedBy?.name).toBe('Author One');
  });

  it('getRunnableVersion returns the exact version and refuses unpublished/archived scenarios', async () => {
    const t = await fromTemplate(ws1, p1, 'support-deescalation');
    await expectCode(scenarios.getRunnableVersion(ws1, t.scenario.id), 409, 'scenario_unpublished');
    const v1 = await scenarios.publish(ws1, p1, t.scenario.id, {});
    const r = await scenarios.getRunnableVersion(ws1, t.scenario.id);
    expect(r.version.id).toBe(v1.version.id);
    expect(r.config.persona.name).toBe('Jordan');
    const pinned = await scenarios.getRunnableVersion(ws1, t.scenario.id, v1.version.id);
    expect(pinned.version.id).toBe(v1.version.id);
    await scenarios.archive(ws1, p1, t.scenario.id);
    await expectCode(scenarios.getRunnableVersion(ws1, t.scenario.id), 409, 'scenario_archived');
    await expectCode(scenarios.publish(ws1, p1, t.scenario.id, {}), 409);
    const un = await scenarios.unarchive(ws1, p1, t.scenario.id);
    expect(un.scenario.status).toBe('PUBLISHED');
  });
});

describe('duplicate, delete and tenant isolation', () => {
  it('duplicates into a new, independent scenario', async () => {
    const t = await fromTemplate(ws1, p1, 'difficult-feedback');
    await scenarios.updateDraft(ws1, p1, t.scenario.id, { revision: 1, lockedFields: ['persona.description'] });
    const v1 = await scenarios.publish(ws1, p1, t.scenario.id, {});
    const dup = await scenarios.create(ws1, p1, { source: 'duplicate', scenarioId: t.scenario.id });
    expect(dup.scenario.id).not.toBe(t.scenario.id);
    expect(dup.scenario.name).toBe('Delivering difficult feedback (copy)');
    expect(dup.scenario.latestVersionId).toBeNull();
    expect(dup.scenario.status).toBe('DRAFT');
    expect(dup.draft.lockedFields).toEqual(['persona.description']);
    await scenarios.updateDraft(ws1, p1, dup.scenario.id, { revision: 1, patch: [{ path: 'persona.name', value: 'Changed Sam' }] });
    const src = await scenarios.detail(ws1, t.scenario.id);
    expect((src.draft.config as any).persona.name).toBe('Sam');
    const fromVersion = await scenarios.create(ws1, p1, { source: 'duplicate', scenarioId: t.scenario.id, versionId: v1.version.id, name: 'From v1' });
    expect(fromVersion.scenario.name).toBe('From v1');
    expect(await prisma.scenarioVersion.count({ where: { scenarioId: dup.scenario.id } })).toBe(0);
  });

  it('returns 404 for scenarios of another workspace on every operation', async () => {
    const t = await fromTemplate(ws1, p1);
    const v = await scenarios.publish(ws1, p1, t.scenario.id, {});
    const id = t.scenario.id;
    await expectCode(scenarios.detail(ws2, id), 404);
    await expectCode(scenarios.updateDraft(ws2, p2, id, { revision: 99, patch: [{ path: 'basics.name', value: 'x' }] }), 404);
    await expectCode(scenarios.publish(ws2, p2, id, {}), 404);
    await expectCode(scenarios.listVersions(ws2, id), 404);
    await expectCode(scenarios.getVersion(ws2, id, v.version.id), 404);
    await expectCode(scenarios.rollback(ws2, p2, id, v.version.id, {}), 404);
    await expectCode(scenarios.getRunnableVersion(ws2, id), 404);
    await expectCode(scenarios.create(ws2, p2, { source: 'duplicate', scenarioId: id }), 404);
    await expectCode(scenarios.exportConfig(ws2, p2, id, { format: 'yaml', source: 'draft' }), 404);
    await expectCode(scenarios.remove(ws2, p2, id), 404);
    await expectCode(assistant.propose(ws2, p2, id, 'make it shorter'), 404);
    const list2 = await scenarios.list(ws2, { limit: 100, sort: 'updated' } as any);
    expect(list2.data.find((s) => s.id === id)).toBeUndefined();
    // A version id from ws1 cannot be pinned under another scenario either.
    const other = await fromTemplate(ws1, p1, 'coaching-session');
    await expectCode(scenarios.getRunnableVersion(ws1, other.scenario.id, v.version.id), 404);
  });

  it('soft-deletes: hidden from the list, versions kept', async () => {
    const t = await fromTemplate(ws1, p1, 'coaching-session', 'To delete');
    await scenarios.publish(ws1, p1, t.scenario.id, {});
    await scenarios.remove(ws1, p1, t.scenario.id);
    await expectCode(scenarios.detail(ws1, t.scenario.id), 404);
    expect(await prisma.scenarioVersion.count({ where: { scenarioId: t.scenario.id } })).toBe(1);
  });

  it('lists with search, filters and unpublished-change flags', async () => {
    const t = await fromTemplate(ws1, p1, 'product-demo-walkthrough', `Searchable demo ${run}`);
    const r = await scenarios.list(ws1, { limit: 25, sort: 'updated', q: `demo ${run}` } as any);
    expect(r.data.map((x) => x.id)).toEqual([t.scenario.id]);
    expect(r.data[0]!.draftHasUnpublishedChanges).toBe(true);
    const f = await scenarios.list(ws1, { limit: 25, sort: 'updated', type: 'demo', tag: 'lead-qualification' } as any);
    expect(f.data.some((x) => x.id === t.scenario.id)).toBe(true);
    const page1 = await scenarios.list(ws1, { limit: 2, sort: 'updated' } as any);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await scenarios.list(ws1, { limit: 2, sort: 'updated', cursor: page1.nextCursor } as any);
    expect(page2.data[0]!.id).not.toBe(page1.data[0]!.id);
  });
});

describe('drafting assistant', () => {
  const brief = 'a 15-minute sales discovery call with a skeptical CFO about our analytics product';

  it('fills empty fields from a brief (simulated) and never touches locked fields', async () => {
    const d = await scenarios.create(ws1, p1, { source: 'blank', name: 'Keep this name' });
    await scenarios.updateDraft(ws1, p1, d.scenario.id, { revision: 1, lockedFields: ['basics.name', 'rubric'] });
    const prop = await assistant.propose(ws1, p1, d.scenario.id, brief);
    expect(prop.simulated).toBe(true);
    const paths = prop.changes.map((c) => c.path);
    expect(paths).not.toContain('basics.name');
    expect(paths).not.toContain('rubric');
    expect(paths).toEqual(expect.arrayContaining(['basics.type', 'basics.targetDurationMinutes', 'persona.role', 'instructions.goals', 'conversation.agenda', 'conversation.firstTurn', 'extraction.variables']));
    expect(prop.changes.find((c) => c.path === 'basics.targetDurationMinutes')!.after).toBe(15);
    expect(String(prop.changes.find((c) => c.path === 'persona.role')!.after)).toMatch(/skeptical CFO/i);

    const applied = await assistant.apply(ws1, p1, d.scenario.id, prop.id);
    expect(applied.status).toBe('APPLIED');
    const cfg = applied.scenario.draft.config as ScenarioConfig;
    expect(cfg.basics.name).toBe('Keep this name');
    expect(cfg.rubric.criteria).toEqual([]);
    expect(cfg.basics.type).toBe('sales_practice');
    await expectCode(assistant.apply(ws1, p1, d.scenario.id, prop.id), 409);
  });

  it('produces a publishable draft from a brief when nothing is locked', async () => {
    const d = await scenarios.create(ws1, p1, { source: 'blank', name: 'From a brief' });
    const prop = await assistant.propose(ws1, p1, d.scenario.id, brief);
    const r = await assistant.apply(ws1, p1, d.scenario.id, prop.id);
    const rubric = (r.scenario.draft.config as ScenarioConfig).rubric;
    expect(rubric.criteria.reduce((s, c) => s + c.weight, 0)).toBe(100);
    expect(r.scenario.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const pub = await scenarios.publish(ws1, p1, d.scenario.id, {});
    expect(pub.version.version).toBe(1);
  });

  it('strips locked, unknown and invalid changes from model output', () => {
    const current = defaultScenarioConfig({ basics: { name: 'N' } });
    const r = sanitizeProposal(
      {
        changes: [
          { path: 'basics.name', valueJson: '"Hacked"', reason: 'x' },
          { path: 'instructions.tone', valueJson: '"calm"', reason: 'ok' },
          { path: 'model.llmProvider', valueJson: '"evil"', reason: 'bad enum' },
          { path: '__proto__', valueJson: '{}', reason: 'x' },
          { path: 'basics.targetDurationMinutes', value: 12, reason: 'plain value' },
          { path: 'rubric.criteria', valueJson: '[]', reason: 'not an editable path' },
        ],
      },
      current,
      ['basics.name'],
    );
    expect(r.changes.map((c) => c.path)).toEqual(['instructions.tone', 'basics.targetDurationMinutes']);
    expect(r.dropped.map((d) => d.path)).toEqual(['basics.name', 'model.llmProvider', '__proto__', 'rubric.criteria']);
  });

  it('refuses to apply stale fields but applies untouched ones (PARTIAL)', async () => {
    const d = await scenarios.create(ws1, p1, { source: 'blank', name: 'Stale test' });
    const prop = await assistant.propose(ws1, p1, d.scenario.id, brief);
    const cur = await scenarios.detail(ws1, d.scenario.id);
    await scenarios.updateDraft(ws1, p1, d.scenario.id, { revision: cur.draft.revision, patch: [{ path: 'persona.role', value: 'Author wrote this' }] });
    const e = await expectCode(assistant.apply(ws1, p1, d.scenario.id, prop.id), 409, 'stale');
    expect(e.details.paths).toEqual(['persona.role']);
    const ok = await assistant.apply(ws1, p1, d.scenario.id, prop.id, ['instructions.goals', 'conversation.agenda']);
    expect(ok.status).toBe('PARTIAL');
    const cfg = ok.scenario.draft.config as ScenarioConfig;
    expect(cfg.persona.role).toBe('Author wrote this');
    expect(cfg.instructions.goals.length).toBeGreaterThan(0);
  });

  it('refuses fields that became locked after the proposal', async () => {
    const d = await scenarios.create(ws1, p1, { source: 'blank', name: 'Lock later' });
    const prop = await assistant.propose(ws1, p1, d.scenario.id, brief);
    const cur = await scenarios.detail(ws1, d.scenario.id);
    await scenarios.updateDraft(ws1, p1, d.scenario.id, { revision: cur.draft.revision, lockedFields: ['conversation.agenda'] });
    await expectCode(assistant.apply(ws1, p1, d.scenario.id, prop.id), 409, 'locked');
    const rej = await assistant.reject(ws1, d.scenario.id, prop.id);
    expect(rej.status).toBe('REJECTED');
  });
});

describe('Scenario Studio', () => {
  const interviewBrief =
    'A 20-minute behavioral interview for a senior product manager role. Ask about their leadership experience. Never ask about salary.';

  it('creates an unpublished studio draft from nothing but the creator’s first edits', async () => {
    const d = await scenarios.create(ws1, p1, { source: 'studio', config: { basics: { name: 'Studio start' } }, lockedFields: ['basics.name'] });
    expect(d.scenario.status).toBe('DRAFT');
    expect(d.latestVersion).toBeNull();
    expect(d.draft.lockedFields).toEqual(['basics.name']);
    expect((d.draft.config as ScenarioConfig).basics.name).toBe('Studio start');
    const blank = await scenarios.create(ws1, p1, { source: 'studio' });
    expect(blank.scenario.name).toBe('Untitled scenario');
    await expectCode(scenarios.create(ws1, p1, { source: 'studio', config: { basics: { targetDurationMinutes: 'long' } } }), 422);
  });

  it('runs the creator journey: brief → manual edits + lock → targeted follow-up → v1 → v2, sessions keep v1', async () => {
    const d = await scenarios.create(ws1, p1, { source: 'studio' });
    const id = d.scenario.id;

    // 1. One natural-language brief produces a coherent, publishable draft.
    const first = await assistant.propose(ws1, p1, id, interviewBrief);
    expect(first.reply).toMatch(/drafted a 20-minute/i);
    const paths = first.changes.map((c) => c.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'basics.name',
        'basics.publicDescription',
        'basics.participantInstructions',
        'instructions.aiInstructions',
        'conversation.agenda',
        'rubric',
        'basics.targetDurationMinutes',
      ]),
    );
    const agenda = first.changes.find((c) => c.path === 'conversation.agenda')!.after as ScenarioConfig['conversation']['agenda'];
    expect(agenda.some((a) => /leadership experience/i.test(a.topic))).toBe(true);
    expect(first.changes.find((c) => c.path === 'instructions.boundaries')!.after).toEqual(expect.arrayContaining(['Never ask about salary']));
    const applied = await assistant.apply(ws1, p1, id, first.id);
    let cfg = applied.scenario.draft.config as ScenarioConfig;
    expect(cfg.conversation.strategy).toBe('adaptive');
    expect(applied.scenario.issues.filter((i) => i.severity === 'error')).toEqual([]);

    // 2. Two manual edits and one lock.
    const manualInstructions = 'You will meet Priya, a hiring manager. Take your time; this is practice.';
    let cur = await scenarios.updateDraft(ws1, p1, id, {
      revision: applied.scenario.draft.revision,
      patch: [
        { path: 'basics.participantInstructions', value: manualInstructions },
        { path: 'persona.name', value: 'Priya' },
      ],
      lockedFields: ['basics.name'],
    });
    const nameBefore = (cur.draft.config as ScenarioConfig).basics.name;

    // 3. A targeted follow-up: only duration and dependent timing change.
    const follow = await assistant.propose(ws1, p1, id, 'Make it 15 minutes');
    const fpaths = follow.changes.map((c) => c.path).sort();
    expect(fpaths).toEqual(expect.arrayContaining(['basics.targetDurationMinutes', 'conversation.ending']));
    for (const p of ['basics.name', 'basics.participantInstructions', 'persona.name', 'rubric', 'conversation.agenda']) expect(fpaths).not.toContain(p);
    expect(follow.changes.find((c) => c.path === 'basics.targetDurationMinutes')!.after).toBe(15);
    // AI-written prose that mentioned the old duration follows it; the creator's text is reported, not rewritten.
    const ft = follow.changes.find((c) => c.path === 'conversation.firstTurn');
    if (ft) expect((ft.after as { text: string }).text).toMatch(/15 minutes/);
    expect(follow.preserved).toEqual(expect.arrayContaining([{ path: 'basics.name', reason: 'locked' }, { path: 'basics.participantInstructions', reason: 'creator' }]));
    expect(follow.reply).toMatch(/Name/);
    const r2 = await assistant.apply(ws1, p1, id, follow.id);
    cfg = r2.scenario.draft.config as ScenarioConfig;
    expect(cfg.basics.targetDurationMinutes).toBe(15);
    expect(cfg.basics.name).toBe(nameBefore);
    expect(cfg.basics.participantInstructions).toBe(manualInstructions);
    expect(cfg.persona.name).toBe('Priya');
    expect(cfg.conversation.ending.maxDurationMinutes).toBeGreaterThanOrEqual(15);

    // 4. The conversation survives a reload (newest first) with replies and fields left alone.
    const history = await assistant.list(ws1, id, 50);
    expect(history.data.map((h) => h.instruction)).toEqual(['Make it 15 minutes', interviewBrief]);
    expect(history.data[0]!.reply).toBeTruthy();
    expect(history.data[0]!.status).toBe('APPLIED');

    // 5. Create Scenario = publish v1; a session pins v1.
    const v1 = await scenarios.publish(ws1, p1, id, { changeNote: 'Created in Scenario Studio', revision: r2.scenario.draft.revision });
    expect(v1.version.version).toBe(1);
    const participant = await prisma.participant.create({ data: { workspaceId: ws1, name: 'Pat', email: `pat-${run}@example.com` } });
    const session = await prisma.session.create({ data: { workspaceId: ws1, scenarioId: id, scenarioVersionId: v1.version.id, participantId: participant.id } });

    // 6. Later AI-assisted edit → v2; the v1 session still runs v1.
    const tweak = await assistant.propose(ws1, p1, id, 'Add a question about stakeholder management');
    expect(tweak.changes.map((c) => c.path)).toEqual(['conversation.agenda']);
    await assistant.apply(ws1, p1, id, tweak.id);
    const v2 = await scenarios.publish(ws1, p1, id, { changeNote: 'More topics' });
    expect(v2.version.version).toBe(2);
    const pinned = await prisma.session.findUniqueOrThrow({ where: { id: session.id } });
    expect(pinned.scenarioVersionId).toBe(v1.version.id);
    const run1 = await scenarios.getRunnableVersion(ws1, id, pinned.scenarioVersionId);
    expect(run1.version.version).toBe(1);
    expect(run1.config.conversation.agenda.some((a) => /stakeholder/i.test(a.topic))).toBe(false);
  });

  it('never touches locked fields, even when asked to regenerate everything', async () => {
    const d = await scenarios.create(ws1, p1, { source: 'studio' });
    const p = await assistant.propose(ws1, p1, d.scenario.id, 'a 10-minute sales discovery call with a busy VP about our CRM');
    const a = await assistant.apply(ws1, p1, d.scenario.id, p.id);
    const before = a.scenario.draft.config as ScenarioConfig;
    await scenarios.updateDraft(ws1, p1, d.scenario.id, { revision: a.scenario.draft.revision, lockedFields: ['rubric', 'persona.role', 'conversation.agenda'] });
    const regen = await assistant.propose(ws1, p1, d.scenario.id, 'Regenerate the whole scenario: turn it into a negotiation with a tough procurement lead, new rubric, new agenda');
    for (const c of regen.changes) expect(['rubric', 'persona.role', 'conversation.agenda']).not.toContain(c.path);
    if (regen.changes.length) {
      const r = await assistant.apply(ws1, p1, d.scenario.id, regen.id);
      const after = r.scenario.draft.config as ScenarioConfig;
      expect(after.rubric).toEqual(before.rubric);
      expect(after.persona.role).toBe(before.persona.role);
      expect(after.conversation.agenda).toEqual(before.conversation.agenda);
    }
    expect(regen.reply).toMatch(/locked/);
  });

  it('reports requests the runtime cannot deliver and never enables a planned tool', async () => {
    const d = await scenarios.create(ws1, p1, { source: 'studio' });
    const p = await assistant.propose(ws1, p1, d.scenario.id, 'A product demo that presents slides, uses a whiteboard, and emails the visitor a summary afterwards');
    expect(p.unsupported.map((u) => u.request)).toEqual(expect.arrayContaining(['Present slides', 'Send emails or messages']));
    const tools = p.changes.find((c) => c.path === 'tools')!.after as ScenarioConfig['tools'];
    const on = tools.enabled.filter((t) => t.enabled).map((t) => t.toolId);
    expect(on).toContain('whiteboard');
    expect(on).not.toContain('slides');
    expect(p.reply).toMatch(/not something the runtime can do/);

    // Model output that tries to switch on a planned tool is stripped before it is stored.
    const current = defaultScenarioConfig();
    const s = sanitizeProposal(
      { changes: [{ path: 'tools', valueJson: JSON.stringify({ enabled: [{ toolId: 'end_session', enabled: true }, { toolId: 'slides', enabled: true }, { toolId: 'timer', enabled: true }] }), reason: 'x' }] },
      current,
      [],
    );
    const stored = s.changes[0]!.after as ScenarioConfig['tools'];
    expect(stored.enabled.map((t) => t.toolId)).toEqual(['end_session', 'timer']);
    expect(s.unsupported[0]!.request).toMatch(/Slides/);
  });

  it('knows which fields hold the creator’s own wording', () => {
    const cfg = defaultScenarioConfig({ basics: { name: 'Mine', publicDescription: 'AI wrote this' }, instructions: { tone: 'AI tone' } });
    const applied = [
      { changes: [{ path: 'basics.publicDescription', before: '', after: 'AI wrote this', reason: '' }, { path: 'instructions.tone', before: '', after: 'older AI tone', reason: '' }], appliedPaths: ['basics.publicDescription', 'instructions.tone'] },
    ];
    const manual = creatorWrittenPaths(cfg, applied);
    expect(manual.has('basics.name')).toBe(true); // typed by the creator
    expect(manual.has('basics.publicDescription')).toBe(false); // still the assistant's text
    expect(manual.has('instructions.tone')).toBe(true); // the assistant's text, since edited by the creator
    expect(manual.has('rubric')).toBe(false); // default
  });
});


describe('Scenario Studio agent runs', () => {
  const brief = 'A 12-minute behavioral interview for a data analyst role. Ask about SQL. Never ask about salary.';
  const run = async (id: string, instruction: string, mode: 'standard' | 'flash' | 'deep' = 'standard') => {
    const started = await agent.start(ws1, p1, id, { instruction, mode });
    expect(started.status).toBe('RUNNING');
    await agent.waitFor(started.id);
    return agent.get(ws1, id, started.id);
  };

  it('standard: drafts, expands the AI instructions, checks, and records every step', async () => {
    const d = await scenarios.create(ws1, p1, { source: 'studio' });
    const r = await run(d.scenario.id, brief);
    expect(r.status).toBe('DONE');
    expect(r.mode).toBe('standard');
    const kinds = (r.events as Array<{ kind: string; text: string }>).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['narration', 'tool', 'update', 'check']));
    const texts = (r.events as Array<{ text: string }>).map((e) => e.text);
    expect(texts.some((t) => /Expanded the AI instructions: updated 1 field/.test(t))).toBe(true);
    expect(texts[texts.length - 1]).toMatch(/^Ready to publish/);
    const detail = await scenarios.detail(ws1, d.scenario.id);
    const cfg = detail.draft.config as ScenarioConfig;
    expect(cfg.instructions.aiInstructions).toMatch(/## FLOW/);
    expect(cfg.instructions.aiInstructions).toMatch(/Never ask about salary/);
    expect(detail.canPublish).toBe(true);
    // Every applied change keeps the value from before the run (for undo).
    const ai = r.changes.find((c) => c.path === 'instructions.aiInstructions')!;
    expect(ai.before).toBe('');
    expect(r.reply).toBeTruthy();
  });

  it('flash: one pass and a check, no follow-up passes', async () => {
    const d = await scenarios.create(ws1, p1, { source: 'studio' });
    const r = await run(d.scenario.id, brief, 'flash');
    expect(r.status).toBe('DONE');
    const texts = (r.events as Array<{ text: string }>).map((e) => e.text);
    expect(texts.some((t) => /Expanded the AI instructions/.test(t))).toBe(false);
    expect(((await scenarios.detail(ws1, d.scenario.id)).draft.config as ScenarioConfig).instructions.aiInstructions).not.toMatch(/## FLOW/);
  });

  it('deep: searches the knowledge base first', async () => {
    knowledgeResults = [{ chunkId: 'c1', documentId: 'd1', documentTitle: 'Analyst handbook', page: 1, heading: null, text: 'Analysts use SQL daily.', snippet: 'Analysts use «SQL» daily.', score: 1 }];
    const d = await scenarios.create(ws1, p1, { source: 'studio' });
    const r = await run(d.scenario.id, brief, 'deep');
    knowledgeResults = [];
    expect(r.status).toBe('DONE');
    const texts = (r.events as Array<{ text: string }>).map((e) => e.text);
    expect(texts).toContain('Searched the knowledge base: 1 excerpt from Analyst handbook');
    expect(texts.some((t) => /Reviewing the whole draft/.test(t))).toBe(true);
  });

  it('never writes locked fields and keeps the creator’s edits', async () => {
    const d = await scenarios.create(ws1, p1, { source: 'studio', config: { basics: { name: 'My own name' } }, lockedFields: ['rubric'] });
    const r = await run(d.scenario.id, brief);
    const cfg = (await scenarios.detail(ws1, d.scenario.id)).draft.config as ScenarioConfig;
    expect(cfg.basics.name).toBe('My own name');
    expect(cfg.rubric.criteria).toEqual([]);
    expect(r.changes.map((c) => c.path)).not.toContain('rubric');
    expect(r.preserved).toEqual(expect.arrayContaining([{ path: 'rubric', reason: 'locked' }, { path: 'basics.name', reason: 'creator' }]));
  });

  it('refuses a second run while one is working, and can be stopped', async () => {
    knowledgeDelayMs = 400;
    const d = await scenarios.create(ws1, p1, { source: 'studio' });
    const started = await agent.start(ws1, p1, d.scenario.id, { instruction: brief, mode: 'deep' });
    await expectCode(agent.start(ws1, p1, d.scenario.id, { instruction: 'again', mode: 'flash' }), 409, 'agent_busy');
    await agent.cancel(ws1, d.scenario.id, started.id);
    await agent.waitFor(started.id);
    knowledgeDelayMs = 0;
    const r = await agent.get(ws1, d.scenario.id, started.id);
    expect(r.status).toBe('CANCELLED');
    expect(r.changes).toEqual([]);
    expect(((await scenarios.detail(ws1, d.scenario.id)).draft.config as ScenarioConfig).persona.role).toBe('');
  });

  it('undo restores what the run changed, except fields edited since', async () => {
    const d = await scenarios.create(ws1, p1, { source: 'studio' });
    const r = await run(d.scenario.id, brief);
    const cur = await scenarios.detail(ws1, d.scenario.id);
    await scenarios.updateDraft(ws1, p1, d.scenario.id, { revision: cur.draft.revision, patch: [{ path: 'persona.name', value: 'Mine now' }] });
    const u = await agent.undo(ws1, p1, d.scenario.id, r.id);
    expect(u.skipped).toContain('persona.name');
    expect(u.reverted).toContain('conversation.agenda');
    const cfg = u.scenario.draft.config as ScenarioConfig;
    expect(cfg.persona.name).toBe('Mine now');
    expect(cfg.conversation.agenda).toEqual([]);
    expect(u.run.status).toBe('UNDONE');
    await expectCode(agent.undo(ws1, p1, d.scenario.id, r.id), 409);
  });

  it('stops a run this server is not executing (e.g. after a restart) right away', async () => {
    const d = await scenarios.create(ws1, p1, { source: 'studio' });
    const orphan = await prisma.draftAssistantProposal.create({
      data: { scenarioId: d.scenario.id, workspaceId: ws1, draftRevision: 1, instruction: 'x', changes: [], appliedPaths: [], status: 'RUNNING', mode: 'standard', events: [{ at: new Date().toISOString(), kind: 'narration', text: 'Working' }] },
    });
    await expectCode(agent.start(ws1, p1, d.scenario.id, { instruction: brief, mode: 'flash' }), 409, 'agent_busy');
    const r = await agent.cancel(ws1, d.scenario.id, orphan.id);
    expect(r.status).toBe('CANCELLED');
    expect((r.events as Array<{ text: string }>).pop()!.text).toMatch(/^Stopped\. Nothing was changed/);
    const next = await run(d.scenario.id, brief, 'flash');
    expect(next.status).toBe('DONE');
  });

  it('is scoped to the workspace', async () => {
    const d = await scenarios.create(ws1, p1, { source: 'studio' });
    await expectCode(agent.start(ws2, p2, d.scenario.id, { instruction: brief, mode: 'flash' }), 404);
  });
});

describe('gallery', () => {
  const SECRET = `TOP-SECRET-${run}`;

  it('lists public scenarios with public-safe fields only', async () => {
    const t = await fromTemplate(ws1, p1, 'sales-discovery-skeptical-buyer', `Gallery item ${run}`);
    const cfg = t.draft.config as ScenarioConfig;
    const r1 = await scenarios.updateDraft(ws1, p1, t.scenario.id, {
      revision: 1,
      patch: [
        { path: 'basics.privacy', value: 'PUBLIC' },
        { path: 'basics.internalDescription', value: `internal ${SECRET}` },
        { path: 'instructions.aiInstructions', value: `ai ${SECRET}` },
        { path: 'persona.description', value: `persona ${SECRET}` },
        { path: 'rubric.criteria', value: cfg.rubric.criteria.map((c, i) => (i === 0 ? { ...c, name: `crit ${SECRET}` } : c)) },
      ],
    });
    await expectCode(scenarios.setGalleryListed(ws1, p1, t.scenario.id, true), 422); // not published yet
    await scenarios.publish(ws1, p1, t.scenario.id, {});
    await scenarios.setGalleryListed(ws1, p1, t.scenario.id, true);
    expect(r1.scenario.privacy).toBe('PUBLIC');

    const list = await gallery.publicList({ limit: 50, q: `Gallery item ${run}` } as any);
    expect(list.data.map((c) => c.id)).toEqual([t.scenario.id]);
    const detail = await gallery.publicDetail(t.scenario.id);
    expect(detail.personaName).toBe('Dana Whitfield');
    expect(detail.participantInstructions).toMatch(/our analytics platform/); // placeholder rendered with default
    for (const payload of [JSON.stringify(list), JSON.stringify(detail)]) {
      expect(payload).not.toContain(SECRET);
      for (const key of ['aiInstructions', 'internalDescription', 'rubric', 'criteria', 'extraction', 'allowlist', 'knowledge', 'settings', 'role']) {
        expect(payload).not.toContain(`"${key}"`);
      }
    }
  });

  it('hides private, unlisted, and disallowed-workspace scenarios', async () => {
    const priv = await fromTemplate(ws1, p1, 'price-negotiation', `Private ${run}`);
    await scenarios.publish(ws1, p1, priv.scenario.id, {});
    await expectCode(gallery.publicDetail(priv.scenario.id), 404);
    await expectCode(scenarios.setGalleryListed(ws1, p1, priv.scenario.id, true), 422);

    const pub2 = await fromTemplate(ws2, p2, 'price-negotiation', `WS2 public ${run}`);
    await scenarios.updateDraft(ws2, p2, pub2.scenario.id, { revision: 1, patch: [{ path: 'basics.privacy', value: 'PUBLIC' }] });
    await scenarios.publish(ws2, p2, pub2.scenario.id, {});
    await scenarios.setGalleryListed(ws2, p2, pub2.scenario.id, true);
    expect((await gallery.publicDetail(pub2.scenario.id)).workspace?.name).toBe('WS Two');
    await prisma.workspace.update({ where: { id: ws2 }, data: { settings: { allowPublicScenarios: false } } });
    await expectCode(gallery.publicDetail(pub2.scenario.id), 404);
    const list = await gallery.publicList({ limit: 50, q: `WS2 public ${run}` } as any);
    expect(list.data).toEqual([]);
    const v = await scenarios.validate(ws2, pub2.scenario.id);
    expect(v.issues.some((i) => i.path === 'basics.privacy' && i.severity === 'error')).toBe(true);
    await prisma.workspace.update({ where: { id: ws2 }, data: { settings: {} } });
  });

  it('workspace gallery shows templates and org-visible published scenarios of that workspace only', async () => {
    const org = await fromTemplate(ws1, p1, 'coaching-session', `Org visible ${run}`);
    await scenarios.updateDraft(ws1, p1, org.scenario.id, { revision: 1, patch: [{ path: 'basics.privacy', value: 'ORGANIZATION' }] });
    await scenarios.publish(ws1, p1, org.scenario.id, {});
    const g1 = await gallery.workspaceGallery(ws1, false, { q: `Org visible ${run}` });
    expect(g1.scenarios.map((s) => s.id)).toEqual([org.scenario.id]);
    const g2 = await gallery.workspaceGallery(ws2, true, { q: `Org visible ${run}` });
    expect(g2.scenarios).toEqual([]);
    expect((await gallery.workspaceGallery(ws1, false, {})).templates.length).toBe(SCENARIO_TEMPLATES.length);
  });
});
