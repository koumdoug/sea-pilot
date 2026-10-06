import type { Section } from "@/lib/landing";
import { isRenderable, type FormField } from "@/lib/landing";
import { CtaLink, LeadForm, TrackView } from "./landing-client";

type FormDef = { id: string; fields: FormField[]; consentText: string } | null;

/** Rendu d'une landing page (publique ou aperçu). Contenu 100 % texte, échappé par React : pas de HTML libre. */
export function LandingView({ pageId, sections, form, primary = "#2563eb", preview = false, track = true }: { pageId: string; sections: Section[]; form: FormDef; primary?: string; preview?: boolean; track?: boolean }) {
  const hasCta = sections.some((s) => s.type === "cta");
  const shown = sections.filter(isRenderable);
  const tracking = track && !preview;
  const formBox = form && (
    <div id="contact" className="mx-auto w-full max-w-xl scroll-mt-6 rounded-2xl bg-white p-5 text-slate-900 shadow-lg ring-1 ring-slate-200 sm:p-7">
      <LeadForm formId={form.id} fields={form.fields} consentText={form.consentText} primary={primary} preview={preview} />
    </div>
  );
  return (
    <div className="bg-white text-slate-900" style={{ ["--primary" as string]: primary }}>
      <TrackView pageId={pageId} enabled={tracking} />
      {shown.map((s) => {
        switch (s.type) {
          case "hero":
            return (
              <header key={s.id} className="px-5 py-14 text-center text-white sm:py-24" style={{ background: primary }}>
                <div className="mx-auto max-w-3xl">
                  <h1 className="text-3xl font-extrabold leading-tight sm:text-5xl">{s.headline}</h1>
                  {s.subheadline && <p className="mx-auto mt-4 max-w-2xl text-lg opacity-95">{s.subheadline}</p>}
                  <CtaLink pageId={pageId} enabled={tracking} href="#contact" className="mt-8 inline-flex min-h-12 items-center rounded-lg bg-white px-6 text-base font-semibold" ><span style={{ color: primary }}>{s.ctaLabel}</span></CtaLink>
                </div>
              </header>
            );
          case "problem":
            return <section key={s.id} className="mx-auto max-w-3xl px-5 py-12"><h2 className="text-2xl font-bold sm:text-3xl">{s.title}</h2><ul className="mt-5 space-y-3">{s.items.filter(Boolean).map((i) => <li key={i} className="flex gap-3 text-lg text-slate-700"><span aria-hidden="true" className="text-red-500">✕</span>{i}</li>)}</ul></section>;
          case "solution":
            return <section key={s.id} className="bg-slate-50 px-5 py-12"><div className="mx-auto max-w-3xl"><h2 className="text-2xl font-bold sm:text-3xl">{s.title}</h2><p className="mt-4 whitespace-pre-line text-lg text-slate-700">{s.body}</p></div></section>;
          case "benefits":
            return <section key={s.id} className="mx-auto max-w-5xl px-5 py-12"><h2 className="text-center text-2xl font-bold sm:text-3xl">{s.title}</h2><ul className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{s.items.filter((i) => i.title).map((i) => <li key={i.title} className="rounded-xl border border-slate-200 p-5"><p className="font-semibold"><span aria-hidden="true" style={{ color: primary }}>✓ </span>{i.title}</p>{i.text && <p className="mt-1 text-slate-600">{i.text}</p>}</li>)}</ul></section>;
          case "proof":
            return <section key={s.id} className="bg-slate-50 px-5 py-12"><div className="mx-auto max-w-4xl"><h2 className="text-center text-2xl font-bold sm:text-3xl">{s.title}</h2><dl className="mt-8 grid grid-cols-2 gap-5 text-center sm:grid-cols-3">{s.stats.filter((x) => x.value).map((x) => <div key={x.label}><dt className="order-2 text-slate-600">{x.label}</dt><dd className="text-3xl font-extrabold" style={{ color: primary }}>{x.value}</dd></div>)}</dl></div></section>;
          case "testimonials":
            return <section key={s.id} className="mx-auto max-w-4xl px-5 py-12"><h2 className="text-center text-2xl font-bold sm:text-3xl">{s.title}</h2><ul className="mt-8 grid gap-5 sm:grid-cols-2">{s.items.filter((x) => x.quote).map((x) => <li key={x.quote} className="rounded-xl border border-slate-200 p-5"><blockquote className="text-slate-800">« {x.quote} »</blockquote><p className="mt-3 text-sm font-semibold">{x.author}{x.role ? <span className="font-normal text-slate-500"> — {x.role}</span> : null}</p></li>)}</ul></section>;
          case "faq":
            return <section key={s.id} className="mx-auto max-w-3xl px-5 py-12"><h2 className="text-2xl font-bold sm:text-3xl">{s.title}</h2><div className="mt-6 divide-y divide-slate-200 rounded-xl border border-slate-200">{s.items.filter((x) => x.q && x.a).map((x) => <details key={x.q} className="group p-4"><summary className="cursor-pointer font-semibold">{x.q}</summary><p className="mt-2 whitespace-pre-line text-slate-700">{x.a}</p></details>)}</div></section>;
          case "cta":
            return <section key={s.id} className="bg-slate-50 px-5 py-14"><div className="mx-auto max-w-xl text-center"><h2 className="text-2xl font-bold sm:text-3xl">{s.title}</h2>{s.text && <p className="mt-2 text-slate-700">{s.text}</p>}</div><div className="mt-8">{formBox}</div></section>;
          case "footer":
            return <footer key={s.id} className="border-t border-slate-200 px-5 py-8 text-center text-sm text-slate-600">{s.text && <p>{s.text}</p>}{s.links.length > 0 && <nav className="mt-2 flex flex-wrap justify-center gap-4" aria-label="Liens du pied de page">{s.links.filter((l) => l.label && l.url).map((l) => <a key={l.label} href={l.url} className="underline" rel="noopener noreferrer">{l.label}</a>)}</nav>}</footer>;
        }
      })}
      {!hasCta && form && <section className="bg-slate-50 px-5 py-14">{formBox}</section>}
    </div>
  );
}
