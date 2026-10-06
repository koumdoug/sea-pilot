import type { MetadataRoute } from "next";
import { env } from "@/lib/env";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: ["/", "/p/"], disallow: ["/api/", "/dashboard", "/settings", "/billing", "/crm", "/leads", "/campaigns", "/offers", "/research", "/analytics", "/automations", "/integrations", "/ai-studio", "/copilot", "/landing-pages", "/onboarding", "/unsubscribe/"] }],
    sitemap: `${env.appUrl}/sitemap.xml`,
  };
}
