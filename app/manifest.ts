import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "무료주차 자동등록",
    short_name: "무료주차",
    description: "입차 현황 확인과 무료주차 등록을 안전하게 관리합니다.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#070b13",
    theme_color: "#0b111e",
    orientation: "portrait",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
