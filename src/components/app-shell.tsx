"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { NavLinks } from "./nav";
import { cx } from "./ui";

/** Coque de l'application : barre latérale (desktop) et tiroir de navigation (mobile). */
export function AppShell({ children, workspaceName, isDemo, userName, unread, banner, logout }: {
  children: ReactNode; workspaceName: string; isDemo: boolean; userName: string; unread: number; banner?: ReactNode; logout: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="px-4 py-4">
        <Link href="/dashboard" className="flex items-center gap-2 text-lg font-extrabold tracking-tight text-ink" onClick={() => setOpen(false)}>
          <span className="grid size-8 place-items-center rounded-lg bg-brand-600 text-sm text-white" aria-hidden="true">S</span>SEA Pilot
        </Link>
        <p className="mt-2 truncate text-xs text-slate-500" title={workspaceName}>{workspaceName}</p>
        {isDemo && <span className="mt-1 inline-block rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-800 ring-1 ring-inset ring-violet-200">Espace de démonstration</span>}
      </div>
      <nav className="flex-1 overflow-y-auto px-3 pb-3" aria-label="Navigation principale"><NavLinks onNavigate={() => setOpen(false)} /></nav>
      <div className="border-t border-slate-200 px-4 py-3 text-sm">
        <p className="truncate font-medium" title={userName}>{userName}</p>
        {logout}
      </div>
    </div>
  );
  return (
    <div className="min-h-dvh lg:flex">
      <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white lg:sticky lg:top-0 lg:block lg:h-dvh">{sidebar}</aside>

      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2 lg:hidden">
        <button type="button" onClick={() => setOpen(true)} aria-label="Ouvrir le menu" aria-expanded={open} className="grid size-11 place-items-center rounded-lg hover:bg-slate-100">
          <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>
        <span className="font-extrabold">SEA Pilot</span>
        <Link href="/dashboard#notifications" className="relative grid size-11 place-items-center rounded-lg hover:bg-slate-100" aria-label={`Notifications${unread ? ` (${unread} non lues)` : ""}`}>
          <svg viewBox="0 0 24 24" className="size-6" fill="currentColor" aria-hidden="true"><path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11a6 6 0 0 0-5-5.9V4a1 1 0 0 0-2 0v1.1A6 6 0 0 0 6 11v5l-2 2v1h16v-1l-2-2z" /></svg>
          {unread > 0 && <span className="absolute right-1.5 top-1.5 grid min-w-4 place-items-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">{unread > 9 ? "9+" : unread}</span>}
        </Link>
      </header>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button type="button" className="absolute inset-0 bg-slate-900/40" aria-label="Fermer le menu" onClick={() => setOpen(false)} />
          <div className={cx("absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-white shadow-xl")}>{sidebar}</div>
        </div>
      )}

      <div className="min-w-0 flex-1">
        {banner}
        <main id="contenu" className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
