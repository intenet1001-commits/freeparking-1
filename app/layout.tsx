import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "무료주차 자동등록 | 나이스파크",
  description: "나이스파크 무료주차 일괄 자동등록 관리 시스템",
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
