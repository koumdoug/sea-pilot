"use client";

import { useState } from "react";
import { ActionForm, SelectField, SubmitButton, TextAreaField, TextField } from "./forms";
import { buttonClass, cx } from "./ui";
import type { ActionState } from "@/lib/action";
import { FIELD_LIBRARY, SECTION_LABEL, sid, type FormField, type Section, type SectionType } from "@/lib/landing";

type Opt = readonly (readonly [string, string])[];

const lines = (t: string) => t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const pairs = (t: string) => lines(t).map((l) => l.split("|").map((s) => s.trim()));
const unlines = (a: string[]) => a.join("\n");

function newSection(type: SectionType): Section {
  const id = sid(type);
  switch (type) {
    case "hero": return { type, id, headline: "", subheadline: "", ctaLabel: "Obtenir une réponse" };
    case "problem": return { type, id, title: "Le problème", items: [] };
    case "solution": return { type, id, title: "Notre solution", body: "" };
    case "benefits": return { type, id, title: "Ce que vous obtenez", items: [] };
    case "proof": return { type, id, title: "Quelques chiffres", stats: [] };
    case "testimonials": return { type, id, title: "Ils nous font confiance", items: [] };
    case "faq": return { type, id, title: "Questions fréquentes", items: [] };
    case "cta": return { type, id, title: "Parlons de votre projet", text: "", ctaLabel: "Envoyer ma demande" };
    case "footer": return { type, id, text: "", links: [] };
  }
}

