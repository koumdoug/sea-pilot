import type { Metadata } from "next";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { requireCtx } from "@/lib/tenant";
import { COMPANY_SIZES, CURRENCIES, LANGUAGES } from "@/lib/constants";
import { DEFAULT_THRESHOLDS, normalizeCriteria } from "@/lib/scoring";
import { Alert, Badge, Card, LinkButton, PageHeader, Section, TableWrap, Td, Th, fmtDate } from "@/components/ui";
import { ActionForm, CheckField, InlineAction, SelectField, SubmitButton, TextAreaField, TextField } from "@/components/forms";
import { ApiKeyCreator } from "@/components/api-key-creator";
import { addMemberAction, changeMemberRoleAction, changePasswordAction, createApiKeyAction, deleteAccountAction, deleteWorkspaceAction, removeMemberAction, revokeApiKeyAction, saveQualificationAction, updateProfileAction, updateWorkspaceAction } from "./actions";

export const metadata: Metadata = { title: "Settings" };
const TABS = [["profil", "Profil"], ["entreprise", "Entreprise"], ["equipe", "Équipe"], ["qualification", "Qualification"], ["api", "API"], ["confidentialite", "Confidentialité"], ["audit", "Journal d'audit"]] as const;
const CRIT_LABEL: Record<string, string> = { need: "Besoin exprimé", budget: "Budget", urgency: "Urgence", fit: "Adéquation avec l'offre", location: "Localisation", size: "Taille de l'entreprise", intent: "Intention d'achat" };
const ROLE_LABEL: Record<string, string> = { owner: "Propriétaire", admin: "Administrateur", member: "Membre", viewer: "Lecteur" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const ctx = await requireCtx({ allowInactive: true });
  const sp = await searchParams;
  const tab = TABS.some((t) => t[0] === sp.tab) ? sp.tab! : "profil";
  const w = ctx.workspace;

  return (
    <>
      <PageHeader title="Réglages" subtitle={`Espace de travail : ${w.name} · votre rôle : ${ROLE_LABEL[ctx.role]}`} />
      <nav className="mb-5 flex flex-wrap gap-2" aria-label="Sections des réglages">
        {TABS.map(([k, l]) => <LinkButton key={k} href={`/settings?tab=${k}`} size="sm" variant={tab === k ? "primary" : "secondary"} aria-current={tab === k ? "page" : undefined}>{l}</LinkButton>)}
      </nav>

      {tab === "profil" && (
        <div className="grid max-w-3xl gap-5">
          <Section title="Votre profil">
            <ActionForm action={updateProfileAction}>
              <TextField name="name" label="Nom" required defaultValue={ctx.user.name} />
              <TextField name="email" label="Adresse e-mail" type="email" defaultValue={ctx.user.email} readOnly help="L'adresse e-mail n'est pas modifiable depuis cette page." />
              <SelectField name="locale" label="Langue de l'interface" required defaultValue={ctx.user.locale} options={LANGUAGES} />
              <SubmitButton>Enregistrer</SubmitButton>
            </ActionForm>
          </Section>
          <Section title="Changer de mot de passe">
            <ActionForm action={changePasswordAction} resetOnSuccess>
              <TextField name="current" label="Mot de passe actuel" type="password" required autoComplete="current-password" />
              <TextField name="next" label="Nouveau mot de passe" type="password" required autoComplete="new-password" help="10 caractères minimum, avec au moins une lettre et un chiffre." />
              <SubmitButton>Modifier le mot de passe</SubmitButton>
            </ActionForm>
          </Section>
        </div>
      )}

      {tab === "entreprise" && (
        <Section title="Entreprise et objectifs" description="Ces informations alimentent l'IA, la fiche stratégie et le calcul de la santé de l'acquisition.">
          {ctx.can("manage_settings") ? (
            <ActionForm action={updateWorkspaceAction}>
              <div className="grid gap-4 md:grid-cols-2">
                <TextField name="name" label="Nom de l'entreprise" required defaultValue={w.name} /><TextField name="website" label="Site web" defaultValue={w.website} />
                <TextField name="industry" label="Secteur" defaultValue={w.industry} /><TextField name="country" label="Pays" defaultValue={w.country} />
                <SelectField name="language" label="Langue des contenus" required defaultValue={w.language} options={LANGUAGES} /><SelectField name="currency" label="Devise" required defaultValue={w.currency} options={CURRENCIES} />
                <SelectField name="companySize" label="Taille" defaultValue={w.companySize} options={COMPANY_SIZES} />
              </div>
              <TextAreaField name="description" label="Description" rows={3} defaultValue={w.description} />
              <h3 className="pt-2 text-sm font-semibold">Objectifs</h3>
              <div className="grid gap-4 md:grid-cols-3">
                <TextField name="goalLeadsPerMonth" label="Leads / mois" type="number" min={0} defaultValue={w.goalLeadsPerMonth} /><TextField name="goalSalesPerMonth" label="Ventes / mois" type="number" min={0} defaultValue={w.goalSalesPerMonth} />
                <TextField name="adBudgetMonthly" label="Budget pub / mois" type="number" min={0} defaultValue={w.adBudgetMonthly} /><TextField name="maxCac" label="CAC maximal" type="number" min={0} defaultValue={w.maxCac} /><TextField name="revenueGoal" label="Objectif de CA / mois" type="number" min={0} defaultValue={w.revenueGoal} />
              </div>
              <SubmitButton>Enregistrer</SubmitButton>
            </ActionForm>
          ) : <Alert tone="info">Seuls les administrateurs modifient ces réglages.</Alert>}
        </Section>
      )}

      {tab === "equipe" && <Team ctxRole={ctx.role} workspaceId={ctx.workspaceId} userId={ctx.user.id} canManage={ctx.can("manage_members")} />}
      {tab === "qualification" && <Qualification workspaceId={ctx.workspaceId} canEdit={ctx.can("manage_settings")} />}
      {tab === "api" && <ApiKeys workspaceId={ctx.workspaceId} canManage={ctx.can("manage_integrations")} slug={w.slug} />}

      {tab === "confidentialite" && (
        <div className="grid max-w-3xl gap-5">
          <Section title="Exporter vos données" description="Téléchargez une copie JSON de vos données (portabilité).">
            <div className="flex flex-wrap gap-2">
              <LinkButton href="/api/export?scope=me" variant="secondary">Mes données personnelles</LinkButton>
              {ctx.can("manage_settings") && <LinkButton href="/api/export?scope=workspace" variant="secondary">Toutes les données de l'espace</LinkButton>}
            </div>
          </Section>
          <Section title="Vos obligations envers vos prospects" description="Chaque lead conserve la preuve de son consentement (texte, date). Les e-mails marketing contiennent un lien de désinscription ; les adresses désinscrites sont ajoutées à une liste de suppression. Sur la fiche d'un prospect, vous pouvez le désinscrire ou effacer ses données personnelles. Complétez votre propre politique de confidentialité vis-à-vis de vos prospects.">
            <p className="text-sm"><a href="/privacy" className="text-brand-700 underline">Politique de confidentialité de SEA Pilot</a> · <a href="/terms" className="text-brand-700 underline">Conditions d'utilisation</a></p>
          </Section>
          {ctx.can("delete_workspace") && (
            <Section title="Supprimer l'espace de travail" description="Supprime définitivement toutes les données de l'espace : leads, campagnes, pages, analytics, intégrations. Irréversible.">
              <ActionForm action={deleteWorkspaceAction}><TextField name="confirm" label={`Tapez « ${w.name} » pour confirmer`} required /><SubmitButton variant="danger" confirm="Supprimer définitivement cet espace et toutes ses données ?">Supprimer l'espace</SubmitButton></ActionForm>
            </Section>
          )}
          <Section title="Supprimer mon compte" description="Supprime votre compte. Les espaces dont vous êtes le seul membre sont supprimés avec leurs données.">
            <ActionForm action={deleteAccountAction}><TextField name="password" label="Mot de passe" type="password" required autoComplete="current-password" /><SubmitButton variant="danger" confirm="Supprimer définitivement votre compte ?">Supprimer mon compte</SubmitButton></ActionForm>
          </Section>
        </div>
      )}

      {tab === "audit" && <AuditTab workspaceId={ctx.workspaceId} allowed={ctx.can("manage_settings")} />}
    </>
  );
}

async function Team({ workspaceId, userId, canManage, ctxRole }: { workspaceId: string; userId: string; canManage: boolean; ctxRole: string }) {
  const members = await db.membership.findMany({ where: { workspaceId }, include: { user: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: "asc" } });
  return (
    <div className="space-y-5">
      <TableWrap caption="Membres de l'espace"><thead><tr><Th>Membre</Th><Th>Rôle</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
        <tbody>{members.map((m) => (
          <tr key={m.id}><Td>{m.user.name}{m.user.id === userId && <span className="text-xs text-slate-500"> (vous)</span>}<div className="text-xs text-slate-500">{m.user.email}</div></Td>
            <Td>{canManage && m.role !== "owner" && m.user.id !== userId ? (
              <ActionForm action={changeMemberRoleAction} className="flex items-end gap-2 !space-y-0"><input type="hidden" name="userId" value={m.user.id} />
                <SelectField name="role" label="Rôle" defaultValue={m.role} required options={[...(ctxRole === "owner" ? [["admin", "Administrateur"] as const] : []), ["member", "Membre"], ["viewer", "Lecteur"]]} /><SubmitButton size="sm" variant="secondary">OK</SubmitButton></ActionForm>
            ) : <Badge>{ROLE_LABEL[m.role]}</Badge>}</Td>
            <Td>{canManage && m.role !== "owner" && m.user.id !== userId && <InlineAction action={removeMemberAction} variant="danger" hidden={{ userId: m.user.id }} confirm="Retirer ce membre ?">Retirer</InlineAction>}</Td></tr>
        ))}</tbody></TableWrap>
      {canManage && (
        <Section title="Ajouter un membre" description="La personne doit déjà avoir un compte SEA Pilot (page d'inscription).">
          <ActionForm action={addMemberAction} resetOnSuccess>
            <div className="grid gap-4 sm:grid-cols-2"><TextField name="email" label="Adresse e-mail du compte" type="email" required /><SelectField name="role" label="Rôle" required defaultValue="member" options={[...(ctxRole === "owner" ? [["admin", "Administrateur"] as const] : []), ["member", "Membre — crée et modifie"], ["viewer", "Lecteur — consulte seulement"]]} /></div>
            <SubmitButton>Ajouter</SubmitButton>
          </ActionForm>
        </Section>
      )}
    </div>
  );
}

async function Qualification({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const cfg = await db.qualificationConfig.findUnique({ where: { workspaceId } });
  const criteria = normalizeCriteria(cfg?.criteria);
  const th = cfg ? { hot: cfg.hotThreshold, warm: cfg.warmThreshold } : DEFAULT_THRESHOLDS;
  return (
    <Section title="Critères de qualification" description="Le score (0–100) est la moyenne pondérée des critères activés. Une information absente vaut 0 et est listée comme « manquante » : rien n'est supposé.">
      {!canEdit && <Alert tone="info">Lecture seule.</Alert>}
      <ActionForm action={saveQualificationAction}>
        <TableWrap caption="Critères"><thead><tr><Th>Actif</Th><Th>Critère</Th><Th>Poids (0–100)</Th></tr></thead>
          <tbody>{criteria.map((c) => (
            <tr key={c.key}><Td><input type="checkbox" name={`e_${c.key}`} defaultChecked={c.enabled} disabled={!canEdit} aria-label={`Activer ${CRIT_LABEL[c.key]}`} className="size-4" /></Td><Td>{CRIT_LABEL[c.key]}</Td>
              <Td><input type="number" name={`w_${c.key}`} min={0} max={100} defaultValue={c.weight} disabled={!canEdit} aria-label={`Poids ${CRIT_LABEL[c.key]}`} className="min-h-10 w-24 rounded border border-slate-300 px-2" /></Td></tr>
          ))}</tbody></TableWrap>
        <div className="grid gap-4 sm:grid-cols-2"><TextField name="hot" label="Seuil « chaud » (score ≥)" type="number" min={1} max={100} defaultValue={th.hot} required /><TextField name="warm" label="Seuil « tiède » (score ≥)" type="number" min={0} max={99} defaultValue={th.warm} required /></div>
        <CheckField name="autoQualify" label="Qualifier automatiquement chaque nouveau lead (et passer les leads « chauds » à « Qualifié »)" defaultChecked={cfg?.autoQualify ?? true} />
        <CheckField name="useAi" label="Affiner avec l'IA lorsque c'est possible" defaultChecked={cfg?.useAi ?? false} help="Nécessite un fournisseur d'IA. Les ajustements de l'IA sont toujours présentés comme des inférences." />
        {canEdit && <SubmitButton>Enregistrer</SubmitButton>}
      </ActionForm>
    </Section>
  );
}

async function ApiKeys({ workspaceId, canManage, slug }: { workspaceId: string; canManage: boolean; slug: string }) {
  const keys = await db.apiKey.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } });
  return (
    <div className="space-y-5">
      <Section title="Clés API" description="Pour envoyer des leads depuis un autre outil (serveur à serveur). Ne placez jamais une clé dans un site public.">
        {canManage ? <ApiKeyCreator action={createApiKeyAction} /> : <Alert tone="info">Seuls les administrateurs gèrent les clés API.</Alert>}
        <div className="mt-4">{keys.length === 0 ? <p className="text-sm text-slate-500">Aucune clé.</p> : (
          <TableWrap caption="Clés API"><thead><tr><Th>Nom</Th><Th>Préfixe</Th><Th>Dernier usage</Th><Th>État</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody>{keys.map((k) => <tr key={k.id}><Td>{k.name}</Td><Td><code>{k.prefix}…</code></Td><Td>{fmtDate(k.lastUsedAt, true)}</Td><Td>{k.revokedAt ? <Badge tone="gray">Révoquée</Badge> : <Badge tone="green">Active</Badge>}</Td><Td>{canManage && !k.revokedAt && <InlineAction action={revokeApiKeyAction} variant="danger" hidden={{ id: k.id }} confirm="Révoquer cette clé ? Les appels qui l'utilisent échoueront.">Révoquer</InlineAction>}</Td></tr>)}</tbody></TableWrap>
        )}</div>
      </Section>
      <Card><h2 className="text-base font-semibold">Utilisation</h2>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">{`curl -X POST ${env.appUrl}/api/v1/leads \\
  -H "Authorization: Bearer sp_VOTRE_CLE" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Marie Durand","email":"marie@example.com","message":"Besoin d'un devis",
       "utm_source":"google","utm_campaign":"ID_CAMPAGNE","consent_marketing":false}'`}</pre>
        <p className="mt-2 text-xs text-slate-600">Champs : name (requis), email ou phone (requis), company, message, source, campaign_id, utm_*, custom (objet), value, consent_marketing (true uniquement si vous avez recueilli le consentement). 60 requêtes/minute. Espace : <code>{slug}</code>.</p></Card>
    </div>
  );
}

async function AuditTab({ workspaceId, allowed }: { workspaceId: string; allowed: boolean }) {
  if (!allowed) return <Alert tone="info">Réservé aux administrateurs.</Alert>;
  const logs = await db.auditLog.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: 100 });
  return (
    <Section title="Journal d'audit" description="100 dernières actions importantes de l'espace.">
      {logs.length === 0 ? <p className="text-sm text-slate-500">Aucune entrée.</p> : <TableWrap caption="Journal d'audit"><thead><tr><Th>Date</Th><Th>Action</Th><Th>Objet</Th></tr></thead><tbody>{logs.map((l) => <tr key={l.id}><Td className="whitespace-nowrap text-xs">{fmtDate(l.createdAt, true)}</Td><Td><code className="text-xs">{l.action}</code></Td><Td className="text-xs text-slate-600">{l.entity}{l.entityId ? ` · ${l.entityId.slice(0, 8)}` : ""}</Td></tr>)}</tbody></TableWrap>}
    </Section>
  );
}
