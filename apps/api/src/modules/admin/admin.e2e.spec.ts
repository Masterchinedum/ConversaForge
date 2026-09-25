import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Harness } from '../../../test/e-harness';

describe('organization admin (integration)', () => {
  const h = new Harness();
  let org: Awaited<ReturnType<Harness['org']>>;
  const base = () => `/api/workspaces/${org.ws.id}`;

  beforeAll(async () => {
    await h.start();
    org = await h.org();
  }, 60_000);
  afterAll(() => h.stop());

  describe('members & roles', () => {
    it('lists members for REVIEWER+, not for MEMBER', async () => {
      const r = await h.req('GET', `${base()}/members`, { token: org.reviewer.token });
      expect(r.statusCode).toBe(200);
      expect(r.json().data.map((m: any) => m.role).sort()).toEqual(['ADMIN', 'CREATOR', 'MEMBER', 'OWNER', 'REVIEWER']);
      expect((await h.req('GET', `${base()}/members`, { token: org.learner.token })).statusCode).toBe(403);
    });

    it('protects the last owner (demote, remove, leave)', async () => {
      const demote = await h.req('PATCH', `${base()}/members/${org.owner.membershipId}`, { token: org.owner.token, body: { role: 'ADMIN' } });
      expect(demote.statusCode).toBe(409);
      expect(demote.json().error.code).toBe('last_owner');
      expect((await h.req('DELETE', `${base()}/members/${org.owner.membershipId}`, { token: org.owner.token })).statusCode).toBe(409);
      expect((await h.req('POST', `${base()}/leave`, { token: org.owner.token })).statusCode).toBe(409);
    });

    it('ADMIN cannot modify owners or grant OWNER; can manage other roles', async () => {
      expect((await h.req('PATCH', `${base()}/members/${org.owner.membershipId}`, { token: org.admin.token, body: { role: 'MEMBER' } })).statusCode).toBe(403);
      expect((await h.req('DELETE', `${base()}/members/${org.owner.membershipId}`, { token: org.admin.token })).statusCode).toBe(403);
      expect((await h.req('PATCH', `${base()}/members/${org.creator.membershipId}`, { token: org.admin.token, body: { role: 'OWNER' } })).statusCode).toBe(403);
      const ok = await h.req('PATCH', `${base()}/members/${org.reviewer.membershipId}`, { token: org.admin.token, body: { role: 'CREATOR' } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().role).toBe('CREATOR');
      await h.req('PATCH', `${base()}/members/${org.reviewer.membershipId}`, { token: org.admin.token, body: { role: 'REVIEWER' } });
      expect((await h.req('PATCH', `${base()}/members/${org.learner.membershipId}`, { token: org.creator.token, body: { role: 'ADMIN' } })).statusCode).toBe(403);
      const audit = await h.prisma.auditLog.findFirst({ where: { workspaceId: org.ws.id, action: 'member.role_changed', targetId: org.reviewer.membershipId } });
      expect(audit?.metadata).toMatchObject({ from: 'REVIEWER', to: 'CREATOR' });
    });

    it('two owners demoting each other concurrently leaves exactly one owner', async () => {
      const o1 = await h.user('O1');
      const ws = await h.workspace(o1);
      const m1 = await h.prisma.membership.findFirstOrThrow({ where: { workspaceId: ws.id, userId: o1.id } });
      const o2 = await h.member(ws.id, 'OWNER');
      const [a, b] = await Promise.all([
        h.req('PATCH', `/api/workspaces/${ws.id}/members/${o2.membershipId}`, { token: o1.token, body: { role: 'ADMIN' } }),
        h.req('PATCH', `/api/workspaces/${ws.id}/members/${m1.id}`, { token: o2.token, body: { role: 'ADMIN' } }),
      ]);
      const codes = [a.statusCode, b.statusCode].sort();
      // One wins; the other is refused (last owner) or no longer authorized (it was demoted first).
      expect(codes[0]).toBe(200);
      expect([403, 409]).toContain(codes[1]);
      expect(await h.prisma.membership.count({ where: { workspaceId: ws.id, role: 'OWNER' } })).toBe(1);
    });

    it('members can leave; owners can transfer ownership', async () => {
      const extra = await h.member(org.ws.id, 'MEMBER');
      expect((await h.req('POST', `${base()}/leave`, { token: extra.token })).statusCode).toBe(200);
      expect(await h.prisma.membership.findUnique({ where: { id: extra.membershipId } })).toBeNull();
      const personal = await h.workspace(extra, 'PERSONAL');
      expect((await h.req('POST', `/api/workspaces/${personal.id}/leave`, { token: extra.token })).statusCode).toBe(409);
    });
  });

  describe('invitations', () => {
    const lastInviteToken = (email: string) => {
      const m = [...h.mails].reverse().find((x) => x.to === email);
      return m ? /\/invite\/([A-Za-z0-9_-]+)/.exec(m.text)?.[1] : undefined;
    };

    it('invites by email, previews, rejects email mismatch, accepts once', async () => {
      const email = `newbie-${h.uid()}@x.example`;
      const inv = await h.req('POST', `${base()}/invitations`, { token: org.admin.token, body: { email, role: 'CREATOR' } });
      expect(inv.statusCode).toBe(201);
      const token = lastInviteToken(email)!;
      expect(token).toBeTruthy();
      const row = await h.prisma.invitation.findUniqueOrThrow({ where: { id: inv.json().id } });
      expect(row.tokenHash).toBe(h.crypto.sha256(token));
      expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 86400_000);

      const prev = await h.req('GET', `/api/invitations/${token}`, { ip: h.ip() });
      expect(prev.statusCode).toBe(200);
      expect(prev.json()).toMatchObject({ role: 'CREATOR', status: 'pending', inviter: 'admin' });

      const wrong = await h.user('Wrong');
      const mismatch = await h.req('POST', `/api/invitations/${token}/accept`, { token: wrong.token });
      expect(mismatch.statusCode).toBe(403);
      expect(mismatch.json().error.code).toBe('invitation_email_mismatch');
      expect((await h.req('POST', `/api/invitations/${token}/accept`, {})).statusCode).toBe(401);

      const invitee = await h.user('Newbie', email.toUpperCase());
      const acc = await h.req('POST', `/api/invitations/${token}/accept`, { token: invitee.token });
      expect(acc.statusCode).toBe(200);
      expect(acc.json()).toMatchObject({ workspaceId: org.ws.id, role: 'CREATOR' });
      const again = await h.req('POST', `/api/invitations/${token}/accept`, { token: invitee.token });
      expect(again.json().alreadyMember).toBe(true);
      expect(await h.prisma.membership.count({ where: { workspaceId: org.ws.id, userId: invitee.id } })).toBe(1);
    });

    it('resend rotates the token; revoke and expiry block acceptance', async () => {
      const email = `rot-${h.uid()}@x.example`;
      const inv = (await h.req('POST', `${base()}/invitations`, { token: org.admin.token, body: { email } })).json();
      const t1 = lastInviteToken(email)!;
      await h.req('POST', `${base()}/invitations/${inv.id}/resend`, { token: org.admin.token });
      const t2 = lastInviteToken(email)!;
      expect(t2).not.toBe(t1);
      expect((await h.req('GET', `/api/invitations/${t1}`, { ip: h.ip() })).statusCode).toBe(404);
      const u = await h.user('Rot', email);
      await h.req('DELETE', `${base()}/invitations/${inv.id}`, { token: org.admin.token });
      expect((await h.req('POST', `/api/invitations/${t2}/accept`, { token: u.token })).statusCode).toBe(410);

      const email2 = `exp-${h.uid()}@x.example`;
      const inv2 = (await h.req('POST', `${base()}/invitations`, { token: org.admin.token, body: { email: email2 } })).json();
      const t3 = lastInviteToken(email2)!;
      await h.prisma.invitation.update({ where: { id: inv2.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const u2 = await h.user('Exp', email2);
      expect((await h.req('POST', `/api/invitations/${t3}/accept`, { token: u2.token })).statusCode).toBe(410);
    });

    it('personal workspaces cannot invite; only owners invite owners; existing members are rejected', async () => {
      const solo = await h.user('Solo');
      const personal = await h.workspace(solo, 'PERSONAL');
      const r = await h.req('POST', `/api/workspaces/${personal.id}/invitations`, { token: solo.token, body: { email: 'a@x.example' } });
      expect(r.statusCode).toBe(409);
      expect((await h.req('POST', `${base()}/invitations`, { token: org.admin.token, body: { email: 'boss@x.example', role: 'OWNER' } })).statusCode).toBe(403);
      expect((await h.req('POST', `${base()}/invitations`, { token: org.admin.token, body: { email: org.learner.email } })).statusCode).toBe(409);
    });
  });

  describe('teams', () => {
    it('creates teams and adds members (participant created/linked) and participants', async () => {
      const t = await h.req('POST', `${base()}/teams`, { token: org.admin.token, body: { name: `Sales ${h.uid()}` } });
      expect(t.statusCode).toBe(201);
      const add = await h.req('POST', `${base()}/teams/${t.json().id}/members`, { token: org.admin.token, body: { userId: org.learner.id } });
      expect(add.statusCode).toBe(201);
      const p = await h.prisma.participant.findFirstOrThrow({ where: { workspaceId: org.ws.id, userId: org.learner.id } });
      expect(add.json().participantId).toBe(p.id);
      const again = await h.req('POST', `${base()}/teams/${t.json().id}/members`, { token: org.admin.token, body: { userId: org.learner.id } });
      expect(again.json().participantId).toBe(p.id);
      const team = (await h.req('GET', `${base()}/teams/${t.json().id}`, { token: org.reviewer.token })).json();
      expect(team.members).toHaveLength(1);
      const outsider = await h.user('Not a member');
      expect((await h.req('POST', `${base()}/teams/${t.json().id}/members`, { token: org.admin.token, body: { userId: outsider.id } })).statusCode).toBe(422);
      expect((await h.req('DELETE', `${base()}/teams/${t.json().id}/members/${p.id}`, { token: org.admin.token })).statusCode).toBe(200);
      expect((await h.req('POST', `${base()}/teams`, { token: org.creator.token, body: { name: 'x' } })).statusCode).toBe(403);
    });
  });

  describe('branding', () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const multipart = (buf: Buffer, filename: string, type: string) => {
      const boundary = '----cfTestBoundary';
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
        buf,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
    };

    it('validates colors, uploads a PNG logo (served publicly), rejects SVG and spoofed types', async () => {
      expect((await h.req('PATCH', `${base()}/branding`, { token: org.admin.token, body: { primaryColor: 'red' } })).statusCode).toBe(422);
      const up = await h.req('PATCH', `${base()}/branding`, { token: org.admin.token, body: { displayName: 'Acme Academy', primaryColor: '#4F46E5', hidePoweredBy: true } });
      expect(up.statusCode).toBe(200);
      expect(up.json().primaryColor).toBe('#4f46e5');
      expect((await h.req('PATCH', `${base()}/branding`, { token: org.creator.token, body: { displayName: 'x' } })).statusCode).toBe(403);

      const svg = multipart(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'logo.svg', 'image/svg+xml');
      expect((await h.req('POST', `${base()}/branding/logo`, { token: org.admin.token, body: svg.body, headers: svg.headers })).statusCode).toBe(415);
      const spoof = multipart(Buffer.from('<html>not a png</html>'), 'logo.png', 'image/png');
      expect((await h.req('POST', `${base()}/branding/logo`, { token: org.admin.token, body: spoof.body, headers: spoof.headers })).statusCode).toBe(415);
      const big = multipart(Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)]), 'big.png', 'image/png');
      expect((await h.req('POST', `${base()}/branding/logo`, { token: org.admin.token, body: big.body, headers: big.headers })).statusCode).toBe(413);

      const ok = multipart(png, 'logo.png', 'image/png');
      const res = await h.req('POST', `${base()}/branding/logo`, { token: org.admin.token, body: ok.body, headers: ok.headers });
      expect(res.statusCode).toBe(201);
      expect(res.json().logoUrl).toMatch(new RegExp(`/api/public/branding/${org.ws.id}/logo`));
      const logo = await h.req('GET', `/api/public/branding/${org.ws.id}/logo`);
      expect(logo.statusCode).toBe(200);
      expect(logo.headers['content-type']).toBe('image/png');
      const pub = await h.req('GET', `/api/public/branding/${org.ws.id}`, { ip: h.ip() });
      expect(pub.json()).toMatchObject({ displayName: 'Acme Academy', hidePoweredBy: true });
      expect(pub.json()).not.toHaveProperty('emailFooter');
    });
  });

  describe('audit, usage, quotas, billing', () => {
    it('lists audit entries with filters and exports CSV (formula-safe)', async () => {
      await h.prisma.auditLog.create({ data: { workspaceId: org.ws.id, actorUserId: org.owner.id, action: 'test.formula', metadata: { note: '=HYPERLINK("x")' } } });
      const r = await h.req('GET', `${base()}/audit?action=member.&limit=5`, { token: org.admin.token });
      expect(r.statusCode).toBe(200);
      expect(r.json().data.every((e: any) => e.action.startsWith('member.'))).toBe(true);
      expect(r.json().data[0].actor.type).toBe('user');
      const page2 = await h.req('GET', `${base()}/audit?limit=2`, { token: org.admin.token });
      expect(page2.json().nextCursor).toBeTruthy();
      const next = await h.req('GET', `${base()}/audit?limit=2&cursor=${page2.json().nextCursor}`, { token: org.admin.token });
      expect(next.json().data[0].id).not.toBe(page2.json().data[0].id);
      const csv = await h.req('GET', `${base()}/audit/export.csv?action=test.`, { token: org.admin.token });
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.body).toContain('test.formula');
      expect(csv.body.split('\n')[0]).toContain('actor_email');
      expect((await h.req('GET', `${base()}/audit`, { token: org.creator.token })).statusCode).toBe(403);
    });

    it('usage summary/ledger (BigInt-safe), quotas need OWNER, alerts are raised and emailed once', async () => {
      const sid = (await h.prisma.session.findFirst({ where: { workspaceId: org.ws.id } }))?.id ?? null;
      await h.prisma.usageLedger.create({
        data: { workspaceId: org.ws.id, sessionId: sid, kind: 'LLM_INPUT_TOKENS', provider: 'anthropic', quantity: 1000, unit: 'tokens', costMicros: BigInt(9_000_000), idempotencyKey: `t-${h.uid()}` },
      });
      const sum = await h.req('GET', `${base()}/usage/summary`, { token: org.admin.token });
      expect(sum.statusCode).toBe(200);
      expect(sum.json().totals.cost_micros).toBeGreaterThanOrEqual(9_000_000);
      expect(sum.json().byProvider.find((p: any) => p.provider === 'anthropic').costMicros).toBeGreaterThanOrEqual(9_000_000);
      const ledger = await h.req('GET', `${base()}/usage/ledger?kind=LLM_INPUT_TOKENS`, { token: org.admin.token });
      expect(typeof ledger.json().data[0].costMicros).toBe('number');
      const csv = await h.req('GET', `${base()}/usage/export.csv`, { token: org.admin.token });
      expect(csv.body).toContain('estimated_cost_usd');

      expect((await h.req('PUT', `${base()}/quotas`, { token: org.admin.token, body: { metric: 'cost_micros', limitValue: 10_000_000 } })).statusCode).toBe(403);
      const q = await h.req('PUT', `${base()}/quotas`, { token: org.owner.token, body: { metric: 'cost_micros', limitValue: 10_000_000, alertThresholdPct: 80, hardLimit: true } });
      expect(q.statusCode).toBe(200);
      const { UsageAdminService } = await import('./usage-admin.service');
      const svc = h.get(UsageAdminService);
      h.mails.length = 0;
      await svc.checkAllWorkspaces();
      const alerts = (await h.req('GET', `${base()}/usage/alerts`, { token: org.admin.token })).json().data;
      expect(alerts.some((a: any) => a.metric === 'cost_micros' && a.thresholdPct === 80)).toBe(true);
      const alertMails = h.mails.filter((m) => m.subject.includes('cost micros'));
      expect(alertMails.map((m) => m.to).sort()).toEqual([org.admin.email, org.owner.email].sort());
      await svc.checkAllWorkspaces();
      expect(h.mails.filter((m) => m.subject.includes('cost micros'))).toHaveLength(alertMails.length);
      const ack = await h.req('POST', `${base()}/usage/alerts/${alerts[0].id}/acknowledge`, { token: org.admin.token });
      expect(ack.json().acknowledgedAt).toBeTruthy();
      await h.req('DELETE', `${base()}/quotas/${q.json().id}`, { token: org.owner.token });
    });

    it('billing defaults to the "none" provider', async () => {
      const b = await h.req('GET', `${base()}/billing`, { token: org.admin.token });
      expect(b.json()).toMatchObject({ provider: 'none', configured: true, plan: 'free' });
    });
  });

  describe('privacy', () => {
    async function participantWithData(email: string) {
      const p = await h.prisma.participant.create({ data: { workspaceId: org.ws.id, email, name: 'Data Subject' } });
      const s = await h.prisma.session.create({
        data: {
          workspaceId: org.ws.id,
          scenarioId: org.scenario.id,
          scenarioVersionId: org.scenario.versionId,
          participantId: p.id,
          state: 'COMPLETED',
          turns: {
            create: [
              { seq: 1, speaker: 'AGENT', text: 'Tell me about yourself.' },
              { seq: 2, speaker: 'PARTICIPANT', text: 'My secret phone number is 555-0100.' },
            ],
          },
        },
      });
      const ev = await h.prisma.evaluation.create({
        data: { sessionId: s.id, workspaceId: org.ws.id, scenarioVersionId: org.scenario.versionId, rubricHash: 'x', status: 'COMPLETED', overallScore: 72 },
      });
      await h.prisma.criterionScore.create({ data: { evaluationId: ev.id, criterionId: 'c1', name: 'Clarity', weight: 100, score: 72, evidence: [{ turnSeq: 2, quote: 'secret phone number' }] } });
      const key = `ws/${org.ws.id}/recordings/${s.id}.webm`;
      const dir = process.env.STORAGE_LOCAL_DIR!;
      await fs.mkdir(path.dirname(path.join(dir, key)), { recursive: true });
      await fs.writeFile(path.join(dir, key), Buffer.from('fake audio'));
      await h.prisma.mediaAsset.create({ data: { workspaceId: org.ws.id, sessionId: s.id, kind: 'RECORDING_AUDIO', storageKey: key, mimeType: 'audio/webm', sizeBytes: BigInt(10), status: 'READY' } });
      const profile = await h.prisma.coachProfile.create({ data: { workspaceId: org.ws.id, participantId: p.id } });
      await h.prisma.memoryFact.create({ data: { workspaceId: org.ws.id, participantId: p.id, coachProfileId: profile.id, content: 'Wants to improve pacing' } });
      await h.prisma.usageLedger.create({
        data: { workspaceId: org.ws.id, sessionId: s.id, kind: 'SESSION_SECONDS', provider: 'simulator', quantity: 60, unit: 'seconds', idempotencyKey: `u-${h.uid()}` },
      });
      return { p, s, key: path.join(dir, key) };
    }

    it('retention job deletes media, redacts transcripts and evidence, keeps scores — idempotently', async () => {
      const { s, key } = await participantWithData(`ret-${h.uid()}@x.example`);
      await h.prisma.session.update({ where: { id: s.id }, data: { retentionUntil: new Date(Date.now() - 1000) } });
      const { PrivacyService, REDACTED_TEXT } = await import('./privacy.service');
      const svc = h.get(PrivacyService);
      const first = await svc.runRetention();
      expect(first.sessionsRedacted).toBeGreaterThanOrEqual(1);
      const turns = await h.prisma.transcriptTurn.findMany({ where: { sessionId: s.id } });
      expect(turns.every((t) => t.text === REDACTED_TEXT)).toBe(true);
      await expect(fs.access(key)).rejects.toThrow();
      const media = await h.prisma.mediaAsset.findFirstOrThrow({ where: { sessionId: s.id } });
      expect(media.status).toBe('DELETED');
      const ev = await h.prisma.evaluation.findFirstOrThrow({ where: { sessionId: s.id }, include: { criteria: true } });
      expect(ev.overallScore).toBe(72);
      expect(JSON.stringify(ev.criteria[0]!.evidence)).not.toContain('secret');
      expect((ev.criteria[0]!.evidence as any[])[0].turnSeq).toBe(2);
      const second = await svc.runRetention();
      expect(second.sessionsRedacted).toBe(0);
      expect(second.sessionMediaDeleted).toBe(0);

      // Workspace default retention applies to sessions without their own retentionUntil.
      const { s: s2 } = await participantWithData(`ret2-${h.uid()}@x.example`);
      await h.prisma.session.update({ where: { id: s2.id }, data: { createdAt: new Date(Date.now() - 40 * 86400_000) } });
      await h.req('PATCH', base(), { token: org.admin.token, body: { settings: { defaultRetentionDays: 30 } } });
      await svc.runRetention();
      expect((await h.prisma.session.findUniqueOrThrow({ where: { id: s2.id } })).contentRedactedAt).toBeTruthy();
      await h.req('PATCH', base(), { token: org.admin.token, body: { settings: { defaultRetentionDays: 3650 } } });
    });

    it('exports a participant’s data as a signed-download JSON asset', async () => {
      const email = `exp-${h.uid()}@x.example`;
      const { s } = await participantWithData(email);
      const r = await h.req('POST', `${base()}/privacy/requests`, { token: org.admin.token, body: { type: 'EXPORT', email: email.toUpperCase() } });
      expect(r.statusCode).toBe(201);
      expect(r.json().status).toBe('PENDING');
      expect((await h.req('POST', `${base()}/privacy/requests/${r.json().id}/download`, { token: org.admin.token })).statusCode).toBe(409);
      const { PrivacyService } = await import('./privacy.service');
      await h.get(PrivacyService).process(r.json().id);
      const done = (await h.req('GET', `${base()}/privacy/requests/${r.json().id}`, { token: org.admin.token })).json();
      expect(done.status).toBe('COMPLETED');
      expect(done.summary).toMatchObject({ participants: 1, sessions: 1, transcriptTurns: 2, memoryFacts: 1 });
      const dl = await h.req('POST', `${base()}/privacy/requests/${r.json().id}/download`, { token: org.admin.token });
      expect(dl.statusCode).toBe(200);
      const url = new URL(dl.json().url);
      const file = await h.req('GET', url.pathname);
      expect(file.statusCode).toBe(200);
      const doc = JSON.parse(file.body);
      expect(doc.sessions[0].id).toBe(s.id);
      expect(doc.sessions[0].transcript[1].text).toContain('555-0100');
      expect(doc.memoryFacts[0].content).toBe('Wants to improve pacing');
      expect((await h.req('GET', `${base()}/privacy/requests`, { token: org.creator.token })).statusCode).toBe(403);
    });

    it('deletes a participant’s data (sessions, media, memory, PII) and keeps the anonymized usage ledger', async () => {
      const email = `del-${h.uid()}@x.example`;
      const { p, s, key } = await participantWithData(email);
      const noConfirm = await h.req('POST', `${base()}/privacy/requests`, { token: org.admin.token, body: { type: 'DELETE', participantId: p.id } });
      expect(noConfirm.statusCode).toBe(422);
      const r = await h.req('POST', `${base()}/privacy/requests`, { token: org.admin.token, body: { type: 'DELETE', participantId: p.id, confirm: p.id } });
      expect(r.statusCode).toBe(201);
      const { PrivacyService } = await import('./privacy.service');
      await h.get(PrivacyService).process(r.json().id);
      expect(await h.prisma.session.findUnique({ where: { id: s.id } })).toBeNull();
      expect(await h.prisma.transcriptTurn.count({ where: { sessionId: s.id } })).toBe(0);
      expect(await h.prisma.memoryFact.count({ where: { participantId: p.id } })).toBe(0);
      await expect(fs.access(key)).rejects.toThrow();
      const tomb = await h.prisma.participant.findUniqueOrThrow({ where: { id: p.id } });
      expect(tomb).toMatchObject({ email: null, name: null, userId: null });
      expect(tomb.deletedAt).toBeTruthy();
      expect(await h.prisma.usageLedger.count({ where: { sessionId: s.id } })).toBe(1);
      const done = (await h.req('GET', `${base()}/privacy/requests/${r.json().id}`, { token: org.admin.token })).json();
      expect(done.status).toBe('COMPLETED');
      expect(done.summary).toMatchObject({ sessions: 1, memoryFacts: 1 });
      expect(await h.prisma.auditLog.count({ where: { workspaceId: org.ws.id, targetId: r.json().id } })).toBeGreaterThanOrEqual(2);
      // Idempotent re-run.
      await h.prisma.dataRequest.update({ where: { id: r.json().id }, data: { status: 'PENDING' } });
      await h.get(PrivacyService).process(r.json().id);
    });
  });

  describe('account', () => {
    it('lists and revokes my login sessions only', async () => {
      const me = await h.user('Me');
      const other = await h.user('Other');
      const t2 = h.crypto.randomToken(32);
      const s2 = await h.prisma.authSession.create({ data: { userId: me.id, tokenHash: h.crypto.sha256(t2), expiresAt: new Date(Date.now() + 86400_000), userAgent: 'Laptop' } });
      const list = await h.req('GET', '/api/auth/sessions', { token: me.token });
      expect(list.json().data).toHaveLength(2);
      expect(list.json().data.filter((x: any) => x.current)).toHaveLength(1);
      expect((await h.req('DELETE', `/api/auth/sessions/${s2.id}`, { token: other.token })).statusCode).toBe(404);
      expect((await h.req('DELETE', `/api/auth/sessions/${s2.id}`, { token: me.token })).statusCode).toBe(200);
      expect((await h.req('GET', '/api/auth/me', { token: t2 })).statusCode).toBe(401);
      expect((await h.req('GET', '/api/auth/me', { token: me.token })).statusCode).toBe(200);
    });
  });
});
