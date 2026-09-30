/**
 * Plain-text transcript for download ("[0:12] Alex: …"), readable in any editor and easy to paste.
 * Meeting notetaker turns carry the real display name in `speakerName`; otherwise the agent line is
 * labelled with the persona and the participant line with the participant's name.
 */
export interface TranscriptTextTurn {
  speaker: string;
  text: string;
  startedAtMs: number | null;
  speakerName?: string | null;
}

export interface TranscriptTextInput {
  scenarioName: string;
  sessionId: string;
  startedAt: Date | null;
  createdAt: Date;
  durationMs: number | null;
  agentName: string;
  participantName: string;
  meeting?: { platform: string | null; url: string | null; mode: string | null } | null;
  turns: TranscriptTextTurn[];
}

const PLATFORM: Record<string, string> = { zoom: 'Zoom', google_meet: 'Google Meet', microsoft_teams: 'Microsoft Teams' };

function clock(ms: number | null) {
  if (ms == null) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function when(d: Date) {
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function renderTranscriptText(o: TranscriptTextInput): string {
  const label = (t: TranscriptTextTurn) => t.speakerName?.trim() || (t.speaker === 'AGENT' ? o.agentName : o.participantName);
  const turns = o.turns.filter((t) => (t.speaker === 'AGENT' || t.speaker === 'PARTICIPANT') && t.text.trim());
  const speakers = [...new Set(turns.map(label))];

  const head = [`${o.scenarioName} — transcript`, '', `Date: ${when(o.startedAt ?? o.createdAt)}`];
  if (o.durationMs != null) head.push(`Duration: ${clock(o.durationMs)}`);
  if (o.meeting) {
    const platform = o.meeting.platform ? PLATFORM[o.meeting.platform] ?? o.meeting.platform : 'Meeting';
    head.push(`Meeting: ${platform}${o.meeting.mode === 'agent' ? ' (AI agent)' : o.meeting.mode === 'notetaker' ? ' (notetaker)' : ''}${o.meeting.url ? ` — ${o.meeting.url}` : ''}`);
  }
  if (speakers.length) head.push(`Speakers: ${speakers.join(', ')}`);
  head.push(`Session: ${o.sessionId}`, '');

  const body = turns.length
    ? turns.map((t) => {
        const at = clock(t.startedAtMs);
        return `${at ? `[${at}] ` : ''}${label(t)}: ${t.text.trim().replace(/\s*\n\s*/g, ' ')}`;
      })
    : ['No transcript was captured.'];
  return [...head, ...body, ''].join('\n');
}
