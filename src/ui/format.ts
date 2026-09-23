export const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const int = new Intl.NumberFormat("ru-RU");
export const num = (n: number) => int.format(n);

/** 1234567 → «1,2 млн». */
export function short(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} млн`;
  if (n >= 1e4) return `${Math.round(n / 1e3)} тыс.`;
  return int.format(n);
}

export function bytes(n: number): string {
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toLocaleString("ru-RU", { maximumFractionDigits: n < 10 && i > 0 ? 1 : 0 })} ${units[i]}`;
}

/** Секунды → «42 мс», «1,3 с». */
export function dur(sec: number): string {
  if (sec < 0) return "—";
  if (sec < 1) return `${Math.round(sec * 1000)} мс`;
  if (sec < 60) return `${sec.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} с`;
  return `${Math.floor(sec / 60)} мин ${Math.round(sec % 60)} с`;
}

export const pct = (part: number, whole: number) =>
  whole ? `${((part / whole) * 100).toLocaleString("ru-RU", { maximumFractionDigits: part / whole < 0.1 ? 1 : 0 })}%` : "0%";

const p2 = (n: number) => String(n).padStart(2, "0");

/** Время в часовом поясе самого лога, а не того, кто смотрит: «22.09.2026 14:20». */
export function when(ms: number, tz: number, seconds = false): string {
  const d = new Date(ms + tz * 60_000);
  const s = `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  return seconds ? `${s}:${p2(d.getUTCSeconds())}` : s;
}

export const clock = (ms: number, tz: number) => {
  const d = new Date(ms + tz * 60_000);
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
};

export const dayLabel = (ms: number, tz: number) => {
  const d = new Date(ms + tz * 60_000);
  return `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)}`;
};

export const tzLabel = (tz: number) => `UTC${tz >= 0 ? "+" : "−"}${p2(Math.floor(Math.abs(tz) / 60))}:${p2(Math.abs(tz) % 60)}`;

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
