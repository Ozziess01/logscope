// Счётчики, которые набираются за один проход по логу. Память ограничена:
// в таблицах держим не больше CAP ключей, при переполнении выбрасываем
// самые редкие — в топ они всё равно не попали бы.

import { clientName, isBot, normalizePath, scannerPath, type Entry } from "./parse.ts";

const CAP = 50_000;
const UNIQUE_CAP = 2_000_000;

/**
 * Запоминает ответы для повторяющихся строк: в логе тысячи запросов
 * с одним User-Agent и одним адресом, а регулярные выражения не бесплатны.
 * Когда кэш переполнен, он просто очищается.
 */
function memo<T>(fn: (s: string) => T, cap = 20_000): (s: string) => T {
  const cache = new Map<string, T>();
  return (s) => {
    let v = cache.get(s);
    if (v === undefined) {
      v = fn(s);
      if (cache.size >= cap) cache.clear();
      cache.set(s, v);
    }
    return v;
  };
}

/** Время ответа — гистограмма в логарифмических корзинах: от 1 мс, каждая следующая на 10% шире, до ~15 минут. */
const HIST_BASE = 0.001;
const HIST_STEP = Math.log(1.1);
const HIST_SIZE = 144;
const bucketOf = (sec: number) => Math.max(0, Math.min(HIST_SIZE - 1, Math.floor(Math.log(Math.max(sec, HIST_BASE) / HIST_BASE) / HIST_STEP)));

/**
 * Перцентиль по гистограмме. Середина корзины может выйти за пределы того,
 * что реально было в логе (все ответы ровно по 30 с → «32 с»), поэтому
 * ответ зажимается между минимумом и максимумом.
 */
export function percentile(hist: ArrayLike<number>, p: number, min = 0, max = Infinity): number {
  let total = 0;
  for (let i = 0; i < hist.length; i++) total += hist[i];
  if (!total) return -1;
  const need = total * p;
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    if (seen + hist[i] >= need) {
      // Внутри корзины считаем значения равномерно разбросанными (в логарифмической шкале).
      const frac = hist[i] ? (need - seen) / hist[i] : 0;
      const v = HIST_BASE * Math.exp(HIST_STEP * (i + frac));
      return Math.min(max, Math.max(min, v));
    }
    seen += hist[i];
  }
  return max;
}

interface Row {
  count: number;
  bytes: number;
  e4: number;
  e5: number;
  rtSum: number;
  rtMin: number;
  rtMax: number;
  over1s: number;
  hist: Uint32Array | null;
}

class Table {
  map = new Map<string, Row>();
  pruned = false;

  hit(key: string, e: Entry): Row {
    let r = this.map.get(key);
    if (!r) {
      if (this.map.size >= CAP) this.prune();
      r = { count: 0, bytes: 0, e4: 0, e5: 0, rtSum: 0, rtMin: Infinity, rtMax: 0, over1s: 0, hist: null };
      this.map.set(key, r);
    }
    r.count++;
    r.bytes += e.bytes;
    if (e.status >= 500) r.e5++;
    else if (e.status >= 400) r.e4++;
    if (e.rt >= 0) {
      r.rtSum += e.rt;
      if (e.rt < r.rtMin) r.rtMin = e.rt;
      if (e.rt > r.rtMax) r.rtMax = e.rt;
      if (e.rt >= 1) r.over1s++;
      (r.hist ??= new Uint32Array(HIST_SIZE))[bucketOf(e.rt)]++;
    }
    return r;
  }

  /** Оставляем половину ключей — самые частые. */
  prune() {
    const counts = [...this.map.values()].map((r) => r.count).sort((a, b) => b - a);
    const edge = counts[Math.floor(CAP / 2)];
    for (const [k, r] of this.map) if (r.count < edge) this.map.delete(k);
    // Если почти у всех одинаковый счёт (тысячи адресов по одному запросу), добираем до половины из них.
    for (const [k, r] of this.map) {
      if (this.map.size <= CAP / 2) break;
      if (r.count === edge) this.map.delete(k);
    }
    this.pruned = true;
  }

  top(n: number, by: (r: Row) => number = (r) => r.count): TopRow[] {
    return [...this.map]
      .filter(([, r]) => by(r) > 0)
      .sort((a, b) => by(b[1]) - by(a[1]))
      .slice(0, n)
      .map(([key, r]) => ({
        key,
        count: r.count,
        bytes: r.bytes,
        e4: r.e4,
        e5: r.e5,
        p50: r.hist ? percentile(r.hist, 0.5, r.rtMin, r.rtMax) : -1,
        p95: r.hist ? percentile(r.hist, 0.95, r.rtMin, r.rtMax) : -1,
        rtSum: r.rtSum,
        over1s: r.over1s,
      }));
  }
}

