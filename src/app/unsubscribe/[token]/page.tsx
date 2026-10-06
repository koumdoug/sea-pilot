import type { Metadata } from "next";
import { verifyToken } from "@/lib/crypto";
import { db } from "@/lib/db";
import { unsubscribeAction } from "./actions";

export const metadata: Metadata = { title: "Désinscription", robots: { index: false, follow: false } };

export default async function UnsubscribePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ done?: string }> }) {
  const { token } = await params;
  const sp = await searchParams;
  const raw = verifyToken(token);
  const [t, workspaceId, leadId] = (raw ?? "").split("|");
  const valid = t === "u" && !!workspaceId && !!leadId;
  const ws = valid ? await db.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } }) : null;
  const action = unsubscribeAction.bind(null, token);
  return (
    <main id="contenu" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-10">
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-bold">Désinscription</h1>
        {!valid || !ws ? <p className="mt-3 text-sm text-red-800" role="alert">Ce lien de désinscription est invalide.</p>
          : sp.done ? <p className="mt-3 text-sm text-emerald-900" role="status">C'est fait : vous ne recevrez plus d'e-mails commerciaux de {ws.name}.</p> : (
            <>
              <p className="mt-3 text-sm text-slate-700">Souhaitez-vous ne plus recevoir d'e-mails commerciaux de <strong>{ws.name}</strong> ?</p>
              <form action={action} className="mt-4"><button className="min-h-11 w-full rounded-lg bg-brand-600 px-4 font-semibold text-white hover:bg-brand-700">Me désinscrire</button></form>
            </>
          )}
      </div>
    </main>
  );
}
