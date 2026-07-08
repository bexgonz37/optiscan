import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./axiom-theme.css";
import { ToastProvider } from "@/components/Toasts";
import { GlobalAlerts } from "@/components/GlobalAlerts";
import { MobileBottomNav } from "@/components/MobileBottomNav";
import { ComplianceFooter } from "@/components/ComplianceFooter";
import { AxiomShell } from "@/components/AxiomShell";

export const metadata: Metadata = {
  title: "OptiScan — Live scanner & alerts",
  description: "Watch what's moving and get research signals for 0DTE options and extended-hours shares. Not financial advice.",
};

export const viewport: Viewport = {
  themeColor: "#05080f",
  width: "device-width",
  initialScale: 1,
};

const THEME_INIT = `(function(){try{var p=JSON.parse(localStorage.getItem('optiscan:prefs')||'{}');if(p&&p.theme==='light'){document.documentElement.dataset.theme='light';}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="axiom-terminal">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <ToastProvider>
          <AxiomShell>
            <div className="app-shell">
              {children}
            </div>
          </AxiomShell>
          <ComplianceFooter />
          <GlobalAlerts />
          <MobileBottomNav />
        </ToastProvider>
      </body>
    </html>
  );
}
