import Link from "next/link";
import { db } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { AppShell } from "@/components/app-shell";
import { logoutAction } from "../(auth)/actions";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireCtx({ allowInactive: true });
  const unread = await db.notification.count({ where: { workspaceId: ctx.workspaceId, readAt: null } });
  const e = ctx.ent;

  let banner: React.ReactNode = null;
  if (e.state === "trial") banner = <Banner tone="info">Essai gratuit : <strong>{e.daysLeft} jour(s) restant(s)</strong> sur le plan {e.plan.name}. <Link href="/billing" className="font-semibold underline">Choisir un plan</Link></Banner>;
  else if (e.state === "past_due") banner = <Banner tone="warn">{e.reason} <Link href="/billing" className="font-semibold underline">Gérer la facturation</Link></Banner>;
  else if (e.state === "canceling") banner = <Banner tone="info">Votre abonnement prend fin dans {e.daysLeft} jour(s). <Link href="/billing" className="font-semibold underline">Le reprendre</Link></Banner>;
  else if (!e.active) banner = <Banner tone="warn">{e.reason} <Link href="/billing" className="font-semibold underline">Voir les plans</Link></Banner>;

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
