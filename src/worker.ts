// Разбор идёт в отдельном потоке, чтобы страница не замирала на большом логе.

import { analyzeBlobs } from "./read.ts";
import { Aggregator, type Filter, type Options, type Report } from "./stats.ts";

export type Request = { id: number; files: Blob[]; options: Options; filter: Filter };
export type Response =
  | { id: number; type: "progress"; bytes: number; total: number; lines: number }
  | { id: number; type: "done"; report: Report; ms: number; bytes: number }
  | { id: number; type: "error"; message: string };

const post = (r: Response) => (self as unknown as Worker).postMessage(r);

self.onmessage = async (ev: MessageEvent<Request>) => {
  const { id, files, options, filter } = ev.data;
  const total = files.reduce((s, f) => s + f.size, 0);
  const t0 = performance.now();
  try {
    const agg = new Aggregator(options, filter);
    await analyzeBlobs(files, agg, (bytes, lines) => post({ id, type: "progress", bytes, total, lines }));
    post({ id, type: "done", report: agg.report(), ms: performance.now() - t0, bytes: total });
  } catch (e) {
    post({ id, type: "error", message: (e as Error).message || String(e) });
  }
};
