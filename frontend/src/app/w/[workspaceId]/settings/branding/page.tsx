'use client';
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { UPLOAD_LIMITS } from '@cf/shared';
import { Alert, Button, Card, Checkbox, ErrorState, Field, Input, Loading, PageHeader, Textarea, useToast } from '@/components/ui';
import { brandStyle } from '@/components/live/branding';
import { api, errorMessage } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';

interface Branding {
  workspaceName: string;
  displayName: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
  supportEmail: string | null;
  emailFooter: string | null;
  hidePoweredBy: boolean;
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const ACCEPT = ['image/png', 'image/jpeg', 'image/webp'];

export default function BrandingPage() {
  const { wsPath, can } = useWorkspace();
  const toast = useToast();
  const { data, error, mutate } = useSWR<Branding>(wsPath('/branding'));
  const [f, setF] = useState({ displayName: '', primaryColor: '', accentColor: '', supportEmail: '', emailFooter: '', hidePoweredBy: false });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const editable = can('branding.manage');

  useEffect(() => {
    if (data)
      setF({
        displayName: data.displayName ?? '',
        primaryColor: data.primaryColor ?? '',
        accentColor: data.accentColor ?? '',
        supportEmail: data.supportEmail ?? '',
        emailFooter: data.emailFooter ?? '',
        hidePoweredBy: data.hidePoweredBy,
      });
  }, [data]);

  if (error) return <ErrorState error={error} retry={() => mutate()} />;
  if (!data) return <Loading />;

  const colorError = (v: string) => (v && !HEX.test(v) ? 'Use a hex color like #4f46e5' : undefined);
  const invalid = !!colorError(f.primaryColor) || !!colorError(f.accentColor);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api(wsPath('/branding'), {
        method: 'PATCH',
        body: {
          displayName: f.displayName.trim() || null,
          primaryColor: f.primaryColor || null,
          accentColor: f.accentColor || null,
          supportEmail: f.supportEmail.trim() || null,
          emailFooter: f.emailFooter.trim() || null,
          hidePoweredBy: f.hidePoweredBy,
        },
      });
      await mutate();
      toast.success('Branding saved');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const upload = async (file: File) => {
    if (!ACCEPT.includes(file.type)) return toast.error('Use a PNG, JPEG or WebP image (SVG is not accepted).');
    if (file.size > UPLOAD_LIMITS.branding.maxBytes) return toast.error('The logo must be at most 2 MB.');
    const fd = new FormData();
    fd.append('file', file);
    setUploading(true);
    try {
      await api(wsPath('/branding/logo'), { method: 'POST', body: fd });
      await mutate();
      toast.success('Logo uploaded');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const shownName = f.displayName.trim() || data.workspaceName;

  return (
    <div>
      <PageHeader title="Branding" description="How participant pages, invitations and emails look for this workspace." />
      {!editable && <Alert tone="info">Only admins can change branding.</Alert>}
      <div className="grid gap-6 lg:grid-cols-2">
        <form onSubmit={save} className="space-y-4">
          <Card title="Logo">
            <div className="flex items-center gap-4">
              <div className="flex h-16 w-40 items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50">
                {data.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={data.logoUrl} alt="Current logo" className="max-h-14 max-w-[150px] object-contain" />
                ) : (
                  <span className="text-xs text-slate-400">No logo</span>
                )}
              </div>
              {editable && (
                <div className="space-y-2">
                  <input ref={fileRef} type="file" accept={ACCEPT.join(',')} className="sr-only" id="logo-file" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
                  <Button variant="secondary" size="sm" loading={uploading} onClick={() => fileRef.current?.click()}>
                    Upload logo
                  </Button>
                  {data.logoUrl && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        await api(wsPath('/branding/logo'), { method: 'DELETE' }).catch((e) => toast.error(errorMessage(e)));
                        mutate();
                      }}
                    >
                      Remove
                    </Button>
                  )}
                  <p className="text-xs text-slate-500">PNG, JPEG or WebP, up to 2 MB.</p>
                </div>
              )}
            </div>
          </Card>
          <Card title="Identity">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Display name" hint={`Defaults to “${data.workspaceName}”.`} className="sm:col-span-2">
                {(id) => <Input id={id} maxLength={80} disabled={!editable} value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} />}
              </Field>
              {(['primaryColor', 'accentColor'] as const).map((k) => (
                <Field key={k} label={k === 'primaryColor' ? 'Primary color' : 'Accent color'} error={colorError(f[k])}>
                  {(id) => (
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        aria-label={`${k === 'primaryColor' ? 'Primary' : 'Accent'} color picker`}
                        disabled={!editable}
                        className="h-9 w-10 cursor-pointer rounded border border-slate-300"
                        value={HEX.test(f[k]) && f[k].length === 7 ? f[k] : '#4f46e5'}
                        onChange={(e) => setF({ ...f, [k]: e.target.value })}
                      />
                      <Input id={id} placeholder="#4f46e5" maxLength={7} disabled={!editable} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value.trim() })} />
                    </div>
                  )}
                </Field>
              ))}
              <Field label="Support email" hint="Shown to participants on landing pages and in emails." className="sm:col-span-2">
                {(id) => <Input id={id} type="email" disabled={!editable} value={f.supportEmail} onChange={(e) => setF({ ...f, supportEmail: e.target.value })} />}
              </Field>
              <Field label="Email footer" hint="Appended to invitation emails (plain text)." className="sm:col-span-2">
                {(id) => <Textarea id={id} rows={3} maxLength={1000} disabled={!editable} value={f.emailFooter} onChange={(e) => setF({ ...f, emailFooter: e.target.value })} />}
              </Field>
              <div className="sm:col-span-2">
                <Checkbox label="Hide “Powered by ConversaForge”" disabled={!editable} checked={f.hidePoweredBy} onChange={(v) => setF({ ...f, hidePoweredBy: v })} />
              </div>
            </div>
          </Card>
          {editable && (
            <Button type="submit" loading={saving} disabled={invalid}>
              Save branding
            </Button>
          )}
        </form>
        <div>
          <p className="mb-2 text-sm font-medium text-slate-700">Live preview — participant landing page</p>
          <div className="rounded-xl bg-slate-50 p-6" style={brandStyle(HEX.test(f.primaryColor) ? f.primaryColor : null)} aria-label="Branding preview">
            <div className="mb-4 flex items-center justify-center gap-3">
              {data.logoUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={data.logoUrl} alt="" className="h-8 object-contain" />
              )}
              <span className="font-semibold text-slate-800">{shownName}</span>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-lg font-semibold">Customer discovery practice</p>
              <p className="mt-1 text-sm text-slate-600">A 10-minute conversation with Jordan, a busy operations manager.</p>
              <div className="mt-4 space-y-2">
                <div className="h-9 rounded-md border border-slate-300 bg-white" />
                <div className="h-9 rounded-md border border-slate-300 bg-white" />
                <button type="button" className="w-full rounded-md bg-brand-600 py-2 text-sm font-medium text-white">
                  Continue
                </button>
              </div>
              {HEX.test(f.accentColor) && (
                <p className="mt-3 text-center text-xs font-medium" style={{ color: f.accentColor }}>
                  Accent color sample
                </p>
              )}
            </div>
            <div className="mt-3 space-y-1 text-center text-xs text-slate-500">
              {f.supportEmail && <p>Questions? {f.supportEmail}</p>}
              {!f.hidePoweredBy && <p>Powered by ConversaForge</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
