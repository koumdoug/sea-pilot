import type { Audience, Offer } from "@prisma/client";
import { ActionForm, SelectField, SubmitButton, TextAreaField, TextField } from "@/components/forms";
import { CURRENCIES } from "@/lib/constants";
import { saveOfferAction } from "./actions";

export function OfferForm({ offer, audiences, currency }: { offer?: Offer | null; audiences: Audience[]; currency: string }) {
  const adv = Array.isArray(offer?.advantages) ? (offer!.advantages as string[]).join("\n") : "";
  return (
    <ActionForm action={saveOfferAction}>
      {offer && <input type="hidden" name="id" value={offer.id} />}
      <TextField name="name" label="Produit / service" required defaultValue={offer?.name} />
      <TextAreaField name="description" label="Description" rows={3} defaultValue={offer?.description} />
      <TextAreaField name="problem" label="Problème résolu pour le client" rows={2} defaultValue={offer?.problem} />
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField name="price" label="Prix" type="number" min={0} step="0.01" defaultValue={offer?.price} />
        <SelectField name="currency" label="Devise" required defaultValue={offer?.currency ?? currency} options={CURRENCIES} />
        <TextField name="marginPct" label="Marge approximative (%)" type="number" min={0} max={100} step="0.1" defaultValue={offer?.marginPct} />
      </div>
      <TextField name="geoZone" label="Zone géographique" defaultValue={offer?.geoZone} />
      <TextAreaField name="advantages" label="Avantages (un par ligne)" rows={3} defaultValue={adv} />
      <TextAreaField name="differentiation" label="Différenciation" rows={2} defaultValue={offer?.differentiation} />
      <SelectField name="audienceId" label="Audience cible" defaultValue={offer?.audienceId} options={audiences.map((a) => [a.id, `${a.name} (${a.type.toUpperCase()})`] as const)} placeholder="— aucune —" />
      <SubmitButton>{offer ? "Enregistrer" : "Créer l'offre"}</SubmitButton>
    </ActionForm>
  );
}