export interface TopRow {
  key: string;
  count: number;
  bytes: number;
  e4: number;
  e5: number;
  /** Секунды; -1 — времени ответа в логе нет. */
  p50: number;
  p95: number;
  rtSum: number;
  /** Сколько запросов шли секунду и дольше. */
  over1s: number;
}

export interface SlowRequest {
  time: number;
  ip: string;
  method: string;
  path: string;
  status: number;
  rt: number;
}

export interface Scanner {
  ip: string;
  count: number;
  paths: string[];
  first: number;
  last: number;
}

export interface Filter {
  ip?: string;
  path?: string;
  /** Класс ответа: 2, 3, 4 или 5. */
  statusClass?: number;
  from?: number;
  to?: number;
}

export interface Options {
  /** Склеивать /product/1 и /product/2 в /product/:id. */
  mergeIds: boolean;
}

export interface Report {
  lines: number;
  parsed: number;
  filteredOut: number;
  unparsed: number;
  unparsedSamples: string[];
  from: number;
  to: number;
  tz: number;
  bytes: number;
  uniqueIps: number;
  uniqueCapped: boolean;
  approximate: boolean;
  classes: [number, number, number, number];
  statuses: [code: number, count: number][];
  methods: [string, number][];
  /** Запросы по минутам: [минута (мс UTC), 2xx, 3xx, 4xx, 5xx]. */
  minutes: [number, number, number, number, number][];
  topPaths: TopRow[];
  topIps: TopRow[];
  notFound: TopRow[];
  serverErrors: TopRow[];
  slowPaths: TopRow[];
  slowest: SlowRequest[];
  hasTiming: boolean;
  p50: number;
  p95: number;
  p99: number;
  clients: { name: string; count: number; bot: boolean }[];
  botRequests: number;
  /** Домен самого сайта, если его удалось понять; переходы с него в referers не входят. */
  ownHost: string;
  referers: [string, number][];
  scanners: Scanner[];
}

export class Aggregator {
  lines = 0;
  parsed = 0;
  filteredOut = 0;
  unparsed = 0;
  unparsedSamples: string[] = [];
  private from = Infinity;
  private to = -Infinity;
  private tz = 0;
  private bytes = 0;
  private unique = new Set<string>();
  private uniqueCapped = false;
  private classes: [number, number, number, number] = [0, 0, 0, 0];
  private statuses = new Map<number, number>();
  private methods = new Map<string, number>();
  private minutes = new Map<number, Uint32Array>();
  private paths = new Table();
  private ips = new Table();
  private notFound = new Table();
  private serverErrors = new Table();
  private clients = new Map<string, { count: number; bot: boolean }>();
  private botRequests = 0;
  private referers = new Map<string, number>();
  private hist = new Uint32Array(HIST_SIZE);
  private rtMin = Infinity;
  private rtMax = 0;
  /** Referer у картинок, скриптов и стилей — это страница самого сайта: так узнаём свой домен. */
  private assetReferers = new Map<string, number>();
  private slowest: SlowRequest[] = [];
  private scan = new Map<string, Scanner>();

  private opts: Options;
  private filter: Filter;
  private norm = memo(normalizePath);
  private client = memo((ua) => ({ name: clientName(ua), bot: isBot(ua) }));
  private refHost = memo(refererHost);

  constructor(opts: Options, filter: Filter = {}) {
    this.opts = opts;
    this.filter = filter;
  }

  /** Строка, которую не удалось разобрать. */
  miss(line: string) {
    this.lines++;
    if (!line.trim()) return;
    this.unparsed++;
    if (this.unparsedSamples.length < 5) this.unparsedSamples.push(line.slice(0, 300));
  }

