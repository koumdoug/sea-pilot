import Link from "next/link";
import { db } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { AppShell } from "@/components/app-shell";
import { logoutAction } from "../(auth)/actions";
import { accessBanner } from "@/lib/access-banner";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireCtx({ allowInactive: true });
  const unread = await db.notification.count({ where: { workspaceId: ctx.workspaceId, readAt: null } });
  const e = ctx.ent;

  const b = accessBanner(e);
  const banner: React.ReactNode = b ? <Banner tone={b.tone}>{b.lead}{b.strong && <strong>{b.strong}</strong>}{b.rest}<Link href={b.cta.href} className="ml-2 font-semibold underline">{b.cta.label}</Link></Banner> : null;

  return (
    <AppShell
      workspaceName={ctx.workspace.name} isDemo={ctx.workspace.isDemo} userName={ctx.user.name} unread={unread} banner={banner}
      logout={<form action={logoutAction}><button className="mt-1 text-xs text-slate-600 underline hover:text-slate-900">Se déconnecter</button></form>}
    >
      {children}
    </AppShell>
  );
}

function Banner({ children, tone }: { children: React.ReactNode; tone: "info" | "warn" }) {
  return <div role="status" className={`px-4 py-2 text-center text-sm ${tone === "warn" ? "bg-amber-100 text-amber-900" : "bg-brand-50 text-brand-700"}`}>{children}</div>;
}
