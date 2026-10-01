/* Test fixtures for runtime specs (integration tests against a Postgres test database). */
import type { PrismaClient } from '@prisma/client';
import {
  defaultScenarioConfig,
  normalizeScenarioConfig,
  stableStringify,
  type ScenarioConfig,
  type ScenarioConfigInput,
} from '@cf/shared';
import { createHash, randomBytes } from 'node:crypto';

export function testDbAvailable(): boolean {
  return /conversaforge_test/.test(process.env.DATABASE_URL ?? '');
}

export function interviewConfig(overrides: Partial<ScenarioConfigInput> = {}, conv: Record<string, unknown> = {}): ScenarioConfig {
  return normalizeScenarioConfig(
    defaultScenarioConfig({
      basics: {
        name: 'Backend engineer screen',
        type: 'interview',
        publicDescription: 'A short screening interview.',
        participantInstructions: 'Hi {{participant_name}}, answer naturally.',
        targetDurationMinutes: 10,
        privacy: 'ORGANIZATION',
      },
      persona: { role: 'Engineering manager at Acme', name: 'Alex', description: 'Friendly and concise.' },
      instructions: { goals: ['Assess backend experience'], boundaries: ['Do not discuss salary'], tone: 'warm' },
      conversation: {
        strategy: 'adaptive',
        agenda: [
          { id: 'background', topic: 'Recent backend work', guidance: 'Probe for role and outcome', required: true, maxFollowUps: 2 },
          { id: 'scaling', topic: 'Scaling a system under load', guidance: '', required: true, maxFollowUps: 1 },
        ],
        firstTurn: { speaker: 'agent', text: 'Hi {{participant_name}}, I am Alex. Ready to begin?' },
        ending: { closingMessage: 'Thanks {{participant_name}}, goodbye!', maxDurationMinutes: 20, wrapUpLeadMinutes: 2 },
        ...conv,
      },
      variables: {
        allowlist: [
          { key: 'participant_name', label: 'Name', required: false, maxLength: 80 },
          { key: 'role_title', label: 'Role', required: false, maxLength: 80 },
        ],
      },
      rubric: { criteria: [{ id: 'depth', name: 'Depth', weight: 100 }] },
      tools: {
        enabled: [
          { toolId: 'end_session', enabled: true, config: {}, usageHint: '' },
          { toolId: 'notepad', enabled: true, config: {}, usageHint: '' },
          { toolId: 'document_upload', enabled: true, config: {}, usageHint: '' },
          { toolId: 'multiple_choice', enabled: true, config: {}, usageHint: '' },
        ],
      },
      ...overrides,
    } as ScenarioConfigInput),
  );
}

export async function createWorkspaceFixture(
  prisma: PrismaClient,
  opts: { role?: 'OWNER' | 'ADMIN' | 'CREATOR' | 'REVIEWER' | 'MEMBER'; name?: string } = {},
) {
  const tag = randomBytes(5).toString('hex');
  const user = await prisma.user.create({ data: { email: `rt-${tag}@example.com`, name: opts.name ?? 'Jamie Rivera' } });
  const workspace = await prisma.workspace.create({
    data: { name: `RT ${tag}`, slug: `rt-${tag}`, memberships: { create: { userId: user.id, role: opts.role ?? 'OWNER' } } },
  });
  const cookieToken = randomBytes(32).toString('base64url');
  await prisma.authSession.create({
    data: { userId: user.id, tokenHash: createHash('sha256').update(cookieToken).digest('hex'), expiresAt: new Date(Date.now() + 86400_000) },
  });
  return { user, workspace, cookieToken, tag };
}

export async function publishScenario(
  prisma: PrismaClient,
  workspaceId: string,
  config: ScenarioConfig,
  opts: { privacy?: 'PRIVATE' | 'ORGANIZATION' | 'PUBLIC'; versions?: number } = {},
) {
  const tag = randomBytes(5).toString('hex');
  const scenario = await prisma.scenario.create({
    data: { workspaceId, slug: `s-${tag}`, name: config.basics.name, type: config.basics.type, privacy: opts.privacy ?? 'ORGANIZATION', status: 'PUBLISHED' },
  });
  const versions = [];
  for (let v = 1; v <= (opts.versions ?? 1); v++) {
    const cfg = v === 1 ? config : { ...config, basics: { ...config.basics, name: `${config.basics.name} v${v}` } };
    versions.push(
      await prisma.scenarioVersion.create({
        data: { scenarioId: scenario.id, workspaceId, version: v, config: cfg as any, configHash: createHash('sha256').update(stableStringify(cfg)).digest('hex') },
      }),
    );
  }
  const latest = versions[versions.length - 1]!;
  await prisma.scenario.update({ where: { id: scenario.id }, data: { latestVersionId: latest.id, latestVersionNumber: latest.version } });
  return { scenario, versions, latest };
}
