"use client";

import { useState, useEffect, useRef } from "react";
import {
  Car,
  Plus,
  Trash2,
  Play,
  CheckCircle,
  XCircle,
  Loader2,
  Settings,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  MinusCircle,
  Pencil,
  ClipboardList,
  Copy,
  Check,
  Search,
  Share2,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  Eye,
  EyeOff,
} from "lucide-react";
import clsx from "clsx";
import { supabase } from "@/lib/supabase";

type CarEntry = {
  id: string;
  plate: string;
  label: string;
  selected: boolean;
  ticketChoice?: string; // 선호 권종 dCode (미지정=종일권 기본)
};

type Candidate = {
  plate: string;
  imageUrl?: string;
};

type CarStatus = {
  status: 'not_entered' | 'entered' | 'registered' | 'no_quota' | 'multi_car' | 'error';
  message: string;
  checkedAt?: number;
  isLast?: boolean; // fp_logs 기반 마지막 기록
  entryTime?: string;
  entryAt?: string; // ISO+09:00 — 경과시간 계산용
  appliedName?: string;
  appliedKind?: 'allDay' | 'hourly';
  quotaAllDay?: number;
  quotaHourly?: number;
  exitedAfterRegistration?: boolean; // 등록완료 후 출차한 경우 (registered→not_entered 전환 감지)
};

