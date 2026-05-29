import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "무료주차 자동등록 | 나이스파크",
  description: "나이스파크 무료주차 일괄 자동등록 관리 시스템",
};

// 모바일 우선: App Router는 viewport를 자동 주입하지 않으므로 명시.
// (없으면 모바일이 데스크톱 폭으로 축소 렌더 → 반응형 무효화)
// maximumScale은 두지 않음 — 저시력 사용자의 확대를 막지 않기 위해(입력 zoom은 globals.css 16px로 억제).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#030712",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body className="bg-gray-950 text-gray-100 min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}
