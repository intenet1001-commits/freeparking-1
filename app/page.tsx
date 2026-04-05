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
  ClipboardList,
} from "lucide-react";
import clsx from "clsx";

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

type LogEntry = {
  id: string;
  plate: string;
  status: "pending" | "running" | "success" | "failed" | "duplicate" | "needs_selection";
  message: string;
  ts: number;
  candidates?: Candidate[];
};

export default function Home() {
  const [cars, setCars] = useState<CarEntry[]>([]);
  const [newPlate, setNewPlate] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [showBulk, setShowBulk] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState({ url: "", id: "", pw: "" });
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem("freeparking_cars");
    if (saved) setCars(JSON.parse(saved));
    const savedSettings = localStorage.getItem("freeparking_settings");
    if (savedSettings) setSettings(JSON.parse(savedSettings));
  }, []);

  useEffect(() => {
    localStorage.setItem("freeparking_cars", JSON.stringify(cars));
  }, [cars]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs]);

  function addCar() {
    const plate = newPlate.trim().toUpperCase();
    if (!plate) return;
    if (cars.find((c) => c.plate === plate)) {
      alert("이미 등록된 차량번호입니다.");
      return;
    }
    setCars((prev) => [
      ...prev,
      { id: Date.now().toString(), plate, label: newLabel.trim(), selected: true },
    ]);
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

  function handleBulkAdd() {
    const entries = parseBulkInput(bulkText);
    if (entries.length === 0) return;
    const dupes: string[] = [];
    const newCars: CarEntry[] = [];
    for (const { plate, label } of entries) {
      if (cars.find((c) => c.plate === plate)) {
        dupes.push(plate);
      } else {
        newCars.push({
          id: `${Date.now()}-${Math.random()}`,
          plate,
          label,
          selected: true,
        });
      }
    }
    if (newCars.length > 0) setCars((prev) => [...prev, ...newCars]);
    setBulkText("");
    setShowBulk(false);
    if (dupes.length > 0) alert(`이미 등록된 번호: ${dupes.join(", ")}`);
  }

  function removeCar(id: string) {
    setCars((prev) => prev.filter((c) => c.id !== id));
  }

  function toggleCar(id: string) {
    setCars((prev) =>
      prev.map((c) => (c.id === id ? { ...c, selected: !c.selected } : c))
    );
  }

  function toggleAll(val: boolean) {
    setCars((prev) => prev.map((c) => ({ ...c, selected: val })));
  }

  function saveSettings() {
    localStorage.setItem("freeparking_settings", JSON.stringify(settings));
    setShowSettings(false);
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

  async function runRegistration() {
    const targets = cars.filter((c) => c.selected);
    if (targets.length === 0) {
      alert("등록할 차량을 선택해주세요.");
      return;
    }
    if (!settings.url || !settings.id || !settings.pw) {
      alert("설정에서 나이스파크 URL, 아이디, 비밀번호를 먼저 입력해주세요.");
      setShowSettings(true);
      return;
    }

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

  const selectedCount = cars.filter((c) => c.selected).length;
  const allSelected = cars.length > 0 && cars.every((c) => c.selected);

  return (
    <div className="min-h-screen bg-gray-950 p-4 md:p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* 헤더 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 rounded-xl p-2.5">
              <Car className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">무료주차 자동등록</h1>
              <p className="text-xs text-gray-400">HI PARKING · 의와 에이스 청계타워</p>
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
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-300">차량 추가</h2>
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
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-mono font-medium text-white">
                      {car.plate}
                    </span>
                    {car.label && (
                      <span className="ml-2 text-xs text-gray-500">{car.label}</span>
                    )}
                  </div>
                  <button
                    onClick={() => removeCar(car.id)}
                    className="text-gray-700 hover:text-red-400 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

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
        {logs.length > 0 && (
          <div className="bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-800">
              <h2 className="text-sm font-semibold text-gray-300">실행 결과</h2>
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
              <span className="text-yellow-400">
                ⚠ 중복 {logs.filter((l) => l.status === "duplicate").length}
              </span>
              {logs.some((l) => l.status === "needs_selection") && (
                <span className="text-orange-400">
                  ? 선택필요 {logs.filter((l) => l.status === "needs_selection").length}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: LogEntry["status"] }) {
  if (status === "running") return <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />;
  if (status === "success") return <CheckCircle className="w-4 h-4 text-green-400" />;
  if (status === "failed") return <XCircle className="w-4 h-4 text-red-400" />;
  if (status === "duplicate") return <XCircle className="w-4 h-4 text-yellow-400" />;
  if (status === "needs_selection") return <AlertCircle className="w-4 h-4 text-orange-400" />;
  return <div className="w-4 h-4 rounded-full border border-gray-700" />;
}

function StatusBadge({ status }: { status: LogEntry["status"] }) {
  const map = {
    pending: ["text-gray-600", "대기"],
    running: ["text-blue-400", "진행중"],
    success: ["text-green-400", "완료"],
    failed: ["text-red-400", "실패"],
    duplicate: ["text-yellow-400", "중복"],
    needs_selection: ["text-orange-400", "선택필요"],
  } as const;
  const [color, label] = map[status];
  return <span className={clsx("text-xs font-medium", color)}>{label}</span>;
}
