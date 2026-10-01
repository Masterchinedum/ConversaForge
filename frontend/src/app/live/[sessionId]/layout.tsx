import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Conversation',
  // Session pages are private: keep them out of search engines and don't leak the URL via Referer.
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function LiveLayout({ children }: { children: React.ReactNode }) {
  return children;
}
