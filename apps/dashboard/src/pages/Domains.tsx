import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type DomainRow } from '../lib/api';
import { Banner, Button, Empty, Field, Input, Loading, Port } from '../components/ui';

const CERT_LABEL: Record<DomainRow['certStatus'], { text: string; state: 'live' | 'warn' | 'off' }> = {
  active: { text: 'Certificate active', state: 'live' },
  issuing: { text: 'Issuing certificate', state: 'warn' },
  pending: { text: 'Awaiting DNS', state: 'off' },
  failed: { text: 'Certificate failed', state: 'warn' },
};

export function Domains() {
  const qc = useQueryClient();
  const [hostname, setHostname] = useState('');
  const [adding, setAdding] = useState(false);

  const domains = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<{ items: DomainRow[] }>('/domains'),
  });

  const add = useMutation({
    mutationFn: () => api.post('/domains', { hostname: hostname.trim().toLowerCase() }),
    onSuccess: async () => {
      setHostname('');
      setAdding(false);
      await qc.invalidateQueries({ queryKey: ['domains'] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/domains/${id}`),
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['domains'] }),
  });

  const makeDefault = useMutation({
    mutationFn: (id: string) => api.patch(`/domains/${id}`, { isDefault: true }),
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['domains'] }),
  });

  const addError = add.error instanceof ApiError ? add.error.message : null;
  const removeError = remove.error instanceof ApiError ? remove.error.message : null;
  const items = domains.data?.items ?? [];

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    add.mutate();
  }

  return (
    <>
      <div className="mb-5 flex items-center gap-3">
        <h1 className="text-xl font-semibold tracking-[-0.02em]">Domains</h1>
        <Button variant="primary" className="ml-auto" onClick={() => setAdding((v) => !v)}>
          Add domain
        </Button>
      </div>

      {adding && (
        <form
          onSubmit={onSubmit}
          className="mb-4 space-y-3 rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-surface)] p-5"
        >
          {addError && <Banner>{addError}</Banner>}
          <Field
            label="Hostname"
            htmlFor="hostname"
            hint="Point a CNAME for this hostname at this server before creating links on it."
          >
            <Input
              id="hostname"
              mono
              autoFocus
              required
              placeholder="go.yourdomain.com"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
            />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={add.isPending}>Add domain</Button>
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </form>
      )}

      {removeError && <div className="mb-4"><Banner>{removeError}</Banner></div>}

      <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-surface)]">
        {domains.isLoading ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty
            title="No domains yet"
            body="A short link needs a domain. Add one you control, then point its DNS at this server."
            action={<Button variant="primary" onClick={() => setAdding(true)}>Add domain</Button>}
          />
        ) : (
          <ul>
            {items.map((d) => {
              const cert = CERT_LABEL[d.certStatus];
              return (
                <li
                  key={d.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--color-rule)] px-5 py-3.5 last:border-0"
                >
                  <Port state={cert.state} title={cert.text} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 font-mono text-[13px] font-medium">
                      {d.hostname}
                      {d.isDefault && (
                        <span className="rounded-[var(--radius-xs)] bg-[var(--color-signal-soft)] px-1.5 py-px text-[11px] font-sans font-medium text-[var(--color-signal)]">
                          default
                        </span>
                      )}
                    </p>
                    <p className="text-[12px] text-[var(--color-ink-3)]">
                      {cert.text} · {d.linkCount} {d.linkCount === 1 ? 'link' : 'links'}
                      {d.certLastError ? ` · ${d.certLastError}` : ''}
                    </p>
                  </div>
                  <div className="flex gap-1.5">
                    {!d.isDefault && (
                      <Button size="sm" variant="ghost" onClick={() => makeDefault.mutate(d.id)}>
                        Make default
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (confirm(`Remove ${d.hostname}?`)) remove.mutate(d.id);
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-surface)] p-5">
        <h2 className="mb-2 text-[13px] font-semibold">Pointing a domain here</h2>
        <ol className="space-y-1.5 text-[12.5px] text-[var(--color-ink-2)]">
          <li>1. Add the hostname above.</li>
          <li>2. Create a CNAME for it pointing at this server's hostname, or an A record to its IP.</li>
          <li>
            3. Issue a certificate for it. Automatic issuance is not built yet — see{' '}
            <code className="font-mono text-[12px]">docs/ARCHITECTURE.md</code> for the manual
            <code className="ml-1 font-mono text-[12px]">lego</code> command in the meantime.
          </li>
        </ol>
      </div>
    </>
  );
}
