import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type ApiKeyRow } from '../lib/api';
import { absoluteTime, relativeTime } from '../lib/format';
import { Banner, Button, CopyButton, Empty, Field, Input, Loading, Port } from '../components/ui';

const SCOPES = ['links:read', 'links:write', 'domains:read', 'domains:write', 'analytics:read'] as const;

export function ApiKeys() {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['links:read', 'links:write']);
  const [token, setToken] = useState<string | null>(null);

  const keys = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => api.get<{ items: ApiKeyRow[] }>('/api-keys'),
  });

  const create = useMutation({
    mutationFn: () => api.post<{ token: string }>('/api-keys', { name, scopes }),
    onSuccess: async (data) => {
      setToken(data.token);
      setName('');
      setCreating(false);
      await qc.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/api-keys/${id}`),
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  });

  const error = create.error instanceof ApiError ? create.error.message : null;
  const items = keys.data?.items ?? [];

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <>
      <div className="mb-5 flex items-center gap-3">
        <h1 className="text-xl font-semibold tracking-[-0.02em]">API keys</h1>
        <Button variant="primary" className="ml-auto" onClick={() => setCreating((v) => !v)}>
          New key
        </Button>
      </div>

      {token && (
        <div className="mb-4 space-y-3 rounded-[var(--radius-md)] border border-[var(--color-signal)] bg-[var(--color-signal-soft)] p-5">
          <p className="text-[13px] font-semibold">Copy this key now</p>
          <p className="text-[12.5px] text-[var(--color-ink-2)]">
            It is stored only as a hash, so this is the one time it can be shown.
          </p>
          <div className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--color-surface)] px-3 py-2">
            <code className="min-w-0 flex-1 break-all font-mono text-[12.5px]">{token}</code>
            <CopyButton value={token} />
          </div>
          <Button size="sm" onClick={() => setToken(null)}>Done</Button>
        </div>
      )}

      {creating && (
        <form onSubmit={onSubmit} className="mb-4 space-y-4 rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-surface)] p-5">
          {error && <Banner>{error}</Banner>}
          <Field label="Name" htmlFor="key-name" hint="So you can tell your keys apart later.">
            <Input id="key-name" required autoFocus placeholder="n8n automation" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium">Scopes</legend>
            <div className="flex flex-wrap gap-1.5">
              {SCOPES.map((s) => {
                const on = scopes.includes(s);
                return (
                  <button
                    type="button"
                    key={s}
                    onClick={() => setScopes(on ? scopes.filter((x) => x !== s) : [...scopes, s])}
                    className={`rounded-full border px-2.5 py-1 font-mono text-[12px] transition ${
                      on
                        ? 'border-[var(--color-signal)] bg-[var(--color-signal-soft)] text-[var(--color-signal)]'
                        : 'border-[var(--color-rule)] text-[var(--color-ink-2)] hover:border-[var(--color-rule-strong)]'
                    }`}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={create.isPending} disabled={scopes.length === 0}>
              Create key
            </Button>
            <Button type="button" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
          </div>
        </form>
      )}

      <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-surface)]">
        {keys.isLoading ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty
            title="No API keys"
            body="Create a key to shorten links from a script, n8n, or anything else that talks HTTP."
            action={<Button variant="primary" onClick={() => setCreating(true)}>New key</Button>}
          />
        ) : (
          <ul>
            {items.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--color-rule)] px-5 py-3.5 last:border-0">
                <Port state={k.revokedAt ? 'off' : 'live'} title={k.revokedAt ? 'Revoked' : 'Active'} />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium">
                    {k.name}
                    {k.revokedAt && <span className="ml-2 text-[12px] font-normal text-[var(--color-ink-3)]">revoked</span>}
                  </p>
                  <p className="font-mono text-[12px] text-[var(--color-ink-3)]">{k.prefix}</p>
                  <p className="mt-0.5 text-[12px] text-[var(--color-ink-3)]">
                    {k.scopes.join(' · ')}
                    {k.lastUsedAt ? ` — last used ${relativeTime(k.lastUsedAt)}` : ' — never used'}
                  </p>
                </div>
                <span className="text-[11.5px] text-[var(--color-ink-3)]" title={absoluteTime(k.createdAt)}>
                  {relativeTime(k.createdAt)}
                </span>
                {!k.revokedAt && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => { if (confirm(`Revoke "${k.name}"? Anything using it stops working immediately.`)) revoke.mutate(k.id); }}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
