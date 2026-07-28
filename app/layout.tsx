import type { Metadata, Viewport } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "./axiom-theme.css";
import "./shared-ui.css";
import "./terminal-theme.css";
import { ToastProvider } from "@/components/Toasts";
import { GlobalAlerts } from "@/components/GlobalAlerts";
import { MobileBottomNav } from "@/components/MobileBottomNav";
import { ComplianceFooter } from "@/components/ComplianceFooter";
import { AxiomShell } from "@/components/AxiomShell";
import { UnlockGate } from "@/components/UnlockGate";
import { UiReviewBanner } from "@/components/UiReviewBanner";

const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-display",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "OptiScan — Live scanner & alerts",
  description: "Watch what's moving and get research signals for 0DTE options and extended-hours shares. Not financial advice.",
};

export const viewport: Viewport = {
  themeColor: "#02050a",
  width: "device-width",
  initialScale: 1,
};

const THEME_INIT = `(function(){try{var p=JSON.parse(localStorage.getItem('optiscan:prefs')||'{}');if(p&&p.theme==='light'){document.documentElement.dataset.theme='light';}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`axiom-terminal ${display.variable} ${jetbrains.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        <ToastProvider>
          <UiReviewBanner />
          <AxiomShell>
            <div className="app-shell">
              {children}
            </div>
          </AxiomShell>
          <ComplianceFooter />
          <GlobalAlerts />
          <MobileBottomNav />
          <UnlockGate />
        </ToastProvider>
      </body>
    </html>
  );
}
