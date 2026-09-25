'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

function ResetForm() {
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (done)
    return (
      <Alert tone="success">
        Password updated. <Link href="/login" className="underline">Sign in</Link>
      </Alert>
    );
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api('/auth/reset-password', { method: 'POST', body: { token, password } });
          setDone(true);
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      <h1 className="text-lg font-semibold">Choose a new password</h1>
      {error && <Alert tone="error">{error}</Alert>}
      <Field label="New password" hint="At least 10 characters">
        {(id) => <Input id={id} type="password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} />}
      </Field>
      <Button type="submit" className="w-full">
        Update password
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
