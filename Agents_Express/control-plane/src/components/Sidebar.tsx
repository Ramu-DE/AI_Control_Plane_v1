"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

// Inline SVG icons (stroke style) to match the console's line icons.
function Icon({ path }: { path: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-[18px] w-[18px] shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={path} />
    </svg>
  );
}

const ICONS = {
  dashboard: "M4 4h7v7H4zM13 4h7v4h-7zM13 11h7v9h-7zM4 14h7v6H4z",
  agents: "M12 3l8 4.5v9L12 21l-8-4.5v-9z",
  policy: "M9 7h6M9 11h6M9 15h4M6 3h12v18H6z",
  gateway: "M4 12h16M4 12l4-4M4 12l4 4M20 6v12",
  tool: "M14 7l3 3M3 21l6-6m0 0a4 4 0 105-5l-3 3-2-2 3-3a4 4 0 00-5 5z",
  registry: "M4 7h16M4 12h16M4 17h16",
  playground: "M9 3h6v4l4 11a2 2 0 01-2 3H7a2 2 0 01-2-3L9 7z",
  // Audit: a document with a magnifying glass (review / attributable trail).
  audit:
    "M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h6M14 3l5 5M14 3v5h5M9 13l2 2 3-3.5M18 18a2.5 2.5 0 10.001-5.001A2.5 2.5 0 0018 18zm1.8.2L22 20",
  settings:
    "M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1l2-1.5-2-3.5-2.4 1a7 7 0 00-1.7-1L14.5 2h-5l-.3 2.5a7 7 0 00-1.7 1l-2.4-1-2 3.5L2.1 11a7 7 0 000 2l-2 1.5 2 3.5 2.4-1a7 7 0 001.7 1L9.5 22h5l.3-2.5a7 7 0 001.7-1l2.4 1 2-3.5-2-1.5a7 7 0 00.1-1z",
  plus: "M12 5v14M5 12h14",
  // Cloud outline — live AWS resources page.
  cloud: "M7 18a4 4 0 010-8 5 5 0 019.6-1.3A3.5 3.5 0 0117 18H7z",
};

interface NavItem {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
}
interface NavGroup {
  title?: string;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
  {
    items: [
      { href: "/", label: "Dashboard", icon: "dashboard" },
      { href: "/agents", label: "Agents", icon: "agents" },
      { href: "/approvals", label: "Approval Inbox", icon: "policy" },
    ],
  },
  {
    title: "Authorization",
    items: [
      { href: "/policies", label: "Policy Library", icon: "policy" },
      { href: "/policy-engines", label: "Policy Engines", icon: "gateway" },
      { href: "/policy-stores", label: "Policy Stores", icon: "tool" },
      { href: "/audit", label: "Audit Trail", icon: "audit" },
    ],
  },
  {
    title: "Tool & Data Management",
    items: [
      { href: "/registry", label: "Registry", icon: "registry" },
      { href: "/graph", label: "Graph Sources", icon: "gateway" },
      { href: "/a2a", label: "A2A Peers", icon: "agents" },
      { href: "/kg", label: "Knowledge Graph", icon: "gateway" },
    ],
  },
  {
    title: "Testing",
    items: [
      { href: "/workflows", label: "Workflows", icon: "agents" },
      { href: "/playground", label: "Playground", icon: "playground" },
    ],
  },
  {
    title: "Platform",
    items: [
      { href: "/tenants", label: "Tenants", icon: "agents" },
      { href: "/aws-resources", label: "AWS Resources", icon: "cloud" },
      { href: "/settings", label: "Settings", icon: "settings" },
    ],
  },
];

// The navigation surface, shared between the desktop sidebar and the mobile
// off-canvas drawer. `onNavigate` lets the mobile drawer close on selection.
function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <div className="flex h-full flex-col">
      {/* Brand */}
      <div className="flex h-14 items-center gap-2 px-4">
        <span className="rounded bg-brand-500 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
          Takeda
        </span>
        <span className="text-sm font-semibold">Agent Management Platform</span>
      </div>

      {/* Open Registry — the primary entry point for creating resources. */}
      <div className="px-3 pb-2">
        <Link href="/registry" className="btn-primary w-full" onClick={onNavigate}>
          <Icon path={ICONS.plus} />
          Open Registry
        </Link>
      </div>

      {/* Nav groups */}
      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {GROUPS.map((group, gi) => (
          <div key={gi}>
            {group.title && <div className="nav-section">{group.title}</div>}
            {group.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={isActive(item.href) ? "page" : undefined}
                className={`nav-item ${
                  isActive(item.href) ? "nav-item-active" : ""
                }`}
              >
                <span className="text-slate-500">
                  <Icon path={ICONS[item.icon]} />
                </span>
                {item.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>

      {/* User profile footer */}
      <div className="flex items-center gap-3 border-t border-slate-200 px-4 py-3">
        <div className="h-8 w-8 rounded-full bg-gradient-to-br from-indigo-400 via-purple-400 to-orange-300" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">Workshop Admin</div>
          <div className="truncate text-xs text-slate-400">
            admin@workshop.local
          </div>
        </div>
      </div>
    </div>
  );
}

export function Sidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();

  // Close the drawer on route change (navigation).
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Close the drawer on Escape, and lock body scroll while it is open.
  useEffect(() => {
    if (!mobileOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMobileOpen(false);
    }
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [mobileOpen]);

  return (
    <>
      {/* Desktop sidebar (unchanged layout, hidden on small screens) */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-200 bg-white lg:flex">
        <SidebarContent />
      </aside>

      {/* Mobile top bar with hamburger */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-4 lg:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="Open navigation menu"
          aria-expanded={mobileOpen}
          aria-controls="mobile-sidebar"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-50"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>
        <span className="rounded bg-brand-500 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
          Takeda
        </span>
        <span className="truncate text-sm font-semibold">
          Agent Management Platform
        </span>
      </header>

      {/* Mobile off-canvas drawer + overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation menu"
            onClick={() => setMobileOpen(false)}
            className="absolute inset-0 bg-slate-900/40"
          />
          <aside
            id="mobile-sidebar"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col border-r border-slate-200 bg-white shadow-xl"
          >
            <div className="flex justify-end px-2 pt-2">
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="Close navigation menu"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <SidebarContent onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}
    </>
  );
}
