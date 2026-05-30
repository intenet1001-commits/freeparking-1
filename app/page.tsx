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
  matchedPlate?: string; // 끝 4자리만 같은 다른 차량이 잡혔을 때 실제 번호판 (충돌 경고)
};

// 차량별 선택 가능 권종 (실측 dCode). 종일권 기본.
const TICKET_OPTIONS: { dCode: string; label: string }[] = [
  { dCode: "00005", label: "종일권" },
  { dCode: "00004", label: "1시간30분" },
  { dCode: "00002", label: "1시간" },
  { dCode: "00001", label: "30분" },
];
const SPECIAL_ROWS = new Set(["__settings__", "__ticketchoices__"]);

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

type LogEntry = {
  id: string;
  plate: string;
  status: "pending" | "running" | "success" | "failed" | "duplicate" | "skipped" | "needs_selection" | "not_entered";
  message: string;
  ts: number;
  candidates?: Candidate[];
};

const APP_PW = "werwer1.";

export default function Home() {
  const [authed, setAuthed] = useState(false);
  const [pwInput, setPwInput] = useState("");
  const [pwError, setPwError] = useState(false);
  const [cars, setCars] = useState<CarEntry[]>([]);
  const [newPlate, setNewPlate] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [showBulk, setShowBulk] = useState(false);
  const [showAddCar, setShowAddCar] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPlate, setEditPlate] = useState("");
  const [editLabel, setEditLabel] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState({ url: "", id: "", pw: "" });
  const [now, setNow] = useState(0); // 경과시간 실시간 갱신용 (0=미초기화)
  const [statusMap, setStatusMap] = useState<Record<string, CarStatus>>({});
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const initialStatusLoaded = useRef(false);

  useEffect(() => {
    if (localStorage.getItem("fp_authed") === "1") setAuthed(true);
  }, []);

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
    // 단일 쿼리로 차량 + 설정(__settings__) + 권종맵(__ticketchoices__) 모두 로드
    supabase
      .from("fp_cars")
      .select("*")
      .order("created_at")
      .then(({ data }) => {
        if (!data) return;
        // 권종 선택 맵: __ticketchoices__ 행의 label JSON ({ carId: dCode })
        let choiceMap: Record<string, string> = {};
        const tcRow = data.find((r) => r.plate === "__ticketchoices__");
        if (tcRow?.label) { try { choiceMap = JSON.parse(tcRow.label); } catch {} }
        setCars(
          data
            .filter((r) => !SPECIAL_ROWS.has(r.plate))
            .map((r) => ({ ...r, selected: true, ticketChoice: choiceMap[r.id] }))
        );
        // 설정: __settings__ 행의 label JSON. 없으면 localStorage 폴백
        const sRow = data.find((r) => r.plate === "__settings__");
        if (sRow?.label) {
          try {
            const s = JSON.parse(sRow.label);
            setSettings({ url: s.url ?? '', id: s.id ?? '', pw: s.pw ?? '' });
            return;
          } catch {}
        }
        try {
          const local = localStorage.getItem('freeparking_settings');
          if (local) setSettings(JSON.parse(local));
        } catch {}
      });
  }, []);

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

  // 차량 목록 첫 로드 시 fp_logs에서 마지막 상태 복원 (배지 초기화)
  useEffect(() => {
    if (cars.length > 0 && !initialStatusLoaded.current) {
      initialStatusLoaded.current = true;
      loadLastStatus();
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
    if (data) setCars((prev) => [...prev, { ...data, selected: true }]);
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
      await supabase
        .from("fp_cars")
        .upsert(
          newCars.map((c) => ({ plate: c.plate, label: c.label })),
          { onConflict: "plate", ignoreDuplicates: true }
        );
      // Re-fetch full list (권종맵 병합 유지)
      const { data } = await supabase.from("fp_cars").select("*").order("created_at");
      if (data) {
        let choiceMap: Record<string, string> = {};
        const tcRow = data.find((r) => r.plate === "__ticketchoices__");
        if (tcRow?.label) { try { choiceMap = JSON.parse(tcRow.label); } catch {} }
        setCars(
          data
            .filter((r) => !SPECIAL_ROWS.has(r.plate))
            .map((r) => ({ ...r, selected: true, ticketChoice: choiceMap[r.id] }))
        );
      }
    }
    setBulkText("");
    setShowBulk(false);
    if (dupes.length > 0) setToast({ msg: `이미 등록된 번호: ${dupes.join(', ')}`, ok: false });
  }

  async function removeCar(id: string) {
    await supabase.from("fp_cars").delete().eq("id", id);
    setCars((prev) => {
      const next = prev.filter((c) => c.id !== id);
      // 삭제 차량의 권종 선택을 __ticketchoices__에서도 정리 (고아 키 방지)
      const map: Record<string, string> = {};
      for (const c of next) if (c.ticketChoice) map[c.id] = c.ticketChoice;
      supabase
        .from("fp_cars")
        .upsert({ plate: "__ticketchoices__", label: JSON.stringify(map) }, { onConflict: "plate" });
      return next;
    });
  }

  async function updateCar(id: string) {
    const plate = editPlate.trim().toUpperCase();
    const label = editLabel.trim();
    if (!plate) return;
    await supabase.from("fp_cars").update({ plate, label }).eq("id", id);
    setCars((prev) => prev.map((c) => c.id === id ? { ...c, plate, label } : c));
    setEditingId(null);
  }

  // 차량별 권종 선택 저장. 컬럼 추가 없이 __ticketchoices__ 행에 { carId: dCode } JSON으로 영속.
  // 함수형 업데이트로 prev(최신 상태)에서 map을 빌드 → 연속 변경 시 직전 선택 유실 방지.
  function saveTicketChoice(id: string, dCode: string) {
    setCars((prev) => {
      const next = prev.map((c) => (c.id === id ? { ...c, ticketChoice: dCode } : c));
      const map: Record<string, string> = {};
      for (const c of next) if (c.ticketChoice) map[c.id] = c.ticketChoice;
      supabase
        .from("fp_cars")
        .upsert({ plate: "__ticketchoices__", label: JSON.stringify(map) }, { onConflict: "plate" })
        .then(({ error }) => { if (error) setToast({ msg: `권종 저장 실패: ${error.message}`, ok: false }); });
      return next;
    });
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
    localStorage.setItem('freeparking_settings', JSON.stringify({ url: settings.url, id: settings.id, pw: settings.pw }));
    // fp_cars의 plate='__settings__' 행에 설정 저장 (fp_settings 테이블 불필요)
    const { error } = await supabase
      .from("fp_cars")
      .upsert({ plate: "__settings__", label: JSON.stringify({ url: settings.url, id: settings.id, pw: settings.pw }) }, { onConflict: "plate" });
    if (error) {
      setToast({ msg: `저장 실패: ${error.message}`, ok: false });
      return;
    }
    setToast({ msg: '설정 저장 완료 ✓', ok: true });
    setShowSettings(false);
  }

  function applyStatusAndAutoSelect(newMap: Record<string, CarStatus>) {
    setStatusMap(newMap);
    // 입차중(등록 전) 차량만 자동 선택. 단, 끝4자리만 일치하는 다른 차량(matchedPlate)은
    // 자동 선택 제외 — 사용자가 직접 확인 후 체크해야 등록되도록 (오등록 방지).
    setCars((prev) => prev.map((c) => ({
      ...c,
      selected: newMap[c.plate]?.status === "entered" && !newMap[c.plate]?.matchedPlate,
    })));
  }

  async function runStatusCheck() {
    const plates = cars.map((c) => c.plate);
    if (plates.length === 0) return;
    setCheckingStatus(true);
    setStatusMap({});
    const collected: Record<string, CarStatus> = {};
    try {
      const resp = await fetch("/api/check-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plates, settings }),
      });
      await readSSE(resp, (data) => {
        if (data.done || !data.plate) return;
        const plate = data.plate as string;
        collected[plate] = {
          status: data.status as CarStatus["status"],
          message: data.message as string,
          checkedAt: Date.now(),
          entryTime: data.entryTime as string | undefined,
          entryAt: data.entryAt as string | undefined,
          appliedName: data.appliedName as string | undefined,
          appliedKind: data.appliedKind as 'allDay' | 'hourly' | undefined,
          quotaAllDay: data.quotaAllDay as number | undefined,
          quotaHourly: data.quotaHourly as number | undefined,
          matchedPlate: data.matchedPlate as string | undefined,
        };
        setStatusMap({ ...collected });
      });
    } catch (e) {
      console.error(e);
    } finally {
      setCheckingStatus(false);
      applyStatusAndAutoSelect(collected);
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
        if (!map[row.plate]) {
          const s = row.status as CarStatus["status"];
          map[row.plate] = {
            status: ["not_entered", "entered", "registered", "no_quota", "multi_car", "error"].includes(s)
              ? s
              : row.status === "success"
              ? "registered"
              : row.status === "skipped" || row.status === "duplicate"
              ? "registered"
              : row.status === "failed"
              ? "error"
              : "not_entered",
            message: row.message,
            checkedAt: new Date(row.created_at).getTime(),
            isLast: true,
          };
        }
      }
      applyStatusAndAutoSelect(map);
    }
    setCheckingStatus(false);
  }

  async function readSSE(
    resp: Response,
    onData: (data: Record<string, unknown>) => void
  ) {
    const reader = resp.body?.getReader();
    const decoder = new TextDecoder();
    if (!reader) throw new Error("스트림 없음");
    // 청크 경계로 'data:' 라인이 쪼개져도 유실되지 않도록 버퍼 누적 (모바일/프록시 신뢰성)
    let buffer = "";
    const flush = (line: string) => {
      if (!line.startsWith("data: ")) return; // ': ping' 주석 등은 무시
      try { onData(JSON.parse(line.slice(6))); } catch {}
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
  }

  function copyLogs() {
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
    navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
      await readSSE(resp, applyLogUpdate);
    } catch (e) {
      console.error(e);
    } finally {
      setRunning(false);
      // Save logs to Supabase → 완료 후 배지 갱신
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
              // Supabase insert 후 fp_logs에서 최신 상태 로드 → 배지 확정 갱신
              setTimeout(() => loadLastStatus(), 300);
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
      await readSSE(resp, applyLogUpdate);
    } catch (e) {
      console.error(e);
    } finally {
      // 선택 등록 완료 후 배지 갱신
      setTimeout(() => loadLastStatus(), 300);
    }
  }

  function submitPw() {
    if (pwInput === APP_PW) {
      localStorage.setItem("fp_authed", "1");
      setAuthed(true);
      setPwError(false);
    } else {
      setPwError(true);
    }
  }

  const selectedCount = cars.filter((c) => c.selected).length;
  const allSelected = cars.length > 0 && cars.every((c) => c.selected);

  if (!authed) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-8 w-full max-w-sm space-y-4">
        <div className="flex items-center gap-3 mb-2">
          <div className="bg-blue-600 rounded-xl p-2"><Car className="w-5 h-5 text-white" /></div>
          <h1 className="text-lg font-bold text-white">무료주차 자동등록</h1>
        </div>
        <input
          type="password"
          placeholder="비밀번호"
          value={pwInput}
          onChange={(e) => { setPwInput(e.target.value); setPwError(false); }}
          onKeyDown={(e) => e.key === "Enter" && submitPw()}
          autoFocus
          suppressHydrationWarning
          className={clsx(
            "w-full bg-gray-800 border rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none",
            pwError ? "border-red-500 focus:border-red-400" : "border-gray-700 focus:border-blue-500"
          )}
        />
        {pwError && <p className="text-xs text-red-400">비밀번호가 틀렸습니다.</p>}
        <button
          onClick={submitPw}
          className="w-full bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold py-2.5 rounded-lg transition-colors"
        >
          입장
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-950 p-4 md:p-8">
      {toast && (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl text-sm font-medium text-white shadow-lg ${toast.ok ? 'bg-green-600' : 'bg-red-500'}`}>
          {toast.msg}
        </div>
      )}
      {pendingDeleteId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setPendingDeleteId(null)}>
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 w-72 space-y-4" onClick={e => e.stopPropagation()}>
            <p className="text-white text-sm font-medium text-center">차량을 삭제하시겠습니까?</p>
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
      <div className="max-w-2xl mx-auto space-y-6">
        {/* 헤더 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 rounded-xl p-2.5">
              <Car className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">무료주차 자동등록</h1>
              <p className="text-xs text-gray-400">HI PARKING · 의왕 에이스 청계타워</p>
            </div>
          </div>
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-white transition-colors px-3 py-1.5 rounded-lg hover:bg-gray-800"
          >
            <Settings className="w-4 h-4" />
            설정
            {showSettings ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>

        {/* 오류 시 클로드코드 전달 버튼 */}
        {logs.length > 0 && !running && logs.some(l => l.status === "failed") && (
          <ClaudeCodeReportButton logs={logs} settings={settings} />
        )}

        {/* 설정 패널 */}
        {showSettings && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-3">
            <h2 className="text-sm font-semibold text-gray-300">나이스파크 관리자 설정</h2>
            <div className="space-y-2">
              <input
                type="text"
                placeholder="사이트 URL (예: https://parking.nicepark.co.kr/...)"
                value={settings.url}
                onChange={(e) => setSettings((s) => ({ ...s, url: e.target.value }))}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  placeholder="관리자 아이디"
                  value={settings.id}
                  onChange={(e) => setSettings((s) => ({ ...s, id: e.target.value }))}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
                <input
                  type="password"
                  placeholder="비밀번호"
                  value={settings.pw}
                  onChange={(e) => setSettings((s) => ({ ...s, pw: e.target.value }))}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>
            <button
              onClick={saveSettings}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium py-2 rounded-lg transition-colors"
            >
              저장
            </button>
          </div>
        )}

        {/* 차량 추가 */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
          <button
            onClick={() => setShowAddCar((v) => !v)}
            className="w-full flex items-center justify-between px-5 py-4 text-left"
          >
            <h2 className="text-sm font-semibold text-gray-300">차량 추가</h2>
            <ChevronDown className={`w-4 h-4 text-gray-500 transition-transform ${showAddCar ? 'rotate-180' : ''}`} />
          </button>

          {showAddCar && <div className="px-5 pb-5 space-y-3">
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
              <textarea
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
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="차량번호 (예: 12가3456)"
                value={newPlate}
                onChange={(e) => setNewPlate(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addCar()}
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
              <input
                type="text"
                placeholder="메모 (선택)"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addCar()}
                className="w-28 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
              />
              <button
                onClick={addCar}
                className="bg-blue-600 hover:bg-blue-500 text-white px-3 py-2 rounded-lg transition-colors"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          )}
          </div>}
        </div>

        {/* 차량 목록 */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
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
                          className="w-28 bg-gray-800 border border-blue-500 rounded px-2 py-0.5 text-xs font-mono text-white focus:outline-none"
                        />
                        <input
                          value={editLabel}
                          onChange={(e) => setEditLabel(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") updateCar(car.id); if (e.key === "Escape") setEditingId(null); }}
                          placeholder="메모 (선택)"
                          className="flex-1 bg-gray-800 border border-gray-600 rounded px-2 py-0.5 text-xs text-white focus:outline-none"
                        />
                      </div>
                      <button
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => updateCar(car.id)}
                        className="text-blue-400 hover:text-blue-300 transition-colors"
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
                        {/* 차량별 등록 권종 선택 (종일권 기본) */}
                        <select
                          value={car.ticketChoice ?? "00005"}
                          onChange={(e) => saveTicketChoice(car.id, e.target.value)}
                          title="등록할 권종 선택"
                          className="bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-xs text-gray-200 focus:outline-none focus:border-blue-500 cursor-pointer"
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

        {/* 현황 조회 오류 보고 */}
        {Object.values(statusMap).some(s => s.status === "error") && !checkingStatus && (
          <StatusCheckErrorButton statusMap={statusMap} settings={settings} />
        )}

        {/* 미등록 입차 차량 안내 배너 (4자리 불일치 차량은 자동선택 제외, 별도 안내) */}
        {(() => {
          if (checkingStatus || Object.keys(statusMap).length === 0) return null;
          const enteredCount = cars.filter(c => statusMap[c.plate]?.status === "entered" && !statusMap[c.plate]?.matchedPlate).length;
          const mismatchCount = cars.filter(c => statusMap[c.plate]?.matchedPlate).length;
          if (enteredCount === 0 && mismatchCount === 0) return null;
          return (
            <div className="space-y-2">
              {enteredCount > 0 && (
                <div className="bg-blue-950/40 border border-blue-700/50 rounded-2xl px-4 py-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-blue-300">
                      {enteredCount}대 입차 미등록 → 자동 선택됨
                    </p>
                    <p className="text-xs text-blue-400/60 mt-0.5">아래 실행 버튼으로 바로 등록하세요</p>
                  </div>
                  <button
                    onClick={runRegistration}
                    disabled={running}
                    className="shrink-0 flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50"
                  >
                    {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                    지금 등록
                  </button>
                </div>
              )}
              {mismatchCount > 0 && (
                <div className="bg-orange-950/40 border border-orange-700/50 rounded-2xl px-4 py-3">
                  <p className="text-sm font-semibold text-orange-300">
                    ⚠ {mismatchCount}대는 끝 4자리만 일치하는 다른 차량
                  </p>
                  <p className="text-xs text-orange-400/70 mt-0.5">
                    자동 선택 안 됨 — 실제 입차 차량을 확인하고 직접 체크해야 등록됩니다
                  </p>
                </div>
              )}
            </div>
          );
        })()}

        {/* 실행 버튼 */}
        <button
          onClick={runRegistration}
          disabled={running || selectedCount === 0}
          className={clsx(
            "w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl font-semibold text-sm transition-all",
            running || selectedCount === 0
              ? "bg-gray-800 text-gray-600 cursor-not-allowed"
              : "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/30"
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
          <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
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
                onClick={copyLogs}
                className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors px-2.5 py-1.5 rounded-lg hover:bg-gray-800"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-green-400" />
                    <span className="text-green-400">복사됨</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    복사
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
  const [cls, baseLabel] = map[s.status] ?? ["bg-gray-800 text-gray-500", s.status];

  // 등록완료일 때 종일권/시간권 종류를 라벨에 추가
  let label = baseLabel;
  if (s.status === "registered") {
    if (s.appliedKind === "allDay") label = "등록완료 · 종일권";
    else if (s.appliedKind === "hourly") label = "등록완료 · 시간권";
  }

  // 끝4자리만 일치하는 다른 차량이면 배지를 주황 경고로 바꿔 실제 차량번호를 전면에 노출
  // (일반 '입차중'과 헷갈리지 않게 + 자동선택 제외됨을 시각적으로 구분)
  let badgeCls = cls;
  if (s.matchedPlate) {
    badgeCls = "bg-orange-900/60 text-orange-300 border border-orange-600/70";
    label = `⚠ ${s.matchedPlate}`;
  }

  const checkTime = s.checkedAt
    ? new Date(s.checkedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })
    : null;

  // 보조 정보 라인
  const subParts: string[] = [];
  if (s.entryTime) subParts.push(`입차 ${s.entryTime}`);
  // 입차중/잔여없음일 때 경과시간 표시 (요구사항 A)
  if (s.status === "entered" || s.status === "no_quota") {
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
      <span className={clsx("inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium", badgeCls)}>
        {label}
        {checkTime && <span className="opacity-60 font-normal">{s.isLast ? "기록" : ""} {checkTime}</span>}
      </span>
      {subParts.length > 0 && (
        <span className="text-[10px] text-gray-400/80 font-normal px-0.5">
          {subParts.join(" · ")}
        </span>
      )}
      {s.matchedPlate && (
        <span className="text-[10px] text-orange-400 font-medium px-0.5" title={`등록한 번호와 끝 4자리만 같은 다른 차량(${s.matchedPlate})입니다. 자동선택 제외 — 직접 체크 시 이 차량에 등록됩니다.`}>
          끝4자리만 일치 (다른 차량) · 자동선택 안 됨
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
