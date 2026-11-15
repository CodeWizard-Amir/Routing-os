"use client";

import { Download, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

export default function PwaInstallButton() {
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);

  useEffect(() => {
    const standalone = window.matchMedia("(display-mode: standalone)").matches
      || ("standalone" in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone));
    setIsInstalled(standalone);

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      setIsInstalled(true);
      setInstallPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);

    // Service workers are enabled for production builds. Use `npm run build && npm run start`
    // when testing installation; registering during Next.js dev can interfere with HMR.
    if ("serviceWorker" in navigator) {
      if (process.env.NODE_ENV === "production") {
        navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error) => {
          console.error("Routine OS service worker registration failed:", error);
        });
      } else {
        // Avoid an old production cache intercepting Next.js development/HMR requests.
        void navigator.serviceWorker.getRegistrations().then((registrations) => {
          registrations
            .filter((registration) => registration.active?.scriptURL.endsWith("/sw.js"))
            .forEach((registration) => void registration.unregister());
        });
      }
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = async () => {
    if (isInstalled) return;

    if (installPrompt) {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === "accepted") setInstallPrompt(null);
      return;
    }

    const isIOS = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
    if (isIOS) {
      window.alert("برای نصب روی iPhone یا iPad: در Safari دکمه Share را بزن، سپس گزینه Add to Home Screen را انتخاب کن.");
      return;
    }

    window.alert("برای نصب برنامه، منوی مرورگر Chrome را باز کن و گزینه Install app یا Add to Home Screen را انتخاب کن. برای نصب باید برنامه با HTTPS یا روی localhost باز شده باشد.");
  };

  if (isInstalled) return null;

  return (
    <button className="pwa-install-button" type="button" onClick={() => void install()} title="نصب Routine OS روی دستگاه">
      {installPrompt ? <Download size={15} /> : <Smartphone size={15} />}
      <span>نصب اپ</span>
    </button>
  );
}
