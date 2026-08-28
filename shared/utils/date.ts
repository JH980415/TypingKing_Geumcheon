export function nowIso(): string {
  return new Date().toISOString();
}

export function timestampForFile(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

export function isValidBirthdate(year: string, month: string, day: string): boolean {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return false;
  const birth = new Date(y, m - 1, d, 0, 0, 0, 0);
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  return birth <= today;
}

export function formatBirthdate(year: string, month: string, day: string): string {
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export function formatMs(ms: number): string {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  return (safe / 1000).toFixed(3);
}
