'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { SCENARIO_TYPE_LABELS, SCENARIO_TYPES } from '@cf/shared';
import { Badge, Input, Select } from '@/components/ui';
import type { GalleryCardData } from './types';

export function GalleryFilters({ onChange }: { onChange: (f: { q: string; type: string; tag: string }) => void }) {
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [tag, setTag] = useState('');
  useEffect(() => {
    const t = setTimeout(() => onChange({ q: q.trim(), type, tag: tag.trim().toLowerCase() }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, type, tag]);
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      <Input aria-label="Search" placeholder="Search…" className="max-w-xs" value={q} onChange={(e) => setQ(e.target.value)} />
      <Select aria-label="Type" className="w-48" value={type} onChange={(e) => setType(e.target.value)}>
        <option value="">All types</option>
        {SCENARIO_TYPES.map((t) => (
          <option key={t} value={t}>
            {SCENARIO_TYPE_LABELS[t]}
          </option>
        ))}
      </Select>
      <Input aria-label="Tag" placeholder="Tag" className="w-36" value={tag} onChange={(e) => setTag(e.target.value)} />
    </div>
  );
}

export function GalleryCard({ card, actions, href }: { card: GalleryCardData; actions?: ReactNode; href?: string }) {
  return (
    <article className="flex h-full flex-col rounded-lg border border-slate-200 bg-white p-4 shadow-sm" data-testid={`gallery-card-${card.id}`}>
      <div className="mb-1 flex flex-wrap items-center gap-1 text-xs">
        <Badge tone={card.kind === 'template' ? 'purple' : 'blue'}>{card.kind === 'template' ? 'Template' : card.typeLabel}</Badge>
        {card.kind === 'template' && <Badge tone="gray">{card.typeLabel}</Badge>}
        {card.isTemplate && <Badge tone="purple">Workspace template</Badge>}
        <span className="text-slate-500">~{card.durationMinutes} min</span>
      </div>
      <h3 className="text-sm font-semibold text-slate-900">{href ? <a href={href} className="hover:underline">{card.name}</a> : card.name}</h3>
      <p className="mt-1 flex-1 text-sm text-slate-600">{card.summary ?? card.publicDescription}</p>
      <p className="mt-2 text-xs text-slate-500">
        {card.personaName ? `With ${card.personaName}` : ''}
        {card.workspace ? `${card.personaName ? ' · ' : ''}by ${card.workspace.name}` : ''}
      </p>
      {card.tags.length > 0 && <p className="mt-1 text-xs text-slate-400">{card.tags.map((t) => `#${t}`).join(' ')}</p>}
      {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
    </article>
  );
}
