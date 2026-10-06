import type { Workspace } from "@prisma/client";
import type { WorkspaceBrief } from "./prompts";

export const briefOf = (w: Pick<Workspace, "name" | "industry" | "country" | "language" | "description" | "website" | "currency">): WorkspaceBrief => ({
  name: w.name, industry: w.industry, country: w.country, language: w.language, description: w.description, website: w.website, currency: w.currency,
});
