import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type DomainRow, type FolderRow, type LinkRow, type Paginated } from '../lib/api';
import { compactNumber, hostOf, prettyUrl, relativeTime } from '../lib/format';
import { Button, CopyButton, Empty, Input, Loading, Port } from '../components/ui';
import { LinkDrawer } from '../components/LinkDrawer';
import { NewLinkDialog } from '../components/NewLinkDialog';

/**
 * The links register.
 *
 * Laid out as a schedule of labelled ports rather than a grid of cards: the
 * question a person comes here with is almost always "where does X point
 * right now", so the slug and the destination sit on one scannable line and
 * everything else is secondary.
 */
export function Links() {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 220);
    return () => clearTimeout(t);
  }, [search]);

  const params = new URLSearchParams({ limit: '50', sort: 'created_desc' });
  if (debounced) params.set('q', debounced);
  if (folderId) params.set('folderId', folderId);
  if (tag) params.set('tag', tag);

  const links = useQuery({
    queryKey: ['links', debounced, folderId, tag],
    queryFn: () => api.get<Paginated<LinkRow>>(`/links?${params.toString()}`),
  });

  const folders = useQuery({
    queryKey: ['folders'],
    queryFn: () => api.get<{ items: FolderRow[] }>('/folders'),
  });

  const domains = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<{ items: DomainRow[] }>('/domains'),
  });

  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of links.data?.items ?? []) {
      for (const t of l.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [links.data]);

  const items = links.data?.items ?? [];
  const hasDomain = (domains.data?.items.length ?? 0) > 0;

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-[-0.02em]">Links</h1>
        {links.data && (
          <span className="tnum rounded-[var(--radius-xs)] bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[12px] text-[var(--color-ink-3)]">
            {items.length}
            {links.data.nextCursor ? '+' : ''}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Input
              placeholder="Search links"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-[min(280px,55vw)] pl-8"
              aria-label="Search links"
            />
            <svg viewBox="0 0 16 16" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-ink-3)]" fill="none" aria-hidden>
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
          <Button variant="primary" onClick={() => setCreating(true)} disabled={!hasDomain}>
            New link
          </Button>
        </div>
      </div>

      {(folders.data?.items.length || allTags.length) ? (
        <div className="mb-4 -mx-4 flex items-center gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
          <FilterChip active={!folderId && !tag} onClick={() => { setFolderId(null); setTag(null); }}>
            All
          </FilterChip>
          {folders.data?.items.map((f) => (
            <FilterChip
              key={f.id}
              active={folderId === f.id}
              onClick={() => { setFolderId(folderId === f.id ? null : f.id); setTag(null); }}
            >
              {f.name}
              <span className="tnum ml-1.5 text-[var(--color-ink-3)]">{f.linkCount}</span>
            </FilterChip>
          ))}
          {allTags.map(([t]) => (
            <FilterChip key={t} active={tag === t} onClick={() => { setTag(tag === t ? null : t); setFolderId(null); }}>
              #{t}
            </FilterChip>
          ))}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-surface)]">
        {links.isLoading ? (
          <Loading label="Loading links" />
        ) : !hasDomain ? (
          <Empty
            title="Add a domain to start"
            body="Short links live on a domain you control. Add one, point its DNS here, and you can create links against it."
            action={<Button variant="primary" onClick={() => (window.location.href = '/domains')}>Go to domains</Button>}
          />
        ) : items.length === 0 ? (
          <Empty
            title={debounced ? `Nothing matches “${debounced}”` : 'No links yet'}
            body={
              debounced
                ? 'Try a different term, or clear the search to see everything.'
                : 'Create your first short link. You can change where it points at any time without changing the link itself.'
            }
            action={
              debounced ? (
                <Button onClick={() => setSearch('')}>Clear search</Button>
              ) : (
                <Button variant="primary" onClick={() => setCreating(true)}>New link</Button>
              )
            }
          />
        ) : (
          <ul>
            {items.map((link) => (
              <li key={link.id} className="relative">
                {/* Copy sits outside the row button: a button inside a button
                    is invalid HTML and breaks keyboard navigation. */}
                <div className="absolute right-3 top-1/2 z-10 -translate-y-1/2">
                  <CopyButton value={link.shortUrl} label="Copy short URL" />
                </div>
                <button
                  onClick={() => setOpenId(link.id)}
                  className="register-row grid-cols-[auto_minmax(0,1fr)] gap-x-3 pr-12 sm:grid-cols-[auto_minmax(0,20ch)_minmax(0,1fr)_auto_auto] sm:gap-x-4"
                >
                  <Port
                    state={link.archivedAt ? 'archived' : 'live'}
                    title={link.archivedAt ? 'Archived' : 'Live'}
                  />

                  <span className="min-w-0 truncate font-mono text-[13px] font-medium text-[var(--color-ink)]">
                    {link.slug}
                  </span>

                  <span className="col-start-2 min-w-0 sm:col-start-auto">
                    <span className="block truncate text-[13px] text-[var(--color-ink-2)]">
                      {link.title || prettyUrl(link.destination)}
                    </span>
                    {link.title && (
                      <span className="block truncate text-[12px] text-[var(--color-ink-3)]">
                        {hostOf(link.destination)}
                      </span>
                    )}
                  </span>

                  <span className="tnum hidden text-right text-[13px] text-[var(--color-ink-2)] sm:block">
                    {compactNumber(link.clickCount)}
                  </span>

                  <span className="hidden w-[7ch] text-right text-[12px] text-[var(--color-ink-3)] sm:block">
                    {relativeTime(link.createdAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {items.length > 0 && (
        <p className="mt-3 text-[12px] text-[var(--color-ink-3)]">
          Select a link to change where it points. The short URL stays the same.
        </p>
      )}

      {openId && <LinkDrawer linkId={openId} onClose={() => setOpenId(null)} />}
      {creating && (
        <NewLinkDialog
          domains={domains.data?.items ?? []}
          folders={folders.data?.items ?? []}
          onClose={() => setCreating(false)}
        />
      )}
    </>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-[12.5px] transition ${
        active
          ? 'border-[var(--color-signal)] bg-[var(--color-signal-soft)] text-[var(--color-signal)]'
          : 'border-[var(--color-rule)] text-[var(--color-ink-2)] hover:border-[var(--color-rule-strong)] hover:text-[var(--color-ink)]'
      }`}
    >
      {children}
    </button>
  );
}
