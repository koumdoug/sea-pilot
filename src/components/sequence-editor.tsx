"use client";

import { useState } from "react";
import { ActionForm, SubmitButton } from "./forms";
import { buttonClass } from "./ui";
import type { ActionState } from "@/lib/action";
import { FOLLOWUP_ACTIONS, FOLLOWUP_ACTION_LABEL, LEAD_STATUSES, LEAD_STATUS_LABEL } from "@/lib/constants";
import type { Step } from "@/lib/followups";

const inp = "block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm min-h-11";

export function SequenceEditor({ action, seq, emailReady }: {
  action: (p: ActionState, fd: FormData) => Promise<ActionState>;
  seq?: { id: string; name: string; description: string | null; active: boolean; autoEnroll: boolean; sendEmails: boolean; steps: Step[] };
  emailReady: boolean;
}) {
  const [steps, setSteps] = useState<Step[]>(seq?.steps ?? [{ day: 0, action: "task", title: "" }]);
  const [send, setSend] = useState(seq?.sendEmails ?? false);
  const upd = (i: number, p: Partial<Step>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const uid = seq?.id ?? "new";

  return (
    <ActionForm action={action} resetOnSuccess={!seq}>
      {seq && <input type="hidden" name="id" value={seq.id} />}
      <input type="hidden" name="steps" value={JSON.stringify(steps)} />
      <div className="grid gap-4 md:grid-cols-2">
        <div><label htmlFor={`n-${uid}`} className="mb-1 block text-sm font-medium">Nom</label><input id={`n-${uid}`} name="name" required defaultValue={seq?.name} className={inp} maxLength={120} /></div>
        <div><label htmlFor={`d-${uid}`} className="mb-1 block text-sm font-medium">Description</label><input id={`d-${uid}`} name="description" defaultValue={seq?.description ?? ""} className={inp} maxLength={400} /></div>
      </div>

      <fieldset className="space-y-3"><legend className="text-sm font-semibold">Étapes (jours après l'inscription)</legend>
        {steps.map((s, i) => (
          <div key={i} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div><label htmlFor={`day-${uid}-${i}`} className="mb-1 block text-xs font-medium">Jour</label><input id={`day-${uid}-${i}`} type="number" min={0} max={365} value={s.day} onChange={(e) => upd(i, { day: Math.max(0, Math.min(365, Number(e.target.value) || 0)) })} className={inp} /></div>
              <div><label htmlFor={`act-${uid}-${i}`} className="mb-1 block text-xs font-medium">Action</label>
                <select id={`act-${uid}-${i}`} value={s.action} onChange={(e) => upd(i, { action: e.target.value as Step["action"] })} className={inp}>{FOLLOWUP_ACTIONS.map((a) => <option key={a} value={a}>{FOLLOWUP_ACTION_LABEL[a]}</option>)}</select></div>
              <div className="flex items-end"><button type="button" className={buttonClass("ghost", "sm")} onClick={() => setSteps((x) => x.filter((_, j) => j !== i))} disabled={steps.length === 1}>Retirer</button></div>
            </div>
            {s.action === "email" && <div className="mt-3 space-y-2"><div><label htmlFor={`sub-${uid}-${i}`} className="mb-1 block text-xs font-medium">Objet</label><input id={`sub-${uid}-${i}`} value={s.subject ?? ""} onChange={(e) => upd(i, { subject: e.target.value })} className={inp} /></div>
              <div><label htmlFor={`body-${uid}-${i}`} className="mb-1 block text-xs font-medium">Message (variables : {"{{prenom}} {{nom}} {{entreprise}}"})</label><textarea id={`body-${uid}-${i}`} rows={4} value={s.body ?? ""} onChange={(e) => upd(i, { body: e.target.value })} className={inp} /></div></div>}
            {(s.action === "task" || s.action === "reminder") && <div className="mt-3"><label htmlFor={`t-${uid}-${i}`} className="mb-1 block text-xs font-medium">Titre</label><input id={`t-${uid}-${i}`} value={s.title ?? ""} onChange={(e) => upd(i, { title: e.target.value })} className={inp} /></div>}
            {s.action === "status_change" && <div className="mt-3"><label htmlFor={`st-${uid}-${i}`} className="mb-1 block text-xs font-medium">Passer le prospect au statut</label>
              <select id={`st-${uid}-${i}`} value={s.status ?? ""} onChange={(e) => upd(i, { status: (e.target.value || undefined) as Step["status"] })} className={inp}><option value="">—</option>{LEAD_STATUSES.map((x) => <option key={x} value={x}>{LEAD_STATUS_LABEL[x]}</option>)}</select></div>}
          </div>
        ))}
        <button type="button" className={buttonClass("secondary", "sm")} onClick={() => setSteps((x) => [...x, { day: Math.max(0, ...x.map((y) => y.day)) + 1, action: "task", title: "" }])} disabled={steps.length >= 30}>+ Ajouter une étape</button>
      </fieldset>

      <div className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" name="active" value="on" defaultChecked={seq?.active ?? true} className="size-4" />Séquence active</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="autoEnroll" value="on" defaultChecked={seq?.autoEnroll ?? false} className="size-4" />Inscrire automatiquement chaque nouveau lead</label>
        <label className="flex items-start gap-2"><input type="checkbox" name="sendEmails" value="on" checked={send} onChange={(e) => setSend(e.target.checked)} className="mt-1 size-4" />
          <span>Autoriser l'envoi RÉEL des e-mails de cette séquence. <span className="block text-xs text-slate-600">Les e-mails ne partent que vers les prospects ayant consenti, via votre fournisseur d'e-mail connecté, avec lien de désinscription. Sinon, une tâche manuelle est créée.</span></span></label>
        {send && !emailReady && <p role="alert" className="text-xs font-medium text-amber-800">Aucun fournisseur d'e-mail n'est connecté (Integrations → E-mail) : les étapes e-mail seront bloquées et transformées en tâches.</p>}
      </div>
      <SubmitButton>{seq ? "Enregistrer la séquence" : "Créer la séquence"}</SubmitButton>
    </ActionForm>
  );
}
