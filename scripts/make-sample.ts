// Пример лога: сутки выдуманного интернет-магазина чая samovar.example.
// Что в нём спрятано, чтобы было что найти:
//   14:20–14:38 — упал бэкенд заказов: сначала 502, потом 504 по 30 секунд;
//   03:12 — сканер перебирает /wp-login.php, /.env, /.git/config;
//   16:40 — ещё один сканер, поменьше, с IPv6;
//   /api/search — медленный, полсекунды и больше;
//   /catalog/old-collection — битая ссылка из Telegram-канала, 404;
//   YandexBot, Googlebot и мониторинг раз в минуту.
// Все IP из диапазонов для документации (RFC 5737, RFC 3849) — чужих адресов нет.
//
//   node scripts/make-sample.ts

import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

let seed = 20260922;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
/** Логнормальное время ответа: медиана и разброс. */
const lognorm = (median: number, spread: number) => {
  const u = Math.max(1e-9, rnd());
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  return median * Math.exp(spread * z);
};

const DAY = Date.UTC(2026, 8, 22) - 3 * 3600_000; // 22.09.2026 00:00 по Москве
const HOST = "https://samovar.example";
const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
function stamp(t: number) {
  const d = new Date(t + 3 * 3600_000);
  return `${pad(d.getUTCDate())}/${mon[d.getUTCMonth()]}/${d.getUTCFullYear()}:${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0300`;
}

const lines: [number, string][] = [];
function log(t: number, ip: string, req: string, status: number, bytes: number, ref: string, ua: string, rt: number) {
  lines.push([t, `${ip} - - [${stamp(t)}] "${req}" ${status} ${bytes} "${ref || "-"}" "${ua || "-"}" ${rt.toFixed(3)}`]);
}

const browsers = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 YaBrowser/25.8.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
];
const browserWeights = [30, 22, 20, 14, 5, 5, 4];
const pickBrowser = () => {
  let r = rnd() * 100;
  for (let i = 0; i < browsers.length; i++) if ((r -= browserWeights[i]) < 0) return browsers[i];
  return browsers[0];
};

const visitorIp = () => {
  if (rnd() < 0.12) return `2001:db8:${int(1, 0xfff).toString(16)}::${int(1, 0xffff).toString(16)}`;
  return `${pick(["203.0.113", "198.51.100", "192.0.2"])}.${int(10, 190)}`;
};

const slugs = ["puer", "ulun", "zelenyj", "krasnyj", "belyj", "travyanoj"];
const posts = ["kak-zavarivat-puer", "chajnaya-ceremoniya", "ulun-dlya-nachinayushchih", "posuda-dlya-chaya"];
const queries = ["пуэр", "улун", "те гуань инь", "да хун пао", "чайник", "габа", "молочный улун", "шу пуэр 2015"];
const outsideRefs = [
  ["https://yandex.ru/search/?text=купить+пуэр", 35],
  ["https://www.google.com/", 20],
  ["https://t.me/samovar_tea", 6],
  ["https://vk.com/", 4],
  ["", 35],
] as const;
const pickRef = () => {
  let r = rnd() * 100;
  for (const [ref, w] of outsideRefs) if ((r -= w) < 0) return ref;
  return "";
};

const INCIDENT_FROM = DAY + (14 * 60 + 20) * 60_000;
const INCIDENT_504 = DAY + (14 * 60 + 30) * 60_000;
const INCIDENT_TO = DAY + (14 * 60 + 38) * 60_000;
/** Бэкенд заказов во время сбоя: 502 сразу, потом 504 по таймауту 30 с. */
function backend(t: number): [status: number, rt: number] | null {
  if (t < INCIDENT_FROM || t >= INCIDENT_TO) return null;
  return t < INCIDENT_504 ? [502, rnd() * 0.004] : [504, 30 + rnd() * 0.02];
}

// ---------- люди ----------

const perHour = [2, 1, 1, 1, 1, 2, 4, 8, 12, 15, 16, 17, 18, 17, 16, 16, 17, 19, 23, 27, 30, 26, 16, 7];
for (let h = 0; h < 24; h++) {
  for (let v = perHour[h] * 5; v > 0; v--) visit(DAY + h * 3600_000 + int(0, 3599) * 1000);
}

