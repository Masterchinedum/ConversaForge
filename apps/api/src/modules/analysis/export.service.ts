import { Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { formatExtractionValue } from './format';
import { ReviewService, type SessionListQuery } from './review.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { slugForFile, toCsv } from './csv';

type Detail = Awaited<ReturnType<ReviewService['detail']>>;

const FONT_CANDIDATES = [
  process.env.PDF_FONT_PATH,
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
];
const BOLD_CANDIDATES = [
  process.env.PDF_FONT_BOLD_PATH,
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
];
function firstExisting(paths: Array<string | undefined>) {
  return paths.find((p) => !!p && existsSync(p));
}

function mmss(ms: number | null | undefined) {
  if (ms == null) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function duration(ms: number | null | undefined) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

@Injectable()
export class ExportService {
  constructor(
    private readonly review: ReviewService,
    private readonly prisma: PrismaService,
  ) {}

  // ───────────────────────── CSV ─────────────────────────

  transcriptCsv(d: Detail): { fileName: string; body: string } {
    const rows: unknown[][] = d.turns.map((t) => [
      t.seq,
      t.speaker,
      t.startedAtMs,
      t.endedAtMs,
      mmss(t.startedAtMs),
      t.interrupted ? 'yes' : 'no',
      t.source ?? '',
      t.text,
    ]);
    const body = toCsv(['seq', 'speaker', 'started_at_ms', 'ended_at_ms', 'offset', 'interrupted', 'source', 'text'], rows);
    return { fileName: `transcript-${slugForFile(d.scenario.name)}-${d.session.id}.csv`, body };
  }

  /** Filtered session list with one column per rubric criterion and extraction key (current evaluations). */
  async sessionsCsv(workspaceId: string, q: SessionListQuery): Promise<{ fileName: string; body: string; count: number }> {
    const where = await this.review.buildWhere(workspaceId, q);
    const MAX_ROWS = 5000;
    const sessions = await this.prisma.session.findMany({
      where,
      include: {
        participant: { select: { name: true, email: true, externalId: true } },
        scenario: { select: { name: true } },
        scenarioVersion: { select: { version: true } },
        evaluations: { where: { isCurrent: true }, include: { criteria: true }, take: 1 },
        extractions: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_ROWS,
    });
    const criterionCols: string[] = [];
    const criterionIndex = new Map<string, string>(); // key → header
    const extractionCols: string[] = [];
    for (const s of sessions) {
      for (const c of s.evaluations[0]?.criteria ?? []) {
        const key = `${c.criterionId}`;
        if (!criterionIndex.has(key)) {
          criterionIndex.set(key, `score:${c.name}`);
          criterionCols.push(key);
        }
      }
      for (const x of s.extractions) if (!extractionCols.includes(x.key)) extractionCols.push(x.key);
    }
    extractionCols.sort();
    const header = [
      'session_id',
      'created_at',
      'participant_name',
      'participant_email',
      'participant_external_id',
      'scenario',
      'version',
      'channel',
      'state',
      'duration_seconds',
      'analysis_status',
      'overall_score',
      'insufficient_evidence',
      'simulated',
      'human_review_required',
      'reviewed_at',
      ...criterionCols.map((k) => criterionIndex.get(k)!),
      ...extractionCols.map((k) => `extract:${k}`),
    ];
    const rows = sessions.map((s) => {
      const ev = s.evaluations[0];
      const byCrit = new Map((ev?.criteria ?? []).map((c) => [c.criterionId, c]));
      const byKey = new Map(s.extractions.map((x) => [x.key, x]));
      return [
        s.id,
        s.createdAt,
        s.participant.name,
        s.participant.email,
        s.participant.externalId,
        s.scenario.name,
        s.scenarioVersion.version,
        s.channel,
        s.state,
        s.durationMs == null ? '' : Math.round(s.durationMs / 1000),
        s.analysisStatus,
        ev?.overallScore ?? '',
        ev ? (ev.insufficientEvidence ? 'yes' : 'no') : '',
        ev ? (ev.simulated ? 'yes' : 'no') : '',
        ev ? (ev.humanReviewRequired ? 'yes' : 'no') : '',
        ev?.reviewedAt ?? '',
        ...criterionCols.map((k) => {
          const c = byCrit.get(k);
          return !c ? '' : c.score === null ? 'insufficient evidence' : c.score;
        }),
        ...extractionCols.map((k) => {
          const x = byKey.get(k);
          return x ? formatExtractionValue(x.value) : '';
        }),
      ];
    });
    const date = new Date().toISOString().slice(0, 10);
    return { fileName: `sessions-${date}.csv`, body: toCsv(header, rows), count: sessions.length };
  }

  // ───────────────────────── PDF ─────────────────────────

  async sessionPdf(d: Detail): Promise<{ fileName: string; body: Buffer }> {
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, info: { Title: `Session report — ${d.scenario.name}` } });
    const regular = firstExisting(FONT_CANDIDATES);
    const bold = firstExisting(BOLD_CANDIDATES);
    if (regular) doc.registerFont('body', regular);
    if (bold) doc.registerFont('bold', bold);
    const fontBody = regular ? 'body' : 'Helvetica';
    const fontBold = bold ? 'bold' : 'Helvetica-Bold';
    // Standard fonts only cover WinAnsi; replace what they cannot draw.
    const t = (s: unknown) => {
      const str = s == null ? '' : String(s);
      return regular ? str : str.replace(/[^\x09\x0a\x0d\x20-\x7e -ÿ–—‘’“”•…]/g, '?');
    };
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    const ev = d.evaluation;
    const simulated = !!ev?.simulated || d.extraction.some((x) => x.simulated);
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const left = doc.page.margins.left;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const ensure = (h: number) => {
      if (doc.y + h > bottom()) doc.addPage();
    };
    const h1 = (s: string) => {
      ensure(40);
      doc.moveDown(0.6).font(fontBold).fontSize(14).fillColor('#0f172a').text(t(s), left, doc.y, { width });
      doc.moveDown(0.3);
    };
    const para = (s: string, opts: { color?: string; size?: number; bold?: boolean } = {}) => {
      doc
        .font(opts.bold ? fontBold : fontBody)
        .fontSize(opts.size ?? 10)
        .fillColor(opts.color ?? '#1e293b')
        .text(t(s), left, doc.y, { width });
    };
    const bullets = (items: unknown) => {
      const list = Array.isArray(items) ? items.map(String).filter(Boolean) : [];
      if (!list.length) return para('—', { color: '#64748b' });
      for (const it of list) {
        ensure(20);
        doc.font(fontBody).fontSize(10).fillColor('#1e293b').text(t(`•  ${it}`), left + 8, doc.y, { width: width - 8 });
      }
    };

    // Header
    doc.font(fontBold).fontSize(18).fillColor('#0f172a').text(t('Session report'), left, 50, { width });
    doc.moveDown(0.2);
    para(`${d.scenario.name} — version v${d.version.number}`, { size: 12, bold: true });
    doc.moveDown(0.4);
    const participant = [d.participant.name, d.participant.email, d.participant.externalId ? `ID ${d.participant.externalId}` : null].filter(Boolean).join(' · ') || 'Anonymous participant';
    const meta: Array<[string, string]> = [
      ['Participant', participant],
      ['Date', d.session.startedAt ? new Date(d.session.startedAt).toUTCString() : new Date(d.session.createdAt).toUTCString()],
      ['Channel', d.session.channel],
      ['Outcome', `${d.session.state}${d.session.endedBy ? ` (ended by ${d.session.endedBy})` : ''}`],
      ['Duration', duration(d.session.durationMs)],
      ['Scenario version id', d.version.id],
      ['Session id', d.session.id],
    ];
    for (const [k, v] of meta) {
      doc.font(fontBold).fontSize(9).fillColor('#475569').text(t(`${k}:`), left, doc.y, { continued: true, width });
      doc.font(fontBody).fillColor('#1e293b').text(t(` ${v}`));
    }
    if (simulated) {
      doc.moveDown(0.5);
      const y = doc.y;
      doc.rect(left, y, width, 34).fill('#fef3c7');
      doc
        .font(fontBold)
        .fontSize(10)
        .fillColor('#92400e')
        .text(t('SIMULATED — produced by the local development simulator (no AI provider configured). Not an AI assessment.'), left + 8, y + 6, {
          width: width - 16,
        });
      doc.y = y + 40;
    }

    // Overall
    h1('Overall result');
    if (!ev) {
      para(d.processing.status === 'SKIPPED' ? `Not analyzed: ${d.session.analysisError ?? 'analysis skipped'}` : `No evaluation available (analysis status: ${d.processing.status}).`, { color: '#64748b' });
    } else {
      if (ev.overallScore === null) {
        para('Not enough evidence to score', { size: 16, bold: true, color: '#92400e' });
        para(
          `The transcript contained evidence for criteria covering ${Math.round((ev.coverage ?? 0) * 100)}% of the rubric weight, below the ${Math.round(d.rubric.minEvidenceCoverage * 100)}% required for an overall score.`,
          { color: '#475569' },
        );
      } else {
        para(`${Math.round(ev.overallScore)} / 100`, { size: 20, bold: true, color: '#0f172a' });
        para(
          `Weighted over criteria with sufficient evidence (${Math.round((ev.coverage ?? 0) * 100)}% of rubric weight). ${
            (ev.coverage ?? 0) < 1 ? 'Criteria without enough evidence were excluded, which adds uncertainty.' : ''
          }${ev.passed === null ? '' : ev.passed ? ` Meets the passing score of ${d.rubric.passingScore}.` : ` Below the passing score of ${d.rubric.passingScore}.`}`,
          { color: '#475569' },
        );
      }
      if (ev.humanReviewRequired) {
        doc.moveDown(0.3);
        para(
          ev.reviewedAt
            ? `Human review completed ${new Date(ev.reviewedAt).toUTCString()}${ev.reviewedBy ? ` by ${ev.reviewedBy.name ?? ev.reviewedBy.email}` : ''}.`
            : 'Advisory result — a human reviewer must confirm this assessment before it is used for decisions.',
          { bold: true, color: ev.reviewedAt ? '#065f46' : '#92400e' },
        );
      }
      doc.moveDown(0.3);
      para(`Evaluated by ${ev.simulated ? 'local simulator' : `${ev.provider ?? ''} ${ev.model ?? ''}`.trim()} · prompt ${ev.promptVersion ?? ''}`, {
        size: 8,
        color: '#94a3b8',
      });

      // Criteria table
      h1('Criteria');
      const cols = [
        { label: 'Criterion', w: width * 0.46 },
        { label: 'Weight', w: width * 0.14 },
        { label: 'Score', w: width * 0.22 },
        { label: 'Confidence', w: width * 0.18 },
      ];
      const row = (cells: string[], header = false) => {
        doc.font(header ? fontBold : fontBody).fontSize(9);
        const hgt = Math.max(...cells.map((c, i) => doc.heightOfString(t(c), { width: cols[i]!.w - 6 }))) + 6;
        ensure(hgt);
        const y = doc.y;
        if (header) doc.rect(left, y, width, hgt).fill('#f1f5f9');
        let x = left;
        cells.forEach((c, i) => {
          doc.font(header ? fontBold : fontBody).fontSize(9).fillColor('#1e293b').text(t(c), x + 3, y + 3, { width: cols[i]!.w - 6 });
          x += cols[i]!.w;
        });
        doc.y = y + hgt;
        doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
      };
      row(cols.map((c) => c.label), true);
      for (const c of ev.criteria) {
        row([
          c.name,
          `${c.weight}%`,
          c.score === null ? 'Insufficient evidence' : `${Math.round(c.score)} / 100`,
          c.confidence == null ? '—' : `${Math.round(c.confidence * 100)}%`,
        ]);
      }

      for (const c of ev.criteria) {
        ensure(60);
        doc.moveDown(0.6);
        para(`${c.name} (${c.weight}%) — ${c.score === null ? 'insufficient evidence' : `${Math.round(c.score)}/100`}`, { bold: true, size: 10 });
        if (c.rationale) para(c.rationale, { color: '#334155', size: 9 });
        const evidence = Array.isArray(c.evidence) ? (c.evidence as Array<{ turnSeq: number; quote: string }>) : [];
        for (const e of evidence) {
          ensure(20);
          doc.font(fontBody).fontSize(9).fillColor('#475569').text(t(`[turn ${e.turnSeq}] “${e.quote}”`), left + 12, doc.y, { width: width - 12 });
        }
      }

      h1('Summary');
      para(ev.summary ?? '—');
      h1('Strengths');
      bullets(ev.strengths);
      h1('Areas to improve');
      bullets(ev.weaknesses);
      h1('Practical next steps');
      bullets(ev.improvements);
    }

    // Extraction
    if (d.extraction.length) {
      h1('Extracted data');
      for (const x of d.extraction) {
        ensure(24);
        doc.font(fontBold).fontSize(9).fillColor('#1e293b').text(t(`${x.key} (${x.type}): `), left, doc.y, { continued: true, width });
        doc
          .font(fontBody)
          .fillColor(x.valid ? '#1e293b' : '#b91c1c')
          .text(t(`${x.value === null ? 'not found' : formatExtractionValue(x.value)}${x.valid ? '' : `  — invalid: ${x.errors.join('; ')}`}`));
      }
    }

    // Transcript
    h1('Transcript');
    if (!d.turns.length) para('No transcript was captured.', { color: '#64748b' });
    for (const turn of d.turns) {
      const label = `[${turn.seq}] ${turn.speaker}${turn.startedAtMs != null ? ` (${mmss(turn.startedAtMs)})` : ''}${turn.interrupted ? ' — interrupted' : ''}: `;
      doc.font(fontBody).fontSize(9);
      ensure(Math.min(120, doc.heightOfString(t(label + turn.text), { width }) + 4));
      doc
        .font(fontBold)
        .fontSize(9)
        .fillColor(turn.speaker === 'PARTICIPANT' ? '#1d4ed8' : '#334155')
        .text(t(label), left, doc.y, { continued: true, width });
      doc.font(fontBody).fillColor('#1e293b').text(t(turn.text));
      doc.moveDown(0.2);
    }

    // Footer + watermark on every page
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      if (simulated) {
        doc.save();
        doc.rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] });
        doc
          .font(fontBold)
          .fontSize(64)
          .fillColor('#f59e0b')
          .fillOpacity(0.12)
          .text('SIMULATED', 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center', lineBreak: false });
        doc.restore();
        doc.fillOpacity(1);
      }
      const savedBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0; // writing in the margin must not trigger a page break
      const footer = `ConversaForge · ${d.scenario.name} v${d.version.number} · session ${d.session.id} · page ${i + 1} of ${range.count}`;
      doc
        .font(fontBody)
        .fontSize(7)
        .fillColor('#94a3b8')
        .text(t(footer), left, doc.page.height - 35, { width, align: 'center', lineBreak: false, height: 10 });
      doc.page.margins.bottom = savedBottom;
    }
    doc.end();
    const body = await done;
    return { fileName: `session-report-${slugForFile(d.scenario.name)}-${d.session.id}.pdf`, body };
  }
}
