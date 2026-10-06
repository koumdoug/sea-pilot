"use client";

import { createContext, useActionState, useContext, useEffect, useId, useRef, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "@/lib/action";
import { Alert, buttonClass, cx } from "./ui";

const FormCtx = createContext<ActionState>({});

/** Formulaire branché sur une server action : gère erreurs globales, erreurs par champ, succès et réinitialisation. */
export function ActionForm({ action, children, className, resetOnSuccess = false, hideSuccess = false }: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  children: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  hideSuccess?: boolean;
}) {
  const [state, formAction] = useActionState(action, {} as ActionState);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => { if (resetOnSuccess && state.ok) ref.current?.reset(); }, [state, resetOnSuccess]);
  return (
    <form ref={ref} action={formAction} className={cx("space-y-4", className)} noValidate={false}>
      <FormCtx.Provider value={state}>
        {state.error && <Alert tone="error">{state.error}</Alert>}
        {!hideSuccess && state.ok && state.message && <Alert tone="success">{state.message}</Alert>}
        {children}
      </FormCtx.Provider>
    </form>
  );
}

export function useFormState() { return useContext(FormCtx); }

export function SubmitButton({ children, pendingLabel = "Enregistrement…", variant = "primary", size = "md", className, confirm }: { children: ReactNode; pendingLabel?: string; variant?: "primary" | "secondary" | "danger" | "ghost"; size?: "sm" | "md"; className?: string; confirm?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-busy={pending} className={cx(buttonClass(variant, size), className)}
      onClick={confirm ? (e) => { if (!window.confirm(confirm)) e.preventDefault(); } : undefined}>
      {pending ? pendingLabel : children}
    </button>
  );
}

type Common = { name: string; label: string; help?: ReactNode; required?: boolean; className?: string };
const inputCls = "block w-full min-h-11 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-ink placeholder:text-slate-400 aria-[invalid=true]:border-red-500";

function Wrap({ label, help, required, className, children, id, error }: Common & { children: ReactNode; id: string; error?: string }) {
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-800">{label}{required && <span className="text-red-600" aria-hidden="true"> *</span>}</label>
      {children}
      {help && <p id={`${id}-help`} className="mt-1 text-xs text-slate-500">{help}</p>}
      {error && <p id={`${id}-err`} role="alert" className="mt-1 text-xs font-medium text-red-700">{error}</p>}
    </div>
  );
}

export function TextField(p: Common & { type?: string; defaultValue?: string | number | null; placeholder?: string; autoComplete?: string; min?: number | string; max?: number | string; step?: number | string; maxLength?: number; readOnly?: boolean }) {
  const id = useId();
  const s = useContext(FormCtx);
  const error = s.fieldErrors?.[p.name];
  return (
    <Wrap {...p} id={id} error={error}>
      <input id={id} name={p.name} type={p.type ?? "text"} required={p.required} defaultValue={p.defaultValue ?? undefined} placeholder={p.placeholder} autoComplete={p.autoComplete}
        min={p.min} max={p.max} step={p.step} maxLength={p.maxLength} readOnly={p.readOnly}
        aria-invalid={!!error} aria-describedby={[p.help && `${id}-help`, error && `${id}-err`].filter(Boolean).join(" ") || undefined} className={inputCls} />
    </Wrap>
  );
}

export function TextAreaField(p: Common & { defaultValue?: string | null; rows?: number; placeholder?: string; maxLength?: number }) {
  const id = useId();
  const s = useContext(FormCtx);
  const error = s.fieldErrors?.[p.name];
  return (
    <Wrap {...p} id={id} error={error}>
      <textarea id={id} name={p.name} required={p.required} rows={p.rows ?? 4} defaultValue={p.defaultValue ?? undefined} placeholder={p.placeholder} maxLength={p.maxLength}
        aria-invalid={!!error} aria-describedby={[p.help && `${id}-help`, error && `${id}-err`].filter(Boolean).join(" ") || undefined} className={inputCls} />
    </Wrap>
  );
}

export function SelectField(p: Common & { options: readonly (string | readonly [string, string])[]; defaultValue?: string | null; placeholder?: string }) {
  const id = useId();
  const s = useContext(FormCtx);
  const error = s.fieldErrors?.[p.name];
  return (
    <Wrap {...p} id={id} error={error}>
      <select id={id} name={p.name} required={p.required} defaultValue={p.defaultValue ?? ""} aria-invalid={!!error} aria-describedby={error ? `${id}-err` : undefined} className={inputCls}>
        {(p.placeholder !== undefined || !p.required) && <option value="">{p.placeholder ?? "—"}</option>}
        {p.options.map((o) => { const [v, l] = typeof o === "string" ? [o, o] : o; return <option key={v} value={v}>{l}</option>; })}
      </select>
    </Wrap>
  );
}

export function CheckField({ name, label, defaultChecked, help, required }: { name: string; label: ReactNode; defaultChecked?: boolean; help?: ReactNode; required?: boolean }) {
  const id = useId();
  const s = useContext(FormCtx);
  const error = s.fieldErrors?.[name];
  return (
    <div>
      <div className="flex items-start gap-2">
        <input id={id} type="checkbox" name={name} value="on" defaultChecked={defaultChecked} required={required} aria-invalid={!!error} className="mt-1 size-4 shrink-0 rounded border-slate-300" />
        <label htmlFor={id} className="text-sm text-slate-800">{label}</label>
      </div>
      {help && <p className="ml-6 mt-0.5 text-xs text-slate-500">{help}</p>}
      {error && <p role="alert" className="ml-6 mt-1 text-xs font-medium text-red-700">{error}</p>}
    </div>
  );
}

/** Petit formulaire d'action sans champ (bouton seul), ex. « Archiver ». */
export function InlineAction({ action, children, variant = "secondary", confirm, hidden = {}, size = "sm" }: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  children: ReactNode; variant?: "primary" | "secondary" | "danger" | "ghost"; confirm?: string; hidden?: Record<string, string>; size?: "sm" | "md";
}) {
  const [state, formAction] = useActionState(action, {} as ActionState);
  return (
    <form action={formAction} className="inline-flex flex-col">
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <SubmitButton variant={variant} size={size} confirm={confirm} pendingLabel="…">{children}</SubmitButton>
      {state.error && <span role="alert" className="mt-1 max-w-xs text-xs text-red-700">{state.error}</span>}
      {state.ok && state.message && <span role="status" className="mt-1 max-w-xs text-xs text-emerald-800">{state.message}</span>}
    </form>
  );
}
