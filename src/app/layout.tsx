import type { Metadata, Viewport } from "next";
import "./globals.css";
import { env } from "@/lib/env";

export const metadata: Metadata = {
  metadataBase: new URL(env.appUrl),
  title: { default: "SEA Pilot — L'acquisition client automatisée par l'IA", template: "%s · SEA Pilot" },
  description: "SEA Pilot transforme votre entreprise, votre offre et vos objectifs en un système d'acquisition mesurable : recherche, stratégie, campagnes, landing pages, leads, qualification IA, relances et analytics.",
  openGraph: { type: "website", siteName: "SEA Pilot", locale: "fr_FR" },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#2554e0" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body className="min-h-dvh">
        <a href="#contenu" className="skip-link">Aller au contenu</a>
        {children}
      </body>
    </html>
  );
}
