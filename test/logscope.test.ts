import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { clientName, isBot, normalizePath, parseLine, parseNginxTime } from "../src/parse.ts";
import { analyzeBlobs } from "../src/read.ts";
import { Aggregator, percentile, type Filter, type Report } from "../src/stats.ts";

const sample = new Blob([readFileSync(new URL("../public/sample/access.log.gz", import.meta.url))]);

async function run(blobs: Blob[], filter: Filter = {}, mergeIds = true): Promise<Report> {
  const agg = new Aggregator({ mergeIds }, filter);
  await analyzeBlobs(blobs, agg);
  return agg.report();
}

test("время nginx", () => {
  assert.deepEqual(parseNginxTime("22/Sep/2026:14:05:09 +0300"), [Date.UTC(2026, 8, 22, 11, 5, 9), 180]);
  assert.deepEqual(parseNginxTime("01/Jan/2026:00:00:00 -0500"), [Date.UTC(2026, 0, 1, 5), -300]);
  assert.equal(parseNginxTime("вчера"), null);
});

test("строка combined со временем ответа в конце", () => {
  const e = parseLine(
    '203.0.113.5 - alice [22/Sep/2026:14:05:09 +0300] "GET /product/42?utm=1 HTTP/2.0" 200 5120 "https://ya.ru/" "Mozilla/5.0 \\"quoted\\"" 0.042',
  )!;
  assert.equal(e.ip, "203.0.113.5");
  assert.equal(e.method, "GET");
  assert.equal(e.path, "/product/42");
  assert.equal(e.status, 200);
  assert.equal(e.bytes, 5120);
  assert.equal(e.referer, "https://ya.ru/");
  assert.equal(e.ua, 'Mozilla/5.0 \\"quoted\\"');
  assert.equal(e.rt, 0.042);
});

test("варианты формата", () => {
  // Без времени ответа — классический combined.
  assert.equal(parseLine('192.0.2.1 - - [22/Sep/2026:14:05:09 +0300] "GET / HTTP/1.1" 304 - "-" "curl/8.5.0"')!.rt, -1);
  // common — без referer и user-agent.
  assert.equal(parseLine('192.0.2.1 - - [22/Sep/2026:14:05:09 +0300] "GET / HTTP/1.0" 200 12')!.bytes, 12);
  // Ключи в хвосте и X-Forwarded-For перед временем.
  assert.equal(parseLine('192.0.2.1 - - [22/Sep/2026:14:05:09 +0300] "GET / HTTP/1.1" 200 1 "-" "x" rt=1.250 uct="0.000" urt="1.249"')!.rt, 1.25);
  assert.equal(parseLine('192.0.2.1 - - [22/Sep/2026:14:05:09 +0300] "GET / HTTP/1.1" 200 1 "-" "x" "198.51.100.1, 10.0.0.1" 0.310 0.309')!.rt, 0.31);
  // TLS-рукопожатие на 80-й порт.
  const junk = parseLine('192.0.2.1 - - [22/Sep/2026:14:05:09 +0300] "\\x16\\x03\\x01\\x00" 400 157 "-" "-"')!;
  assert.deepEqual([junk.method, junk.path, junk.status], ["?", "(мусор)", 400]);
  // Прокси-запрос с полным адресом.
  assert.equal(parseLine('192.0.2.1 - - [22/Sep/2026:14:05:09 +0300] "GET http://example.com/a/b HTTP/1.1" 400 0 "-" "-"')!.path, "/a/b");
  assert.equal(parseLine("просто текст"), null);
});

test("JSON-логи", () => {
  const e = parseLine(
    '{"time_iso8601":"2026-09-22T14:05:09+03:00","remote_addr":"2001:db8::1","request":"POST /api/orders HTTP/2.0","status":"502","body_bytes_sent":"157","request_time":"0.003","http_user_agent":"Mozilla/5.0","http_referer":""}',
  )!;
  assert.deepEqual(
    [e.ip, e.method, e.path, e.status, e.bytes, e.rt, e.time, e.tz],
    ["2001:db8::1", "POST", "/api/orders", 502, 157, 0.003, Date.UTC(2026, 8, 22, 11, 5, 9), 180],
  );
});