// 차량별 선택 가능 권종 (실측 dCode). 종일권 기본.
const TICKET_OPTIONS: { dCode: string; label: string }[] = [
  { dCode: "00005", label: "종일권" },
  { dCode: "00004", label: "1시간30분" },
  { dCode: "00002", label: "1시간" },
  { dCode: "00001", label: "30분" },
];
const PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://freeparking-1.vercel.app/";
// 입차시각(ISO) → "N시간 M분 경과" / "M분 경과". now(epoch)는 부모 타이머가 주입.
// epoch 차이만 쓰므로 표시 단말 타임존과 무관.
function formatElapsed(entryAtISO?: string, now?: number): string | null {
  if (!entryAtISO || !now) return null;
  const start = new Date(entryAtISO).getTime();
  if (Number.isNaN(start)) return null;
  let mins = Math.floor((now - start) / 60000);
  if (mins < 0) mins = 0;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}시간 ${m}분 경과` : `${m}분 경과`;
}

function formatTimeWithDay(tsMs: number): string {
  const d = new Date(tsMs);
  const day = d.toLocaleDateString("ko-KR", { weekday: "narrow", timeZone: "Asia/Seoul" });
  const time = d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Seoul" });
  return `${day} ${time}`;
}

type LogEntry = {
  id: string;
  plate: string;
  status: "pending" | "running" | "success" | "failed" | "duplicate" | "skipped" | "needs_selection" | "not_entered";
  message: string;
  ts: number;
  candidates?: Candidate[];
};

export default function Home() {
  const [authed, setAuthed] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [pwInput, setPwInput] = useState("");
  const [pwError, setPwError] = useState(false);
  const [pwErrorMessage, setPwErrorMessage] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [cars, setCars] = useState<CarEntry[]>([]);
  const [newPlate, setNewPlate] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [showBulk, setShowBulk] = useState(false);
  const [showAddCar, setShowAddCar] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [appShared, setAppShared] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPlate, setEditPlate] = useState("");
  const [editLabel, setEditLabel] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState({ url: "", id: "", pw: "" });
  const [serverSettingsReady, setServerSettingsReady] = useState(false);
  const [now, setNow] = useState(0); // 경과시간 실시간 갱신용 (0=미초기화)
  const [statusMap, setStatusMap] = useState<Record<string, CarStatus>>({});
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const initialStatusLoaded = useRef(false);

  useEffect(() => {
    fetch("/api/auth", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        setAuthed(data.authenticated === true);
        setServerSettingsReady(data.parkingConfigured === true);
      })
      .catch(() => setAuthed(false))
      .finally(() => setAuthReady(true));
  }, []);

  useEffect(() => {
    if (!pendingDeleteId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPendingDeleteId(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pendingDeleteId]);

  // 경과시간 타이머: 차량 수와 무관하게 단일 setInterval. 화면 복귀 시 즉시 갱신.
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const iv = setInterval(tick, 60000);
    const onVis = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(iv); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  useEffect(() => {
    if (!authed) return;
    // 자격증명은 브라우저 DB 응답에 싣지 않는다. 차량과 권종만 최소 컬럼으로 분리 조회.
    const local = localStorage.getItem('freeparking_settings');
    if (local) {
      try {
        const saved = JSON.parse(local);
        setSettings({
          url: typeof saved?.url === 'string' ? saved.url : '',
          id: typeof saved?.id === 'string' ? saved.id : '',
          pw: '',
        });
      } catch {}
    }
    Promise.all([
      supabase
      .from("fp_cars")
      .select("id, plate, label, created_at")
      .neq("plate", "__settings__")
      .neq("plate", "__ticketchoices__")
      .order("created_at"),
      supabase
        .from("fp_cars")
        .select("label")
        .eq("plate", "__ticketchoices__")
        .maybeSingle(),
    ]).then(([carsResult, choicesResult]) => {
        const data = carsResult.data;
        if (!data) {
          if (carsResult.error) setToast({ msg: '차량 목록을 불러오지 못했습니다.', ok: false });
          return;
        }
        let choiceMap: Record<string, string> = {};
        const tcRow = choicesResult.data;
        if (tcRow?.label) { try { choiceMap = JSON.parse(tcRow.label); } catch {} }
        setCars(
          data.map((r) => ({ ...r, selected: false, ticketChoice: choiceMap[r.id] }))
        );
      });
  }, [authed]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  // 차량 목록 첫 로드 시: 설정 완료면 즉시 라이브 조회, 미설정이면 fp_logs 기록 복원
  useEffect(() => {
    if (cars.length > 0 && !initialStatusLoaded.current) {
      initialStatusLoaded.current = true;
      if (serverSettingsReady || (settings.url && settings.id && settings.pw)) {
        runStatusCheck();
      } else {
        loadLastStatus();
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cars.length]);

  async function addCar() {
    const plate = newPlate.trim().toUpperCase();
    if (!plate) return;
    if (cars.find((c) => c.plate === plate)) {
      setToast({ msg: '이미 등록된 차량번호입니다.', ok: false });
      return;
    }
    const { data, error } = await supabase
      .from("fp_cars")
      .insert({ plate, label: newLabel.trim() })
      .select()
      .single();
    if (error) {
      setToast({ msg: `추가 실패: ${error.message}`, ok: false });
      return;
    }
    if (data) setCars((prev) => [...prev, { ...data, selected: false }]);
    setNewPlate("");
    setNewLabel("");
  }

  function parseBulkInput(text: string): { plate: string; label: string }[] {
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        // 한국 번호판 패턴 추출 (예: 325무9913, 12가3456, 서울 가 1234)
        const plateMatch = line.match(
          /([0-9]{2,3}\s*[가-힣]\s*[0-9]{4}|[가-힣]{2}\s*[0-9]{2}\s*[가-힣]\s*[0-9]{4})/
        );
        if (plateMatch) {
          const plate = plateMatch[1].replace(/\s/g, "").toUpperCase();
          const label = line.replace(plateMatch[0], "").trim();
          return { plate, label };
        }
        // 패턴 미일치 시 첫 토큰을 번호판으로
        const parts = line.split(/\s+/);
        return {
          plate: parts[0].replace(/\s/g, "").toUpperCase(),
          label: parts.slice(1).join(" ").trim(),
        };
      })
      .filter(({ plate }) => plate.length >= 4);
  }

  async function handleBulkAdd() {
    const rawEntries = parseBulkInput(bulkText);
    if (rawEntries.length === 0) return;
    // 붙여넣기 내 중복 제거 (plate 기준)
    const seen = new Set<string>();
    const entries = rawEntries.filter((e) => { if (seen.has(e.plate)) return false; seen.add(e.plate); return true; });
    const newCars = entries.filter((e) => !cars.find((c) => c.plate === e.plate));
    const dupes = entries.filter((e) => cars.find((c) => c.plate === e.plate)).map((e) => e.plate);
    if (newCars.length > 0) {
      const { error } = await supabase
        .from("fp_cars")
        .upsert(
          newCars.map((c) => ({ plate: c.plate, label: c.label })),
          { onConflict: "plate", ignoreDuplicates: true }
        );
      if (error) {
        setToast({ msg: `일괄 추가 실패: ${error.message}`, ok: false });
        return;
      }
      // 자격증명 특수행이 브라우저 응답에 포함되지 않도록 최소 컬럼만 재조회.
      const { data } = await supabase
        .from("fp_cars")
        .select("id, plate, label, created_at")
        .neq("plate", "__settings__")
        .neq("plate", "__ticketchoices__")
        .order("created_at");
      if (data) {
        const choiceMap = Object.fromEntries(cars.map((car) => [car.id, car.ticketChoice]));
        setCars(
          data.map((r) => ({ ...r, selected: false, ticketChoice: choiceMap[r.id] }))
        );
      }
    }
    setBulkText("");
    setShowBulk(false);
    if (dupes.length > 0) setToast({ msg: `이미 등록된 번호: ${dupes.join(', ')}`, ok: false });
  }

  async function removeCar(id: string) {
    const { error } = await supabase.from("fp_cars").delete().eq("id", id);
    if (error) {
      setToast({ msg: `삭제 실패: ${error.message}`, ok: false });
      return;
    }
    setCars((prev) => {
      const next = prev.filter((c) => c.id !== id);
      return next;
    });
  }

  async function updateCar(id: string) {
    const plate = editPlate.trim().toUpperCase();
    const label = editLabel.trim();
    if (!plate) return;
    const { error } = await supabase.from("fp_cars").update({ plate, label }).eq("id", id);
    if (error) {
      setToast({ msg: `수정 실패: ${error.message}`, ok: false });
      return;
    }
    setCars((prev) => prev.map((c) => c.id === id ? { ...c, plate, label } : c));
    setEditingId(null);
  }

  async function saveTicketChoice(id: string, dCode: string) {
    const previousChoice = cars.find((car) => car.id === id)?.ticketChoice;
    const nextCars = cars.map((car) => car.id === id ? { ...car, ticketChoice: dCode } : car);
    setCars(nextCars);
    const choiceMap = Object.fromEntries(
      nextCars.map((car) => [car.id, car.ticketChoice ?? "00005"])
    );
    const { error } = await supabase
      .from("fp_cars")
      .upsert(
        { plate: "__ticketchoices__", label: JSON.stringify(choiceMap) },
        { onConflict: "plate" }
      );
    if (error) {
      setCars((prev) => prev.map((car) => car.id === id ? { ...car, ticketChoice: previousChoice } : car));
      setToast({ msg: `권종 저장 실패: ${error.message}`, ok: false });
    }
  }

  function toggleCar(id: string) {
    setCars((prev) =>
      prev.map((c) => (c.id === id ? { ...c, selected: !c.selected } : c))
    );
  }

  function toggleAll(val: boolean) {
    setCars((prev) => prev.map((c) => ({ ...c, selected: val })));
  }

  async function saveSettings() {
    if (!settings.url.trim() || !settings.id.trim() || !settings.pw) {
      setToast({ msg: 'URL·아이디·비밀번호를 모두 입력해주세요.', ok: false });
      return;
    }
    // 관리자 비밀번호는 브라우저 저장소에 남기지 않고 현재 탭의 메모리에서만 사용한다.
    localStorage.setItem('freeparking_settings', JSON.stringify({ url: settings.url, id: settings.id }));
    setToast({ msg: '설정 저장 완료 · 비밀번호는 브라우저에 저장하지 않습니다.', ok: true });
    setShowSettings(false);
  }

  function applyStatusAndAutoSelect(newMap: Record<string, CarStatus>, mode: 'auto' | 'clear' = 'auto') {
    setStatusMap((previous) => mode === 'clear' ? newMap : { ...previous, ...newMap });
    // 'auto'(라이브 현황조회): 입차중(등록전) 차량 자동 선택 + 경과시간 기반 권종 자동 추천.
    // 'clear'(fp_logs 기록 복원): 선택 모두 해제 + 권종 추천 안 함.
    setCars((prev) => prev.map((c) => {
      const st = newMap[c.plate];
      let ticketChoice = c.ticketChoice;
      // 입차중(등록전) 차량: 종일권 기본.
      if (mode === 'auto' && st?.status === 'entered' && !c.ticketChoice) {
        {
          ticketChoice = '00005'; // 종일권
        }
      }
      return {
        ...c,
        ticketChoice,
        selected: mode === 'auto'
          ? st ? st.status === 'entered' : c.selected
          : false,
      };
    }));
  }

  async function runStatusCheck() {
    const plates = cars.map((c) => c.plate);
    if (plates.length === 0) return;
    if (!settingsReady) {
      setShowSettings(true);
      setToast({ msg: '먼저 주차 시스템 설정을 완료해주세요.', ok: false });
      return;
    }
    setCheckingStatus(true);

    // fp_logs에서 당일 등록완료 여부 조회 (KST 자정 기준 — 전날 기록으로 오판 방지)
    const kstTodayStart = `${new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)}T00:00:00+09:00`;
    const { data: logRows } = await supabase
      .from("fp_logs")
      .select("plate, status")
      .in("plate", plates)
      .in("status", ["success", "skipped", "duplicate"])
      .gte("created_at", kstTodayStart)
      .order("created_at", { ascending: false })
      .limit(plates.length * 5);
    const lastRegisteredPlates = new Set<string>();
    for (const row of logRows ?? []) {
      lastRegisteredPlates.add(row.plate);
    }

    const collected: Record<string, CarStatus> = {};
    try {
      const resp = await fetch("/api/check-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plates, settings }),
      });
      if (resp.status === 401) {
        setAuthed(false);
        throw new Error('로그인이 만료되었습니다. 다시 로그인해주세요.');
      }
      await readSSE(resp, (data) => {
        if (data.done || !data.plate) return;
        const plate = data.plate as string;
        const newStatus = data.status as CarStatus["status"];
        // 최근 등록완료 기록이 있는 차량이 미입차 → 출차완료
        const exitedAfterRegistration =
          newStatus === 'not_entered' && lastRegisteredPlates.has(plate);
        collected[plate] = {
          status: newStatus,
          message: data.message as string,
          checkedAt: Date.now(),
          entryTime: data.entryTime as string | undefined,
          entryAt: data.entryAt as string | undefined,
          appliedName: data.appliedName as string | undefined,
          appliedKind: data.appliedKind as 'allDay' | 'hourly' | undefined,
          quotaAllDay: data.quotaAllDay as number | undefined,
          quotaHourly: data.quotaHourly as number | undefined,
          exitedAfterRegistration: exitedAfterRegistration || undefined,
        };
        setStatusMap({ ...collected });
      });
    } catch (e) {
      console.error(e);
    } finally {
      setCheckingStatus(false);
      // 결과가 하나라도 있을 때만 반영/자동선택. 조회 실패(빈 결과) 시 기존 상태·수동 선택 보존.
      if (Object.keys(collected).length > 0) {
        applyStatusAndAutoSelect(collected);
      } else {
        setToast({ msg: '현황 조회 실패 — 네트워크/설정을 확인하세요 (선택 유지됨)', ok: false });
      }
    }
  }

  async function loadLastStatus() {
    const plates = cars.map((c) => c.plate);
    if (plates.length === 0) return;
    setCheckingStatus(true);
    const { data } = await supabase
      .from("fp_logs")
      .select("plate, status, message, created_at")
      .in("plate", plates)
      .order("created_at", { ascending: false })
      .limit(200);
    if (data) {
      const map: Record<string, CarStatus> = {};
      for (const row of data) {
        if (map[row.plate]) continue;
        if (row.status === "failed") continue; // stale 실패 기록은 복원 안 함 (오류 배지 방지)
        const s = row.status as CarStatus["status"];
        map[row.plate] = {
          status: ["not_entered", "entered", "registered", "no_quota", "multi_car", "error"].includes(s)
            ? s
            : row.status === "success"
            ? "registered"
            : row.status === "skipped" || row.status === "duplicate"
            ? "registered"
            : "not_entered",
          message: row.message,
          checkedAt: new Date(row.created_at).getTime(),
          isLast: true,
        };
      }
      applyStatusAndAutoSelect(map, 'clear');
    }
    setCheckingStatus(false);
  }

  async function readSSE(
    resp: Response,
    onData: (data: Record<string, unknown>) => void
  ) {
    if (!resp.ok) {
      const payload = await resp.json().catch(() => null) as { error?: string } | null;
      throw new Error(payload?.error || `요청 실패 (${resp.status})`);
    }
    const reader = resp.body?.getReader();
    const decoder = new TextDecoder();
    if (!reader) throw new Error("스트림 없음");
    // 청크 경계로 'data:' 라인이 쪼개져도 유실되지 않도록 버퍼 누적 (모바일/프록시 신뢰성)
    let buffer = "";
    let streamError = "";
    const flush = (line: string) => {
      if (!line.startsWith("data: ")) return; // ': ping' 주석 등은 무시
      try {
        const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
        if (typeof data.error === "string") streamError = data.error;
        onData(data);
      } catch {}
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // 마지막 미완성 라인은 다음 read까지 보존
      for (const line of lines) flush(line);
    }
    buffer += decoder.decode();
    for (const line of buffer.split("\n")) flush(line);
    if (streamError) throw new Error(streamError);
  }

  function applyLogUpdate(data: Record<string, unknown>) {
    if (!data.plate) return;
    const plate = data.plate as string;
    const logStatus = data.status as LogEntry["status"];
    setLogs((prev) =>
      prev.map((l) =>
        l.plate === plate
          ? {
              ...l,
              status: logStatus,
              message: data.message as string,
              candidates: data.candidates as Candidate[] | undefined,
              ts: Date.now(),
            }
          : l
      )
    );
    // 등록 완료 시 statusMap 즉시 갱신 (현황 조회 없이 배지 업데이트)
    if (logStatus === 'success' || logStatus === 'skipped' || logStatus === 'duplicate') {
      setStatusMap((prev) => ({
        ...prev,
        [plate]: {
          status: 'registered',
          message: data.message as string,
          checkedAt: Date.now(),
          entryTime: data.entryTime as string | undefined,
          entryAt: data.entryAt as string | undefined,
          appliedName: data.appliedName as string | undefined,
          appliedKind: data.appliedKind as 'allDay' | 'hourly' | undefined,
          // 등록 직후엔 잔여매수 알 수 없음 — 다음 현황조회에서 갱신
          quotaAllDay: prev[plate]?.quotaAllDay,
          quotaHourly: prev[plate]?.quotaHourly,
        },
      }));
    }
    // 미입차 확인 시 배지도 즉시 업데이트 — 이전 "입차중" 배지가 남아 혼동되는 것 방지
    if (logStatus === 'not_entered') {
      setStatusMap((prev) => ({
        ...prev,
        [plate]: {
          status: 'not_entered',
          message: data.message as string,
          checkedAt: Date.now(),
        },
      }));
    }
  }

  function buildLogShareText() {
    const statusLabel: Record<LogEntry["status"], string> = {
      pending: "대기",
      running: "진행중",
      success: "✓ 완료",
      failed: "✗ 실패",
      duplicate: "— 중복",
      skipped: "— 패스",
      needs_selection: "? 선택필요",
      not_entered: "— 입차안됨",
    };
    const now = new Date().toLocaleString("ko-KR");
    const lines = [
      `[무료주차 자동등록 결과] ${now}`,
      "",
      ...logs.map((l) => `${l.plate}  ${statusLabel[l.status]}  ${l.message}`),
      "",
      `성공 ${logs.filter((l) => l.status === "success").length} / 실패 ${logs.filter((l) => l.status === "failed").length} / 중복 ${logs.filter((l) => l.status === "duplicate").length} / 입차안됨 ${logs.filter((l) => l.status === "not_entered").length}`,
    ];
    return lines.join("\n");
  }

  async function shareText(title: string, text: string, url?: string) {
    try {
      if (navigator.share) {
        await navigator.share({ title, text, ...(url ? { url } : {}) });
      } else {
        await navigator.clipboard.writeText([text, url].filter(Boolean).join("\n"));
      }
      return true;
    } catch (error) {
      if ((error as Error)?.name === "AbortError") return false;
      setToast({ msg: '공유하지 못했습니다. 브라우저 권한을 확인해주세요.', ok: false });
      return false;
    }
  }

  async function shareLogs() {
    if (await shareText('무료주차 자동등록 결과', buildLogShareText())) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  async function shareApp() {
    const shared = await shareText(
      '무료주차 자동등록',
      '입차 차량의 현황을 확인하고 무료주차를 빠르게 등록할 수 있어요.',
      PUBLIC_APP_URL
    );
    if (shared) {
      setAppShared(true);
      setTimeout(() => setAppShared(false), 2000);
      if (!navigator.share) setToast({ msg: '고정 앱 주소를 복사했습니다.', ok: true });
    }
  }

  async function runRegistration() {
    const targets = cars.filter((c) => c.selected);
    if (targets.length === 0) {
      setToast({ msg: '등록할 차량을 선택해주세요.', ok: false });
      return;
    }
    const runId = crypto.randomUUID();
    setRunning(true);
    setLogs(
      targets.map((c) => ({
        id: c.id,
        plate: c.plate,
        status: "pending",
        message: "대기 중...",
        ts: Date.now(),
      }))
    );

    try {
      const resp = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cars: targets.map((c) => ({ plate: c.plate, label: c.label, ticketChoice: c.ticketChoice })),
          settings,
          selectedJson: {},
        }),
      });
      if (resp.status === 401) {
        setAuthed(false);
        throw new Error('로그인이 만료되었습니다. 다시 로그인해주세요.');
      }
      await readSSE(resp, applyLogUpdate);
    } catch (e) {
      const message = e instanceof Error ? e.message : '등록 요청에 실패했습니다.';
      setLogs((prev) => prev.map((log) =>
        ["pending", "running"].includes(log.status)
          ? { ...log, status: "failed", message }
          : log
      ));
      setToast({ msg: message, ok: false });
    } finally {
      setRunning(false);
      // 배지는 SSE 결과를 유지한다. 저장 기록으로 최신 조회 결과를 덮어쓰지 않는다.
      setLogs((currentLogs) => {
        const logsToSave = currentLogs.filter(
          (l) => !["pending", "running"].includes(l.status)
        );
        if (logsToSave.length > 0) {
          supabase
            .from("fp_logs")
            .insert(
              logsToSave.map((l) => ({
                run_id: runId,
                plate: l.plate,
                status: l.status,
                message: l.message,
                candidates: l.candidates ?? null,
              }))
            )
            .then(({ error }) => {
              if (error) console.error("로그 저장 실패:", error.message);
            });
        }
        return currentLogs;
      });
    }
  }

  async function handleSelect(plate: string, selectedIndex: number) {
    const car = cars.find((c) => c.plate === plate);
    if (!car) return;

    setLogs((prev) =>
      prev.map((l) =>
        l.plate === plate
          ? { ...l, status: "running", message: "선택 차량 등록 중...", candidates: undefined }
          : l
      )
    );

    try {
      const resp = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cars: [{ plate: car.plate, label: car.label, ticketChoice: car.ticketChoice }],
          settings,
          selectedJson: { [plate]: selectedIndex },
        }),
      });
      if (resp.status === 401) {
        setAuthed(false);
        throw new Error('로그인이 만료되었습니다. 다시 로그인해주세요.');
      }
      await readSSE(resp, applyLogUpdate);
    } catch (e) {
      const message = e instanceof Error ? e.message : '선택 등록에 실패했습니다.';
      setLogs((prev) => prev.map((log) => log.plate === plate
        ? { ...log, status: "failed", message }
        : log));
      setToast({ msg: message, ok: false });
    }
  }

  async function submitPw() {
    const normalizedPassword = pwInput.trim();
    if (!normalizedPassword || authSubmitting) return;
    setAuthSubmitting(true);
    setPwError(false);
    setPwErrorMessage('');
    try {
      const response = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: normalizedPassword }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        setPwError(true);
        setPwErrorMessage(
          typeof data?.error === 'string'
            ? data.error
            : '로그인에 실패했습니다. 네트워크 연결을 확인해주세요.'
        );
        return;
      }
      const data = await response.json();
      setServerSettingsReady(data.parkingConfigured === true);
      setPwInput('');
      setAuthed(true);
    } catch {
      setPwError(true);
    } finally {
      setAuthSubmitting(false);
    }
  }

  async function lockApp() {
    await fetch('/api/auth', { method: 'DELETE' }).catch(() => undefined);
    setAuthed(false);
    setServerSettingsReady(false);
    setPwInput('');
  }

  // 현황 조회 후 주차권 잔여 매수 요약 (시스템 공통값). fp_logs 복원 데이터(isLast)는 제외.
  const quotaSummary = (() => {
    for (const st of Object.values(statusMap)) {
      if (!st.isLast && (st.quotaAllDay !== undefined || st.quotaHourly !== undefined)) {
        return { allDay: st.quotaAllDay, hourly: st.quotaHourly };
      }
    }
    return null;
  })();

  const selectedCount = cars.filter((c) => c.selected).length;
  const settingsReady = serverSettingsReady || Boolean(settings.url && settings.id && settings.pw);
  const registrationDisabled = running || checkingStatus || selectedCount === 0 || !settingsReady;

  if (!authReady) return (
    <div className="fp-intro flex items-center justify-center" aria-label="앱 보안 상태 확인 중">
      <div className="fp-boot-indicator">
        <Loader2 className="h-5 w-5 animate-spin" />
        보안 채널 확인 중
      </div>
    </div>
  );

  if (!authed) return (
    <main className="fp-intro flex min-h-[100dvh] items-center justify-center p-4 sm:p-8">
      {toast && (
        <div role="status" aria-live="polite" className={`fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl px-5 py-3 text-sm font-medium text-white shadow-lg ${toast.ok ? 'bg-emerald-600' : 'bg-rose-500'}`}>
          {toast.msg}
        </div>
      )}
      <div className="fp-orbit fp-orbit-one" aria-hidden="true" />
      <div className="fp-orbit fp-orbit-two" aria-hidden="true" />
      <section className="fp-access-panel relative z-10 w-full max-w-md" aria-labelledby="intro-title">
        <div className="fp-access-topline">
          <span className="fp-system-state"><span /> SYSTEM READY</span>
          <span className="fp-system-code">FP / 02</span>
        </div>

        <div className="fp-brand-mark" aria-hidden="true">
          <Car className="h-7 w-7" />
        </div>
        <p className="fp-eyebrow"><Sparkles className="h-3.5 w-3.5" /> Precision parking control</p>
        <h1 id="intro-title" className="fp-intro-title">주차 등록을<br />가장 정교하게.</h1>
        <p className="fp-intro-copy">
          입차 현황 확인부터 무료주차 등록까지, 안전한 하나의 흐름으로 관리합니다.
        </p>

        <form className="mt-8 space-y-4" onSubmit={(event) => { event.preventDefault(); submitPw(); }}>
          <input
            type="text"
            name="username"
            value="freeparking"
            autoComplete="username"
            readOnly
            tabIndex={-1}
            className="sr-only"
            aria-hidden="true"
          />
          <div className="space-y-2">
            <label htmlFor="app-password" className="fp-field-label">접근 비밀번호</label>
            <div className="relative">
              <input
                id="app-password"
                type={showPw ? "text" : "password"}
                placeholder="비밀번호 입력"
                value={pwInput}
                onChange={(e) => {
                  setPwInput(e.target.value);
                  setPwError(false);
                  setPwErrorMessage('');
                }}
                autoFocus
                autoComplete="current-password"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={pwError}
                aria-describedby={pwError ? "password-error" : undefined}
                suppressHydrationWarning
                className={clsx("fp-input w-full pr-12", pwError && "fp-input-error")}
              />
              <button
                type="button"
                onClick={() => setShowPw((value) => !value)}
                aria-label={showPw ? "비밀번호 숨기기" : "비밀번호 표시"}
                className="absolute inset-y-0 right-0 flex w-12 items-center justify-center text-slate-400 hover:text-cyan-300"
              >
                {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {pwError && <p id="password-error" role="alert" className="text-xs text-rose-300">{pwErrorMessage}</p>}
          </div>
          <button
            type="submit"
            disabled={!pwInput || authSubmitting}
            className="fp-primary-button w-full"
          >
            {authSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            {authSubmitting ? '보안 확인 중...' : '시스템 시작'}
          </button>
        </form>

        <button type="button" onClick={shareApp} className="fp-share-button mt-3 w-full">
          {appShared ? <Check className="h-4 w-4" /> : <Share2 className="h-4 w-4" />}
          {appShared ? '주소 공유 완료' : '로그인 주소 공유하기'}
        </button>

        <div className="fp-trust-line">
          <LockKeyhole className="h-3.5 w-3.5" />
          암호화된 세션 · 30일 안전 로그인
        </div>
      </section>
    </main>
  );

  return (
    <div className="fp-shell min-h-[100dvh] p-4 md:p-8">
      {toast && (
        <div role="status" aria-live="polite" className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl text-sm font-medium text-white shadow-lg ${toast.ok ? 'bg-emerald-600' : 'bg-rose-500'}`}>
          {toast.msg}
        </div>
      )}
      {pendingDeleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setPendingDeleteId(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="delete-title" className="fp-panel rounded-2xl p-6 w-72 space-y-4" onClick={e => e.stopPropagation()}>
            <p id="delete-title" className="text-slate-100 text-sm font-medium text-center">차량을 완전히 삭제할까요?</p>
            <p className="text-gray-400 text-xs text-center">
              {cars.find(c => c.id === pendingDeleteId)?.plate}
              {cars.find(c => c.id === pendingDeleteId)?.label ? ` · ${cars.find(c => c.id === pendingDeleteId)?.label}` : ''}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPendingDeleteId(null)}
                className="flex-1 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm py-2 rounded-lg transition-colors"
              >
                취소
              </button>
              <button
                onClick={() => { removeCar(pendingDeleteId); setPendingDeleteId(null); }}
                className="flex-1 bg-red-600 hover:bg-red-500 text-white text-sm py-2 rounded-lg transition-colors"
              >
                삭제
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="fp-content max-w-2xl mx-auto space-y-6">
        {/* 헤더 */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="fp-brand-mark fp-brand-mark-small">
              <Car className="w-6 h-6" />
            </div>
            <div className="min-w-0">
              <p className="fp-eyebrow mb-1">Control center</p>
              <h1 className="text-base font-bold leading-tight text-slate-100 sm:text-xl">무료주차 자동등록</h1>
              <p className="truncate text-xs text-slate-400">HI PARKING · 의왕 에이스 청계타워</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button onClick={shareApp} className="fp-utility-button" aria-label="앱 공유하기">
              <Share2 className="w-4 h-4" /><span className="hidden sm:inline">공유</span>
            </button>
            <button
              onClick={() => setShowSettings((v) => !v)}
              className="fp-utility-button"
              aria-expanded={showSettings}
              aria-controls="settings-panel"
            >
              <Settings className="w-4 h-4" /><span className="hidden sm:inline">설정</span>
              {showSettings ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
            <button onClick={lockApp} className="fp-utility-button" aria-label="앱 잠그기" title="앱 잠그기">
              <LockKeyhole className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 오류 시 클로드코드 전달 버튼 */}
        {logs.length > 0 && !running && logs.some(l => l.status === "failed") && (
          <ClaudeCodeReportButton logs={logs} settings={settings} />
        )}

        {/* 설정 패널 */}
        {showSettings && (
          <div id="settings-panel" className="fp-panel rounded-2xl p-5 space-y-3">
            <h2 className="text-sm font-semibold text-gray-300">나이스파크 관리자 설정</h2>
            {serverSettingsReady ? (
              <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/10 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-emerald-300">
                  <ShieldCheck className="h-4 w-4" />
                  하이파크 계정 저장 완료
                </div>
                <p className="mt-2 text-xs leading-5 text-slate-400">
                  URL·아이디·비밀번호가 서버에 안전하게 저장되어 있어 앱을 새로 열어도 다시 입력할 필요가 없습니다.
                </p>
              </div>
            ) : <>
            <div className="space-y-2">
              <label htmlFor="parking-url" className="fp-field-label">사이트 URL</label>
              <input
                id="parking-url"
                type="text"
                placeholder="사이트 URL (예: https://parking.nicepark.co.kr/...)"
                value={settings.url}
                onChange={(e) => setSettings((s) => ({ ...s, url: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-2">
                  <label htmlFor="parking-id" className="fp-field-label">관리자 아이디</label>
                  <input
                    id="parking-id"
                    type="text"
                    placeholder="관리자 아이디"
                    value={settings.id}
                    onChange={(e) => setSettings((s) => ({ ...s, id: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-cyan-400"
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="parking-password" className="fp-field-label">관리자 비밀번호</label>
                  <input
                    id="parking-password"
                    type="password"
                    placeholder="비밀번호"
                    value={settings.pw}
                    onChange={(e) => setSettings((s) => ({ ...s, pw: e.target.value }))}
                    className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-cyan-400"
                  />
                </div>
              </div>
            </div>
            <button
              onClick={saveSettings}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium py-2 rounded-lg transition-colors"
            >
              저장
            </button>
            </>}
          </div>
        )}

        {/* 차량 추가 */}
        <div className="fp-panel rounded-2xl overflow-hidden">
          <button
            onClick={() => setShowAddCar((v) => !v)}
            className="w-full flex items-center justify-between px-5 py-4 text-left"
            aria-expanded={showAddCar}
            aria-controls="add-car-panel"
          >
            <h2 className="text-sm font-semibold text-gray-300">차량 추가</h2>
            <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform ${showAddCar ? 'rotate-180' : ''}`} />
          </button>

          {showAddCar && <div id="add-car-panel" className="px-5 pb-5 space-y-3">
            <div className="flex items-center justify-end">
              <button
                onClick={() => setShowBulk((v) => !v)}
                className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                <ClipboardList className="w-3.5 h-3.5" />
                일괄 입력
              </button>
            </div>

          {showBulk ? (
            <div className="space-y-2">
              <label htmlFor="bulk-cars" className="fp-field-label">차량 목록 붙여넣기</label>
              <textarea
                id="bulk-cars"
                rows={6}
                placeholder={"차량번호를 한 줄에 하나씩 붙여넣기\n예:\n325무9913 홍길동\n12가3456\n서울 가 1234 메모"}
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none font-mono"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleBulkAdd}
                  disabled={!bulkText.trim()}
                  className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-600 text-white text-sm font-medium py-2 rounded-lg transition-colors"
                >
                  일괄 추가
                </button>
                <button
                  onClick={() => { setBulkText(""); setShowBulk(false); }}
                  className="px-4 text-sm text-gray-400 hover:text-white transition-colors"
                >
                  취소
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_44px] sm:items-end sm:gap-2">
              <div className="space-y-2">
                <label htmlFor="new-plate" className="fp-field-label">차량번호</label>
              <input
                id="new-plate"
                type="text"
                placeholder="차량번호 (예: 12가3456)"
                value={newPlate}
                onChange={(e) => setNewPlate(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addCar()}
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
              </div>
              <div className="space-y-2">
                <label htmlFor="new-label" className="fp-field-label">메모</label>
              <input
                id="new-label"
                type="text"
                placeholder="메모 (선택)"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addCar()}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
              </div>
              <button
                onClick={addCar}
                className="min-h-11 bg-cyan-500 hover:bg-cyan-400 text-slate-950 px-3 py-2 rounded-lg transition-colors"
                aria-label="차량 추가"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          )}
          </div>}
        </div>

        {/* 차량 목록 */}
        <div className="fp-panel rounded-2xl overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-gray-800">
            <h2 className="text-sm font-semibold text-gray-300">
              차량 목록{" "}
              <span className="text-gray-500 font-normal">
                ({selectedCount}/{cars.length} 선택)
              </span>
            </h2>
            {cars.length > 0 && (
              <div className="flex gap-2">
                <button
                  onClick={() => toggleAll(true)}
                  className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
                >
                  전체선택
                </button>
                <span className="text-gray-700">|</span>
                <button
                  onClick={() => toggleAll(false)}
                  className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                >
                  전체해제
                </button>
              </div>
            )}
          </div>

          {cars.length === 0 ? (
            <div className="px-5 py-10 text-center text-gray-600 text-sm">
              차량번호를 추가해주세요
            </div>
          ) : (
            <div className="divide-y divide-gray-800/50">
              {cars.map((car) => (
                <div
                  key={car.id}
                  className={clsx(
                    "flex items-center gap-3 px-5 py-3 transition-colors",
                    car.selected ? "bg-gray-900" : "bg-gray-950/50"
                  )}
                >
                  <input
                    type="checkbox"
                    checked={car.selected}
                    onChange={() => toggleCar(car.id)}
                    className="w-5 h-5 accent-blue-500 cursor-pointer shrink-0"
                    aria-label={`${car.plate} 등록 선택`}
                  />
                  {editingId === car.id ? (
                    <>
                      <div className="flex-1 flex items-center gap-1.5 min-w-0">
                        <input
                          autoFocus
                          value={editPlate}
                          onChange={(e) => setEditPlate(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") updateCar(car.id); if (e.key === "Escape") setEditingId(null); }}
                          placeholder="차량번호"
                          aria-label={`${car.plate} 차량번호 수정`}
                          className="w-28 bg-gray-800 border border-blue-500 rounded px-2 py-0.5 text-xs font-mono text-white focus:outline-none"
                        />
                        <input
                          value={editLabel}
                          onChange={(e) => setEditLabel(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") updateCar(car.id); if (e.key === "Escape") setEditingId(null); }}
                          placeholder="메모 (선택)"
                          aria-label={`${car.plate} 메모 수정`}
                          className="flex-1 bg-gray-800 border border-gray-600 rounded px-2 py-0.5 text-xs text-white focus:outline-none"
                        />
                      </div>
                      <button
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => updateCar(car.id)}
                        className="text-blue-400 hover:text-blue-300 transition-colors"
                        aria-label={`${car.plate} 수정 저장`}
                      >
                        <Check className="w-4 h-4" />
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-mono font-medium text-white">
                          {car.plate}
                        </span>
                        {car.label && (
                          <span className="text-xs text-gray-500">{car.label}</span>
                        )}
                        {statusMap[car.plate] && (
                          <CarStatusBadge s={statusMap[car.plate]} now={now} />
                        )}
                        {/* 차량별 기본 권종 (저장 → 현황조회 후에도 유지됨) */}
                        <select
                          value={car.ticketChoice ?? "00005"}
                          onChange={(e) => saveTicketChoice(car.id, e.target.value)}
                          title="기본 권종 (저장됨 — 현황조회 후에도 유지)"
                          className="bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-xs text-gray-200 focus:outline-none focus:border-blue-500 cursor-pointer"
                          aria-label={`${car.plate} 기본 권종`}
                        >
                          {TICKET_OPTIONS.map((o) => (
                            <option key={o.dCode} value={o.dCode}>{o.label}</option>
                          ))}
                        </select>
                      </div>
                      <button
                        onClick={() => { setEditingId(car.id); setEditPlate(car.plate); setEditLabel(car.label); }}
                        className="p-2 -m-0.5 text-gray-700 hover:text-gray-400 transition-colors shrink-0"
                        aria-label="차량 수정"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setPendingDeleteId(car.id)}
                        className="p-2 -m-0.5 text-gray-700 hover:text-red-400 transition-colors shrink-0"
                        aria-label="차량 삭제"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 현황 조회 버튼 */}
        {cars.length > 0 && (
          <button
            onClick={runStatusCheck}
            disabled={checkingStatus}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-2xl text-sm font-medium transition-all bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-50 disabled:cursor-not-allowed border border-gray-700"
          >
            {checkingStatus ? (
              <><Loader2 className="w-4 h-4 animate-spin" />조회 중...</>
            ) : (
              <><Search className="w-4 h-4" />현황 조회</>
            )}
          </button>
        )}

        {/* 주차권 잔여 매수 요약 (현황 조회 후에만 표시) */}
        {quotaSummary && !checkingStatus && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-2.5 flex items-center gap-3 text-xs">
            <span className="text-gray-500 font-medium shrink-0">주차권 잔여</span>
            <div className="flex items-center gap-4 flex-wrap">
              {quotaSummary.allDay !== undefined && (
                <span className={quotaSummary.allDay > 0 ? "text-green-400" : "text-gray-600"}>
                  종일권 <span className="font-bold">{quotaSummary.allDay}</span>매
                </span>
              )}
              {quotaSummary.hourly !== undefined && (
                <span className={quotaSummary.hourly > 0 ? "text-blue-400" : "text-gray-600"}>
                  시간권 <span className="font-bold">{quotaSummary.hourly}</span>매
                </span>
              )}
            </div>
          </div>
        )}

        {/* 현황 조회 오류 보고 */}
        {Object.values(statusMap).some(s => s.status === "error") && !checkingStatus && (
          <StatusCheckErrorButton statusMap={statusMap} settings={settings} />
        )}

        {/* 실행 버튼 */}
        <div className="fp-safety-note">
          <ShieldCheck className="h-4 w-4" />
          <span>{checkingStatus ? '현황 갱신이 끝나면 등록할 수 있습니다.' : '선택한 차량만 조회 후 안전하게 등록합니다.'}</span>
        </div>
        <button
          onClick={runRegistration}
          disabled={registrationDisabled}
          className={clsx(
            "w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl font-semibold text-sm transition-all",
            registrationDisabled
              ? "bg-gray-800 text-gray-600 cursor-not-allowed"
              : "fp-primary-button shadow-lg shadow-cyan-950/30"
          )}
        >
          {running ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              등록 중... ({selectedCount}대)
            </>
          ) : (
            <>
              <Play className="w-4 h-4" />
              무료주차 등록 실행 ({selectedCount}대)
            </>
          )}
        </button>

        {/* 실행 로그 */}
        {logs.length > 0 && (() => {
          const done = logs.filter((l) => !["pending", "running"].includes(l.status)).length;
          const total = logs.length;
          const pct = total > 0 ? Math.round((done / total) * 100) : 0;
          const success = logs.filter((l) => l.status === "success").length;
          return (
          <div className="fp-panel rounded-2xl overflow-hidden">
            {/* 진행률 바 */}
            <div className="px-5 pt-4 pb-2 space-y-1.5">
              <div className="flex items-center justify-between text-xs text-gray-400">
                <span>{done === total && total > 0 ? "완료" : "진행 중"}</span>
                <span className="font-mono">{done}/{total} ({pct}%)</span>
              </div>
              <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className={clsx(
                    "h-full rounded-full transition-all duration-500",
                    done === total && total > 0
                      ? success === total ? "bg-green-500" : "bg-blue-500"
                      : "bg-blue-500"
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
            <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-300">실행 결과</h2>
              <button
                onClick={shareLogs}
                className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors px-2.5 py-1.5 rounded-lg hover:bg-gray-800"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-green-400" />
                    <span className="text-green-400">완료</span>
                  </>
                ) : (
                  <>
                    <Share2 className="w-3.5 h-3.5" />
                    결과 공유
                  </>
                )}
              </button>
            </div>
            <div ref={logRef} className="max-h-96 overflow-y-auto divide-y divide-gray-800/50">
              {logs.map((log) => (
                <div key={log.id}>
                  <div className="flex items-center gap-3 px-5 py-3">
                    <StatusIcon status={log.status} />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-mono font-medium text-white">
                        {log.plate}
                      </span>
                      <span className="ml-2 text-xs text-gray-400">{log.message}</span>
                    </div>
                    <StatusBadge status={log.status} />
                  </div>
                  {log.status === "needs_selection" && log.candidates && log.candidates.length > 0 && (
                    <div className="px-5 pb-4 space-y-2 bg-orange-950/20">
                      <p className="text-xs text-orange-400 font-medium">
                        입차된 차량을 선택해주세요:
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {log.candidates.map((c, i) => (
                          <button
                            key={i}
                            onClick={() => handleSelect(log.plate, i)}
                            className="px-4 py-2 bg-orange-500/10 border border-orange-500/30 hover:border-orange-400 hover:bg-orange-500/20 rounded-xl text-sm font-mono text-orange-300 transition-colors"
                          >
                            {c.plate}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="px-5 py-3 border-t border-gray-800 flex flex-wrap gap-4 text-xs text-gray-500">
              <span className="text-green-400">
                ✓ 성공 {logs.filter((l) => l.status === "success").length}
              </span>
              <span className="text-red-400">
                ✗ 실패 {logs.filter((l) => l.status === "failed").length}
              </span>
              <span className="text-gray-500">
                — 패스 {logs.filter((l) => l.status === "skipped" || l.status === "duplicate").length}
              </span>
              {logs.some((l) => l.status === "needs_selection") && (
                <span className="text-orange-400">
                  ? 선택필요 {logs.filter((l) => l.status === "needs_selection").length}
                </span>
              )}
              {logs.some((l) => l.status === "not_entered") && (
                <span className="text-gray-400">
                  ○ 입차안됨 {logs.filter((l) => l.status === "not_entered").length}
                </span>
              )}
            </div>
          </div>
          );
        })()}
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: LogEntry["status"] }) {
  if (status === "running") return <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />;
  if (status === "success") return <CheckCircle className="w-4 h-4 text-green-400" />;
  if (status === "failed") return <XCircle className="w-4 h-4 text-red-400" />;
  if (status === "duplicate") return <div className="w-4 h-4 rounded-full border-2 border-gray-600" />;
  if (status === "skipped") return <div className="w-4 h-4 rounded-full border-2 border-gray-600" />;
  if (status === "not_entered") return <MinusCircle className="w-4 h-4 text-gray-500" />;
  if (status === "needs_selection") return <AlertCircle className="w-4 h-4 text-orange-400" />;
  return <div className="w-4 h-4 rounded-full border border-gray-700" />;
}

function StatusBadge({ status }: { status: LogEntry["status"] }) {
  const map = {
    pending: ["text-gray-600", "대기"],
    running: ["text-blue-400", "진행중"],
    success: ["text-green-400", "완료"],
    failed: ["text-red-400", "실패"],
    duplicate: ["text-gray-500", "패스"],
    skipped: ["text-gray-500", "패스"],
    needs_selection: ["text-orange-400", "선택필요"],
    not_entered: ["text-gray-400", "입차안됨"],
  } as const;
  const [color, label] = map[status];
  return <span className={clsx("text-xs font-medium", color)}>{label}</span>;
}

function CarStatusBadge({ s, now }: { s: CarStatus; now: number }) {
  const map: Record<string, [string, string]> = {
    not_entered: ["bg-gray-800 text-gray-400", "미입차"],
    entered:     ["bg-yellow-900/50 text-yellow-400 border border-yellow-800/50", "입차중"],
    registered:  ["bg-green-900/50 text-green-400 border border-green-800/50", "등록완료"],
    no_quota:    ["bg-orange-900/50 text-orange-400 border border-orange-800/50", "잔여없음"],
    multi_car:   ["bg-orange-900/50 text-orange-400 border border-orange-800/50", "복수차량"],
    error:       ["bg-red-900/50 text-red-400 border border-red-800/50", "오류"],
  };

  // 등록완료 후 출차한 경우: 별도 배지 스타일
  if (s.exitedAfterRegistration) {
    const cls = "bg-blue-900/50 text-blue-400 border border-blue-800/50";
    const checkTime = s.checkedAt ? formatTimeWithDay(s.checkedAt) : null;
    return (
      <span className="inline-flex flex-col gap-0.5">
        <span className={clsx("inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium", cls)}>
          출차완료
        </span>
        {checkTime && (
          <span className="text-[10px] text-gray-400/80 font-normal px-0.5">
            출차확인 {checkTime}
          </span>
        )}
      </span>
    );
  }

  const [cls, baseLabel] = map[s.status] ?? ["bg-gray-800 text-gray-500", s.status];

  // 등록완료일 때 종일권/시간권 종류를 라벨에 추가
  let label = baseLabel;
  if (s.status === "registered") {
    if (s.appliedKind === "allDay") label = "등록완료 · 종일권";
    else if (s.appliedKind === "hourly") label = "등록완료 · 시간권";
  }

  const checkTime = s.checkedAt ? formatTimeWithDay(s.checkedAt) : null;

  // 보조 정보 라인
  const subParts: string[] = [];
  if (s.entryAt) {
    subParts.push(`입차 ${formatTimeWithDay(new Date(s.entryAt).getTime())}`);
  } else if (s.entryTime) {
    subParts.push(`입차 ${s.entryTime}`);
  }
  if (s.status === "entered" || s.status === "no_quota" || s.status === "registered") {
    const elapsed = formatElapsed(s.entryAt, now);
    if (elapsed) subParts.push(elapsed);
  }
  if (s.status === "registered" && s.appliedName) subParts.push(s.appliedName);
  if ((s.status === "entered" || s.status === "no_quota") &&
      (s.quotaAllDay !== undefined || s.quotaHourly !== undefined)) {
    const parts: string[] = [];
    if (s.quotaAllDay !== undefined) parts.push(`종일 ${s.quotaAllDay}`);
    if (s.quotaHourly !== undefined) parts.push(`시간 ${s.quotaHourly}`);
    subParts.push(`잔여 ${parts.join("/")}`);
  }

  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className={clsx("inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium", cls)}>
        {label}
        {checkTime && <span className="opacity-60 font-normal">{s.isLast ? "기록" : ""} {checkTime}</span>}
      </span>
      {subParts.length > 0 && (
        <span className="text-[10px] text-gray-400/80 font-normal px-0.5">
          {subParts.join(" · ")}
        </span>
      )}
      {s.status === "error" && s.message && (
        <span className="text-xs text-red-400/70 font-normal px-0.5 max-w-[200px] truncate" title={s.message}>
          {s.message}
        </span>
      )}
    </span>
  );
}

function ClaudeCodeReportButton({ logs, settings }: {
  logs: LogEntry[];
  settings: { url: string; id: string; pw: string };
}) {
  const [copied, setCopied] = useState(false);
  const failedLogs = logs.filter(l => l.status === "failed");

  function generatePrompt() {
    const now = new Date().toLocaleString("ko-KR");
    const lines = [
      `## freeparking_1 자동등록 오류 보고`,
      ``,
      `**발생 시간**: ${now}`,
      `**사이트 URL**: ${settings.url || "(미설정)"}`,
      `**관리자 ID**: ${settings.id || "(미설정)"}`,
      ``,
      `**실패 차량 목록**:`,
      ...failedLogs.map(l => `- ${l.plate}: ${l.message}`),
      ``,
      `lib/register-http.ts의 HTTP fetch 기반 구현이 실패했습니다.`,
      `Playwright를 사용해 직접 디버깅 후 register-http.ts를 개선해주세요.`,
      `(비밀번호는 직접 입력 필요)`,
    ];
    return lines.join("\n");
  }

  function copyPrompt() {
    navigator.clipboard.writeText(generatePrompt());
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  return (
    <div className="bg-red-950/30 border border-red-800/40 rounded-2xl px-4 py-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-red-400">등록 실패 차량 있음</p>
        <p className="text-xs text-red-300/60 mt-0.5">
          {failedLogs.map(l => l.plate).join(", ")}
        </p>
      </div>
      <button
        onClick={copyPrompt}
        className="shrink-0 flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-red-900/40 hover:bg-red-900/70 text-red-300 border border-red-700/40 transition-colors"
      >
        {copied ? (
          <><Check className="w-3.5 h-3.5 text-green-400" /><span className="text-green-400">복사됨</span></>
        ) : (
          <><Copy className="w-3.5 h-3.5" />Claude Code에 전달</>
        )}
      </button>
    </div>
  );
}

function StatusCheckErrorButton({ statusMap, settings }: {
  statusMap: Record<string, { status: string; message: string; checkedAt?: number }>;
  settings: { url: string; id: string; pw: string };
}) {
  const [copied, setCopied] = useState(false);
  const errorEntries = Object.entries(statusMap).filter(([, s]) => s.status === "error");

  function generatePrompt() {
    const now = new Date().toLocaleString("ko-KR");
    const lines = [
      `## freeparking_1 현황 조회 오류 보고`,
      ``,
      `**발생 시간**: ${now}`,
      `**사이트 URL**: ${settings.url || "(미설정)"}`,
      `**관리자 ID**: ${settings.id || "(미설정)"}`,
      ``,
      `**오류 차량 목록**:`,
      ...errorEntries.map(([plate, s]) => `- ${plate}: ${s.message}`),
      ``,
      `lib/check-status.ts의 HTTP fetch 기반 현황 조회가 실패했습니다.`,
      `Playwright로 직접 디버깅 후 check-status.ts를 개선해주세요.`,
      `(비밀번호는 직접 입력 필요)`,
    ];
    return lines.join("\n");
  }

  function copyPrompt() {
    navigator.clipboard.writeText(generatePrompt());
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  return (
    <div className="bg-red-950/30 border border-red-800/40 rounded-2xl px-4 py-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-red-400">현황 조회 오류</p>
        <p className="text-xs text-red-300/60 mt-0.5 break-all">
          {errorEntries[0]?.[1].message || "알 수 없는 오류"}
        </p>
      </div>
      <button
        onClick={copyPrompt}
        className="shrink-0 flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-red-900/40 hover:bg-red-900/70 text-red-300 border border-red-700/40 transition-colors"
      >
        {copied ? (
          <><Check className="w-3.5 h-3.5 text-green-400" /><span className="text-green-400">복사됨</span></>
        ) : (
          <><Copy className="w-3.5 h-3.5" />Claude Code에 전달</>
        )}
      </button>
    </div>
  );
}
