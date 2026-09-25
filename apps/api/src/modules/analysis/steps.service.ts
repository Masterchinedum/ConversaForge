import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { stableStringify, validateExtractionValue, type ScenarioConfig } from '@cf/shared';
import { env } from '../../config/env';
import { CryptoService } from '../../common/crypto/crypto.service';
import { LlmService } from '../../common/llm/llm.service';
import { LlmUnavailableError, type ResolvedLlm } from '../../common/llm/llm.types';
import { MailService } from '../../common/mail/mail.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { UsageService } from '../usage/usage.service';
import { subjectSpeaker, type TurnLike } from './evidence';
import {
  EXTRACTION_PROMPT_VERSION,
  SCORING_PROMPT_VERSION,
  extractionJsonSchema,
  extractionSystemPrompt,
  extractionUserPrompt,
  scoringJsonSchema,
  scoringSystemPrompt,
  scoringUserPrompt,
} from './prompts';
import { processEvaluation } from './scoring';
import { SIMULATED_SUMMARY_PREFIX, simulateExtraction, simulateScoring } from './simulator';
import { NonRetryableError, PIPELINE_STEPS, parseVersionConfig, type PipelineStep, type StepOutcome } from './pipeline.types';

export interface StepContext {
  sessionId: string;
  workspaceId: string;
  generation: number;
}

interface Loaded {
  session: Prisma.SessionGetPayload<{ include: { scenario: { select: { id: true; name: true; type: true } }; participant: true } }>;
  version: { id: string; version: number };
  config: ScenarioConfig;
  turns: TurnLike[];
}

