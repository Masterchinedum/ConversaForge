'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useWorkspace } from '@/lib/workspace';
import { useToast } from '@/components/ui';
import { Icon, type IconName } from './icons';
import { MeetingPracticeModal } from './meeting-practice';

/** Where a scenario can run: embed/API, phone, meeting bot. */
export function ChannelCards({ scenarioId, published, meetingEnabled, personaName }: { scenarioId: string; published: boolean; meetingEnabled: boolean; personaName: string }) {
  const { href, wsPath, can } = useWorkspace();
  const toast = useToast();
  const [meetingOpen, setMeetingOpen] = useState(false);
  const card = 'flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-brand-300 hover:shadow';
  const body = (icon: IconName, tint: string, title: string, sub: string) => (
    <>
      <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${tint}`}>
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-slate-900">{title}</span>
        <span className="block text-xs text-slate-500">{sub}</span>
      </span>
    </>
  );
  return (
    <div data-testid="channel-cards">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Channels</p>
      <div className="grid gap-3 md:grid-cols-3">
        <Link href={href(`/scenarios/${scenarioId}/access`)} className={card}>
          {body('code', 'bg-sky-50 text-sky-700', 'Integrate', 'Embed via iframe or API.')}
        </Link>
        {can('channels.manage') ? (
          <Link href={href('/channels')} className={card}>
            {body('phone', 'bg-emerald-50 text-emerald-700', 'Phone Call', 'Run over a phone call.')}
          </Link>
        ) : (
          <button type="button" className={card} onClick={() => toast.info('Ask an admin to connect a phone number (Phone & meetings).')}>
            {body('phone', 'bg-emerald-50 text-emerald-700', 'Phone Call', 'Run over a phone call.')}
          </button>
        )}
        <button
          type="button"
          className={card}
          onClick={() => {
            if (!published) toast.info('Create the scenario first, then send it to a meeting.');
            else if (!meetingEnabled) toast.info('Turn on Channels → Meeting bot in Scenario Studio (Advanced settings), then save your changes.');
            else setMeetingOpen(true);
          }}
        >
          {body('video', 'bg-teal-50 text-teal-700', 'Meeting Bot', 'Deploy to Google Meet or Zoom calls.')}
        </button>
      </div>
      <MeetingPracticeModal open={meetingOpen} onClose={() => setMeetingOpen(false)} wsPath={wsPath} scenarioId={scenarioId} personaName={personaName} />
    </div>
  );
}
