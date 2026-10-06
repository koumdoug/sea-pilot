import type { Metadata } from "next";
import { db } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { listIntegrations, type IntegrationState } from "@/lib/integrations/service";
import { PROVIDERS } from "@/lib/integrations/providers";
import { PLATFORM_LABEL } from "@/lib/constants";
import { Alert, Badge, Card, ConfigRequired, LinkButton, PageHeader, Section, TableWrap, Td, Th, fmtDate, type Tone } from "@/components/ui";
import { ActionForm, InlineAction, SelectField, SubmitButton, TextField } from "@/components/forms";
import { connectWithKeyAction, disconnectAction, linkAdCampaignAction, refreshAction, saveConfigAction, syncAction } from "./actions";

export const metadata: Metadata = { title: "Integrations" };
const STATE: Record<IntegrationState, { label: string; tone: Tone }> = {
  needs_config: { label: "Configuration requise", tone: "orange" }, disconnected: { label: "Non connecté", tone: "gray" }, connected: { label: "Connecté", tone: "green" }, error: { label: "Erreur", tone: "red" }, expired: { label: "Session expirée", tone: "orange" },
};
const ERRORS: Record<string, string> = { needs_config: "Ce fournisseur n'est pas configuré sur le serveur (identifiants d'application manquants).", denied: "Autorisation refusée côté fournisseur.", state: "Le retour de connexion est invalide ou a expiré. Réessayez.", forbidden: "Vous n'avez pas la permission de gérer les intégrations.", exchange: "L'échange avec le fournisseur a échoué. Réessayez.", unknown: "Fournisseur inconnu.", nocode: "Aucun code d'autorisation reçu." };

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const list = await listIntegrations(ctx.workspaceId);
  const [adCampaigns, campaigns] = await Promise.all([
    db.adCampaign.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { name: "asc" }, take: 100, include: { campaign: { select: { name: true } } } }),
    db.campaign.findMany({ where: { workspaceId: ctx.workspaceId, status: { not: "archived" } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const canManage = ctx.can("manage_integrations");

  return (
    <>
      <PageHeader title="Intégrations" subtitle="Connectez vos outils. Un fournisseur n'est jamais affiché « connecté » tant que la connexion n'a pas réellement abouti." />
      {sp.connected && <div className="mb-4"><Alert tone="success">Connexion à {PROVIDERS[sp.connected]?.label ?? sp.connected} réussie. Renseignez l'identifiant du compte ci-dessous pour activer la synchronisation.</Alert></div>}
      {sp.error && <div className="mb-4"><Alert tone="error">{ERRORS[sp.error] ?? "La connexion a échoué."}</Alert></div>}
      {!canManage && <div className="mb-4"><Alert tone="info">Seuls les administrateurs peuvent connecter ou déconnecter une intégration.</Alert></div>}

      <ul className="grid gap-4 lg:grid-cols-2">
        {list.map((i) => {
          const p = PROVIDERS[i.provider];
          const st = STATE[i.state];
          const configured = i.state !== "needs_config";
          const connected = i.state === "connected" || i.state === "error" || i.state === "expired";
          return (
            <li key={i.provider}><Card className="h-full" aria-labelledby={`h-${i.provider}`}>
              <div className="flex flex-wrap items-start justify-between gap-2"><div><h2 id={`h-${i.provider}`} className="text-base font-semibold">{i.label}</h2><p className="text-sm text-slate-600">{i.description}</p></div><Badge tone={st.tone}>{st.label}</Badge></div>

              {i.state === "needs_config" && <div className="mt-3"><ConfigRequired env={i.requiredEnv}>Les identifiants de l'application {i.label} ne sont pas définis sur ce serveur : la connexion est impossible tant que l'administrateur de SEA Pilot ne les a pas ajoutés (voir README, section Intégrations).</ConfigRequired></div>}

              {connected && <div className="mt-3 space-y-2 text-sm">
                {i.accountName && <p>Compte : <strong>{i.accountName}</strong></p>}
                <p className="text-xs text-slate-500">Connecté le {fmtDate(i.connectedAt)}{i.lastSyncAt ? ` · dernière synchro ${fmtDate(i.lastSyncAt, true)}` : ""}</p>
                {i.lastError && <Alert tone="error">{i.lastError}</Alert>}
                {i.state === "expired" && <Alert tone="warning">La session a expirée : reconnectez le compte.</Alert>}
              </div>}

              {canManage && configured && (
                <div className="mt-4 space-y-3">
                  {i.state !== "connected" && i.authType === "oauth" && <LinkButton href={`/api/integrations/${i.provider}/connect`} variant="primary">{connected ? "Reconnecter" : "Connecter"} {i.label}</LinkButton>}
                  {i.authType === "api_key" && i.state !== "connected" && (
                    <ActionForm action={connectWithKeyAction}><input type="hidden" name="provider" value={i.provider} />
                      {i.fields.map((f) => <TextField key={f.key} name={f.key} label={f.label} required={f.required} type={f.secret ? "password" : "text"} placeholder={f.placeholder} autoComplete="off" />)}
                      <SubmitButton pendingLabel="Vérification de la clé…">Vérifier et connecter</SubmitButton></ActionForm>
                  )}
                  {i.authType === "oauth" && connected && i.fields.length > 0 && (
                    <ActionForm action={saveConfigAction}><input type="hidden" name="provider" value={i.provider} />
                      {i.fields.map((f) => <TextField key={f.key} name={f.key} label={f.label} required={f.required} placeholder={f.placeholder} defaultValue={String(i.config[f.key] ?? "")} />)}
                      <SubmitButton variant="secondary" pendingLabel="Vérification…">Enregistrer et vérifier</SubmitButton></ActionForm>
                  )}
                  {connected && <div className="flex flex-wrap gap-2">
                    <InlineAction action={refreshAction} hidden={{ provider: i.provider }}>Vérifier la connexion</InlineAction>
                    {p.fetchMetrics && i.state === "connected" && <InlineAction action={syncAction} variant="primary" hidden={{ provider: i.provider }}>Synchroniser (30 jours)</InlineAction>}
                    <InlineAction action={disconnectAction} variant="danger" hidden={{ provider: i.provider }} confirm="Déconnecter cette intégration ? Les identifiants stockés seront supprimés.">Déconnecter</InlineAction>
                  </div>}
                </div>
              )}
            </Card></li>
          );
        })}
      </ul>

      <div className="mt-8">
        <Section title="Campagnes des plateformes publicitaires" description="Associez chaque campagne synchronisée à une campagne SEA Pilot pour relier dépenses, leads et clients.">
          {adCampaigns.length === 0 ? <p className="text-sm text-slate-500">Aucune campagne synchronisée. Connectez une plateforme publicitaire puis lancez une synchronisation.</p> : (
            <TableWrap caption="Campagnes des plateformes"><thead><tr><Th>Campagne plateforme</Th><Th>Plateforme</Th><Th>Associée à</Th></tr></thead>
              <tbody>{adCampaigns.map((a) => (
                <tr key={a.id}><Td>{a.name}</Td><Td>{PLATFORM_LABEL[a.platform] ?? a.platform}</Td>
                  <Td>{canManage ? <ActionForm action={linkAdCampaignAction} className="flex flex-wrap items-end gap-2 !space-y-0"><input type="hidden" name="adCampaignId" value={a.id} />
                    <SelectField name="campaignId" label="Campagne" defaultValue={a.campaignId} options={campaigns.map((c) => [c.id, c.name] as const)} placeholder="— non associée —" /><SubmitButton size="sm" variant="secondary">OK</SubmitButton></ActionForm> : a.campaign?.name ?? "—"}</Td></tr>
              ))}</tbody></TableWrap>
          )}
        </Section>
      </div>
      <p className="mt-4 text-xs text-slate-500">Meta Pixel, Google Tag, TikTok Pixel et LinkedIn Insight Tag ne sont pas disponibles pour l'instant. Le suivi des paramètres UTM, des visites de landing pages et des leads est, lui, pleinement opérationnel.</p>
    </>
  );
}
