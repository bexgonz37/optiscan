import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ToastProvider } from "@/components/Toasts";
import { GlobalAlerts } from "@/components/GlobalAlerts";

export const metadata: Metadata = {
  title: "OptiScan — Options Scanner",
  description: "Momentum + unusual options activity scanner powered by Polygon/Massive. Signals only.",
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
          {children}
          <GlobalAlerts />
        </ToastProvider>
      </body>
    </html>
  );
}
