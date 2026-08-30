"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("freeparking page error", error);
  }, [error]);

  function recover() {
    reset();
    window.location.replace("/");
  }

  return (
    <main className="fp-intro flex min-h-[100dvh] items-center justify-center p-4 sm:p-8">
      <section className="fp-access-panel relative z-10 w-full max-w-md text-center" aria-labelledby="error-title">
        <div className="fp-brand-mark mx-auto" aria-hidden="true">
          <AlertTriangle className="h-7 w-7" />
        </div>
        <p className="fp-eyebrow justify-center">Recovery mode</p>
        <h1 id="error-title" className="fp-intro-title">화면을 다시 연결할게요.</h1>
        <p className="fp-intro-copy mx-auto">
          홈 화면에 저장된 이전 버전 정보 때문에 연결이 끊겼을 수 있습니다.
        </p>
        <button type="button" onClick={recover} className="fp-primary-button mt-8 w-full">
          <RefreshCw className="h-4 w-4" />
          최신 화면으로 다시 열기
        </button>
      </section>
    </main>
  );
}
