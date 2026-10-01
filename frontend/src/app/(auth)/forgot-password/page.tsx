'use client';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api('/auth/forgot-password', { method: 'POST', body: { email } });
          setSent(true);
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      <h1 className="text-lg font-semibold">Reset password</h1>
      {sent ? (
        <Alert tone="success">If an account exists for that email, a reset link is on its way.</Alert>
      ) : (
        <>
          {error && <Alert tone="error">{error}</Alert>}
          <Field label="Email">{(id) => <Input id={id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Button type="submit" className="w-full">
            Send reset link
          </Button>
        </>
      )}
    </form>
  );
}
