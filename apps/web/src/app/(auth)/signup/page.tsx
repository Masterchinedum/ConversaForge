'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

function SignupForm() {
  const router = useRouter();
  const next = useSearchParams().get('next');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
          await api('/auth/signup', { method: 'POST', body: form });
          router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/app');
        } catch (err) {
          setError(errorMessage(err));
          setLoading(false);
        }
      }}
    >
      <h1 className="text-lg font-semibold">Create your account</h1>
      {error && <Alert tone="error">{error}</Alert>}
      <Field label="Name">{(id) => <Input id={id} autoComplete="name" required value={form.name} onChange={set('name')} />}</Field>
      <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="email" required value={form.email} onChange={set('email')} />}</Field>
      <Field label="Password" hint="At least 10 characters">
        {(id) => <Input id={id} type="password" autoComplete="new-password" minLength={10} required value={form.password} onChange={set('password')} />}
      </Field>
      <Button type="submit" className="w-full" loading={loading}>
        Create account
      </Button>
      <p className="text-center text-sm text-slate-600">
        Already have an account?{' '}
        <Link href={`/login${next ? `?next=${encodeURIComponent(next)}` : ''}`} className="text-brand-700 hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}
