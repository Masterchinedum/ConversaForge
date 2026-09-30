import { renderTranscriptText } from './transcript-text';

describe('plain-text transcript', () => {
  const base = {
    scenarioName: 'Renewal negotiation',
    sessionId: 's_1',
    startedAt: new Date('2026-09-30T10:05:00Z'),
    createdAt: new Date('2026-09-30T10:00:00Z'),
    durationMs: 754_000,
    agentName: 'Alex',
    participantName: 'Casey',
  };

  it('labels agent/participant lines with names and offsets, and skips system turns', () => {
    const text = renderTranscriptText({
      ...base,
      meeting: { platform: 'google_meet', url: 'https://meet.google.com/abc-defg-hij', mode: 'agent' },
      turns: [
        { speaker: 'AGENT', text: 'Hi, thanks for\njoining.', startedAtMs: 3_000 },
        { speaker: 'SYSTEM', text: 'tool opened', startedAtMs: 4_000 },
        { speaker: 'PARTICIPANT', text: 'Happy to be here.', startedAtMs: 3_725_000 },
        { speaker: 'PARTICIPANT', text: '   ', startedAtMs: 3_726_000 },
      ],
    });
    expect(text.split('\n')).toEqual([
      'Renewal negotiation — transcript',
      '',
      'Date: 2026-09-30 10:05 UTC',
      'Duration: 12:34',
      'Meeting: Google Meet (AI agent) — https://meet.google.com/abc-defg-hij',
      'Speakers: Alex, Casey',
      'Session: s_1',
      '',
      '[0:03] Alex: Hi, thanks for joining.',
      '[1:02:05] Casey: Happy to be here.',
      '',
    ]);
  });

  it('uses meeting display names when present and says when nothing was captured', () => {
    const named = renderTranscriptText({ ...base, turns: [{ speaker: 'AGENT', text: 'Budget?', startedAtMs: null, speakerName: 'Dana' }] });
    expect(named).toContain('\nDana: Budget?\n');
    expect(named).not.toContain('Meeting:');
    expect(renderTranscriptText({ ...base, durationMs: null, turns: [] })).toContain('No transcript was captured.');
  });
});
