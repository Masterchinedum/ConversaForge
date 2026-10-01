'use client';
import { clsx } from '@/components/ui';
import type { ReactNode } from 'react';
import { brandStyle } from './branding';

export interface BrandingInfo {
  displayName?: string;
  logoUrl?: string;
  primaryColor?: string;
  hidePoweredBy?: boolean;
}

/** Page frame for participant screens: workspace branding, width, optional "powered by". */
export function LiveShell({
  branding,
  children,
  compact,
  wide,
}: {
  branding?: BrandingInfo | null;
  children: ReactNode;
  compact?: boolean;
  wide?: boolean;
}) {
  return (
    <div style={brandStyle(branding?.primaryColor)} className={clsx('flex min-h-[100dvh] flex-col bg-slate-50', compact && 'min-h-0')}>
      {!compact && (branding?.logoUrl || branding?.displayName) && (
        <header className="border-b border-slate-200 bg-white">
          <div className={clsx('mx-auto flex items-center gap-3 px-4 py-3', wide ? 'max-w-6xl' : 'max-w-2xl')}>
            {branding.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={branding.logoUrl} alt={branding.displayName ? `${branding.displayName} logo` : 'Logo'} className="h-7 w-auto max-w-[160px] object-contain" referrerPolicy="no-referrer" />
            )}
            {branding.displayName && <span className="text-sm font-semibold text-slate-800">{branding.displayName}</span>}
          </div>
        </header>
      )}
      <main className={clsx('mx-auto w-full flex-1', compact ? 'p-3' : 'px-4 py-6 sm:py-10', wide ? 'max-w-6xl' : 'max-w-2xl')}>
        {wide ? children : <div className={clsx('rounded-xl bg-white shadow-sm ring-1 ring-slate-200', compact ? 'p-4' : 'p-5 sm:p-8')}>{children}</div>}
      </main>
      {!branding?.hidePoweredBy && (
        <footer className={clsx('pb-4 text-center text-xs text-slate-500', compact && 'pb-2')}>
          Powered by <span className="font-medium text-slate-600">ConversaForge</span>
        </footer>
      )}
    </div>
  );
}

export function SimulatedBanner({ parts }: { parts?: string[] }) {
  return (
    <div role="note" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <span className="font-semibold">⚠ Simulated session.</span> Parts of this conversation
      {parts && parts.length ? ` (${parts.join(', ')})` : ''} are produced by a local development simulator, not a real AI
      provider. Responses are scripted and feedback will be labeled as simulated.
    </div>
  );
}

export function StatusScreen({
  title,
  children,
  tone = 'info',
  actions,
}: {
  title: string;
  children?: ReactNode;
  tone?: 'info' | 'error' | 'success';
  actions?: ReactNode;
}) {
  const icon = tone === 'error' ? '⚠' : tone === 'success' ? '✓' : 'ℹ';
  return (
    <div className="space-y-4 text-center" role={tone === 'error' ? 'alert' : 'status'}>
      <div
        aria-hidden
        className={clsx(
          'mx-auto flex h-12 w-12 items-center justify-center rounded-full text-xl',
          tone === 'error' ? 'bg-red-100 text-red-700' : tone === 'success' ? 'bg-emerald-100 text-emerald-700' : 'bg-brand-100 text-brand-700',
        )}
      >
        {icon}
      </div>
      <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
      {children && <div className="mx-auto max-w-md text-sm leading-relaxed text-slate-600">{children}</div>}
      {actions && <div className="flex flex-wrap justify-center gap-2 pt-2">{actions}</div>}
    </div>
  );
}
