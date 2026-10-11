import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Me } from '../lib/api';
import { getTheme, setTheme, type Theme } from '../lib/theme';
import { Button } from './ui';

const NAV = [
  { to: '/links', label: 'Links' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/domains', label: 'Domains' },
  { to: '/keys', label: 'API keys' },
];

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="size-[22px]" aria-hidden>
        <circle cx="10" cy="16" r="4" fill="none" stroke="var(--color-signal)" strokeWidth="2.5" />
        <path d="M14 16h5" stroke="var(--color-signal)" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="23" cy="16" r="4" fill="var(--color-signal)" />
      </svg>
      <span className="text-[15px] font-semibold tracking-[-0.01em]">MT Link</span>
    </div>
  );
}

export function AppShell() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const [navOpen, setNavOpen] = useState(false);

  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me') });

  const logout = useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSuccess: () => {
      qc.clear();
      navigate('/login', { replace: true });
    },
  });

  function cycleTheme() {
    const next: Theme = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
    setTheme(next);
    setThemeState(next);
  }

  return (
    <div className="min-h-dvh bg-[var(--color-paper)]">
      <header className="sticky top-0 z-30 border-b border-[var(--color-rule)] bg-[var(--color-surface)]">
        <div className="flex h-14 items-center gap-4 px-4 sm:px-6">
          <Logo />

          <nav className="ml-4 hidden items-center gap-0.5 md:flex">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[13px] font-medium transition ${
                    isActive
                      ? 'bg-[var(--color-signal-soft)] text-[var(--color-signal)]'
                      : 'text-[var(--color-ink-2)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={cycleTheme}
              className="hidden size-8 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-ink-3)]
                transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)] sm:inline-flex"
              title={`Theme: ${theme}. Click to change.`}
              aria-label={`Theme: ${theme}. Click to change.`}
            >
              {theme === 'dark' ? (
                <svg viewBox="0 0 16 16" className="size-4" fill="none" aria-hidden>
                  <path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                </svg>
              ) : theme === 'light' ? (
                <svg viewBox="0 0 16 16" className="size-4" fill="none" aria-hidden>
                  <circle cx="8" cy="8" r="3.1" stroke="currentColor" strokeWidth="1.4" />
                  <path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1M12.9 12.9l-1.1-1.1M4.2 4.2 3.1 3.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" className="size-4" fill="none" aria-hidden>
                  <rect x="1.75" y="3" width="12.5" height="8.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
                  <path d="M5.5 13.75h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              )}
            </button>

            <div className="hidden text-right sm:block">
              <p className="text-[13px] font-medium leading-tight">{me?.user?.name ?? '—'}</p>
              <p className="text-[11.5px] leading-tight text-[var(--color-ink-3)]">{me?.tenant?.name ?? ''}</p>
            </div>

            <Button size="sm" variant="ghost" onClick={() => logout.mutate()} loading={logout.isPending}>
              Sign out
            </Button>

            <button
              className="inline-flex size-8 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-ink-2)] md:hidden"
              onClick={() => setNavOpen((v) => !v)}
              aria-label="Menu"
              aria-expanded={navOpen}
            >
              <svg viewBox="0 0 16 16" className="size-4" fill="none" aria-hidden>
                <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>

        {navOpen && (
          <nav className="flex flex-col border-t border-[var(--color-rule)] px-2 py-2 md:hidden">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={() => setNavOpen(false)}
                className={({ isActive }) =>
                  `rounded-[var(--radius-sm)] px-3 py-2 text-sm font-medium ${
                    isActive ? 'bg-[var(--color-signal-soft)] text-[var(--color-signal)]' : 'text-[var(--color-ink-2)]'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        )}
      </header>

      <main className="mx-auto max-w-[1200px] px-4 py-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}
