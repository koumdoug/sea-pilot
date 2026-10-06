"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "@/lib/action";
import { Alert, buttonClass } from "./ui";
import { CopyButton } from "./copy-button";

function Btn() {
  const { pending } = useFormStatus();
  return <button disabled={pending} className={buttonClass("primary")}>{pending ? "Création…" : "Créer la clé"}</button>;
}

export function ApiKeyCreator({ action }: { action: (p: ActionState, fd: FormData) => Promise<ActionState> }) {
  const [state, formAction] = useActionState(action, {} as ActionState);
  const key = (state.data as { key?: string } | undefined)?.key;
  return (
    <form action={formAction} className="space-y-3">
      {state.error && <Alert tone="error">{state.error}</Alert>}
      {key && (
        <Alert tone="success" title="Votre nouvelle clé API (affichée une seule fois)">
          <code className="mt-1 block break-all rounded bg-white/80 p-2 text-xs" data-testid="new-api-key">{key}</code>
          <div className="mt-2"><CopyButton text={key} label="Copier la clé" /></div>
        </Alert>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1"><label htmlFor="api-name" className="mb-1 block text-sm font-medium">Nom de la clé</label><input id="api-name" name="name" required minLength={2} maxLength={80} placeholder="Ex. CRM externe" className="block min-h-11 w-full rounded-lg border border-slate-300 px-3 text-sm" /></div>
        <Btn />
      </div>
    </form>
  );
}
