export type CronRunState = 'ok' | 'missing' | 'unfinished' | 'failed';

export function classifyCronRun(statuses: string[]): CronRunState {
  if (statuses.includes('done')) return 'ok';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('running')) return 'unfinished';
  return 'missing';
}
