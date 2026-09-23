// Разбор строки access.log. Понимает стандартный формат nginx «combined»
// (он же у Apache), его варианты с полями в конце — временем ответа,
// X-Forwarded-For, upstream — и JSON-логи (log_format … escape=json).

export interface Entry {
  ip: string;
  /** Время запроса, миллисекунды UTC. */
  time: number;
  /** Смещение часового пояса лога в минутах: +0300 → 180. */
  tz: number;
  method: string;
  /** Путь без строки запроса. */
  path: string;
  status: number;
  bytes: number;
  referer: string;
  ua: string;
  /** Время ответа в секундах или -1, если его нет в логе. */
  rt: number;
}

const months: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

let lastStamp = "";
let lastTime = 0;
let lastTz = 0;

/**
 * «22/Sep/2026:14:05:09 +0300» → миллисекунды UTC. В логе тысячи строк
 * подряд с одной и той же секундой, поэтому последний ответ запоминаем.
 */
export function parseNginxTime(s: string): [time: number, tz: number] | null {
  if (s === lastStamp) return [lastTime, lastTz];
  if (s.length < 20 || s[2] !== "/" || s[6] !== "/" || s[11] !== ":") return null;
  const mon = months[s.slice(3, 6)];
  if (mon === undefined) return null;
  const d = +s.slice(0, 2), y = +s.slice(7, 11), h = +s.slice(12, 14), mi = +s.slice(15, 17), se = +s.slice(18, 20);
  let tz = 0;
  if (s.length >= 26) {
    const sign = s[21] === "-" ? -1 : 1;
    tz = sign * (+s.slice(22, 24) * 60 + +s.slice(24, 26));
  }
  const t = Date.UTC(y, mon, d, h, mi, se) - tz * 60000;
  if (Number.isNaN(t)) return null;
  [lastStamp, lastTime, lastTz] = [s, t, tz];
  return [t, tz];
}

/** ISO-время из JSON-логов: 2026-09-22T14:05:09+03:00. */
function parseIsoTime(s: string): [number, number] | null {
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(s);
  const tz = m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]) : 0;
  return [t, tz];
}

// ip - user [время] "запрос" статус байты "откуда" "браузер" хвост
// Строки в кавычках могут содержать \" — nginx так экранирует кавычки.
const q = String.raw`"((?:[^"\\]|\\.)*)"`;
const combined = new RegExp(String.raw`^(\S+) \S+ \S+ \[([^\]]+)\] ${q} (\d{3}) (\d+|-)(?: ${q} ${q})?(.*)$`);

/** Время ответа из хвоста строки: «rt=0.042», «request_time=0.042» или просто первое число вида 0.042. */
function tailTime(tail: string): number {
  if (!tail) return -1;
  const m = /(?:rt|request_time)=\"?(\d+(?:\.\d+)?)/.exec(tail) ?? /(?:^|\s)"?(\d+\.\d{3})"?(?:\s|$)/.exec(tail);
  return m ? Number(m[1]) : -1;
}

/** «GET /a?b=1 HTTP/1.1» → метод и путь. Мусор вроде TLS-рукопожатия на 80-й порт — метод «?». */
function splitRequest(req: string): [method: string, path: string] {
  const sp1 = req.indexOf(" ");
  if (sp1 < 1) return ["?", req === "-" || req === "" ? "(пусто)" : "(мусор)"];
  const method = req.slice(0, sp1);
  if (!/^[A-Z]{3,10}$/.test(method)) return ["?", "(мусор)"];
  const sp2 = req.indexOf(" ", sp1 + 1);
  let target = sp2 < 0 ? req.slice(sp1 + 1) : req.slice(sp1 + 1, sp2);
  const qm = target.indexOf("?");
  if (qm >= 0) target = target.slice(0, qm);
  // Абсолютная форма «GET http://host/path» — у прокси и сканеров.
  if (target.startsWith("http://") || target.startsWith("https://")) {
    const slash = target.indexOf("/", target.indexOf("//") + 2);
    target = slash < 0 ? "/" : target.slice(slash);
  }
  return [method, target || "/"];
}

export function parseLine(line: string): Entry | null {
  if (line.charCodeAt(0) === 123 /* { */) return parseJsonLine(line);
  const m = combined.exec(line);
  if (!m) return null;
  const time = parseNginxTime(m[2]);
  if (!time) return null;
  const [method, path] = splitRequest(m[3]);
  return {
    ip: m[1],
    time: time[0],
    tz: time[1],
    method,
    path,
    status: +m[4],
    bytes: m[5] === "-" ? 0 : +m[5],
    referer: m[6] && m[6] !== "-" ? m[6] : "",
    ua: m[7] && m[7] !== "-" ? m[7] : "",
    rt: tailTime(m[8]),
  };
}

