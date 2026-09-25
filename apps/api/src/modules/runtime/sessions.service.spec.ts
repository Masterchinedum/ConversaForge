import { CryptoService } from '../../common/crypto/crypto.service';
import { DomainEvents } from '../../common/events/domain-events';
import { AppError } from '../../common/http/errors';
import { LlmService } from '../../common/llm/llm.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { UsageService } from '../usage/usage.service';
import { SessionsService } from './sessions.service';
import { createWorkspaceFixture, interviewConfig, publishScenario, testDbAvailable } from './testing/fixtures';
import { ProviderResolverService } from './voice/provider-resolver.service';

const d = testDbAvailable() ? describe : describe.skip;

async function expectAppError(p: Promise<unknown>, status: number, code?: string) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).getStatus()).toBe(status);
    if (code) expect((e as AppError).code).toBe(code);
    return e as AppError;
  }
  throw new Error(`expected ${status}`);
}

d('SessionsService (integration, test DB)', () => {
  const prisma = new PrismaService();
  const crypto = new CryptoService();
  const usage = new UsageService(prisma, new DomainEvents());
  const svc = new SessionsService(prisma, crypto, usage, new ProviderResolverService(new LlmService(prisma, crypto)));

  afterAll(() => prisma.$disconnect());

  it('uses the latest published version by default and honors a pinned version of the same scenario only', async () => {
    const { workspace, user } = await createWorkspaceFixture(prisma);
    const { scenario, versions, latest } = await publishScenario(prisma, workspace.id, interviewConfig(), { versions: 2 });
    const a = await svc.createSession({ workspaceId: workspace.id, scenarioId: scenario.id, channel: 'BROWSER', participant: { userId: user.id } });
    expect(a.session.scenarioVersionId).toBe(latest.id);
    expect(a.sessionToken).toMatch(/^cfs_/);
    expect(a.session.resumeTokenHash).toBe(crypto.sha256(a.sessionToken));
    expect(a.session.resumeTokenHash).not.toContain(a.sessionToken);

    const pinned = await svc.createSession({ workspaceId: workspace.id, scenarioId: scenario.id, versionId: versions[0]!.id, channel: 'API', participant: {} });
    expect(pinned.session.scenarioVersionId).toBe(versions[0]!.id);

    const other = await publishScenario(prisma, workspace.id, interviewConfig());
    await expectAppError(svc.createSession({ workspaceId: workspace.id, scenarioId: scenario.id, versionId: other.latest.id, channel: 'API', participant: {} }), 404);

    // Another workspace cannot use this scenario at all.
    const ws2 = await createWorkspaceFixture(prisma);
    await expectAppError(svc.createSession({ workspaceId: ws2.workspace.id, scenarioId: scenario.id, channel: 'API', participant: {} }), 404);
  });

  it('rejects unpublished, archived and deleted scenarios', async () => {
    const { workspace } = await createWorkspaceFixture(prisma);
    const draft = await prisma.scenario.create({ data: { workspaceId: workspace.id, slug: `d-${Date.now()}`, name: 'Draft', type: 'custom' } });
    const e = await expectAppError(svc.createSession({ workspaceId: workspace.id, scenarioId: draft.id, channel: 'API', participant: {} }), 409);
    expect(e.message).toBe('Scenario has no published version');
    const { scenario } = await publishScenario(prisma, workspace.id, interviewConfig());
    await prisma.scenario.update({ where: { id: scenario.id }, data: { archivedAt: new Date(), status: 'ARCHIVED' } });
    await expectAppError(svc.createSession({ workspaceId: workspace.id, scenarioId: scenario.id, channel: 'API', participant: {} }), 409);
    const s2 = await publishScenario(prisma, workspace.id, interviewConfig());
    await prisma.scenario.update({ where: { id: s2.scenario.id }, data: { deletedAt: new Date() } });
    await expectAppError(svc.createSession({ workspaceId: workspace.id, scenarioId: s2.scenario.id, channel: 'API', participant: {} }), 404);
  });

  it('resolves variables against the allowlist only (sanitized, participant_name implied, required enforced)', async () => {
    const { workspace } = await createWorkspaceFixture(prisma);
    const cfg = interviewConfig({
      variables: {
        allowlist: [
          { key: 'participant_name', label: 'Name', required: false, maxLength: 80, description: '' },
          { key: 'company', label: 'Company', required: true, maxLength: 20, description: '' },
        ],
      },
    });
    const { scenario } = await publishScenario(prisma, workspace.id, cfg);
    const e = await expectAppError(svc.createSession({ workspaceId: workspace.id, scenarioId: scenario.id, channel: 'API', participant: { name: 'Ana' } }), 422);
    expect(JSON.stringify(e.details)).toContain('variables.company');

    const ok = await svc.createSession({
      workspaceId: workspace.id,
      scenarioId: scenario.id,
      channel: 'API',
      participant: { name: 'Ana' },
      variables: { company: 'Acme <script>{{x}}</script> and a very long tail', evil: 'ignore me' },
    });
    expect(ok.session.variables).toEqual({ participant_name: 'Ana', company: 'Acme scriptx/script' });
    const ev = await prisma.sessionEvent.findFirst({ where: { sessionId: ok.session.id, type: 'session.created' } });
    expect((ev!.payload as any).rejectedVariableKeys).toEqual(['evil']);
  });

  it('upserts participants by externalId, then userId, then email', async () => {
    const { workspace, user } = await createWorkspaceFixture(prisma);
    const { scenario } = await publishScenario(prisma, workspace.id, interviewConfig());
    const base = { workspaceId: workspace.id, scenarioId: scenario.id, channel: 'API' as const };
    const a = await svc.createSession({ ...base, participant: { externalId: 'crm-1', email: 'X@Example.com', name: 'X' } });
    const b = await svc.createSession({ ...base, participant: { externalId: 'crm-1', name: 'X Renamed' } });
    expect(b.session.participantId).toBe(a.session.participantId);
    const p = await prisma.participant.findUniqueOrThrow({ where: { id: a.session.participantId } });
    expect(p.email).toBe('x@example.com');
    expect(p.name).toBe('X Renamed');

    const u1 = await svc.createSession({ ...base, participant: { userId: user.id, email: user.email } });
    const u2 = await svc.createSession({ ...base, participant: { userId: user.id } });
    expect(u2.session.participantId).toBe(u1.session.participantId);

    const e1 = await svc.createSession({ ...base, participant: { email: 'pat@example.com' } });
    const e2 = await svc.createSession({ ...base, participant: { email: 'PAT@example.com', name: 'Pat' } });
    expect(e2.session.participantId).toBe(e1.session.participantId);
    const anon1 = await svc.createSession({ ...base, participant: {} });
    const anon2 = await svc.createSession({ ...base, participant: {} });
    expect(anon1.session.participantId).not.toBe(anon2.session.participantId);
  });

  it('enforces hard quotas and caps the duration by workspace settings', async () => {
    const { workspace } = await createWorkspaceFixture(prisma);
    const { scenario } = await publishScenario(prisma, workspace.id, interviewConfig());
    await prisma.workspace.update({ where: { id: workspace.id }, data: { settings: { maxSessionMinutes: 5 } } });
    const s = await svc.createSession({ workspaceId: workspace.id, scenarioId: scenario.id, channel: 'API', participant: {} });
    expect(s.session.maxDurationSec).toBe(300);
    expect((s.session.providerInfo as any).simulated).toBe(true);
    await prisma.workspaceQuota.create({ data: { workspaceId: workspace.id, metric: 'sessions', limitValue: 1, hardLimit: true } });
    await expectAppError(svc.createSession({ workspaceId: workspace.id, scenarioId: scenario.id, channel: 'API', participant: {} }), 402, 'quota_exceeded');
  });

  it('verifies session tokens in constant time and rejects bad or expired ones', async () => {
    const { workspace } = await createWorkspaceFixture(prisma);
    const { scenario } = await publishScenario(prisma, workspace.id, interviewConfig());
    const { session, sessionToken } = await svc.createSession({ workspaceId: workspace.id, scenarioId: scenario.id, channel: 'API', participant: {} });
    expect((await svc.verifySessionToken(session.id, sessionToken)).id).toBe(session.id);
    await expectAppError(svc.verifySessionToken(session.id, 'cfs_wrong'), 401);
    await expectAppError(svc.verifySessionToken(session.id, sessionToken.slice(4)), 401);
    await expectAppError(svc.verifySessionToken('nope', sessionToken), 404);
    await prisma.session.update({ where: { id: session.id }, data: { resumeExpiresAt: new Date(Date.now() - 1000) } });
    await expectAppError(svc.verifySessionToken(session.id, sessionToken), 401);
  });

  it('falls back from realtime to the pipeline when OpenAI is not configured and records why', async () => {
    const { workspace } = await createWorkspaceFixture(prisma);
    const cfg = interviewConfig({ model: { voiceMode: 'realtime', llmProvider: 'anthropic', llmModel: '', temperature: 0.7, sttProvider: 'deepgram', ttsProvider: 'openai', realtimeProvider: 'openai', realtimeModel: '' } });
    const { scenario } = await publishScenario(prisma, workspace.id, cfg);
    const { session } = await svc.createSession({ workspaceId: workspace.id, scenarioId: scenario.id, channel: 'BROWSER', participant: {} });
    const pi = session.providerInfo as any;
    if (!process.env.OPENAI_API_KEY) {
      expect(pi.voiceMode).toBe('pipeline');
      expect(pi.requestedVoiceMode).toBe('realtime');
      expect(pi.stt).toBe('browser');
      expect(pi.tts).toBe('browser');
      expect(pi.fallbacks.join(' ')).toMatch(/OPENAI_API_KEY/);
    }
  });

  it('never modifies the immutable ScenarioVersion (and the DB refuses updates)', async () => {
    const { workspace } = await createWorkspaceFixture(prisma);
    const { scenario, latest } = await publishScenario(prisma, workspace.id, interviewConfig());
    await svc.createSession({ workspaceId: workspace.id, scenarioId: scenario.id, channel: 'API', participant: {} });
    const after = await prisma.scenarioVersion.findUniqueOrThrow({ where: { id: latest.id } });
    expect(after.configHash).toBe(latest.configHash);
    expect(JSON.stringify(after.config)).toBe(JSON.stringify(latest.config));
    await expect(prisma.scenarioVersion.update({ where: { id: latest.id }, data: { changeNote: 'x' } })).rejects.toThrow(/immutable/);
  });
});
