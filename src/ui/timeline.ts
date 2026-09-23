// Запросы по времени: столбики с разбивкой на 2xx/3xx/4xx/5xx.
// Шаг подбирается так, чтобы столбиков было не больше ~120.

import type { Report } from "../stats.ts";
import { clock, dayLabel, esc, num, short, when } from "./format.ts";

const steps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080].map((m) => m * 60_000);

export interface Bucket {
  from: number;
  to: number;
  c: [number, number, number, number];
}

export function buckets(r: Report): Bucket[] {
  if (!r.minutes.length) return [];
  const first = r.minutes[0][0];
  const last = r.minutes[r.minutes.length - 1][0] + 60_000;
  const step = steps.find((s) => (last - first) / s <= 120) ?? steps[steps.length - 1];
  // Выравниваем по местному времени лога, чтобы часовые столбики начинались ровно в :00.
  const tzMs = r.tz * 60_000;
  const start = Math.floor((first + tzMs) / step) * step - tzMs;
  const out: Bucket[] = [];
  for (let t = start; t < last; t += step) out.push({ from: t, to: t + step, c: [0, 0, 0, 0] });
  for (const [t, a, b, c, d] of r.minutes) {
    const x = out[Math.floor((t - start) / step)];
    x.c[0] += a;
    x.c[1] += b;
    x.c[2] += c;
    x.c[3] += d;
  }
  return out;
}

export function timeline(r: Report, width: number): string {
  const bs = buckets(r);
  if (!bs.length) return `<p class="muted">Нет запросов.</p>`;
  const W = Math.max(300, Math.round(width));
  const narrow = W < 500;
  const H = narrow ? 200 : 240;
  const left = narrow ? 44 : 56;
  const top = 10;
  const bottom = 30;
  const max = Math.max(1, ...bs.map((b) => b.c[0] + b.c[1] + b.c[2] + b.c[3]));
  const step = niceStep(max / 4);
  const ceil = Math.ceil(max / step) * step;
  const y = (v: number) => top + (H - top - bottom) * (1 - v / ceil);
  const slot = (W - left) / bs.length;
  const gap = slot > 6 ? 1 : 0;

  const parts: string[] = [];
  for (let v = 0; v <= ceil; v += step) {
    parts.push(
      `<line x1="${left}" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="grid"/>`,
      `<text x="${left - 8}" y="${y(v) + 4}" class="tick" text-anchor="end">${short(v)}</text>`,
    );
  }
  const span = bs[bs.length - 1].to - bs[0].from;
  const multiDay = span > 36 * 3600_000;
  // Подписи оси X: примерно каждые 90 пикселей.
  const every = Math.max(1, Math.ceil(90 / slot));
  bs.forEach((b, i) => {
    const x = left + slot * i;
    let acc = 0;
    const rects = b.c
      .map((n, k) => {
        if (!n) return "";
        const y1 = y(acc + n);
        const h = y(acc) - y1;
        acc += n;
        return `<rect x="${x + gap / 2}" y="${y1}" width="${Math.max(0.5, slot - gap)}" height="${h}" class="c${k + 2}"/>`;
      })
      .join("");
    const total = b.c[0] + b.c[1] + b.c[2] + b.c[3];
    const title = `${when(b.from, r.tz)} — ${clock(b.to, r.tz)}: ${num(total)} запросов` + (b.c[3] ? `, из них 5xx: ${num(b.c[3])}` : "") + (b.c[2] ? `, 4xx: ${num(b.c[2])}` : "");
    const label = i % every === 0 ? `<text x="${x + slot / 2}" y="${H - bottom + 16}" class="tick" text-anchor="middle">${multiDay ? dayLabel(b.from, r.tz) : clock(b.from, r.tz)}</text>` : "";
    parts.push(`<g class="bucket" data-from="${b.from}" data-to="${b.to}"><title>${esc(title)}</title><rect class="hit" x="${x}" y="${top}" width="${slot}" height="${H - top - bottom}"/>${rects}${label}</g>`);
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Запросы по времени">${parts.join("")}</svg>`;
}

function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  for (const k of [1, 2, 5, 10]) if (raw <= k * p) return k * p;
  return 10 * p;
}