/** The individual, idempotent post-session steps. Orchestration (queueing, retries, status) lives in AnalysisService. */
@Injectable()
export class PipelineStepsService {
  private readonly logger = new Logger('AnalysisSteps');

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly usage: UsageService,
    private readonly mail: MailService,
    private readonly crypto: CryptoService,
  ) {}

  run(step: PipelineStep, ctx: StepContext): Promise<StepOutcome> {
    switch (step) {
      case 'finalize_transcript':
        return this.finalizeTranscript(ctx);
      case 'score':
        return this.score(ctx);
      case 'extract':
        return this.extract(ctx);
      case 'report':
        return this.report(ctx);
      case 'notify':
        return this.notify(ctx);
    }
  }

  async load(ctx: StepContext): Promise<Loaded> {
    const session = await this.prisma.session.findFirst({
      where: { id: ctx.sessionId, workspaceId: ctx.workspaceId },
      include: { scenario: { select: { id: true, name: true, type: true } }, participant: true },
    });
    if (!session) throw new NonRetryableError('Session not found', 'session_not_found');
    // The EXACT version the session ran with (invariant #2).
    const version = await this.prisma.scenarioVersion.findFirst({
      where: { id: session.scenarioVersionId, workspaceId: ctx.workspaceId },
      select: { id: true, version: true, config: true },
    });
    if (!version) throw new NonRetryableError('Scenario version not found', 'version_not_found');
    const turns = await this.prisma.transcriptTurn.findMany({
      where: { sessionId: session.id },
      orderBy: { seq: 'asc' },
      select: { seq: true, speaker: true, text: true },
    });
    return {
      session,
      version: { id: version.id, version: version.version },
      config: parseVersionConfig(version.config),
      turns: turns.filter((t) => t.text.trim().length > 0),
    };
  }

  private async resolveLlm(workspaceId: string, config: ScenarioConfig): Promise<ResolvedLlm> {
    const preferred = config.model.llmProvider;
    try {
      return await this.llm.resolve(workspaceId, 'analysis', preferred);
    } catch (e) {
      if (e instanceof LlmUnavailableError) throw new NonRetryableError(e.message, 'provider_unavailable');
      throw e;
    }
  }

  // ── 1. finalize_transcript ──
  async finalizeTranscript(ctx: StepContext): Promise<StepOutcome> {
    const session = await this.prisma.session.findFirst({
      where: { id: ctx.sessionId, workspaceId: ctx.workspaceId },
      select: { id: true, durationMs: true },
    });
    if (!session) throw new NonRetryableError('Session not found', 'session_not_found');
    const turns = await this.prisma.transcriptTurn.findMany({ where: { sessionId: session.id }, orderBy: { seq: 'asc' } });
    let fixedTimings = 0;
    const stats = {
      turnCount: 0,
      participantTurns: 0,
      agentTurns: 0,
      systemTurns: 0,
      participantWords: 0,
      agentWords: 0,
      participantTalkMs: 0,
      agentTalkMs: 0,
      interruptedTurns: 0,
      emptyTurns: 0,
    };
    for (const t of turns) {
      let start = t.startedAtMs;
      let end = t.endedAtMs;
      if (start !== null && start < 0) start = 0;
      if (end !== null && end < 0) end = 0;
      if (start !== null && end !== null && end < start) end = start;
      if (start !== t.startedAtMs || end !== t.endedAtMs) {
        fixedTimings++;
        await this.prisma.transcriptTurn.update({ where: { id: t.id }, data: { startedAtMs: start, endedAtMs: end } });
      }
      const words = t.text.trim() ? t.text.trim().split(/\s+/).length : 0;
      if (!words) {
        stats.emptyTurns++;
        continue;
      }
      stats.turnCount++;
      if (t.interrupted) stats.interruptedTurns++;
      const talk = start !== null && end !== null ? end - start : 0;
      if (t.speaker === 'PARTICIPANT') {
        stats.participantTurns++;
        stats.participantWords += words;
        stats.participantTalkMs += talk;
      } else if (t.speaker === 'AGENT') {
        stats.agentTurns++;
        stats.agentWords += words;
        stats.agentTalkMs += talk;
      } else stats.systemTurns++;
    }
    const talkTotal = stats.participantTalkMs + stats.agentTalkMs;
    const wordTotal = stats.participantWords + stats.agentWords;
    const talkTimeRatio =
      talkTotal > 0
        ? { participant: round2(stats.participantTalkMs / talkTotal), agent: round2(stats.agentTalkMs / talkTotal), basis: 'time' }
        : wordTotal > 0
          ? { participant: round2(stats.participantWords / wordTotal), agent: round2(stats.agentWords / wordTotal), basis: 'words' }
          : null;
    return {
      status: 'COMPLETED',
      result: {
        ...stats,
        fixedTimings,
        talkTimeRatio,
        firstSeq: turns[0]?.seq ?? null,
        lastSeq: turns[turns.length - 1]?.seq ?? null,
        finalizedAt: new Date().toISOString(),
        retranscribed: false,
      },
    };
  }

  // ── 2. score ──
  async score(ctx: StepContext): Promise<StepOutcome> {
    const { session, version, config, turns } = await this.load(ctx);
    const rubric = config.rubric;
    if (!rubric.enabled || rubric.criteria.length === 0) {
      return { status: 'SKIPPED', result: { reason: 'No rubric is configured for this scenario version' } };
    }
    const subject = subjectSpeaker(rubric.evaluatedSubject);
    const llm = await this.resolveLlm(ctx.workspaceId, config);
    const { json, usage } = await llm.provider.completeJson(llm.model, {
      system: scoringSystemPrompt(),
      messages: [{ role: 'user', content: scoringUserPrompt(config, turns) }],
      jsonSchema: scoringJsonSchema(rubric.criteria.map((c) => c.id)),
      maxTokens: 16000,
      simulate: () => simulateScoring(rubric.criteria, turns, subject),
    });
    await this.usage.recordLlm(ctx.workspaceId, session.id, usage, `analysis:${session.id}:score:g${ctx.generation}`, true);

    const processed = processEvaluation(json, rubric, turns, subject);
    let summary = processed.summary;
    if (llm.simulated && !summary.startsWith(SIMULATED_SUMMARY_PREFIX)) summary = `${SIMULATED_SUMMARY_PREFIX}. ${summary}`.trim();
    const rubricHash = this.crypto.sha256(stableStringify(rubric));
    const humanReviewRequired = config.analysis.requireHumanReview || config.basics.type === 'interview' || session.scenario.type === 'interview';

    const evaluation = await this.prisma.$transaction(async (tx) => {
      const current = await tx.session.findUnique({ where: { id: session.id }, select: { analysisGeneration: true } });
      const isLatest = current?.analysisGeneration === ctx.generation;
      const data = {
        workspaceId: ctx.workspaceId,
        scenarioVersionId: version.id,
        rubricHash,
        status: 'COMPLETED' as const,
        overallScore: processed.weighted.overallScore,
        scoredWeightPct: processed.weighted.coverage,
        insufficientEvidence: processed.weighted.insufficientEvidence,
        summary,
        strengths: processed.strengths,
        weaknesses: processed.weaknesses,
        improvements: processed.improvements,
        notes: processed.notes,
        provider: llm.simulated ? 'simulator' : llm.provider.id,
        model: llm.model,
        promptVersion: SCORING_PROMPT_VERSION,
        simulated: llm.simulated,
        isCurrent: isLatest,
        humanReviewRequired,
        error: null,
        completedAt: new Date(),
      };
      const ev = await tx.evaluation.upsert({
        where: { sessionId_generation: { sessionId: session.id, generation: ctx.generation } },
        create: { sessionId: session.id, generation: ctx.generation, ...data },
        update: data,
      });
      await tx.criterionScore.deleteMany({ where: { evaluationId: ev.id } });
      await tx.criterionScore.createMany({
        data: processed.criteria.map((c) => ({
          evaluationId: ev.id,
          criterionId: c.criterionId,
          name: c.name,
          weight: c.weight,
          score: c.score,
          insufficientEvidence: c.insufficientEvidence,
          confidence: c.confidence,
          rationale: c.rationale,
          evidence: c.evidence as unknown as Prisma.InputJsonValue,
        })),
      });
      if (isLatest) {
        await tx.evaluation.updateMany({ where: { sessionId: session.id, id: { not: ev.id }, isCurrent: true }, data: { isCurrent: false } });
      }
      return ev;
    });

    return {
      status: 'COMPLETED',
      result: {
        evaluationId: evaluation.id,
        overallScore: evaluation.overallScore,
        coverage: processed.weighted.coverage,
        insufficientEvidence: processed.weighted.insufficientEvidence,
        simulated: llm.simulated,
        provider: evaluation.provider,
        model: llm.model,
        ...processed.stats,
      },
    };
  }

  // ── 3. extract ──
  async extract(ctx: StepContext): Promise<StepOutcome> {
    const { session, version, config, turns } = await this.load(ctx);
    const vars = config.extraction.variables;
    if (!vars.length) return { status: 'SKIPPED', result: { reason: 'No extraction variables are configured for this scenario version' } };
    const llm = await this.resolveLlm(ctx.workspaceId, config);
    const { json, usage } = await llm.provider.completeJson(llm.model, {
      system: extractionSystemPrompt(),
      messages: [{ role: 'user', content: extractionUserPrompt(vars, turns) }],
      jsonSchema: extractionJsonSchema(vars),
      maxTokens: 8000,
      simulate: () => simulateExtraction(vars, turns),
    });
    await this.usage.recordLlm(ctx.workspaceId, session.id, usage, `analysis:${session.id}:extract:g${ctx.generation}`, true);

    const values = ((json as any)?.values ?? {}) as Record<string, any>;
    const bySeq = new Map(turns.map((t) => [t.seq, t]));
    let invalid = 0;
    let found = 0;
    for (const v of vars) {
      const entry = values[v.key];
      const raw = entry && typeof entry === 'object' && 'value' in entry ? entry.value : entry ?? null;
      const checked = validateExtractionValue(v, raw);
      const seqs: number[] = Array.from(
        new Set<number>((Array.isArray(entry?.evidenceTurnSeqs) ? entry.evidenceTurnSeqs : []).map(Number).filter((s: number) => bySeq.has(s))),
      ).slice(0, 10);
      const evidence = seqs.map((s) => ({ turnSeq: s, speaker: bySeq.get(s)!.speaker, excerpt: clip(bySeq.get(s)!.text, 240) }));
      const confRaw = Number(entry?.confidence);
      const confidence = checked.value === null ? null : Number.isFinite(confRaw) ? Math.max(0, Math.min(1, confRaw)) : null;
      if (!checked.valid) invalid++;
      if (checked.value !== null) found++;
      const data = {
        workspaceId: ctx.workspaceId,
        scenarioVersionId: version.id,
        type: v.type,
        value: checked.value === null ? Prisma.DbNull : (checked.value as Prisma.InputJsonValue),
        valid: checked.valid,
        errors: checked.errors,
        evidence: evidence as unknown as Prisma.InputJsonValue,
        confidence,
        simulated: llm.simulated,
      };
      await this.prisma.extractionResult.upsert({
        where: { sessionId_key: { sessionId: session.id, key: v.key } },
        create: { sessionId: session.id, key: v.key, ...data },
        update: data,
      });
    }
    await this.prisma.extractionResult.deleteMany({ where: { sessionId: session.id, key: { notIn: vars.map((v) => v.key) } } });
    return {
      status: 'COMPLETED',
      result: { variables: vars.length, found, invalid, simulated: llm.simulated, provider: llm.simulated ? 'simulator' : llm.provider.id, model: llm.model, promptVersion: EXTRACTION_PROMPT_VERSION },
    };
  }

  // ── 4. report ──
  async buildReportContent(ctx: StepContext) {
    const { session, version, config } = await this.load(ctx);
    const [evaluation, extractions, toolEvents, jobs] = await Promise.all([
      this.prisma.evaluation.findFirst({
        where: { sessionId: session.id, workspaceId: ctx.workspaceId, isCurrent: true },
        include: { criteria: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.extractionResult.findMany({ where: { sessionId: session.id, workspaceId: ctx.workspaceId }, orderBy: { key: 'asc' } }),
      this.prisma.toolEvent.findMany({ where: { sessionId: session.id }, select: { toolId: true, kind: true } }),
      this.prisma.processingJob.findMany({ where: { sessionId: session.id, generation: ctx.generation, workspaceId: ctx.workspaceId } }),
    ]);
    const finalize = jobs.find((j) => j.kind === 'finalize_transcript')?.result as Record<string, unknown> | null | undefined;
    const byTool: Record<string, number> = {};
    for (const t of toolEvents) if (t.kind === 'INVOKED' || t.kind === 'PRESENTED') byTool[t.toolId] = (byTool[t.toolId] ?? 0) + 1;
    const order = new Map(config.rubric.criteria.map((c, i) => [c.id, i]));
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      generation: ctx.generation,
      session: {
        id: session.id,
        state: session.state,
        channel: session.channel,
        createdAt: session.createdAt,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        durationMs: session.durationMs,
        endedBy: session.endedBy,
        simulated: !!(session.providerInfo as any)?.simulated,
      },
      scenario: { id: session.scenario.id, name: session.scenario.name, type: config.basics.type },
      scenarioVersion: { id: version.id, number: version.version },
      participant: {
        id: session.participant.id,
        name: session.participant.name,
        email: session.participant.email,
        externalId: session.participant.externalId,
      },
      transcript: finalize
        ? {
            turnCount: finalize.turnCount,
            participantTurns: finalize.participantTurns,
            agentTurns: finalize.agentTurns,
            participantWords: finalize.participantWords,
            agentWords: finalize.agentWords,
            interruptedTurns: finalize.interruptedTurns,
            talkTimeRatio: finalize.talkTimeRatio,
            finalizedAt: finalize.finalizedAt,
          }
        : null,
      evaluation: evaluation
        ? {
            id: evaluation.id,
            overallScore: evaluation.overallScore,
            coverage: evaluation.scoredWeightPct,
            insufficientEvidence: evaluation.insufficientEvidence,
            passingScore: config.rubric.passingScore ?? null,
            passed:
              evaluation.overallScore === null || config.rubric.passingScore === undefined
                ? null
                : evaluation.overallScore >= config.rubric.passingScore,
            summary: evaluation.summary,
            strengths: evaluation.strengths,
            weaknesses: evaluation.weaknesses,
            improvements: evaluation.improvements,
            simulated: evaluation.simulated,
            humanReviewRequired: evaluation.humanReviewRequired,
            reviewedAt: evaluation.reviewedAt,
            provider: evaluation.provider,
            model: evaluation.model,
            promptVersion: evaluation.promptVersion,
          }
        : null,
      criteria: (evaluation?.criteria ?? [])
        .sort((a, b) => (order.get(a.criterionId) ?? 99) - (order.get(b.criterionId) ?? 99))
        .map((c) => ({
          criterionId: c.criterionId,
          name: c.name,
          weight: c.weight,
          score: c.score,
          insufficientEvidence: c.insufficientEvidence,
          confidence: c.confidence,
          evidenceCount: Array.isArray(c.evidence) ? c.evidence.length : 0,
        })),
      extraction: extractions.map((x) => ({ key: x.key, type: x.type, value: x.value, valid: x.valid, errors: x.errors, confidence: x.confidence })),
      tools: { total: toolEvents.length, byTool, errors: toolEvents.filter((t) => t.kind === 'ERROR').length },
      processing: {
        status: 'PROCESSING',
        steps: PIPELINE_STEPS.map((s) => {
          const j = jobs.find((x) => x.kind === s);
          return { step: s, status: j?.status ?? 'NOT_STARTED', error: j?.lastError ?? null };
        }),
      },
    };
  }

  async report(ctx: StepContext): Promise<StepOutcome> {
    const content = await this.buildReportContent(ctx);
    const json = JSON.parse(JSON.stringify(content)) as Prisma.InputJsonValue;
    await this.prisma.sessionReport.upsert({
      where: { sessionId: ctx.sessionId },
      create: { sessionId: ctx.sessionId, workspaceId: ctx.workspaceId, content: json },
      update: { content: json, generatedAt: new Date() },
    });
    return { status: 'COMPLETED', result: { sections: Object.keys(content).length } };
  }

  // ── 5. notify ──
  async notify(ctx: StepContext): Promise<StepOutcome> {
    const { session, config } = await this.load(ctx);
    if (!config.analysis.notifyOnComplete) return { status: 'SKIPPED', result: { reason: 'Notifications are off for this scenario version' } };
    const link = `/w/${ctx.workspaceId}/sessions/${session.id}`;
    const already = await this.prisma.notification.count({ where: { workspaceId: ctx.workspaceId, type: 'session.analyzed', link } });
    if (already > 0) return { status: 'COMPLETED', result: { alreadyNotified: true } };
    const members = await this.prisma.membership.findMany({
      where: { workspaceId: ctx.workspaceId, role: { in: ['OWNER', 'ADMIN', 'CREATOR', 'REVIEWER'] }, user: { deletedAt: null } },
      include: { user: { select: { id: true, email: true, name: true } } },
    });
    const who = session.participant.name || session.participant.email || 'A participant';
    const title = `Session analyzed: ${session.scenario.name}`;
    const body = `${who} completed "${session.scenario.name}". The report is ready to review.`;
    await this.prisma.notification.createMany({
      data: members.map((m) => ({ workspaceId: ctx.workspaceId, userId: m.userId, type: 'session.analyzed', title, body, link })),
    });
    let emailed = 0;
    for (const m of members) {
      try {
        await this.mail.send({
          to: m.user.email,
          subject: title,
          text: `${body}\n\nOpen the session: ${env.WEB_PUBLIC_URL}${link}\n`,
        });
        emailed++;
      } catch (e: any) {
        this.logger.warn(`Notification email to member ${m.userId} failed: ${e?.message}`);
      }
    }
    return { status: 'COMPLETED', result: { notified: members.length, emailed } };
  }
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
function clip(s: string, n: number) {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
