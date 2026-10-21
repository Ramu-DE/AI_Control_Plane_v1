"use client";

import Link from "next/link";
import { ReactNode } from "react";

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-5 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:px-6 lg:px-8">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

// Detail-page header with a back control + avatar, like the agent/record pages.
// Provide `onBack` for in-page (client) navigation rendered as a real <button>,
// or `backHref` for link-based navigation. If both are given, `onBack` wins.
export function DetailHeader({
  backHref,
  onBack,
  title,
  subtitle,
  avatar,
  actions,
}: {
  backHref?: string;
  onBack?: () => void;
  title: string;
  subtitle?: string;
  avatar?: boolean;
  actions?: ReactNode;
}) {
  const backIcon = (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  );

  const back = onBack ? (
    <button
      type="button"
      onClick={onBack}
      className="text-slate-500 hover:text-slate-900"
      aria-label="Back"
    >
      {backIcon}
    </button>
  ) : backHref ? (
    <Link
      href={backHref}
      className="text-slate-500 hover:text-slate-900"
      aria-label="Back"
    >
      {backIcon}
    </Link>
  ) : null;

  return (
    <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-6 lg:px-8">
      <div className="flex items-center gap-3">
        {back}
        {avatar && (
          <div className="h-9 w-9 rounded-md bg-gradient-to-br from-indigo-400 via-purple-400 to-orange-300" />
        )}
        <div>
          <h1 className="text-lg font-semibold leading-tight">{title}</h1>
          {subtitle && <p className="text-sm text-slate-500">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  Draft: "bg-slate-100 text-slate-600",
  "Pending approval": "bg-blue-50 text-blue-700",
  Approved: "bg-green-50 text-green-700",
  Rejected: "bg-red-50 text-red-700",
  Deprecated: "bg-slate-100 text-slate-500",
  Ready: "bg-green-50 text-green-700",
  ready: "bg-green-50 text-green-700",
  draft: "bg-slate-100 text-slate-600",
  public: "bg-slate-900 text-white",
  private: "bg-slate-100 text-slate-600",
  enabled: "bg-green-50 text-green-700",
  disabled: "bg-slate-100 text-slate-500",
};

export function Pill({ status }: { status: string }) {
  const dot =
    status === "Draft" || status === "draft" ? (
      <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
    ) : null;
  return (
    <span className={`badge ${STATUS_STYLES[status] ?? "bg-slate-100 text-slate-600"}`}>
      {dot}
      {status}
    </span>
  );
}

// kept for back-compat with older pages
export const StatusBadge = Pill;

export function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="label">
        {label} {required && <span className="text-red-500">*</span>}
      </span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function RadioCard({
  selected,
  onClick,
  title,
  description,
  icon,
  badge,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  description: string;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`radio-card text-left ${
        selected ? "radio-card-selected" : "radio-card-idle"
      }`}
    >
      <span
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
          selected ? "border-brand-500" : "border-slate-300"
        }`}
      >
        {selected && <span className="h-2 w-2 rounded-full bg-brand-500" />}
      </span>
      {icon && (
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-base ${
            selected ? "bg-brand-500 text-white" : "bg-slate-100 text-slate-500"
          }`}
        >
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-900">{title}</span>
          {badge}
        </span>
        <span className="mt-0.5 block text-xs text-slate-500">{description}</span>
      </span>
    </button>
  );
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:items-center">
      <div className="my-auto max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white shadow-xl">
        <div className="flex items-start justify-between px-6 pt-6">
          <div>
            <h2 className="text-lg font-semibold">{title}</h2>
            {subtitle && (
              <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-slate-100 px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function Toggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
        on ? "bg-brand-500" : "bg-slate-300"
      }`}
      aria-pressed={on}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
          on ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

export function SubNav({
  items,
  active,
  onSelect,
}: {
  items: { key: string; label: string; icon?: ReactNode }[];
  active: string;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="card w-48 shrink-0 p-2">
      {items.map((it) => (
        <button
          key={it.key}
          onClick={() => onSelect(it.key)}
          className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm ${
            active === it.key
              ? "bg-slate-100 font-medium text-slate-900"
              : "text-slate-600 hover:bg-slate-50"
          }`}
        >
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500">
      {text}
    </div>
  );
}
