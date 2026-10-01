'use client';
import { clsx } from '@/components/ui';
import type { ClientRuntimeConfig } from '@cf/shared';
import { initials, parseColor } from './branding';

export function AgentAvatar({
  persona,
  speaking = false,
  size = 'lg',
}: {
  persona: ClientRuntimeConfig['persona'];
  speaking?: boolean;
  size?: 'sm' | 'md' | 'lg';
}) {
  const dim = { sm: 'h-10 w-10 text-sm', md: 'h-16 w-16 text-lg', lg: 'h-24 w-24 text-2xl sm:h-28 sm:w-28' }[size];
  const accent = parseColor(persona.avatar?.accentColor);
  const bg = accent ? `rgb(${accent.join(' ')})` : undefined;
  const name = persona.name || 'AI agent';
  return (
    <div className="relative inline-flex items-center justify-center" aria-hidden>
      {speaking && (
        <>
          <span
            className={clsx('absolute inset-0 rounded-full bg-brand-500/30 motion-safe:animate-ping', dim)}
            style={{ animationDuration: '1.6s' }}
          />
          <span className={clsx('absolute -inset-1.5 rounded-full ring-4 ring-brand-500/60', dim)} />
        </>
      )}
      {persona.avatar?.kind === 'image' && persona.avatar.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={persona.avatar.imageUrl}
          alt=""
          referrerPolicy="no-referrer"
          className={clsx('relative rounded-full object-cover shadow', dim)}
        />
      ) : (
        <span
          className={clsx('relative flex items-center justify-center rounded-full font-semibold text-white shadow', dim, !bg && 'bg-brand-600')}
          style={bg ? { backgroundColor: bg } : undefined}
        >
          {persona.avatar?.kind === 'none' ? 'AI' : initials(name)}
        </span>
      )}
    </div>
  );
}
