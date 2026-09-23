// Потоковое чтение: файл идёт кусками, .gz распаковывается на лету,
// в памяти одновременно только текущий кусок. Одинаково работает в
// браузере (в Web Worker) и в Node — на этом держатся тесты и замер.

import { parseLine } from "./parse.ts";
import type { Aggregator } from "./stats.ts";

export type OnProgress = (bytesRead: number, lines: number) => void;

/** Читает файлы по очереди в один отчёт: access.log, access.log.1, access.log.2.gz… */
export async function analyzeBlobs(blobs: Blob[], agg: Aggregator, onProgress?: OnProgress): Promise<void> {
  let done = 0;
  for (const blob of blobs) {
    await analyzeBlob(blob, agg, (bytes, lines) => onProgress?.(done + bytes, lines));
    done += blob.size;
  }
  onProgress?.(done, agg.lines);
}

async function analyzeBlob(blob: Blob, agg: Aggregator, onProgress?: OnProgress): Promise<void> {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  let read = 0;
  let stream: ReadableStream<Uint8Array> = blob.stream().pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, c) {
        read += chunk.byteLength;
        c.enqueue(chunk);
      },
    }),
  );
  // gzip узнаём по первым байтам, а не по имени файла.
  if (head[0] === 0x1f && head[1] === 0x8b) {
    stream = stream.pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
  }
  const reader = stream.pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>).getReader();

  let rest = "";
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    agg.textSize += value.length;
    const text = rest + value;
    let start = 0;
    let nl = text.indexOf("\n");
    while (nl >= 0) {
      feed(agg, text, start, nl);
      start = nl + 1;
      nl = text.indexOf("\n", start);
    }
    rest = text.slice(start);
    const now = performance.now();
    if (onProgress && now - lastReport > 100) {
      lastReport = now;
      onProgress(read, agg.lines);
    }
  }
  if (rest) feed(agg, rest, 0, rest.length);
}

function feed(agg: Aggregator, text: string, from: number, to: number) {
  if (to > from && text.charCodeAt(to - 1) === 13 /* \r */) to--;
  const line = text.slice(from, to);
  const e = parseLine(line);
  if (e) agg.add(e);
  else agg.miss(line);
}
