import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Gallery', description: 'Public AI conversation practice scenarios and templates.' };

export default function GalleryLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link href="/gallery" className="font-bold text-brand-700">
            ConversaForge <span className="font-normal text-slate-500">Gallery</span>
          </Link>
          <Link href="/app" className="text-sm text-slate-700 hover:underline">
            Open app
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
