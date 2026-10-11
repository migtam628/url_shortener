import {
  forwardRef,
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-[var(--color-signal)] text-[var(--color-signal-ink)] hover:brightness-110 active:brightness-95 border border-transparent',
  secondary:
    'bg-[var(--color-surface)] text-[var(--color-ink)] border border-[var(--color-rule-strong)] hover:bg-[var(--color-surface-2)]',
  ghost:
    'bg-transparent text-[var(--color-ink-2)] border border-transparent hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]',
  danger:
    'bg-transparent text-[var(--color-danger)] border border-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]',
};

const SIZES: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-[13px] gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, className = '', children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center rounded-[var(--radius-sm)] font-medium transition
        disabled:opacity-45 disabled:pointer-events-none ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
});

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg className={`animate-spin size-3.5 ${className}`} viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(
  function Input({ className = '', mono, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={`h-9 w-full rounded-[var(--radius-sm)] border border-[var(--color-rule-strong)] bg-[var(--color-surface)]
          px-2.5 text-sm placeholder:text-[var(--color-ink-3)] transition
          focus:border-[var(--color-signal)] focus:outline-none focus:ring-2 focus:ring-[var(--color-signal)]/20
          disabled:opacity-50 ${mono ? 'font-mono' : ''} ${className}`}
        {...rest}
      />
    );
  },
);

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-[var(--color-ink)]">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-[12.5px] text-[var(--color-danger)]">{error}</p>
      ) : hint ? (
        <p className="text-[12.5px] text-[var(--color-ink-3)]">{hint}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Port indicator — the status glyph, borrowed from a patch panel
// ---------------------------------------------------------------------------

export function Port({ state, title }: { state: 'live' | 'archived' | 'warn' | 'off'; title?: string }) {
  const color =
    state === 'live'
      ? 'var(--color-signal)'
      : state === 'warn'
        ? 'var(--color-warn)'
        : state === 'archived'
          ? 'var(--color-ink-3)'
          : 'var(--color-rule-strong)';
  return <span className="port" style={{ background: color }} title={title} aria-label={title} />;
}

// ---------------------------------------------------------------------------
// Copy to clipboard
// ---------------------------------------------------------------------------

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          // Clipboard needs a secure context; over plain http on a LAN it
          // throws. Select the text instead so the user can copy manually.
          const el = document.createElement('textarea');
          el.value = value;
          document.body.appendChild(el);
          el.select();
          try {
            document.execCommand('copy');
            setCopied(true);
          } finally {
            el.remove();
          }
        }
      }}
      className="inline-flex size-7 items-center justify-center rounded-[var(--radius-xs)]
        text-[var(--color-ink-3)] transition hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]"
      title={copied ? 'Copied' : label}
      aria-label={copied ? 'Copied' : label}
    >
      {copied ? (
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden>
          <path d="M3 8.5 6.2 11.5 13 4.5" stroke="var(--color-ok)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden>
          <rect x="5.25" y="5.25" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10.75 2.75H3.75a1 1 0 0 0-1 1v7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Feedback states
// ---------------------------------------------------------------------------

export function Banner({ tone = 'error', children }: { tone?: 'error' | 'warn' | 'info'; children: ReactNode }) {
  const styles =
    tone === 'error'
      ? 'border-[var(--color-danger)] bg-[var(--color-danger-soft)] text-[var(--color-danger)]'
      : tone === 'warn'
        ? 'border-[var(--color-warn)] bg-transparent text-[var(--color-warn)]'
        : 'border-[var(--color-signal)] bg-[var(--color-signal-soft)] text-[var(--color-ink)]';
  return (
    <div role="alert" className={`rounded-[var(--radius-sm)] border px-3 py-2 text-[13px] ${styles}`}>
      {children}
    </div>
  );
}

/** Empty states are an invitation to act, not an apology. */
export function Empty({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
      <p className="text-[15px] font-semibold text-[var(--color-ink)]">{title}</p>
      <p className="max-w-sm text-[13px] text-[var(--color-ink-2)]">{body}</p>
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-20 text-[var(--color-ink-3)]">
      <Spinner />
      <span className="text-[13px]">{label}</span>
    </div>
  );
}
