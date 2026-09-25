import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Conversation',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return children;
}