export function LandingEditor({ action, page, form, campaigns, offers, previewHref }: {
  action: (p: ActionState, fd: FormData) => Promise<ActionState>;
  page: { id: string; name: string; slug: string; seoTitle: string | null; seoDescription: string | null; ogImage: string | null; canonicalUrl: string | null; campaignId: string | null; offerId: string | null; primary: string; sections: Section[] };
  form: { fields: FormField[]; consentText: string; successMessage: string; redirectUrl: string | null; active: boolean };
  campaigns: Opt; offers: Opt; previewHref: string;
}) {
  const [sections, setSections] = useState<Section[]>(page.sections);
  const [fields, setFields] = useState<Record<string, { on: boolean; required: boolean }>>(() => Object.fromEntries(FIELD_LIBRARY.map((f) => { const cur = form.fields.find((x) => x.key === f.key); return [f.key, { on: !!cur, required: cur?.required ?? f.required }]; })));
  const [addType, setAddType] = useState<SectionType>("faq");

  const update = (i: number, patch: Partial<Section>) => setSections((s) => s.map((x, j) => (j === i ? ({ ...x, ...patch } as Section) : x)));
  const move = (i: number, d: -1 | 1) => setSections((s) => { const j = i + d; if (j < 0 || j >= s.length) return s; const c = [...s]; [c[i], c[j]] = [c[j], c[i]]; return c; });
  const remove = (i: number) => setSections((s) => s.filter((_, j) => j !== i));

  const formFields = FIELD_LIBRARY.filter((f) => fields[f.key]?.on).map((f) => ({ key: f.key, label: f.label, type: f.type, required: f.key === "name" ? true : fields[f.key].required, ...(f.options ? { options: f.options } : {}) }));

  return (
    <ActionForm action={action}>
      <input type="hidden" name="id" value={page.id} />
      <input type="hidden" name="sections" value={JSON.stringify(sections)} />
      <input type="hidden" name="formFields" value={JSON.stringify(formFields)} />

      <fieldset className="space-y-4 rounded-xl border border-slate-200 bg-white p-4"><legend className="px-1 text-base font-semibold">Informations</legend>
        <div className="grid gap-4 md:grid-cols-2">
          <TextField name="name" label="Nom interne" required defaultValue={page.name} />
          <TextField name="slug" label="Adresse (slug)" required defaultValue={page.slug} help="Lettres minuscules, chiffres et tirets." maxLength={60} />
          <SelectField name="campaignId" label="Campagne liée" defaultValue={page.campaignId} options={campaigns} placeholder="— aucune —" help="Les leads de la page sont rattachés à cette campagne." />
          <SelectField name="offerId" label="Offre liée" defaultValue={page.offerId} options={offers} placeholder="— aucune —" />
          <TextField name="primary" label="Couleur principale" type="color" defaultValue={page.primary} />
        </div>
      </fieldset>

      <fieldset className="space-y-4 rounded-xl border border-slate-200 bg-white p-4"><legend className="px-1 text-base font-semibold">Référencement (SEO)</legend>
        <TextField name="seoTitle" label="Title" defaultValue={page.seoTitle} maxLength={70} help="≤ 60 caractères recommandés." />
        <TextAreaField name="seoDescription" label="Meta description" rows={2} defaultValue={page.seoDescription} maxLength={170} help="≤ 160 caractères recommandés." />
        <div className="grid gap-4 md:grid-cols-2">
          <TextField name="ogImage" label="Image Open Graph (URL)" defaultValue={page.ogImage} placeholder="https://…" />
          <TextField name="canonicalUrl" label="URL canonique (optionnel)" defaultValue={page.canonicalUrl} placeholder="https://…" help="Laisser vide pour utiliser l'adresse SEA Pilot." />
        </div>
      </fieldset>

      <fieldset className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"><legend className="px-1 text-base font-semibold">Sections</legend>
        {sections.map((s, i) => (
          <div key={s.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold">{i + 1}. {SECTION_LABEL[s.type]}</p>
              <div className="flex gap-1">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className={buttonClass("ghost", "sm")} aria-label={`Monter la section ${SECTION_LABEL[s.type]}`}>↑</button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === sections.length - 1} className={buttonClass("ghost", "sm")} aria-label={`Descendre la section ${SECTION_LABEL[s.type]}`}>↓</button>
                <button type="button" onClick={() => remove(i)} className={buttonClass("ghost", "sm")} aria-label={`Supprimer la section ${SECTION_LABEL[s.type]}`}>Supprimer</button>
              </div>
            </div>
            <SectionFields s={s} onChange={(p) => update(i, p)} />
          </div>
        ))}
        <div className="flex flex-wrap items-end gap-2">
          <div><label htmlFor="add-type" className="mb-1 block text-sm font-medium">Ajouter une section</label>
            <select id="add-type" value={addType} onChange={(e) => setAddType(e.target.value as SectionType)} className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm">{(Object.keys(SECTION_LABEL) as SectionType[]).map((t) => <option key={t} value={t}>{SECTION_LABEL[t]}</option>)}</select></div>
          <button type="button" onClick={() => setSections((s) => [...s, newSection(addType)])} className={buttonClass("secondary")}>Ajouter</button>
        </div>
        <p className="text-xs text-slate-500">Le texte est affiché tel quel (pas de HTML). Les sections « Preuve » et « Témoignages » ne contiennent que ce que vous saisissez : n'y mettez que des éléments réels et vérifiables.</p>
      </fieldset>

      <fieldset className="space-y-4 rounded-xl border border-slate-200 bg-white p-4"><legend className="px-1 text-base font-semibold">Formulaire de capture</legend>
        <p className="text-sm text-slate-600">Champs affichés (l'e-mail ou le téléphone est obligatoire). Les champs budget, échéance, ville et taille alimentent la qualification automatique des leads.</p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {FIELD_LIBRARY.map((f) => (
            <li key={f.key} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 px-3 py-2 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" className="size-4" checked={fields[f.key]?.on ?? false} disabled={f.key === "name"} onChange={(e) => setFields((x) => ({ ...x, [f.key]: { ...x[f.key], on: e.target.checked } }))} />{f.label}</label>
              {fields[f.key]?.on && f.key !== "name" && <label className="flex items-center gap-1 text-xs text-slate-600"><input type="checkbox" className="size-4" checked={fields[f.key].required} onChange={(e) => setFields((x) => ({ ...x, [f.key]: { ...x[f.key], required: e.target.checked } }))} />obligatoire</label>}
            </li>
          ))}
        </ul>
        <TextAreaField name="consentText" label="Case de consentement marketing (facultative pour le visiteur)" rows={2} defaultValue={form.consentText} maxLength={500} help="Des e-mails de relance ne sont envoyés qu'aux personnes ayant coché cette case." />
        <TextField name="successMessage" label="Message de confirmation" defaultValue={form.successMessage} maxLength={300} />
        <TextField name="redirectUrl" label="Redirection après envoi (optionnel)" defaultValue={form.redirectUrl} placeholder="https://…" />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="formActive" value="on" defaultChecked={form.active} className="size-4" /> Formulaire actif</label>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton>Enregistrer</SubmitButton>
        <a href={previewHref} target="_blank" rel="noopener noreferrer" className={cx(buttonClass("secondary"))}>Prévisualiser (nouvel onglet)</a>
        <span className="text-xs text-slate-500">Enregistrez avant de prévisualiser.</span>
      </div>
    </ActionForm>
  );
}

