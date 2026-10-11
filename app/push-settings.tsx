'use client';

import { useEffect, useState } from 'react';
import { Bell, BellOff, Loader2 } from 'lucide-react';

type Mode = 'loading' | 'unsupported' | 'unconfigured' | 'off' | 'on' | 'denied' | 'busy';

function appInstalled(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

function applicationServerKey(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

export default function PushSettings() {
  const [mode, setMode] = useState<Mode>('loading');
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function initialize() {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        setMode('unsupported');
        return;
      }
      try {
        const response = await fetch('/api/push/subscription', { cache: 'no-store' });
        if (!response.ok) throw new Error('알림 설정을 확인하지 못했습니다.');
        const config = await response.json();
        if (!config.publicKey) { setMode('unconfigured'); return; }
        const registration = await navigator.serviceWorker.register('/push-sw.js');
        const subscription = await registration.pushManager.getSubscription();
        if (cancelled) return;
        setPublicKey(config.publicKey);
        if (subscription) {
          // Restore the server record if the database was reset while the browser kept its subscription.
          const sync = await fetch('/api/push/subscription', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(subscription.toJSON()),
          });
          if (!sync.ok) throw new Error('알림 구독을 서버에 연결하지 못했습니다. 다시 켜주세요.');
        }
        setMode(Notification.permission === 'denied' ? 'denied' : subscription ? 'on' : 'off');
      } catch (error) {
        if (!cancelled) {
          setMode('off');
          setMessage(error instanceof Error ? error.message : '알림 설정 오류');
        }
      }
    }
    void initialize();
    return () => { cancelled = true; };
  }, []);

  async function enable() {
    if (!publicKey) return;
    setMode('busy');
    setMessage('');
    try {
      // Permission is requested only from this button's user gesture.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { setMode('denied'); return; }
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationServerKey(publicKey),
        });
      }
      const response = await fetch('/api/push/subscription', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subscription.toJSON()),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || '서버에 알림 구독을 저장하지 못했습니다.');
      }
      setMode('on');
      setMessage('오류와 일요일 10:30 작동 상태·12:00 처리 결과를 이 기기로 알려드립니다.');
    } catch (error) {
      setMode('off');
      setMessage(error instanceof Error ? error.message : '알림을 켜지 못했습니다.');
    }
  }

  async function disable() {
    setMode('busy');
    setMessage('');
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const response = await fetch('/api/push/subscription', {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        if (!response.ok) throw new Error('서버에서 알림을 해제하지 못했습니다.');
        await subscription.unsubscribe();
      }
      setMode('off');
      setMessage('이 기기의 알림을 껐습니다.');
    } catch (error) {
      setMode('on');
      setMessage(error instanceof Error ? error.message : '알림을 끄지 못했습니다.');
    }
  }

  async function sendTest() {
    setMode('busy');
    setMessage('');
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) throw new Error('이 기기의 알림 구독이 없습니다.');
      const response = await fetch('/api/push/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      if (!response.ok) throw new Error('테스트 알림 발송에 실패했습니다.');
      setMessage('테스트 알림을 보냈습니다. 아이폰 알림을 확인해주세요.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '테스트 알림 오류');
    } finally {
      setMode('on');
    }
  }

  return (
    <section className="fp-panel rounded-2xl px-5 py-4" aria-label="아이폰 알림">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          {mode === 'on' ? <Bell className="h-5 w-5 text-emerald-400 shrink-0" />
            : <BellOff className="h-5 w-5 text-slate-400 shrink-0" />}
          <div>
            <h2 className="text-sm font-semibold text-slate-100">주차 알림</h2>
            <p className="mt-1 text-xs leading-5 text-slate-400">
              {mode === 'on' ? '오류와 일요일 10:30 상태·12:00 처리 결과 알림 켜짐'
                : mode === 'unconfigured' ? '서버 알림 설정 준비 중'
                : mode === 'denied' ? '아이폰 설정에서 알림 권한을 허용해주세요.'
                : mode === 'unsupported' ? '이 브라우저에서는 알림을 사용할 수 없습니다. 아이폰은 홈 화면에 추가한 뒤 열어주세요.'
                : '오류와 일요일 10:30 상태·12:00 처리 결과를 알려드립니다.'}
            </p>
          </div>
        </div>
        {mode === 'busy' || mode === 'loading' ? <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
          : mode === 'on' ? <div className="flex gap-1">
              <button className="fp-utility-button" onClick={sendTest}>테스트</button>
              <button className="fp-utility-button" onClick={disable}>끄기</button>
            </div>
          : mode === 'off' ? <button className="fp-utility-button" onClick={enable}>알림 켜기</button>
          : null}
      </div>
      {mode === 'off' && !appInstalled() && <p className="mt-2 text-xs text-amber-300">아이폰은 홈 화면에 추가한 앱에서 알림을 켤 수 있습니다.</p>}
      {message && <p role="status" className="mt-2 text-xs text-slate-300">{message}</p>}
    </section>
  );
}
