// Замер скорости: пример лога, повторённый N раз, читается целиком в памяти —
// диск не участвует, меряется только разбор и подсчёт.
//
//   node scripts/bench.ts [повторов=20] [--gz]

import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { analyzeBlobs } from "../src/read.ts";
import { Aggregator } from "../src/stats.ts";

const times = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 20);
const gz = process.argv.includes("--gz");
const text = gunzipSync(readFileSync(new URL("../public/sample/access.log.gz", import.meta.url)));
const raw = Buffer.concat(Array(times).fill(text));
const blob = new Blob([gz ? gzipSync(raw, { level: 6 }) : raw]);

const t0 = performance.now();
const agg = new Aggregator({ mergeIds: true });
await analyzeBlobs([blob], agg);
const r = agg.report();
const sec = (performance.now() - t0) / 1000;

const mb = raw.length / 1e6;
console.log(
  `${gz ? "gzip, " : ""}${mb.toFixed(0)} МБ текста, ${agg.lines.toLocaleString("ru-RU")} строк за ${sec.toFixed(2)} с: ` +
    `${(mb / sec).toFixed(0)} МБ/с, ${Math.round(agg.lines / sec).toLocaleString("ru-RU")} строк/с; ` +
    `память ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} МБ; разобрано ${r.parsed.toLocaleString("ru-RU")}`,
);
