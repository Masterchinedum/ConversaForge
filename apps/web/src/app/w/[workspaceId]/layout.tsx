'use client';
import clsx from 'clsx';
import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { Capability } from '@cf/shared';
import { VerifyEmailBanner } from '@/components/account/VerifyEmailBanner';
import { Loading } from '@/components/ui';
import { api } from '@/lib/api';
import { makeWorkspaceCtx, useMe, WorkspaceContext } from '@/lib/workspace';

type NavItem = { href: string; label: string; cap?: Capability; exact?: boolean };
type NavGroup = { title?: string; items: NavItem[] };

const NAV: NavGroup[] = [
  {
    items: [
      { href: '/', label: 'Dashboard', exact: true },
      { href: '/learn', label: 'My learning' },
    ],
  },
  {
    title: 'Build',
    items: [
      { href: '/scenarios', label: 'Scenarios', cap: 'scenarios.edit' },
      { href: '/gallery', label: 'Gallery & templates' },
      { href: '/courses', label: 'Courses', cap: 'sessions.review' }, // reviewers get a read-only view of learner progress
      { href: '/knowledge', label: 'Knowledge', cap: 'knowledge.manage' },
    ],
  },
  {
    title: 'Review',
    items: [
      { href: '/sessions', label: 'Sessions', cap: 'sessions.review' },
      { href: '/analytics', label: 'Analytics', cap: 'analytics.view' },
      { href: '/coach', label: 'Coach memory', cap: 'memory.manage' },
    ],
  },
  {
    title: 'Organization',
    items: [
      { href: '/settings/members', label: 'Members & teams', cap: 'members.manage' },
      { href: '/settings', label: 'Settings', cap: 'workspace.manage', exact: true },
      { href: '/settings/branding', label: 'Branding', cap: 'branding.manage' },
      { href: '/settings/usage', label: 'Usage & quotas', cap: 'usage.view' },
      { href: '/settings/providers', label: 'AI providers', cap: 'providers.manage' },
      { href: '/settings/functions', label: 'Custom functions', cap: 'providers.manage' },
      { href: '/channels', label: 'Phone & meetings', cap: 'channels.manage' },
      { href: '/settings/developer', label: 'API & webhooks', cap: 'apikeys.manage' },
      { href: '/settings/audit', label: 'Audit log', cap: 'audit.view' },
      { href: '/settings/privacy', label: 'Privacy & retention', cap: 'workspace.manage' },
    ],
  },
];

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const pathname = usePathname();
  const router = useRouter();
  const { data: me, error, mutate: refreshMe } = useMe();
  const [menuOpen, setMenuOpen] = useState(false);
  const ctx = useMemo(() => (me ? makeWorkspaceCtx(me, workspaceId) : null), [me, workspaceId]);
  // A workspace missing from a cached /auth/me may have just been joined or created: re-check once before "not found".
  const [recheckedFor, setRecheckedFor] = useState<string | null>(null);
  useEffect(() => {
    if (me && !ctx && recheckedFor !== workspaceId) void refreshMe().finally(() => setRecheckedFor(workspaceId));
  }, [me, ctx, workspaceId, recheckedFor, refreshMe]);

  useEffect(() => {
    if (error) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [error, pathname, router]);
  useEffect(() => {
    if (ctx) {
      try {
        localStorage.setItem('cf:lastWorkspace', ctx.workspaceId);
      } catch {
        /* ignore */
      }
    }
  }, [ctx]);
  useEffect(() => setMenuOpen(false), [pathname]);

  if (!me || (!ctx && recheckedFor !== workspaceId)) return <Loading />;
  if (!ctx)
    return (
      <main className="mx-auto max-w-lg px-4 py-16 text-center">
        <h1 className="text-lg font-semibold">Workspace not found</h1>
        <p className="mt-2 text-sm text-slate-600">It may not exist, or you are not a member.</p>
        <Link href="/app" className="mt-4 inline-block text-brand-700 hover:underline">
          Go to my workspace
        </Link>
      </main>
    );

  const base = `/w/${workspaceId}`;
  const isActive = (item: NavItem) => {
    const full = item.href === '/' ? base : base + item.href;
    return item.exact ? pathname === full : pathname === full || pathname.startsWith(full + '/');
  };

  const sidebar = (
    <nav aria-label="Workspace" className="flex h-full flex-col gap-4 overflow-y-auto p-3">
      <div>
        <label htmlFor="ws-switch" className="sr-only">
          Switch workspace
        </label>
        <select
          id="ws-switch"
          className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
          value={workspaceId}
          onChange={(e) => (e.target.value === '__new' ? router.push('/w/new') : router.push(`/w/${e.target.value}`))}
        >
          {me.workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
          <option value="__new">+ New organization…</option>
        </select>
        <p className="mt-1 px-1 text-xs text-slate-500">Role: {ctx.role.toLowerCase()}</p>
      </div>
      {NAV.map((g, i) => {
        const items = g.items.filter((it) => !it.cap || ctx.can(it.cap));
        if (!items.length) return null;
        return (
          <div key={i}>
            {g.title && <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{g.title}</p>}
            <ul className="space-y-0.5">
              {items.map((it) => (
                <li key={it.href}>
                  <Link
                    href={it.href === '/' ? base : base + it.href}
                    aria-current={isActive(it) ? 'page' : undefined}
                    className={clsx(
                      'block rounded-md px-2 py-1.5 text-sm',
                      isActive(it) ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-700 hover:bg-slate-100',
                    )}
                  >
                    {it.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <div className="mt-auto border-t border-slate-200 pt-3 text-sm">
        <p className="truncate px-2 text-slate-700">{me.user.name ?? me.user.email}</p>
        <p className="truncate px-2 text-xs text-slate-500">{me.user.email}</p>
        <div className="mt-2 flex gap-3 px-2">
          <Link href="/account" className="text-xs text-slate-600 hover:underline">
            Account
          </Link>
          <button
            className="text-xs text-slate-600 hover:underline"
            onClick={async () => {
              await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
              window.location.href = '/login';
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    </nav>
  );

  return (
    <WorkspaceContext.Provider value={ctx}>
      <div className="min-h-screen lg:flex">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">
          Skip to content
        </a>
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2 lg:hidden">
          <Link href={base} className="font-bold text-brand-700">
            ConversaForge
          </Link>
          <button className="rounded border border-slate-300 px-2 py-1 text-sm" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
            Menu
          </button>
        </header>
        {menuOpen && <div className="border-b border-slate-200 bg-white lg:hidden">{sidebar}</div>}
        <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white lg:block">
          <div className="sticky top-0 h-screen">
            <Link href={base} className="block px-5 pt-4 text-lg font-bold text-brand-700">
              ConversaForge
            </Link>
            <div className="h-[calc(100vh-3rem)]">{sidebar}</div>
          </div>
        </aside>
        <main id="main" className="min-w-0 flex-1 px-4 py-6 lg:px-8">
          {me.user.emailVerifiedAt === null && <VerifyEmailBanner email={me.user.email} />}
          {children}
        </main>
      </div>
    </WorkspaceContext.Provider>
  );
}
