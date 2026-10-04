import type { CarStatusResult } from './check-status';

export type SummaryLog = { plate: string; status: string };

export function buildSundaySummary(
  plates: string[],
  statuses: CarStatusResult[],
  logs: SummaryLog[]
): { body: string; unresolved: number } {
  const byPlate = new Map(statuses.map((result) => [result.plate, result]));
  const completedLogs = new Set(logs
    .filter((log) => ['success', 'skipped', 'duplicate'].includes(log.status))
    .map((log) => log.plate));
  const hadRun = logs.some((log) => log.plate === '__run__');
  const runFailed = logs.some((log) => log.plate === '__run__' && log.status === 'failed');
  let confirmed = 0;
  let recorded = 0;
  let pending = 0;
  let notEntered = 0;
  let unresolved = 0;

  for (const plate of plates) {
    const status = byPlate.get(plate)?.status;
    if (status === 'registered') confirmed += 1;
    else if (status === 'entered' || status === 'no_quota') pending += 1;
    else if (status === 'not_entered' && completedLogs.has(plate)) recorded += 1;
    else if (status === 'not_entered') notEntered += 1;
    else unresolved += 1;
  }

  const parts = [
    `등록 확인 ${confirmed}대`,
    `오늘 처리 기록 ${recorded}대`,
    `등록 전 ${pending}대`,
    `미입차 ${notEntered}대`,
    `조회 불가 ${unresolved}대`,
  ];
  if (!hadRun) parts.push('자동 실행 기록 없음');
  else if (runFailed) parts.push('자동 실행 오류 기록 있음');
  return { body: parts.join(' · '), unresolved };
}