  add(e: Entry) {
    this.lines++;
    const f = this.filter;
    const path = this.opts.mergeIds ? this.norm(e.path) : e.path;
    if (
      (f.ip && e.ip !== f.ip) ||
      (f.path && path !== f.path) ||
      (f.statusClass && Math.floor(e.status / 100) !== f.statusClass) ||
      (f.from !== undefined && e.time < f.from) ||
      (f.to !== undefined && e.time >= f.to)
    ) {
      this.filteredOut++;
      return;
    }
    this.parsed++;
    if (e.time < this.from) [this.from, this.tz] = [e.time, e.tz];
    if (e.time > this.to) this.to = e.time;
    this.bytes += e.bytes;

    if (!this.uniqueCapped) {
      this.unique.add(e.ip);
      if (this.unique.size >= UNIQUE_CAP) this.uniqueCapped = true;
    }
    const cls = Math.floor(e.status / 100);
    if (cls >= 2 && cls <= 5) this.classes[cls - 2]++;
    this.statuses.set(e.status, (this.statuses.get(e.status) ?? 0) + 1);
    this.methods.set(e.method, (this.methods.get(e.method) ?? 0) + 1);

    const minute = Math.floor(e.time / 60000) * 60000;
    let m = this.minutes.get(minute);
    if (!m) this.minutes.set(minute, (m = new Uint32Array(4)));
    if (cls >= 2 && cls <= 5) m[cls - 2]++;

    this.paths.hit(path, e);
    this.ips.hit(e.ip, e);
    // Сканеры в 404 не пишем: для них отдельный список, а здесь нужны свои битые ссылки.
    if (e.status === 404 && !scannerPath.test(e.path)) this.notFound.hit(path, e);
    if (e.status >= 500) this.serverErrors.hit(path, e);

    const { name, bot } = this.client(e.ua);
    if (bot) this.botRequests++;
    const c = this.clients.get(name);
    if (c) c.count++;
    else this.clients.set(name, { count: 1, bot });

    if (e.referer) {
      const host = this.refHost(e.referer);
      if (host) {
        const map = assetRe.test(e.path) ? this.assetReferers : this.referers;
        map.set(host, (map.get(host) ?? 0) + 1);
      }
    }

    if (e.rt >= 0) {
      this.hist[bucketOf(e.rt)]++;
      if (e.rt < this.rtMin) this.rtMin = e.rt;
      if (e.rt > this.rtMax) this.rtMax = e.rt;
      const s = this.slowest;
      if (s.length < 20 || e.rt > s[s.length - 1].rt) {
        s.push({ time: e.time, ip: e.ip, method: e.method, path: e.path, status: e.status, rt: e.rt });
        s.sort((a, b) => b.rt - a.rt);
        if (s.length > 20) s.pop();
      }
    }

    if (e.status >= 400 && scannerPath.test(e.path)) {
      let sc = this.scan.get(e.ip);
      if (!sc) this.scan.set(e.ip, (sc = { ip: e.ip, count: 0, paths: [], first: e.time, last: e.time }));
      sc.count++;
      sc.last = Math.max(sc.last, e.time);
      sc.first = Math.min(sc.first, e.time);
      if (sc.paths.length < 6 && !sc.paths.includes(e.path)) sc.paths.push(e.path);
    }
  }

  report(): Report {
    const byCount = <K>(m: Map<K, number>) => [...m].sort((a, b) => b[1] - a[1]);
    const hasTiming = this.hist.some((x) => x > 0);
    const ownHost = byCount(this.assetReferers)[0]?.[0] ?? "";
    return {
      lines: this.lines,
      parsed: this.parsed,
      filteredOut: this.filteredOut,
      unparsed: this.unparsed,
      unparsedSamples: this.unparsedSamples,
      from: this.parsed ? this.from : 0,
      to: this.parsed ? this.to : 0,
      tz: this.tz,
      bytes: this.bytes,
      uniqueIps: this.unique.size,
      uniqueCapped: this.uniqueCapped,
      approximate: this.paths.pruned || this.ips.pruned,
      classes: this.classes,
      statuses: byCount(this.statuses),
      methods: byCount(this.methods),
      minutes: [...this.minutes]
        .sort((a, b) => a[0] - b[0])
        .map(([t, c]) => [t, c[0], c[1], c[2], c[3]]),
      topPaths: this.paths.top(30),
      topIps: this.ips.top(30),
      notFound: this.notFound.top(15),
      serverErrors: this.serverErrors.top(15),
      // Медленные адреса — по суммарному времени: частый адрес на 300 мс грузит сервер сильнее редкого на 5 с.
      slowPaths: hasTiming ? this.paths.top(15, (r) => (r.count >= 5 ? r.rtSum : 0)) : [],
      slowest: this.slowest,
      hasTiming,
      p50: percentile(this.hist, 0.5, this.rtMin, this.rtMax),
      p95: percentile(this.hist, 0.95, this.rtMin, this.rtMax),
      p99: percentile(this.hist, 0.99, this.rtMin, this.rtMax),
      clients: [...this.clients].map(([name, c]) => ({ name, ...c })).sort((a, b) => b.count - a.count).slice(0, 15),
      botRequests: this.botRequests,
      ownHost,
      referers: byCount(this.referers)
        .filter(([h]) => h !== ownHost)
        .slice(0, 15),
      scanners: [...this.scan.values()].filter((s) => s.count >= 5).sort((a, b) => b.count - a.count),
    };
  }
}

const assetRe = /\.(js|mjs|css|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf)$/i;

function refererHost(ref: string): string {
  const m = /^https?:\/\/([^/:?#]+)/i.exec(ref);
  return m ? m[1].toLowerCase().replace(/^www\./, "") : "";
}
