/** Offres proposées par défaut dans AI Studio : les offres archivées sont exclues, sauf celle de la campagne sélectionnée (conservée pour ne pas casser son contexte). */
export function selectableOffers<T extends { id: string; status: string }>(offers: T[], keepId?: string | null): T[] {
  return offers.filter((o) => o.status !== "archived" || o.id === keepId);
}

/** Offre présélectionnée : celle de la campagne si elle est proposée, sinon la première offre proposée. */
export function defaultOfferId(choices: { id: string }[], campaignOfferId?: string | null): string | undefined {
  return choices.find((o) => o.id === campaignOfferId)?.id ?? choices[0]?.id;
}
