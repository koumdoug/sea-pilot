import { z } from "zod";
import type { Form } from "@prisma/client";
import { db } from "./db";
import { createLead } from "./leads";
import { formFieldsSchema, type FormField } from "./landing";

export class SubmitError extends Error {
  constructor(message: string, public status = 400, public fieldErrors?: Record<string, string>) {
    super(message);
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^[+()\d\s.-]{6,25}$/;

export type Submission = {
  values: Record<string, unknown>;
  consent?: boolean;
  utm?: { source?: string; medium?: string; campaign?: string; term?: string; content?: string };
  referrer?: string;
  landingUrl?: string;
  ipHash?: string | null;
};

/** Valide les valeurs reçues contre la définition du formulaire (clés inconnues refusées, champs obligatoires, formats). */
export function validateValues(fields: FormField[], values: Record<string, unknown>): { clean: Record<string, string>; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const clean: Record<string, string> = {};
  const allowed = new Set(fields.map((f) => f.key));
  for (const k of Object.keys(values)) if (!allowed.has(k)) delete values[k];
  for (const f of fields) {
    const raw = values[f.key];
    const v = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw).trim();
    if (!v) { if (f.required) errors[f.key] = "Ce champ est obligatoire."; continue; }
    const max = f.type === "textarea" ? 4000 : 300;
    if (v.length > max) { errors[f.key] = `Maximum ${max} caractères.`; continue; }
    if (f.type === "email" && !EMAIL.test(v)) { errors[f.key] = "Adresse e-mail invalide."; continue; }
    if (f.type === "tel" && !PHONE.test(v)) { errors[f.key] = "Numéro de téléphone invalide."; continue; }
    if (f.type === "select" && f.options && !f.options.includes(v)) { errors[f.key] = "Choix invalide."; continue; }
    clean[f.key] = v;
  }
  if (!clean.email && !clean.phone && !errors.email && !errors.phone) errors.email = "Indiquez au moins un e-mail ou un téléphone.";
  return { clean, errors };
}

export async function submitToForm(formId: string, s: Submission) {
  const form = await db.form.findFirst({ where: { id: formId, active: true }, include: { landingPage: true } });
  if (!form) throw new SubmitError("Formulaire introuvable.", 404);
  if (form.landingPage && form.landingPage.status !== "published") throw new SubmitError("Formulaire introuvable.", 404);
  return submitToFormRecord(form, s);
}

export async function submitToFormRecord(form: Form, s: Submission) {
  const fields = formFieldsSchema.safeParse(form.fields);
  if (!fields.success) throw new SubmitError("Formulaire mal configuré.", 500);
  const { clean, errors } = validateValues(fields.data, { ...s.values });
  if (Object.keys(errors).length) throw new SubmitError("Certains champs sont invalides.", 422, errors);
  const { name, email, phone, company, message, ...custom } = clean;
  const utm = z.object({ source: z.string().max(200).optional(), medium: z.string().max(200).optional(), campaign: z.string().max(200).optional(), term: z.string().max(200).optional(), content: z.string().max(200).optional() }).safeParse(s.utm ?? {});
  const { lead, duplicate } = await createLead({
    workspaceId: form.workspaceId, name: name ?? email ?? phone ?? "Sans nom", email, phone, company, message, customFields: Object.keys(custom).length ? custom : null,
    utm: utm.success ? utm.data : undefined, landingPageId: form.landingPageId, formId: form.id, referrer: s.referrer, landingUrl: s.landingUrl,
    consentMarketing: !!s.consent, consentText: form.consentText, ipHash: s.ipHash, source: utm.success ? utm.data.source : undefined,
  });
  if (!duplicate) await db.analyticsEvent.create({ data: { workspaceId: form.workspaceId, type: "form_submit", landingPageId: form.landingPageId, leadId: lead.id, campaignId: lead.campaignId, utmSource: lead.utmSource, utmMedium: lead.utmMedium, utmCampaign: lead.utmCampaign } });
  return { lead, duplicate, form };
}
