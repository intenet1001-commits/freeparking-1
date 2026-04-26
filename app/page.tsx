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
  RefreshCw,
} from "lucide-react";
import clsx from "clsx";
import { supabase } from "@/lib/supabase";

type CarEntry = {
  id: string;
  plate: string;
  label: string;
  selected: boolean;
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
};

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
  const [isLocal, setIsLocal] = useState(true);
  const [statusMap, setStatusMap] = useState<Record<string, CarStatus>>({});
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (localStorage.getItem("fp_authed") === "1") setAuthed(true);
  }, []);

  useEffect(() => {
    const hostname = window.location.hostname;
    setIsLocal(hostname === "localhost" || /^(192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|10\.)/.test(hostname));
  }, []);

  useEffect(() => {
    supabase
      .from("fp_cars")
      .select("*")
      .order("created_at")
      .then(({ data }) => {
        if (data) setCars(data.filter(r => r.plate !== "__settings__").map((r) => ({ ...r, selected: true })));
      });
    // fp_cars의 plate='__settings__' 행에 설정 저장 (별도 테이블 불필요)
    supabase
      .from("fp_cars")
      .select("label")
      .eq("plate", "__settings__")
      .single()
      .then(({ data }) => {
        if (data?.label) {
          try {
            const s = JSON.parse(data.label);
            setSettings({ url: s.url ?? '', id: s.id ?? '', pw: s.pw ?? '' });
            return;
          } catch {}
        }
        // Supabase에 없으면 localStorage 폴백
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
      // Re-fetch full list
      const { data } = await supabase.from("fp_cars").select("*").order("created_at");
      if (data) setCars(data.filter(r => r.plate !== "__settings__").map((r) => ({ ...r, selected: true })));
    }
    setBulkText("");
    setShowBulk(false);
    if (dupes.length > 0) setToast({ msg: `이미 등록된 번호: ${dupes.join(', ')}`, ok: false });
  }

  async function removeCar(id: string) {
    await supabase.from("fp_cars").delete().eq("id", id);
    setCars((prev) => prev.filter((c) => c.id !== id));
  }

  async function updateCar(id: string) {
    const plate = editPlate.trim().toUpperCase();
    const label = editLabel.trim();
    if (!plate) return;
    await supabase.from("fp_cars").update({ plate, label }).eq("id", id);
    setCars((prev) => prev.map((c) => c.id === id ? { ...c, plate, label } : c));
    setEditingId(null);
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
    // 입차중(등록 전) 차량만 자동 선택
    setCars((prev) => prev.map((c) => ({
      ...c,
      selected: newMap[c.plate]?.status === "entered",
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
      const reader = resp.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) return;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        for (const line of chunk.split("\n").filter((l) => l.startsWith("data: "))) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.done) break;
            if (data.plate) {
              collected[data.plate] = { status: data.status, message: data.message, checkedAt: Date.now() };
              setStatusMap({ ...collected });
            }
          } catch {}
        }
      }
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
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split("\n").filter((l) => l.startsWith("data: "))) {
        try {
          const data = JSON.parse(line.slice(6));
          onData(data);
        } catch {}
      }
    }
  }

  function applyLogUpdate(data: Record<string, unknown>) {
    if (!data.plate) return;
    setLogs((prev) =>
      prev.map((l) =>
        l.plate === data.plate
          ? {
              ...l,
              status: data.status as LogEntry["status"],
              message: data.message as string,
              candidates: data.candidates as Candidate[] | undefined,
              ts: Date.now(),
            }
          : l
      )
    );
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
          cars: targets.map((c) => ({ plate: c.plate, label: c.label })),
          settings,
          selectedJson: {},
        }),
      });
      await readSSE(resp, applyLogUpdate);
    } catch (e) {
      console.error(e);
    } finally {
      setRunning(false);
      // Save logs to Supabase
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
          cars: [{ plate: car.plate, label: car.label }],
          settings,
          selectedJson: { [plate]: selectedIndex },
        }),
      });
      await readSSE(resp, applyLogUpdate);
    } catch (e) {
      console.error(e);
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
                    className="w-4 h-4 accent-blue-500 cursor-pointer"
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
                          <CarStatusBadge s={statusMap[car.plate]} />
                        )}
                      </div>
                      <button
                        onClick={() => { setEditingId(car.id); setEditPlate(car.plate); setEditLabel(car.label); }}
                        className="text-gray-700 hover:text-gray-400 transition-colors"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => setPendingDeleteId(car.id)}
                        className="text-gray-700 hover:text-red-400 transition-colors"
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

        {/* 미등록 입차 차량 안내 배너 */}
        {(() => {
          const enteredCount = cars.filter(c => statusMap[c.plate]?.status === "entered").length;
          if (enteredCount === 0 || checkingStatus || Object.keys(statusMap).length === 0) return null;
          return (
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

function CarStatusBadge({ s }: { s: { status: string; message: string; checkedAt?: number; isLast?: boolean } }) {
  const map: Record<string, [string, string]> = {
    not_entered: ["bg-gray-800 text-gray-400", "미입차"],
    entered:     ["bg-yellow-900/50 text-yellow-400 border border-yellow-800/50", "입차중"],
    registered:  ["bg-green-900/50 text-green-400 border border-green-800/50", "등록완료"],
    no_quota:    ["bg-orange-900/50 text-orange-400 border border-orange-800/50", "잔여없음"],
    multi_car:   ["bg-orange-900/50 text-orange-400 border border-orange-800/50", "복수차량"],
    error:       ["bg-red-900/50 text-red-400 border border-red-800/50", "오류"],
  };
  const [cls, label] = map[s.status] ?? ["bg-gray-800 text-gray-500", s.status];
  const time = s.checkedAt
    ? new Date(s.checkedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })
    : null;
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className={clsx("inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium", cls)}>
        {label}
        {time && <span className="opacity-60 font-normal">{s.isLast ? "기록" : ""} {time}</span>}
      </span>
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
