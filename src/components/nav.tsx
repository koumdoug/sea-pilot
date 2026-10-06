"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "./ui";

const ICONS: Record<string, string> = {
  dashboard: "M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z",
  research: "M15.5 14h-.8l-.3-.3A6.5 6.5 0 1 0 14 15.5l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z",
  offers: "M21.4 11.6l-9-9A2 2 0 0 0 11 2H4a2 2 0 0 0-2 2v7c0 .5.2 1 .6 1.4l9 9a2 2 0 0 0 2.8 0l7-7a2 2 0 0 0 0-2.8zM6.5 8a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z",
  campaigns: "M3 11v2h3l5 4V7L6 11H3zm13.5 1a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z",
  pages: "M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16H5V8h14v11z",
  leads: "M16 11a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM4 20a8 8 0 0 1 16 0v1H4v-1z",
  crm: "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z",
  studio: "M12 2l2.4 5.6L20 10l-5.6 2.4L12 18l-2.4-5.6L4 10l5.6-2.4L12 2zM19 15l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1 1-2.5z",
  copilot: "M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z",
  analytics: "M5 9.2h3V19H5V9.2zM10.6 5h2.8v14h-2.8V5zm5.6 8H19v6h-2.8v-6z",
  automations: "M13 2L3 14h7l-1 8 10-12h-7l1-8z",
  integrations: "M16 7V3h-2v4h-4V3H8v4H6v6l3 3v5h6v-5l3-3V7h-2z",
  settings: "M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.9a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1L11 21h4l.4-2.9c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5-2.2-1.6zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z",
  billing: "M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z",
};

export const NAV: { href: string; label: string; icon: keyof typeof ICONS }[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard" },
  { href: "/research", label: "Research", icon: "research" },
  { href: "/offers", label: "Offers", icon: "offers" },
  { href: "/campaigns", label: "Campaigns", icon: "campaigns" },
  { href: "/landing-pages", label: "Landing Pages", icon: "pages" },
  { href: "/leads", label: "Leads", icon: "leads" },
  { href: "/crm", label: "CRM", icon: "crm" },
  { href: "/ai-studio", label: "AI Studio", icon: "studio" },
  { href: "/copilot", label: "AI Copilot", icon: "copilot" },
  { href: "/analytics", label: "Analytics", icon: "analytics" },
  { href: "/automations", label: "Automations", icon: "automations" },
  { href: "/integrations", label: "Integrations", icon: "integrations" },
  { href: "/settings", label: "Settings", icon: "settings" },
  { href: "/billing", label: "Billing", icon: "billing" },
];

export function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const path = usePathname();
  return (
    <ul className="space-y-0.5">
      {NAV.map((n) => {
        const active = path === n.href || path.startsWith(n.href + "/");
        return (
          <li key={n.href}>
            <Link href={n.href} onClick={onNavigate} aria-current={active ? "page" : undefined}
              className={cx("flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors", active ? "bg-brand-50 text-brand-700" : "text-slate-700 hover:bg-slate-100")}>
              <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="currentColor" aria-hidden="true"><path d={ICONS[n.icon]} /></svg>
              {n.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
