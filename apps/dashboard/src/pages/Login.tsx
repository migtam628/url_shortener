import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Banner, Button, Field, Input } from '../components/ui';

export function Login() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: () => api.post('/auth/login', { email, password }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      navigate('/links', { replace: true });
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    login.mutate();
  }

  const error = login.error instanceof ApiError ? login.error.message : login.error ? 'Could not sign in.' : null;

  return (
    <div className="grid min-h-dvh place-items-center bg-[var(--color-paper)] px-4 py-10">
      <div className="w-full max-w-[360px]">
        <div className="mb-7 flex items-center gap-2.5">
          <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
            <circle cx="10" cy="16" r="4" fill="none" stroke="var(--color-signal)" strokeWidth="2.5" />
            <path d="M14 16h5" stroke="var(--color-signal)" strokeWidth="2.5" strokeLinecap="round" />
            <circle cx="23" cy="16" r="4" fill="var(--color-signal)" />
          </svg>
          <span className="text-base font-semibold tracking-[-0.01em]">MT Link</span>
        </div>

        <h1 className="mb-1 text-[22px] font-semibold leading-tight tracking-[-0.02em]">Sign in</h1>
        <p className="mb-6 text-[13px] text-[var(--color-ink-2)]">
          Manage short links and see where they point.
        </p>

        <form onSubmit={onSubmit} className="space-y-4">
          {error && <Banner>{error}</Banner>}

          <Field label="Email" htmlFor="email">
            <Input
              id="email"
              type="email"
              autoComplete="username"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>

          <Field label="Password" htmlFor="password">
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          <Button type="submit" variant="primary" className="w-full" loading={login.isPending}>
            Sign in
          </Button>
        </form>
      </div>
    </div>
  );
}