function visit(start: number) {
  const ip = visitorIp();
  const ua = pickBrowser();
  let t = start;
  let ref = pickRef();
  let first = true;
  for (let n = int(1, 6); n > 0; n--) {
    const page = pickPage(ref);
    const status = page === "/catalog/old-collection" ? 404 : 200;
    // Страницы отдаёт фронтенд — они живы и во время сбоя. Падают запросы к API.
    log(t, ip, `GET ${page} HTTP/2.0`, status, status === 404 ? 3650 : int(14000, 42000), ref, ua, lognorm(0.045, 0.5));
    let ts = t + 150;
    if (first) {
      log(ts, ip, "GET /static/app.3f9a1c.js HTTP/2.0", 200, 184_311, HOST + page, ua, rnd() * 0.002);
      log(ts, ip, "GET /static/style.8b2e.css HTTP/2.0", 200, 31_902, HOST + page, ua, rnd() * 0.002);
      first = false;
    }
    if (status === 200) {
      for (let i = int(page.startsWith("/product") ? 3 : 1, 8); i > 0; i--) {
        const id = rnd() < 0.015 ? 1999 : int(1001, 1240);
        log(ts + int(50, 400), ip, `GET /img/products/${id}.webp HTTP/2.0`, id === 1999 ? 404 : 200, id === 1999 ? 0 : int(18000, 120000), HOST + page, ua, rnd() * 0.003);
      }
      // Корзину фронтенд при ошибке запрашивает ещё два раза.
      for (let attempt = 0; attempt < 3; attempt++) {
        const at = ts + 300 + attempt * 2000;
        const cart = backend(at);
        log(at, ip, "GET /api/cart HTTP/2.0", cart ? cart[0] : 200, cart ? 157 : int(90, 900), HOST + page, ua, cart ? cart[1] : lognorm(0.012, 0.4));
        if (!cart) break;
      }
      if (rnd() < 0.1) {
        const q = encodeURIComponent(pick(queries));
        log(ts + int(2000, 9000), ip, `GET /api/search?q=${q} HTTP/2.0`, 200, int(1200, 9000), HOST + page, ua, lognorm(0.62, 0.55));
      }
      if (page.startsWith("/product/") && rnd() < 0.15) {
        const c = backend(ts);
        log(ts + int(5000, 30000), ip, "POST /api/cart/add HTTP/2.0", c ? c[0] : 200, c ? 157 : 312, HOST + page, ua, c ? c[1] : lognorm(0.03, 0.4));
      }
      if (page === "/checkout" && rnd() < 0.6) {
        const o = backend(ts + 40000);
        log(ts + int(30000, 90000), ip, "POST /api/orders HTTP/2.0", o ? o[0] : 201, o ? 157 : 540, HOST + page, ua, o ? o[1] : lognorm(0.18, 0.4));
        // Во время сбоя люди жмут «Оформить» ещё раз.
        if (o) for (let r = int(1, 3); r > 0; r--) {
          const again = backend(ts + 60000 + r * 15000) ?? [201, lognorm(0.18, 0.4)];
          log(ts + 60000 + r * 15000, ip, "POST /api/orders HTTP/2.0", again[0], again[0] === 201 ? 540 : 157, HOST + page, ua, again[1]);
        }
      }
    }
    ref = HOST + page;
    t += int(15, 180) * 1000;
    if (t > DAY + 86_399_000) break;
  }
}

function pickPage(ref: string): string {
  const r = rnd() * 100;
  if (ref.startsWith("https://t.me") && rnd() < 0.5) return "/catalog/old-collection";
  if (r < 18) return "/";
  if (r < 32) return "/catalog";
  if (r < 52) return `/catalog/${pick(slugs)}`;
  if (r < 82) return `/product/${int(1001, 1240)}`;
  if (r < 87) return `/blog/${pick(posts)}`;
  if (r < 92) return "/cart";
  if (r < 96) return "/checkout";
  return pick(["/about", "/delivery", "/contacts"]);
}

// ---------- боты ----------

const yandex = "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)";
const google = "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
for (const [ua, net, n] of [[yandex, "198.51.100", 1600], [google, "203.0.113", 1100]] as const) {
  for (let i = 0; i < n; i++) {
    const t = DAY + int(0, 86_399) * 1000;
    const page = i % 200 === 0 ? "/robots.txt" : i % 200 === 1 ? "/sitemap.xml" : pickPage("");
    const status = page === "/catalog/old-collection" ? 404 : rnd() < 0.08 ? 304 : 200;
    log(t, `${net}.${int(210, 229)}`, `GET ${page} HTTP/1.1`, status, status === 200 ? int(14000, 42000) : 0, "", ua, lognorm(0.05, 0.5));
  }
}
for (let m = 0; m < 1440; m++) {
  log(DAY + m * 60_000 + 7000, "198.51.100.7", "HEAD /health HTTP/1.1", 200, 0, "", "Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)", rnd() * 0.003);
}

// ---------- сканеры и мусор ----------

const probes = [
  "/wp-login.php", "/wp-admin/", "/xmlrpc.php", "/.env", "/.env.backup", "/.git/config", "/.git/HEAD", "/phpmyadmin/",
  "/pma/", "/admin.php", "/config.php", "/backup.zip", "/db.sql", "/.aws/credentials", "/server-status", "/actuator/env",
  "/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php", "/cgi-bin/luci", "/boaform/admin/formLogin", "/HNAP1/",
];
function scanner(ip: string, ua: string, from: number, count: number) {
  for (let i = 0; i < count; i++) {
    const path = probes[i % probes.length] + (i >= probes.length ? `?${i}` : "");
    const status = path.startsWith("/.git") ? 403 : 404;
    log(from + i * int(200, 1200), ip, `GET ${path} HTTP/1.1`, status, 153, "", ua, rnd() * 0.002);
  }
}
scanner("192.0.2.250", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.129 Safari/537.36", DAY + (3 * 60 + 12) * 60_000, 540);
scanner("2001:db8:bad::1", "python-requests/2.32.3", DAY + (16 * 60 + 40) * 60_000, 80);
for (let i = 0; i < 12; i++) {
  lines.push([DAY + int(0, 86_399) * 1000, ""]);
  const t = lines[lines.length - 1][0];
  lines[lines.length - 1][1] = `${pick(["203.0.113", "198.51.100"])}.${int(191, 250)} - - [${stamp(t)}] "\\x16\\x03\\x01\\x00\\xF1\\x01\\x00\\x00\\xED\\x03\\x03" 400 157 "-" "-" 0.000`;
}

lines.sort((a, b) => a[0] - b[0]);
const text = lines.map((l) => l[1]).join("\n") + "\n";
writeFileSync(new URL("../public/sample/access.log.gz", import.meta.url), gzipSync(text, { level: 9 }));
console.log(`строк: ${lines.length}, ${(text.length / 1e6).toFixed(1)} МБ текста`);
