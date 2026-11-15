import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Routine OS | مدیریت هوشمند زندگی",
    short_name: "Routine OS",
    description: "برنامه‌ریز شخصی برای مدیریت فعالیت‌ها، عادت‌ها، اهداف و زمان روزانه",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#f6f7fb",
    theme_color: "#6658e8",
    lang: "fa",
    dir: "rtl",
    categories: ["productivity", "lifestyle", "utilities"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
