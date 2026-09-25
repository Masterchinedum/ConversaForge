/**
 * Development/demo seed. Idempotent: re-running updates nothing that already exists.
 *   cd apps/api && pnpm seed
 * Creates a demo organization with one user per role, publishes every built-in template as a
 * scenario (version 1), a demo course, and a share link. Refuses to run in production unless
 * SEED_ALLOW_PRODUCTION=true.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { hash } from '@node-rs/argon2';
import { createHash, randomBytes } from 'node:crypto';
import {
  SCENARIO_TEMPLATES,
  normalizeScenarioConfig,
  stableStringify,
  validateScenarioForPublish,
} from '@cf/shared';

const prisma = new PrismaClient();
const PASSWORD = process.env.SEED_PASSWORD ?? 'demo-password-123';

const USERS = [
  { email: 'owner@demo.test', name: 'Olivia Owner', role: 'OWNER' as const },
  { email: 'admin@demo.test', name: 'Adam Admin', role: 'ADMIN' as const },
  { email: 'creator@demo.test', name: 'Casey Creator', role: 'CREATOR' as const },
  { email: 'reviewer@demo.test', name: 'Riley Reviewer', role: 'REVIEWER' as const },
  { email: 'learner@demo.test', name: 'Lee Learner', role: 'MEMBER' as const },
];

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW_PRODUCTION !== 'true') {
    throw new Error('Refusing to seed demo data in production (set SEED_ALLOW_PRODUCTION=true to override).');
  }
  const passwordHash = await hash(PASSWORD);

  const users = [];
  for (const u of USERS) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: { email: u.email, name: u.name, passwordHash },
    });
    users.push({ ...u, id: user.id });
    const personalSlug = `${u.email.split('@')[0]}-personal`;
    const hasPersonal = await prisma.membership.findFirst({ where: { userId: user.id, workspace: { kind: 'PERSONAL' } } });
    if (!hasPersonal) {
      await prisma.workspace.create({
        data: {
          name: `${u.name}'s workspace`,
          slug: `${personalSlug}-${randomBytes(2).toString('hex')}`,
          kind: 'PERSONAL',
          createdById: user.id,
          memberships: { create: { userId: user.id, role: 'OWNER' } },
        },
      });
    }
  }
  const owner = users[0]!;
  const creator = users.find((u) => u.role === 'CREATOR')!;

  const ws = await prisma.workspace.upsert({
    where: { slug: 'acme-training' },
    update: {},
    create: {
      name: 'Acme Training',
      slug: 'acme-training',
      kind: 'ORGANIZATION',
      createdById: owner.id,
      settings: { allowPublicScenarios: true, maxSessionMinutes: 30, defaultRetentionDays: 365 },
    },
  });
  for (const u of users) {
    await prisma.membership.upsert({
      where: { workspaceId_userId: { workspaceId: ws.id, userId: u.id } },
      update: { role: u.role },
      create: { workspaceId: ws.id, userId: u.id, role: u.role },
    });
  }
  await prisma.workspaceBranding.upsert({
    where: { workspaceId: ws.id },
    update: {},
    create: { workspaceId: ws.id, displayName: 'Acme Training', primaryColor: '#4f46e5', accentColor: '#0ea5e9' },
  });

  const scenarioIds: string[] = [];
  for (const t of SCENARIO_TEMPLATES) {
    const slug = t.key;
    const existing = await prisma.scenario.findUnique({ where: { workspaceId_slug: { workspaceId: ws.id, slug } } });
    if (existing) {
      scenarioIds.push(existing.id);
      continue;
    }
    const result = validateScenarioForPublish(t.config);
    if (!result.ok || !result.config) {
      console.warn(`Template ${t.key} does not validate; skipping`, result.issues.filter((i) => i.severity === 'error'));
      continue;
    }
    const config = normalizeScenarioConfig(result.config);
    const configHash = createHash('sha256').update(stableStringify(config)).digest('hex');
    const scenario = await prisma.scenario.create({
      data: {
        workspaceId: ws.id,
        slug,
        name: config.basics.name,
        type: config.basics.type,
        privacy: 'ORGANIZATION',
        status: 'PUBLISHED',
        tags: config.basics.tags,
        publicDescription: config.basics.publicDescription,
        createdById: creator.id,
        updatedById: creator.id,
        draft: {
          create: { config: config as unknown as Prisma.InputJsonValue, lockedFields: [], updatedById: creator.id },
        },
      },
    });
    const version = await prisma.scenarioVersion.create({
      data: {
        scenarioId: scenario.id,
        workspaceId: ws.id,
        version: 1,
        config: config as unknown as Prisma.InputJsonValue,
        configHash,
        changeNote: 'Initial version (seeded from template)',
        publishedById: creator.id,
      },
    });
    await prisma.scenario.update({
      where: { id: scenario.id },
      data: { latestVersionId: version.id, latestVersionNumber: 1 },
    });
    await prisma.scenarioDraft.update({ where: { scenarioId: scenario.id }, data: { baseVersionId: version.id } });
    scenarioIds.push(scenario.id);
  }

  // Demo course (0% for every new enrollment).
  let course = await prisma.course.findFirst({ where: { workspaceId: ws.id, title: 'Interview readiness' } });
  if (!course && scenarioIds.length >= 2) {
    course = await prisma.course.create({
      data: {
        workspaceId: ws.id,
        title: 'Interview readiness',
        description: 'Practice a behavioral interview, then review a short guide.',
        visibility: 'ORGANIZATION',
        status: 'PUBLISHED',
        forcedOrder: true,
        createdById: creator.id,
        items: {
          create: [
            { position: 0, kind: 'SCENARIO', title: 'Behavioral interview practice', scenarioId: scenarioIds[0], completionRule: { type: 'session_completed' } },
            { position: 1, kind: 'LINK', title: 'Read: the STAR method', url: 'https://en.wikipedia.org/wiki/Situation,_task,_action,_result', completionRule: { type: 'viewed' } },
            { position: 2, kind: 'SCENARIO', title: 'Second practice scenario', scenarioId: scenarioIds[1], completionRule: { type: 'session_completed' } },
          ],
        },
      },
    });
  }

  // Demo share link for the first scenario.
  let linkToken: string | null = null;
  if (scenarioIds[0]) {
    const link = await prisma.shareLink.findFirst({ where: { scenarioId: scenarioIds[0], label: 'Demo link' } });
    linkToken =
      link?.token ??
      (
        await prisma.shareLink.create({
          data: {
            scenarioId: scenarioIds[0],
            workspaceId: ws.id,
            token: randomBytes(32).toString('base64url'),
            label: 'Demo link',
            identityMode: 'NAME_EMAIL',
            createdById: creator.id,
          },
        })
      ).token;
  }

  console.log('Seed complete.');
  console.log(`  Workspace: ${ws.name} (${ws.id})`);
  console.log(`  Users (password "${PASSWORD}"): ${USERS.map((u) => `${u.email} [${u.role}]`).join(', ')}`);
  console.log(`  Scenarios published: ${scenarioIds.length}`);
  if (linkToken) console.log(`  Share link: /r/${linkToken}`);
  if (course) console.log(`  Course: ${course.title} (${course.id})`);
  void createHash;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
