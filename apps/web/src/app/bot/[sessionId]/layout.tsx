import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Meeting agent',
  // Opened only by the meeting bot's browser: private, never indexed, no Referer.
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function BotLayout({ children }: { children: React.ReactNode }) {
  return children;
}
