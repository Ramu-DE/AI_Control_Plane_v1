"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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
  settings:
    "M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1l2-1.5-2-3.5-2.4 1a7 7 0 00-1.7-1L14.5 2h-5l-.3 2.5a7 7 0 00-1.7 1l-2.4-1-2 3.5L2.1 11a7 7 0 000 2l-2 1.5 2 3.5 2.4-1a7 7 0 001.7 1L9.5 22h5l.3-2.5a7 7 0 001.7-1l2.4 1 2-3.5-2-1.5a7 7 0 00.1-1z",
  plus: "M12 5v14M5 12h14",
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
    ],
  },
  {
    title: "Tool Management",
    items: [{ href: "/registry", label: "Registry", icon: "registry" }],
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
      { href: "/settings", label: "Settings", icon: "settings" },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white">
      {/* Brand */}
      <div className="flex h-14 items-center gap-2 px-4">
        <span className="rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-bold text-white">
          aws
        </span>
        <span className="text-sm font-semibold">Agent Management Platform</span>
      </div>

      {/* Quick Create */}
      <div className="px-3 pb-2">
        <Link href="/registry" className="btn-primary w-full">
          <Icon path={ICONS.plus} />
          Quick Create
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
        <button className="text-slate-400 hover:text-slate-600" aria-label="menu">
          ⋮
        </button>
      </div>
    </aside>
  );
}
