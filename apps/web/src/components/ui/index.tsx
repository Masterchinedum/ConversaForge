'use client';
/**
 * Minimal accessible UI kit (Tailwind). Keep components presentational; data fetching lives in pages.
 */
import clsx from 'clsx';
import Link from 'next/link';
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

export { clsx };

// ── Button ──
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
const variants: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 focus-visible:ring-brand-500 disabled:bg-brand-600/50',
  secondary: 'bg-white text-slate-800 border border-slate-300 hover:bg-slate-50 focus-visible:ring-brand-500 disabled:text-slate-400',
  ghost: 'text-slate-700 hover:bg-slate-100 focus-visible:ring-brand-500 disabled:text-slate-400',
  danger: 'bg-red-600 text-white hover:bg-red-700 focus-visible:ring-red-500 disabled:bg-red-600/50',
  link: 'text-brand-700 underline-offset-2 hover:underline px-0 py-0',
};
const sizes = { sm: 'px-2.5 py-1.5 text-xs', md: 'px-3.5 py-2 text-sm', lg: 'px-5 py-2.5 text-base' };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: keyof typeof sizes;
  loading?: boolean;
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-md font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:cursor-not-allowed',
        variants[variant],
        variant !== 'link' && sizes[size],
        className,
      )}
      {...rest}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
});

export function ButtonLink({ href, variant = 'primary', size = 'md', className, children, ...rest }: { href: string; variant?: Variant; size?: keyof typeof sizes; className?: string; children: ReactNode; target?: string }) {
  return (
    <Link
      href={href}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-md font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1',
        variants[variant],
        variant !== 'link' && sizes[size],
        className,
      )}
      {...rest}
    >
      {children}
    </Link>
  );
}

// ── Form controls ──
const control =
  'block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-100 aria-[invalid=true]:border-red-500';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={clsx(control, className)} {...rest} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, rows = 4, ...rest }, ref) {
  return <textarea ref={ref} rows={rows} className={clsx(control, 'font-[inherit]', className)} {...rest} />;
});
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={clsx(control, 'pr-8', className)} {...rest}>
      {children}
    </select>
  );
});

/** Label + control + hint/error. Pass a render function to receive the generated id. */
export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: (id: string) => ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={clsx('space-y-1', className)}>
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
        {required && <span className="ml-0.5 text-red-600" aria-hidden>*</span>}
      </label>
      {children(id)}
      {error ? (
        <p className="text-xs text-red-600" role="alert">{error}</p>
      ) : hint ? (
        <p className="text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

export function Checkbox({ label, checked, onChange, disabled, description }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; description?: ReactNode }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input id={id} type="checkbox" className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id} className="text-sm text-slate-700">
        {label}
        {description && <span className="block text-xs text-slate-500">{description}</span>}
      </label>
    </div>
  );
}

// ── Layout ──
export function Card({ className, children, title, actions }: { className?: string; children: ReactNode; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={clsx('rounded-lg border border-slate-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          {title && <h2 className="text-sm font-semibold text-slate-900">{title}</h2>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions, back }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        {back && (
          <Link href={back.href} className="mb-1 inline-block text-xs text-slate-500 hover:text-slate-800">
            ← {back.label}
          </Link>
        )}
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-slate-600">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const badgeTones = {
  gray: 'bg-slate-100 text-slate-700',
  green: 'bg-emerald-100 text-emerald-800',
  yellow: 'bg-amber-100 text-amber-800',
  red: 'bg-red-100 text-red-800',
  blue: 'bg-sky-100 text-sky-800',
  purple: 'bg-violet-100 text-violet-800',
};
export function Badge({ tone = 'gray', children, className, title }: { tone?: keyof typeof badgeTones; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={clsx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', badgeTones[tone], className)}>
      {children}
    </span>
  );
}

/** Prominent label for anything produced by the local development simulator. */
export function SimulatedBadge({ what = 'Simulated' }: { what?: string }) {
  return (
    <Badge tone="yellow" title="Produced by the local development simulator, not a real AI provider">
      ⚠ {what}
    </Badge>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={clsx('animate-spin text-current', className ?? 'h-5 w-5')} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-slate-500" role="status">
      <Spinner className="h-4 w-4" /> {label}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      {description && <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
      {msg}
      {retry && (
        <button className="ml-3 underline" onClick={retry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Alert({ tone = 'info', title, children }: { tone?: 'info' | 'warning' | 'error' | 'success'; title?: ReactNode; children?: ReactNode }) {
  const cls = {
    info: 'border-sky-200 bg-sky-50 text-sky-900',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    error: 'border-red-200 bg-red-50 text-red-900',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  }[tone];
  return (
    <div className={clsx('rounded-md border p-3 text-sm', cls)} role={tone === 'error' ? 'alert' : 'status'}>
      {title && <p className="font-medium">{title}</p>}
      {children && <div className={clsx(title && 'mt-1')}>{children}</div>}
    </div>
  );
}

// ── Table ──
export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx('overflow-x-auto rounded-lg border border-slate-200 bg-white', className)}>
      <table className="min-w-full divide-y divide-slate-200 text-sm">{children}</table>
    </div>
  );
}
export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return <th scope="col" className={clsx('bg-slate-50 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500', className)}>{children}</th>;
}
export function Td({ children, className, colSpan }: { children?: ReactNode; className?: string; colSpan?: number }) {
  return <td colSpan={colSpan} className={clsx('whitespace-nowrap px-3 py-2 text-slate-700', className)}>{children}</td>;
}

// ── Tabs ──
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: T; label: ReactNode }>; value: T; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={clsx(
            '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
            value === t.id ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ── Modal ──
export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      className={clsx('w-full rounded-lg p-0 shadow-xl backdrop:bg-slate-900/40', wide ? 'max-w-3xl' : 'max-w-lg')}
    >
      {open && (
        <div>
          <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
            <h2 className="text-base font-semibold">{title}</h2>
            <button onClick={onClose} className="rounded p-1 text-slate-500 hover:bg-slate-100" aria-label="Close">
              ✕
            </button>
          </header>
          <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
          {footer && <footer className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

// ── Toasts ──
type Toast = { id: number; tone: 'success' | 'error' | 'info'; message: string };
const ToastCtx = createContext<(tone: Toast['tone'], message: string) => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={clsx(
              'pointer-events-auto max-w-sm rounded-md px-4 py-2 text-sm shadow-lg',
              t.tone === 'success' && 'bg-emerald-600 text-white',
              t.tone === 'error' && 'bg-red-600 text-white',
              t.tone === 'info' && 'bg-slate-800 text-white',
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export function useToast() {
  const push = useContext(ToastCtx);
  return {
    success: (m: string) => push('success', m),
    error: (m: string) => push('error', m),
    info: (m: string) => push('info', m),
  };
}

// ── Misc ──
export function Stat({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-slate-900">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  );
}

export function ConfirmButton({ onConfirm, children, confirmText = 'Are you sure?', ...rest }: ButtonProps & { onConfirm: () => void | Promise<void>; confirmText?: string }) {
  const [loading, setLoading] = useState(false);
  return (
    <Button
      {...rest}
      loading={loading}
      onClick={async () => {
        if (!window.confirm(confirmText)) return;
        setLoading(true);
        try {
          await onConfirm();
        } finally {
          setLoading(false);
        }
      }}
    >
      {children}
    </Button>
  );
}
