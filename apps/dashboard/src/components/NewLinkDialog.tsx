import { useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type DomainRow, type FolderRow } from '../lib/api';
import { Banner, Button, CopyButton, Field, Input } from './ui';

export function NewLinkDialog({
  domains,
  folders,
  onClose,
}: {
  domains: DomainRow[];
  folders: FolderRow[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [destination, setDestination] = useState('');
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const [folderId, setFolderId] = useState('');
  const [domainId, setDomainId] = useState(domains.find((d) => d.isDefault)?.id ?? domains[0]?.id ?? '');
  const [showUtm, setShowUtm] = useState(false);
  const [utm, setUtm] = useState({ source: '', medium: '', campaign: '' });
  const [created, setCreated] = useState<{ shortUrl: string } | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string; slug: string; shortUrl: string }>('/links', {
        destination,
        domainId: domainId || undefined,
        slug: slug.trim() || undefined,
        title: title.trim() || undefined,
        folderId: folderId || undefined,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        redirectCode: 302,
        ...(showUtm && (utm.source || utm.medium || utm.campaign)
          ? { utm: Object.fromEntries(Object.entries(utm).filter(([, v]) => v)) }
          : {}),
      }),
    onSuccess: async (data) => {
      setCreated({ shortUrl: data.shortUrl });
      await qc.invalidateQueries({ queryKey: ['links'] });
    },
  });

  const error = create.error instanceof ApiError ? create.error.message : null;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  function reset() {
    setCreated(null);
    setDestination('');
    setSlug('');
    setTitle('');
    setTags('');
    create.reset();
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="animate-overlay fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]" />
        <Dialog.Content
          className="animate-drawer fixed left-1/2 top-1/2 z-50 w-[min(520px,calc(100vw-2rem))]
            max-h-[calc(100dvh-4rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto
            rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-surface)] p-5 shadow-2xl outline-none"
        >
          <Dialog.Title className="text-base font-semibold tracking-[-0.01em]">New link</Dialog.Title>
          <Dialog.Description className="mt-0.5 text-[12.5px] text-[var(--color-ink-3)]">
            Leave the slug blank and one is generated for you.
          </Dialog.Description>

          {created ? (
            <div className="mt-5 space-y-4">
              <Banner tone="info">Link created and live.</Banner>
              <div className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-[var(--color-surface-2)] px-3 py-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[13px]">{created.shortUrl}</code>
                <CopyButton value={created.shortUrl} />
              </div>
              <div className="flex gap-2">
                <Button variant="primary" onClick={reset}>Create another</Button>
                <Button onClick={onClose}>Done</Button>
              </div>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="mt-5 space-y-4">
              {error && <Banner>{error}</Banner>}

              <Field label="Destination" htmlFor="new-dest" hint="Where the short link sends people.">
                <Input
                  id="new-dest"
                  required
                  autoFocus
                  mono
                  spellCheck={false}
                  placeholder="https://example.com/page"
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                />
              </Field>

              <div className="grid gap-4 sm:grid-cols-[1fr_1fr]">
                <Field label="Domain" htmlFor="new-domain">
                  <select
                    id="new-domain"
                    value={domainId}
                    onChange={(e) => setDomainId(e.target.value)}
                    className="h-9 w-full rounded-[var(--radius-sm)] border border-[var(--color-rule-strong)]
                      bg-[var(--color-surface)] px-2 text-sm"
                  >
                    {domains.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.hostname}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Slug" htmlFor="new-slug" hint="Optional">
                  <Input
                    id="new-slug"
                    mono
                    spellCheck={false}
                    placeholder="auto"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value)}
                  />
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-[1fr_1fr]">
                <Field label="Title" htmlFor="new-title" hint="Optional, for your reference">
                  <Input id="new-title" value={title} onChange={(e) => setTitle(e.target.value)} />
                </Field>

                <Field label="Folder" htmlFor="new-folder" hint="Optional">
                  <select
                    id="new-folder"
                    value={folderId}
                    onChange={(e) => setFolderId(e.target.value)}
                    className="h-9 w-full rounded-[var(--radius-sm)] border border-[var(--color-rule-strong)]
                      bg-[var(--color-surface)] px-2 text-sm"
                  >
                    <option value="">None</option>
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                </Field>
              </div>

              <Field label="Tags" htmlFor="new-tags" hint="Comma separated">
                <Input
                  id="new-tags"
                  placeholder="fieldnation, marketing"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                />
              </Field>

              <div>
                <button
                  type="button"
                  onClick={() => setShowUtm((v) => !v)}
                  className="text-[12.5px] font-medium text-[var(--color-signal)] hover:underline"
                >
                  {showUtm ? 'Hide' : 'Add'} UTM parameters
                </button>
                {showUtm && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    {(['source', 'medium', 'campaign'] as const).map((k) => (
                      <Field key={k} label={k[0]!.toUpperCase() + k.slice(1)} htmlFor={`utm-${k}`}>
                        <Input
                          id={`utm-${k}`}
                          value={utm[k]}
                          onChange={(e) => setUtm({ ...utm, [k]: e.target.value })}
                        />
                      </Field>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex gap-2 pt-1">
                <Button type="submit" variant="primary" loading={create.isPending}>
                  Create link
                </Button>
                <Dialog.Close asChild>
                  <Button type="button" variant="ghost">Cancel</Button>
                </Dialog.Close>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