type Json = Record<string, unknown>;
const pickStr = (o: Json, ...keys: string[]) => {
  for (const k of keys) if (typeof o[k] === "string" && o[k] !== "") return o[k] as string;
  return "";
};
const pickNum = (o: Json, ...keys: string[]) => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number") return v;
    if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v))) return Number(v);
  }
  return NaN;
};

function parseJsonLine(line: string): Entry | null {
  let o: Json;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  const stamp = pickStr(o, "time_local", "time_iso8601", "time", "@timestamp", "timestamp");
  const time = stamp.includes("/") ? parseNginxTime(stamp) : parseIsoTime(stamp);
  const status = pickNum(o, "status");
  if (!time || !status) return null;
  let method = pickStr(o, "request_method", "method");
  let path = pickStr(o, "uri", "request_uri", "path");
  if (!method || !path) [method, path] = splitRequest(pickStr(o, "request"));
  else path = path.split("?")[0];
  const rt = pickNum(o, "request_time", "duration", "rt");
  return {
    ip: pickStr(o, "remote_addr", "ip", "client_ip") || "-",
    time: time[0],
    tz: time[1],
    method,
    path,
    status,
    bytes: pickNum(o, "body_bytes_sent", "bytes_sent", "bytes") || 0,
    referer: pickStr(o, "http_referer", "referer", "referrer").replace(/^-$/, ""),
    ua: pickStr(o, "http_user_agent", "user_agent", "ua").replace(/^-$/, ""),
    rt: Number.isNaN(rt) ? -1 : rt,
  };
}

/**
 * Склеивает похожие адреса: /product/1042 и /product/1043 → /product/:id.
 * Иначе топ адресов забит тысячей строк по одному запросу.
 */
export function normalizePath(path: string): string {
  if (path.length > 200) path = path.slice(0, 200) + "…";
  return path
    .split("/")
    .map((seg) => {
      if (/^\d+$/.test(seg)) return ":id";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":uuid";
      if (/^[0-9a-f]{16,}$/i.test(seg)) return ":hash";
      if (/^\d+\.(webp|jpe?g|png|gif|avif)$/i.test(seg)) return ":id." + seg.split(".").pop();
      return seg;
    })
    .join("/");
}

const botRe = /bot|crawl|spider|slurp|scrap|curl|wget|python|go-http|java\/|okhttp|httpclient|axios|node-fetch|headless|monitor|uptime|zgrab|masscan|nmap|nuclei|facebookexternalhit|preview/i;

/** Бот или скрипт по заголовку User-Agent. Пустой UA тоже считаем скриптом: браузер его всегда шлёт. */
export const isBot = (ua: string) => ua === "" || botRe.test(ua);

/** Короткое имя клиента для топа: «Googlebot», «Chrome», «curl». */
export function clientName(ua: string): string {
  if (!ua) return "(без User-Agent)";
  const known = /(YandexBot|YandexImages|YandexMetrika|Googlebot|bingbot|Applebot|PetalBot|AhrefsBot|SemrushBot|MJ12bot|DotBot|GPTBot|ClaudeBot|UptimeRobot|TelegramBot|facebookexternalhit|curl|Wget|python-requests|Go-http-client|okhttp|zgrab|Nuclei|masscan)/i.exec(ua);
  if (known) return known[1];
  if (/bot|crawl|spider/i.test(ua)) return "другой бот";
  if (/YaBrowser/.test(ua)) return "Яндекс Браузер";
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\//.test(ua)) return "Opera";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Chrome\//.test(ua)) return /Mobile/.test(ua) ? "Chrome, телефон" : "Chrome";
  if (/Safari\//.test(ua)) return /iPhone|iPad/.test(ua) ? "Safari, iPhone" : "Safari";
  return "другое";
}

/** Запросы, которые делают сканеры уязвимостей: чужие CMS, файлы с секретами, админки. */
export const scannerPath = /\/\.(env|git|svn|aws|ssh|DS_Store)|wp-(login|admin|content|includes)|xmlrpc\.php|phpmyadmin|pma\/|\/cgi-bin\/|\.(php|asp|aspx|jsp|cgi)$|\/(backup|dump|db)\.(zip|sql|tar|gz)|\/actuator|\/server-status|\/config\.(json|yml|php)|\/boaform|\/HNAP1/i;
