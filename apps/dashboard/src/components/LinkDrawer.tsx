import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type LinkRow, type LinkVersion } from '../lib/api';
import { absoluteTime, fullNumber, prettyUrl, relativeTime } from '../lib/format';
import { Banner, Button, CopyButton, Field, Input, Loading } from './ui';

/**
 * Link detail.
 *
 * The destination field and the history below it are the same story told
 * twice: "here is where this points, and here is everywhere it has pointed".
 * That pairing is the product, so it gets the top of the drawer and the only
 * piece of real visual weight in the app.
 */
export function LinkDrawer({ linkId, onClose }: { linkId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [destination, setDestination] = useState('');
  const [note, setNote] = useState('');
  const [title, setTitle] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);

  const link = useQuery({
    queryKey: ['link', linkId],
    queryFn: () => api.get<LinkRow & { domain: { hostname: string } }>(`/links/${linkId}`),
  });

  const versions = useQuery({
    queryKey: ['link-versions', linkId],
    queryFn: () => api.get<{ items: LinkVersion[] }>(`/links/${linkId}/versions`),
  });

  useEffect(() => {
    if (link.data && !dirty) {
      setDestination(link.data.destination);
      setTitle(link.data.title ?? '');
    }
  }, [link.data, dirty]);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 2400);
    return () => clearTimeout(t);
  }, [saved]);

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/links/${linkId}`, {
        destination,
        title: title || null,
        ...(note ? { note } : {}),
      }),
    onSuccess: async () => {
      setDirty(false);
      setNote('');
      setSaved(true);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['link', linkId] }),
        qc.invalidateQueries({ queryKey: ['link-versions', linkId] }),
        qc.invalidateQueries({ queryKey: ['links'] }),
      ]);
    },
  });

  const archive = useMutation({
    mutationFn: (archived: boolean) => api.patch(`/links/${linkId}`, { archived }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['link', linkId] }),
        qc.invalidateQueries({ queryKey: ['links'] }),
      ]);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/links/${linkId}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['links'] });
      onClose();
    },
  });

  const error = save.error instanceof ApiError ? save.error.message : null;
  const data = link.data;
  const history = versions.data?.items ?? [];

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="animate-overlay fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]" />
        <Dialog.Content
          className="animate-drawer fixed right-0 top-0 z-50 flex h-dvh w-full max-w-[560px] flex-col
            border-l border-[var(--color-rule)] bg-[var(--color-surface)] shadow-2xl outline-none"
        >
          <div className="flex items-start gap-3 border-b border-[var(--color-rule)] px-5 py-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="truncate font-mono text-[15px] font-semibold">
                {data ? `${data.domain.hostname}/${data.slug}` : 'Link'}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-[12.5px] text-[var(--color-ink-3)]">
                {data ? `${fullNumber(data.clickCount)} clicks · created ${relativeTime(data.createdAt)}` : ' '}
              </Dialog.Description>
            </div>
            {data && <CopyButton value={data.shortUrl} label="Copy short URL" />}
            <Dialog.Close asChild>
              <button
                className="inline-flex size-7 items-center justify-center rounded-[var(--radius-xs)] text-[var(--color-ink-3)]
                  transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]"
                aria-label="Close"
              >
                <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden>
                  <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </Dialog.Close>
          </div>

          {link.isLoading || !data ? (
            <Loading label="Loading link" />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="space-y-4 px-5 py-5">
                {error && <Banner>{error}</Banner>}
                {saved && <Banner tone="info">Saved. The new destination is live now.</Banner>}

                <Field
                  label="Destination"
                  htmlFor="destination"
                  hint="Change this and the short URL above keeps working — it just points somewhere else."
                >
                  <Input
                    id="destination"
                    value={destination}
                    mono
                    onChange={(e) => {
                      setDestination(e.target.value);
                      setDirty(true);
                    }}
                    spellCheck={false}
                  />
                </Field>

                <Field label="Title" htmlFor="title" hint="For your own reference. Visitors never see it.">
                  <Input
                    id="title"
                    value={title}
                    onChange={(e) => {
                      setTitle(e.target.value);
                      setDirty(true);
                    }}
                  />
                </Field>

                {dirty && (
                  <Field label="Change note" htmlFor="note" hint="Optional. Stored with this change in the history.">
                    <Input
                      id="note"
                      value={note}
                      placeholder="Why it changed"
                      onChange={(e) => setNote(e.target.value)}
                    />
                  </Field>
                )}

                <div className="flex items-center gap-2 pt-1">
                  <Button
                    variant="primary"
                    disabled={!dirty}
                    loading={save.isPending}
                    onClick={() => save.mutate()}
                  >
                    Save changes
                  </Button>
                  {dirty && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setDestination(data.destination);
                        setTitle(data.title ?? '');
                        setNote('');
                        setDirty(false);
                      }}
                    >
                      Discard
                    </Button>
                  )}
                </div>

                {data.redirectCode === 301 && (
                  <Banner tone="warn">
                    This link sends a 301. Browsers cache that more or less permanently, so people who
                    have already used it may keep going to the old destination even after you change it.
                  </Banner>
                )}
              </div>

              {/* ---- QR ------------------------------------------------- */}
              <section className="border-t border-[var(--color-rule)] px-5 py-5">
                <h3 className="mb-3 text-[13px] font-semibold">QR code</h3>
                <div className="flex items-center gap-4">
                  <img
                    src={`/api/v1/links/${linkId}/qr.png?size=256`}
                    alt={`QR code for ${data.shortUrl}`}
                    className="size-24 rounded-[var(--radius-sm)] border border-[var(--color-rule)] bg-white"
                  />
                  <div className="space-y-2 text-[12.5px] text-[var(--color-ink-2)]">
                    <p className="max-w-[28ch]">
                      Print this. You can change the destination later without reprinting anything.
                    </p>
                    <div className="flex gap-2">
                      <a href={`/api/v1/links/${linkId}/qr.png?size=1024`} download>
                        <Button size="sm">PNG</Button>
                      </a>
                      <a href={`/api/v1/links/${linkId}/qr.svg`} download>
                        <Button size="sm">SVG</Button>
                      </a>
                    </div>
                  </div>
                </div>
              </section>

              {/* ---- History -------------------------------------------- */}
              <section className="border-t border-[var(--color-rule)] px-5 py-5">
                <h3 className="mb-4 text-[13px] font-semibold">
                  History
                  <span className="ml-2 font-normal text-[var(--color-ink-3)]">
                    everywhere this link has pointed
                  </span>
                </h3>

                {versions.isLoading ? (
                  <Loading label="Loading history" />
                ) : (
                  <ol className="relative space-y-0">
                    {history.map((v, i) => {
                      const current = i === 0;
                      return (
                        <li key={v.id} className="relative flex gap-3 pb-5 last:pb-0">
                          {/* Continuous rule through the timeline */}
                          {i < history.length - 1 && (
                            <span
                              className="absolute left-[3.5px] top-[14px] h-full w-px bg-[var(--color-rule)]"
                              aria-hidden
                            />
                          )}
                          <span
                            className="relative z-10 mt-[5px] size-2 flex-none rounded-full"
                            style={{
                              background: current ? 'var(--color-signal)' : 'var(--color-rule-strong)',
                              boxShadow: current ? '0 0 0 3px var(--color-signal-soft)' : 'none',
                            }}
                            aria-hidden
                          />
                          <div className="min-w-0 flex-1">
                            <p
                              className={`break-all font-mono text-[12.5px] ${
                                current ? 'text-[var(--color-ink)]' : 'text-[var(--color-ink-2)]'
                              }`}
                            >
                              {prettyUrl(v.destination, 90)}
                            </p>
                            <p className="mt-0.5 text-[11.5px] text-[var(--color-ink-3)]">
                              {current && <span className="text-[var(--color-signal)]">Current · </span>}
                              <time dateTime={v.changedAt} title={absoluteTime(v.changedAt)}>
                                {relativeTime(v.changedAt)}
                              </time>
                              {v.changedBy && ` · ${v.changedBy.name}`}
                              {v.slug !== data.slug && ` · was /${v.slug}`}
                              {v.note && ` · ${v.note}`}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>

              {/* ---- Danger --------------------------------------------- */}
              <section className="border-t border-[var(--color-rule)] px-5 py-5">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    loading={archive.isPending}
                    onClick={() => archive.mutate(!data.archivedAt)}
                  >
                    {data.archivedAt ? 'Restore' : 'Archive'}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    loading={remove.isPending}
                    onClick={() => {
                      if (
                        confirm(
                          `Delete ${data.domain.hostname}/${data.slug}?\n\nAnyone who uses this short URL — including printed QR codes — will get a 404. Archiving keeps it resolvable.`,
                        )
                      ) {
                        remove.mutate();
                      }
                    }}
                  >
                    Delete
                  </Button>
                  <p className="text-[12px] text-[var(--color-ink-3)]">
                    Archiving stops the link resolving but keeps its history.
                  </p>
                </div>
              </section>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
