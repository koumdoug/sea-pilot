import type { IntegrationProviderId } from "../constants";

export type Credentials = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number; // epoch ms
  apiKey?: string;
  from?: string;
  [k: string]: unknown;
};

export type MetricRow = {
  externalCampaignId: string;
  campaignName: string;
  date: string; // YYYY-MM-DD (UTC)
  spend: number;
  impressions: number;
  clicks: number;
  externalAccountId?: string;
};

export type DateRange = { from: string; to: string }; // YYYY-MM-DD

export type ConnectResult = { credentials: Credentials; accountName?: string; externalAccountId?: string; config?: Record<string, unknown> };

export interface IntegrationProvider {
  id: IntegrationProviderId;
  label: string;
  description: string;
  category: "analytics" | "ads" | "email";
  authType: "oauth" | "api_key";
  /** variables d'environnement serveur à définir pour que la connexion soit possible */
  requiredEnv: string[];
  /** champs à saisir par l'utilisateur (config requise après connexion ou clé API) */
  fields?: { key: string; label: string; secret?: boolean; placeholder?: string; required?: boolean }[];
  isConfigured(): boolean;
  authUrl?(state: string, redirectUri: string): string;
  exchangeCode?(code: string, redirectUri: string): Promise<ConnectResult>;
  connectWithKey?(input: Record<string, string>): Promise<ConnectResult>;
  refresh?(c: Credentials): Promise<Credentials>;
  /** valide que les identifiants fonctionnent encore (retourne un message d'erreur sinon) */
  check?(c: Credentials, config: Record<string, unknown>): Promise<void>;
  /** données publicitaires par jour et par campagne */
  fetchMetrics?(c: Credentials, config: Record<string, unknown>, range: DateRange): Promise<MetricRow[]>;
}

export class IntegrationError extends Error {
  constructor(message: string, public expired = false) {
    super(message);
  }
}