function SectionFields({ s, onChange }: { s: Section; onChange: (p: Partial<Section>) => void }) {
  const t = (label: string, value: string, key: string, rows = 0, help?: string) => {
    const id = `${s.id}-${key}`;
    const common = "block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm";
    return (
      <div key={key}><label htmlFor={id} className="mb-1 block text-sm font-medium">{label}</label>
        {rows ? <textarea id={id} rows={rows} defaultValue={value} onChange={(e) => onChange({ [key]: e.target.value } as Partial<Section>)} className={common} />
          : <input id={id} defaultValue={value} onChange={(e) => onChange({ [key]: e.target.value } as Partial<Section>)} className={cx(common, "min-h-11")} />}
        {help && <p className="mt-1 text-xs text-slate-500">{help}</p>}</div>
    );
  };
  const list = (label: string, value: string, apply: (text: string) => Partial<Section>, help: string, key = "items") => {
    const id = `${s.id}-${key}`;
    return (<div key={id}><label htmlFor={id} className="mb-1 block text-sm font-medium">{label}</label>
      <textarea id={id} rows={4} defaultValue={value} onChange={(e) => onChange(apply(e.target.value))} className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" /><p className="mt-1 text-xs text-slate-500">{help}</p></div>);
  };
  switch (s.type) {
    case "hero": return <div className="space-y-3">{t("Titre", s.headline, "headline")}{t("Sous-titre", s.subheadline, "subheadline", 2)}{t("Texte du bouton", s.ctaLabel, "ctaLabel")}</div>;
    case "problem": return <div className="space-y-3">{t("Titre", s.title, "title")}{list("Problèmes (un par ligne)", unlines(s.items), (v) => ({ items: lines(v) }) as Partial<Section>, "Une ligne = un point.")}</div>;
    case "solution": return <div className="space-y-3">{t("Titre", s.title, "title")}{t("Texte", s.body, "body", 4)}</div>;
    case "benefits": return <div className="space-y-3">{t("Titre", s.title, "title")}{list("Bénéfices", s.items.map((i) => `${i.title}${i.text ? " | " + i.text : ""}`).join("\n"), (v) => ({ items: pairs(v).map(([title, text]) => ({ title: title ?? "", text: text ?? "" })) }) as Partial<Section>, "Format : titre | description (la description est facultative).")}</div>;
    case "proof": return <div className="space-y-3">{t("Titre", s.title, "title")}{list("Chiffres réels", s.stats.map((i) => `${i.value} | ${i.label}`).join("\n"), (v) => ({ stats: pairs(v).map(([value, label]) => ({ value: value ?? "", label: label ?? "" })) }) as Partial<Section>, "Format : valeur | libellé — ex. « 12 ans | d'expérience ». Uniquement des chiffres vérifiables.", "stats")}</div>;
    case "testimonials": return <div className="space-y-3">{t("Titre", s.title, "title")}{list("Témoignages réels", s.items.map((i) => `${i.quote} | ${i.author}${i.role ? " | " + i.role : ""}`).join("\n"), (v) => ({ items: pairs(v).map(([quote, author, role]) => ({ quote: quote ?? "", author: author ?? "", role: role ?? "" })) }) as Partial<Section>, "Format : citation | auteur | rôle. Uniquement des avis authentiques, avec accord de la personne.")}</div>;
    case "faq": return <div className="space-y-3">{t("Titre", s.title, "title")}{list("Questions / réponses", s.items.map((i) => `${i.q} | ${i.a}`).join("\n"), (v) => ({ items: pairs(v).map(([q, ...a]) => ({ q: q ?? "", a: a.join(" | ") })) }) as Partial<Section>, "Format : question | réponse (une par ligne).")}</div>;
    case "cta": return <div className="space-y-3">{t("Titre", s.title, "title")}{t("Texte", s.text, "text", 2)}{t("Texte du bouton", s.ctaLabel, "ctaLabel")}<p className="text-xs text-slate-500">Le formulaire de capture s'affiche dans cette section.</p></div>;
    case "footer": return <div className="space-y-3">{t("Texte", s.text, "text", 2)}{list("Liens", s.links.map((l) => `${l.label} | ${l.url}`).join("\n"), (v) => ({ links: pairs(v).map(([label, url]) => ({ label: label ?? "", url: url ?? "" })) }) as Partial<Section>, "Format : libellé | URL (https://… ou /chemin).", "links")}</div>;
  }
}
