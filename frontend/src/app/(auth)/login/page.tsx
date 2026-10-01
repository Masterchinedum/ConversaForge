'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { safeReturnUrl } from '@/lib/live/token';

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get('next');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
          await api('/auth/login', { method: 'POST', body: { email, password } });
          router.replace(safeReturnUrl(next) ?? '/app');
        } catch (err) {
          setError(errorMessage(err));
          setLoading(false);
        }
      }}
    >
      <h1 className="text-lg font-semibold">Sign in</h1>
      {error && <Alert tone="error">{error}</Alert>}
      <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
      <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
      <Button type="submit" className="w-full" loading={loading}>
        Sign in
      </Button>
      <div className="flex justify-between text-sm">
        <Link href="/forgot-password" className="text-slate-600 hover:underline">
          Forgot password?
        </Link>
        <Link href={`/signup${next ? `?next=${encodeURIComponent(next)}` : ''}`} className="text-brand-700 hover:underline">
          Create account
        </Link>
      </div>
    </form>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
