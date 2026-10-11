import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  type AnalyticsSummary,
  type Breakdown,
  type Timeseries,
  type TopLink,
} from '../lib/api';
import { compactNumber, fullNumber, prettyUrl } from '../lib/format';
import { Loading } from '../components/ui';

const RANGES = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
] as const;

export function Analytics() {
  const [days, setDays] = useState(30);
  const from = new Date(Date.now() - days * 86_400_000).toISOString();
  const to = new Date().toISOString();
  const qs = `from=${from}&to=${to}`;

  const summary = useQuery({
    queryKey: ['analytics', 'summary', days],
    queryFn: () => api.get<AnalyticsSummary>(`/analytics/summary?${qs}`),
  });
  const series = useQuery({
    queryKey: ['analytics', 'series', days],
    queryFn: () => api.get<Timeseries>(`/analytics/timeseries?${qs}&interval=day`),
  });
  const top = useQuery({
    queryKey: ['analytics', 'top', days],
    queryFn: () => api.get<{ items: TopLink[] }>(`/analytics/top-links?${qs}`),
  });

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-[-0.02em]">Analytics</h1>
        <div className="ml-auto flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.days}
              onClick={() => setDays(r.days)}
              className={`rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[12.5px] font-medium transition ${
                days === r.days
                  ? 'bg-[var(--color-signal-soft)] text-[var(--color-signal)]'
                  : 'text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)]'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Stat label="Clicks" value={summary.data?.clicks} loading={summary.isLoading} />
        <Stat label="Unique visitors" value={summary.data?.uniqueVisitors} loading={summary.isLoading} />
        <Stat label="Bot traffic" value={summary.data?.bots} loading={summary.isLoading} muted />
      </div>

      <section className="mb-4 rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-surface)] p-5">
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-[13px] font-semibold">Clicks per day</h2>
          {series.data && (
            <span className="text-[11.5px] text-[var(--color-ink-3)]">
              {series.data.source === 'rollup' ? 'from daily rollup' : 'live'}
            </span>
          )}
        </div>
        {series.isLoading ? <Loading /> : <Chart points={series.data?.points ?? []} />}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <BreakdownCard title="Countries" dimension="country" qs={qs} />
        <BreakdownCard title="Devices" dimension="device" qs={qs} />
        <BreakdownCard title="Browsers" dimension="browser" qs={qs} />
        <BreakdownCard title="Referrers" dimension="referrer" qs={qs} />
      </div>

      <section className="mt-4 overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-surface)]">
        <h2 className="border-b border-[var(--color-rule)] px-5 py-3 text-[13px] font-semibold">Top links</h2>
        {top.isLoading ? (
          <Loading />
        ) : (
          <ul>
            {(top.data?.items ?? []).map((l) => (
              <li
                key={l.linkId}
                className="flex items-center gap-4 border-b border-[var(--color-rule)] px-5 py-2.5 last:border-0"
              >
                <code className="w-[14ch] shrink-0 truncate font-mono text-[12.5px]">/{l.slug}</code>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--color-ink-2)]">
                  {prettyUrl(l.destination)}
                </span>
                <span className="tnum text-[12.5px] font-medium">{fullNumber(l.clicks)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Stat({
  label,
  value,
  loading,
  muted,
}: {
  label: string;
  value?: number;
  loading: boolean;
  muted?: boolean;
}) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-surface)] px-4 py-3.5">
      <p className="text-[12px] text-[var(--color-ink-3)]">{label}</p>
      <p
        className={`tnum mt-1 text-[26px] font-semibold leading-none tracking-[-0.02em] ${
          muted ? 'text-[var(--color-ink-3)]' : ''
        }`}
      >
        {loading ? '—' : fullNumber(value ?? 0)}
      </p>
    </div>
  );
}

/**
 * Inline bar chart.
 *
 * Hand-drawn rather than pulled from a charting library: it is one series of
 * daily counts, and a 90KB dependency to draw thirty rectangles is not a
 * trade worth making on a page that should load instantly.
 */
function Chart({ points }: { points: Array<{ t: string; clicks: number }> }) {
  if (points.length === 0) {
    return <p className="py-10 text-center text-[13px] text-[var(--color-ink-3)]">No clicks in this period yet.</p>;
  }

  const max = Math.max(...points.map((p) => p.clicks), 1);
  const total = points.reduce((s, p) => s + p.clicks, 0);

  return (
    <div>
      <div className="flex h-[140px] items-end gap-[2px]" role="img"
        aria-label={`Clicks per day, ${total} total across ${points.length} days`}>
        {points.map((p) => {
          const pct = (p.clicks / max) * 100;
          const date = new Date(p.t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
          return (
            <div
              key={p.t}
              className="group relative flex-1 rounded-t-[2px] bg-[var(--color-signal)] transition-opacity hover:opacity-100"
              style={{ height: `${Math.max(pct, 1.5)}%`, opacity: 0.55 }}
              title={`${date}: ${p.clicks} clicks`}
            >
              <span
                className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 hidden -translate-x-1/2
                  whitespace-nowrap rounded-[var(--radius-xs)] bg-[var(--color-ink)] px-1.5 py-1 text-[11px]
                  text-[var(--color-paper)] group-hover:block"
              >
                {date} · {p.clicks}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-[var(--color-ink-3)]">
        <span>{new Date(points[0]!.t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
        <span className="tnum">peak {compactNumber(max)}/day</span>
        <span>{new Date(points.at(-1)!.t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
      </div>
    </div>
  );
}

function BreakdownCard({ title, dimension, qs }: { title: string; dimension: string; qs: string }) {
  const q = useQuery({
    queryKey: ['analytics', dimension, qs],
    queryFn: () => api.get<Breakdown>(`/analytics/breakdown/${dimension}?${qs}`),
  });

  const items = (q.data?.items ?? []).slice(0, 7);
  const max = Math.max(...items.map((i) => i.clicks), 1);

  return (
    <section className="rounded-[var(--radius-md)] border border-[var(--color-rule)] bg-[var(--color-surface)] p-5">
      <h2 className="mb-3 text-[13px] font-semibold">{title}</h2>
      {q.isLoading ? (
        <Loading />
      ) : items.length === 0 ? (
        <p className="py-5 text-[12.5px] text-[var(--color-ink-3)]">Nothing recorded yet.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((i) => (
            <li key={i.value} className="flex items-center gap-3">
              <span className="w-[13ch] shrink-0 truncate text-[12.5px]">{i.value}</span>
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-2)]">
                <span
                  className="block h-full rounded-full bg-[var(--color-signal)]"
                  style={{ width: `${(i.clicks / max) * 100}%`, opacity: 0.75 }}
                />
              </span>
              <span className="tnum w-[6ch] shrink-0 text-right text-[12px] text-[var(--color-ink-2)]">
                {compactNumber(i.clicks)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
