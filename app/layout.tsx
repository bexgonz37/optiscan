import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ToastProvider } from "@/components/Toasts";
import { GlobalAlerts } from "@/components/GlobalAlerts";
import { MobileBottomNav } from "@/components/MobileBottomNav";

export const metadata: Metadata = {
  title: "OptiScan — Live scanner & alerts",
  description: "Watch what's moving and get research signals for 0DTE options and extended-hours shares. Not financial advice.",
};

export const viewport: Viewport = {
  themeColor: "#0b0f14",
  width: "device-width",
  initialScale: 1,
};

const THEME_INIT = `(function(){try{var p=JSON.parse(localStorage.getItem('optiscan:prefs')||'{}');if(p&&p.theme==='light'){document.documentElement.dataset.theme='light';}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        <ToastProvider>
          <div className="app-shell">
            {children}
          </div>
          <GlobalAlerts />
          <MobileBottomNav />
        </ToastProvider>
      </body>
    </html>
  );
}
