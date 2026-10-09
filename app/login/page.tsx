'use client';

import { useState, type FormEvent } from 'react';

// Single-owner login gate (self-hosting decision, CLAUDE.md "Network
// exposure"). One shared secret, no username — see middleware.ts for the
// server-side check every other route goes through.
export default function LoginPage(): React.ReactElement {
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(
          res.status === 429
            ? 'Too many failed attempts — try again later.'
            : body.error || 'Incorrect secret.',
        );
        return;
      }
      const params = new URLSearchParams(window.location.search);
      window.location.href = params.get('next') || '/';
    } catch {
      setError('Could not reach the server — check your connection.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page">
      <div className="card login-card">
        <h1 className="login-title">Agon</h1>
        <p className="login-subtitle">Enter the access secret to continue.</p>
        <form onSubmit={handleSubmit} className="login-form">
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            placeholder="Access secret"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className="login-input"
          />
          <button type="submit" disabled={submitting || !secret} className="nt-btn">
            {submitting ? 'Checking…' : 'Log in'}
          </button>
        </form>
        {error && <p className="login-error">{error}</p>}
      </div>
    </div>
  );
}
