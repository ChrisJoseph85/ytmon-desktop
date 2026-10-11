import React, { useEffect, useId, useRef, useState } from 'react';
import { formatBytes, formatDuration } from '@shared/format';
import { thumbUrl } from '@shared/media';

// ---------- Button ----------
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
  loading?: boolean;
  iconOnly?: boolean;
};
export function Button({
  variant = 'default',
  size = 'md',
  loading,
  iconOnly,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonProps) {
  const cls = [
    'btn',
    variant !== 'default' ? `btn-${variant}` : '',
    size === 'sm' ? 'btn-sm' : '',
    iconOnly ? 'btn-icon' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={cls} disabled={disabled || loading} {...rest}>
      {loading ? <span className="spinner" aria-hidden /> : null}
      {children}
    </button>
  );
}

// ---------- Text inputs ----------
export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: React.ReactNode;
  error?: string | null;
  children: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <span className="tiny" style={{ color: 'var(--danger)' }} role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="hint">{hint}</span>
      ) : null}
    </div>
  );
}

export function Select({
  label,
  hint,
  error,
  value,
  onChange,
  options,
  id,
  disabled,
  ariaLabel,
}: {
  label?: string;
  hint?: React.ReactNode;
  error?: string | null;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  id?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const control = (
    <select
      id={selectId}
      className={`select${error ? ' input-error' : ''}`}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
  if (!label) return control;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={selectId}>
      {control}
    </Field>
  );
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="switch"
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

// ---------- Feedback ----------
export function Badge({
  tone = 'default',
  dot,
  children,
  title,
}: {
  tone?: 'default' | 'success' | 'info' | 'warn' | 'danger' | 'accent';
  dot?: boolean;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span className={`badge${tone !== 'default' ? ` badge-${tone}` : ''}`} title={title}>
      {dot ? <span className="badge-dot" aria-hidden /> : null}
      {children}
    </span>
  );
}

export function Alert({
  tone = 'info',
  icon,
  children,
  action,
}: {
  tone?: 'info' | 'success' | 'warn' | 'danger';
  icon?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const glyph = icon ?? { info: 'ℹ', success: '✓', warn: '⚠', danger: '⚠' }[tone];
  return (
    <div className={`alert alert-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <span className="alert-icon" aria-hidden>
        {glyph}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      {action}
    </div>
  );
}

export function EmptyState({
  icon = '◍',
  title,
  children,
  action,
}: {
  icon?: string;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden>
        {icon}
      </div>
      <div className="empty-title">{title}</div>
      {children ? <div style={{ maxWidth: 420 }}>{children}</div> : null}
      {action}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="empty" role="status" aria-live="polite">
      <span className="spinner spinner-lg" aria-hidden />
      <span className="muted">{label}</span>
    </div>
  );
}

export function Skeleton({ height = 16, width = '100%' }: { height?: number; width?: number | string }) {
  return <div className="skeleton" style={{ height, width }} />;
}

export function Progress({
  value,
  tone = 'default',
  large,
  label,
}: {
  value: number;
  tone?: 'default' | 'success' | 'info' | 'warn';
  large?: boolean;
  label?: string;
}) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  return (
    <div
      className={`progress${large ? ' progress-lg' : ''}`}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? 'Progress'}
    >
      <div className={`progress-fill${tone !== 'default' ? ` ${tone}` : ''}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// ---------- Modal ----------
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      // Focus trap.
      const nodes = ref.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    const t = setTimeout(() => {
      const target = ref.current?.querySelector<HTMLElement>('[data-autofocus], button, input, select');
      target?.focus();
    }, 30);
    return () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(t);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' modal-lg' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-header">
          <h2 style={{ flex: 1 }}>{title}</h2>
          <Button variant="ghost" size="sm" iconOnly onClick={onClose} aria-label="Close dialog">
            ✕
          </Button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>;
}

// ---------- Misc ----------
export function PillGroup<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string; count?: number }[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="pill-group" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className="pill"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count !== undefined ? <span className="faint"> {o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/**
 * Thumbnails come from GET /videos/{id}/thumbnail through the ytmon-media
 * proxy: Video.thumbnail_url points at YouTube and does not load on an offline
 * phone, and a plain <img> cannot send the bearer token. The endpoint answers
 * 200 (server-cached bytes), 307 (nothing cached yet) or 404 (no image), so a
 * placeholder is the fallback for all three.
 */
export function Thumb({
  videoId,
  alt,
  duration,
  kind,
  mediaType,
}: {
  videoId: string;
  alt: string;
  duration: number | null;
  kind?: string;
  mediaType?: 'video' | 'audio';
}) {
  const [failed, setFailed] = useState(false);
  return (
    <>
      {!failed ? (
        <img
          className="thumb-img"
          src={thumbUrl(videoId)}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className={`thumb-placeholder${mediaType === 'audio' ? ' audio' : ''}`} aria-hidden>
          <span style={{ fontSize: 26 }}>{mediaType === 'audio' ? '♪' : '▶'}</span>
        </div>
      )}
      {kind === 'short' ? <span className="thumb-kind">SHORT</span> : null}
      {duration !== null && duration !== undefined ? (
        <span className="thumb-duration">{formatDuration(duration)}</span>
      ) : null}
      <span className="sr-only">{alt}</span>
    </>
  );
}

export function KeyValue({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', margin: 0, fontSize: 13 }}>
      {items.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="muted nowrap">{k}</dt>
          <dd style={{ margin: 0, minWidth: 0 }} className="truncate">
            {v}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

export function sizeLabel(bytes: number | null): string {
  return bytes === null ? '—' : formatBytes(bytes);
}