'use client';
/** "Practice in a meeting": the scenario's AI persona joins the member's Zoom / Google Meet / Teams call. */
import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import { api, download, errorMessage } from '@/lib/api';
import { Alert, Badge, Button, Field, Input, Modal } from '@/components/ui';

export interface PracticeBot {
  id: string;
  status: 'SCHEDULED' | 'JOINING' | 'IN_CALL' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'BLOCKED';
  platform: 'zoom' | 'google_meet' | 'microsoft_teams' | null;
  botName: string | null;
  sessionId: string | null;
  lastError: string | null;
  scheduledAt: string | null;
  lastEventAt?: string | null;
  /** AI agent bots: whether Recall's browser opened the bot page (null for notetakers). */
  pageLoaded?: boolean | null;
  botPageOrigin?: string | null;
}

const ACTIVE = new Set(['SCHEDULED', 'JOINING', 'IN_CALL']);
const PLATFORM: Record<string, string> = { zoom: 'Zoom', google_meet: 'Google Meet', microsoft_teams: 'Teams' };
const TONE: Record<PracticeBot['status'], 'gray' | 'blue' | 'green' | 'red' | 'yellow'> = {
  SCHEDULED: 'gray',
  JOINING: 'blue',
  IN_CALL: 'green',
  COMPLETED: 'green',
  FAILED: 'red',
  CANCELLED: 'gray',
  BLOCKED: 'yellow',
};

export function MeetingPracticeModal({
  open,
  onClose,
  wsPath,
  scenarioId,
  personaName,
}: {
  open: boolean;
  onClose: () => void;
  wsPath: (p: string) => string;
  scenarioId: string;
  personaName: string;
}) {
  const base = wsPath(`/scenarios/${scenarioId}/meeting-bots`);
  const [meetingUrl, setMeetingUrl] = useState('');
  const [joinAt, setJoinAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [botId, setBotId] = useState<string | null>(null);
  const bot = useSWR<PracticeBot>(botId ? `${base}/${botId}` : null, {
    refreshInterval: (b) => (!b || ACTIVE.has(b.status) ? 3000 : 0),
  });
  const b = bot.data;
  const who = b?.botName || personaName || 'the AI agent';

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<PracticeBot>(base, { method: 'POST', body: { meetingUrl: meetingUrl.trim(), ...(joinAt ? { joinAt: new Date(joinAt).toISOString() } : {}) } });
      setBotId(r.id);
      await bot.mutate(r, { revalidate: false });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!botId) return;
    setBusy(true);
    try {
      await bot.mutate(await api<PracticeBot>(`${base}/${botId}/cancel`, { method: 'POST' }), { revalidate: false });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setBotId(null);
    setError(null);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Practice in a meeting"
      footer={
        !b ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={send} loading={busy} disabled={meetingUrl.trim().length < 10}>
              Send {personaName || 'agent'} to the meeting
            </Button>
          </>
        ) : ACTIVE.has(b.status) ? (
          <Button variant="secondary" onClick={cancel} loading={busy}>
            Remove from meeting
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={reset}>
              Try another meeting
            </Button>
            <Button onClick={onClose}>Done</Button>
          </>
        )
      }
    >
      {!b ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            Start a Zoom, Google Meet or Teams meeting (for example at meet.new), paste its link, and {personaName || 'the AI agent'} joins as a participant and plays the scenario with you
            by voice. When the meeting ends you get the usual feedback report.
          </p>
          <Field label="Meeting link" required>
            {(id) => <Input id={id} placeholder="https://meet.google.com/abc-defg-hij" value={meetingUrl} onChange={(e) => setMeetingUrl(e.target.value)} autoFocus />}
          </Field>
          <Field label="Join at (optional)" hint="Leave empty to join now. At most 20 hours ahead.">
            {(id) => <Input id={id} type="datetime-local" value={joinAt} onChange={(e) => setJoinAt(e.target.value)} />}
          </Field>
          {error && <Alert tone="error">{error}</Alert>}
        </div>
      ) : (
        <div className="space-y-3 text-sm text-slate-700" aria-live="polite">
          <div className="flex items-center gap-2">
            <Badge tone={TONE[b.status]}>{b.status.replace('_', ' ').toLowerCase()}</Badge>
            {b.platform && <span className="text-slate-500">{PLATFORM[b.platform]}</span>}
          </div>
          {b.status === 'SCHEDULED' && <p>{who} will join {b.scheduledAt ? `at ${new Date(b.scheduledAt).toLocaleString()}` : 'in a moment'}.</p>}
          {b.status === 'JOINING' && (
            <p>
              {who} is joining. If your meeting has a lobby or waiting room, <strong>admit “{who}”</strong>.
            </p>
          )}
          {b.status === 'IN_CALL' && <p>{who} is in the meeting and will greet you in a moment.</p>}
          {b.status === 'IN_CALL' && b.pageLoaded === false && b.lastEventAt && Date.now() - new Date(b.lastEventAt).getTime() > 20_000 && (
            <Alert tone="warning" title="The bot is in the meeting but cannot open its page">
              It opens {b.botPageOrigin ?? 'the web app'}/bot/… to speak, and that page has not loaded. If you use a tunnel (ngrok, cloudflared), check that it is running and that WEB_PUBLIC_URL is its current address, then remove the bot and send it again.
            </Alert>
          )}
          {b.status === 'COMPLETED' && (
            <div className="space-y-2">
              <p>
                The practice session is over.{' '}
                {b.sessionId && (
                  <Link className="text-brand-700 hover:underline" href={`/report/${b.sessionId}`}>
                    Open your feedback report
                  </Link>
                )}
              </p>
              {b.sessionId && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => download(`/me/sessions/${b.sessionId}/transcript.txt`, `transcript-${b.sessionId}.txt`).catch((e) => setError(errorMessage(e)))}
                >
                  Download transcript
                </Button>
              )}
            </div>
          )}
          {b.status === 'CANCELLED' && <p>{who} was removed from the meeting.</p>}
          {(b.status === 'FAILED' || b.status === 'BLOCKED') && (
            <Alert tone={b.status === 'BLOCKED' ? 'warning' : 'error'} title={b.status === 'BLOCKED' ? 'Meeting bots are not set up' : 'The bot could not join'}>
              {b.lastError}
            </Alert>
          )}
          {error && <Alert tone="error">{error}</Alert>}
        </div>
      )}
    </Modal>
  );
}