test("склейка адресов и боты", () => {
  assert.equal(normalizePath("/product/1042"), "/product/:id");
  assert.equal(normalizePath("/u/3f2a9c1e-1b2c-4d5e-8f90-1234567890ab/edit"), "/u/:uuid/edit");
  assert.equal(normalizePath("/img/products/1042.webp"), "/img/products/:id.webp");
  assert.equal(normalizePath("/static/app.3f9a1c.js"), "/static/app.3f9a1c.js");
  assert.ok(isBot("Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)"));
  assert.ok(isBot(""));
  assert.ok(!isBot("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"));
  assert.equal(clientName("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140.0.0.0 YaBrowser/25.8.0.0 Safari/537.36"), "Яндекс Браузер");
});

test("перцентили по гистограмме — с точностью до ширины корзины", () => {
  const agg = new Aggregator({ mergeIds: true });
  for (let i = 1; i <= 1000; i++) {
    agg.add({ ip: "1", time: 0, tz: 0, method: "GET", path: "/", status: 200, bytes: 0, referer: "", ua: "", rt: i / 1000 });
  }
  const r = agg.report();
  // Настоящие значения 0,5 с и 0,95 с; корзины шире на 25%, так что погрешность до ~12%.
  assert.ok(Math.abs(r.p50 - 0.5) / 0.5 < 0.13, `p50 ${r.p50}`);
  assert.ok(Math.abs(r.p95 - 0.95) / 0.95 < 0.13, `p95 ${r.p95}`);
  assert.equal(percentile([0, 0], 0.5), -1);
});

test("пример: всё спрятанное находится", async () => {
  const r = await run([sample]);
  assert.equal(r.unparsed, 0);
  assert.ok(r.parsed > 40_000, `разобрано ${r.parsed}`);
  assert.equal(r.tz, 180);
  assert.ok(r.hasTiming);

  // Сбой 14:20–14:38: все 5xx — в этом окне, первым падает API корзины.
  const inc = (m: number[]) => m[0] >= Date.UTC(2026, 8, 22, 11, 20) && m[0] < Date.UTC(2026, 8, 22, 11, 38);
  const in5xx = r.minutes.filter(inc).reduce((s, m) => s + m[4], 0);
  assert.equal(in5xx, r.classes[3]);
  assert.equal(r.serverErrors[0].key, "/api/cart");

  // Сканеры: оба найдены, первый — ночной.
  assert.deepEqual(r.scanners.map((s) => s.ip), ["192.0.2.250", "2001:db8:bad::1"]);

  // Битая ссылка — первая среди 404, если не считать сканеров.
  assert.ok(r.notFound.slice(0, 3).some((p) => p.key === "/catalog/old-collection"));

  // Поиск — среди самых медленных по суммарному времени.
  const slow = r.slowPaths.slice(0, 3).map((p) => p.key);
  assert.ok(slow.includes("/api/search"), `медленные: ${slow}`);
  const search = r.topPaths.find((p) => p.key === "/api/search")!;
  assert.ok(search.p50 > 0.4 && search.p50 < 0.9, `p50 поиска ${search.p50}`);

  // Товары склеились в /product/:id.
  assert.equal(r.topPaths[0].key, "/img/products/:id.webp");
  assert.ok(r.topPaths.some((p) => p.key === "/product/:id"));
  assert.ok(r.clients.some((c) => c.name === "YandexBot" && c.bot));
  assert.ok(r.botRequests > 4000);
});

test("фильтр по IP и по классу ответа", async () => {
  const byIp = await run([sample], { ip: "192.0.2.250" });
  assert.equal(byIp.parsed, 540);
  assert.equal(byIp.topIps.length, 1);
  const only5xx = await run([sample], { statusClass: 5 });
  assert.deepEqual(only5xx.classes.slice(0, 3), [0, 0, 0]);
  assert.ok(only5xx.parsed > 0);
});

test("несколько файлов, gzip и без, CRLF и строка без перевода в конце", async () => {
  const a = '192.0.2.1 - - [22/Sep/2026:10:00:00 +0300] "GET /a HTTP/1.1" 200 10 "-" "curl/8"\r\n';
  const b = '192.0.2.2 - - [22/Sep/2026:11:00:00 +0300] "GET /b HTTP/1.1" 500 20 "-" "curl/8"';
  const r = await run([new Blob([a]), new Blob([gzipSync(b)])]);
  assert.equal(r.parsed, 2);
  assert.equal(r.bytes, 30);
  assert.deepEqual(r.classes, [1, 0, 0, 1]);
});
