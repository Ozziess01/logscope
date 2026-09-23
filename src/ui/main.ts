import "./style.css";
import type { Filter, Report, TopRow } from "../stats.ts";
import type { Request, Response } from "../worker.ts";
import { bytes, clock, dur, esc, num, pct, plural, short, tzLabel, when } from "./format.ts";
import { timeline } from "./timeline.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const openEl = $("open");
const fileInput = $<HTMLInputElement>("file");
const errorEl = $("error");
const progressEl = $("progress");
const reportEl = $("report");

let files: Blob[] = [];
let names: string[] = [];
let filter: Filter = {};
let mergeIds = true;
let report: Report | null = null;
let worker: Worker | null = null;
let runId = 0;
let lastRun = { ms: 0, bytes: 0 };

// ---------- открытие ----------

$("pick").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files?.length) open([...fileInput.files]);
  fileInput.value = "";
});
for (const ev of ["dragenter", "dragover"]) {
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    openEl.classList.add("over");
  });
}
document.addEventListener("dragleave", (e) => {
  if ((e as DragEvent).relatedTarget === null) openEl.classList.remove("over");
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  openEl.classList.remove("over");
  const list = e.dataTransfer?.files;
  if (list?.length) open([...list]);
});
$("sample").addEventListener("click", async () => {
  errorEl.hidden = true;
  try {
    const r = await fetch("sample/access.log.gz");
    if (!r.ok) throw new Error(`пример не загрузился (${r.status})`);
    // Не r.blob(): некоторые серверы отдают .gz с Content-Encoding: gzip, браузер
    // распаковывает сам, и Chrome на blob() такого ответа падает с «Failed to fetch».
    // Разбору всё равно: сжатый и распакованный текст он различает по первым байтам.
    open([new File([await r.arrayBuffer()], "access.log.gz — пример")]);
  } catch (e) {
    showError((e as Error).message);
  }
});

function open(list: File[]) {
  errorEl.hidden = true;
  files = list;
  names = list.map((f) => f.name);
  filter = {};
  report = null;
  run();
}

function showError(message: string) {
  errorEl.textContent = message;
  errorEl.hidden = false;
  openEl.hidden = false;
  progressEl.hidden = true;
  reportEl.hidden = true;
}

// ---------- разбор в фоне ----------

function run() {
  worker?.terminate();
  worker = new Worker(new URL("../worker.ts", import.meta.url), { type: "module" });
  const id = ++runId;
  const total = files.reduce((s, f) => s + f.size, 0);
  openEl.hidden = true;
  progressEl.hidden = false;
  reportEl.classList.toggle("busy", report !== null);
  setProgress(0, total, 0);

  worker.onmessage = (ev: MessageEvent<Response>) => {
    const m = ev.data;
    if (m.id !== id) return;
    if (m.type === "progress") setProgress(m.bytes, m.total, m.lines);
    else if (m.type === "error") showError(`Не удалось прочитать: ${m.message}`);
    else {
      progressEl.hidden = true;
      reportEl.classList.remove("busy");
      if (m.report.parsed === 0 && m.report.filteredOut === 0) {
        showError(
          m.report.unparsed
            ? `Ни одной строки не разобралось. Похоже, формат лога не combined и не JSON. Первая строка: «${m.report.unparsedSamples[0]?.slice(0, 160)}»`
            : "Файл пустой.",
        );
        return;
      }
      report = m.report;
      lastRun = { ms: m.ms, bytes: m.bytes };
      render();
    }
  };
  worker.onerror = (e) => showError(`Ошибка при разборе: ${e.message}`);
  worker.postMessage({ id, files, options: { mergeIds }, filter } satisfies Request);
}

function setProgress(done: number, total: number, lines: number) {
  $("progress-bar").style.width = `${total ? Math.min(100, (done / total) * 100) : 0}%`;
  $("progress-text").textContent = `Прочитано ${bytes(done)} из ${bytes(total)} · ${short(lines)} ${plural(lines, "строка", "строки", "строк")}`;
}

// ---------- фильтры ----------

function setFilter(patch: Filter) {
  filter = { ...filter, ...patch };
  run();
}

document.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-f]");
  if (!el || reportEl.hidden) return;
  const [key, value] = [el.dataset.f!, el.dataset.v!];
  if (key === "clear") {
    const next = { ...filter };
    if (value === "time") [next.from, next.to] = [undefined, undefined];
    else delete next[value as keyof Filter];
    filter = next;
    run();
  } else if (key === "ip") setFilter({ ip: value });
  else if (key === "path") setFilter({ path: value });
  else if (key === "class") setFilter({ statusClass: Number(value) });
  window.scrollTo({ top: reportEl.offsetTop - 12, behavior: "smooth" });
});

$("timeline").addEventListener("click", (e) => {
  const g = (e.target as Element).closest<SVGGElement>(".bucket");
  if (g) setFilter({ from: Number(g.dataset.from), to: Number(g.dataset.to) });
});

// ---------- отчёт ----------

function render() {
  const r = report!;
  reportEl.hidden = false;
  renderFileBar(r);
  renderFilters(r);
  renderTiles(r);
  drawTimeline();
  $("timeline-note").textContent = `Время как в логе (${tzLabel(r.tz)}). Нажмите на столбик — отчёт пересчитается только для этого промежутка.`;

  $("paths").innerHTML = table(
    ["Адрес", "Запросов", "Ошибок", ...(r.hasTiming ? ["p95"] : [])],
    r.topPaths.slice(0, 15).map((p) => ({
      attrs: `data-f="path" data-v="${esc(p.key)}"`,
      cells: [code(p.key), num(p.count), errors(p), ...(r.hasTiming ? [dur(p.p95)] : [])],
    })),
  );
  $("ips").innerHTML = table(
    ["IP", "Запросов", "Ошибок", "Трафик"],
    r.topIps.slice(0, 15).map((p) => ({
      attrs: `data-f="ip" data-v="${esc(p.key)}"`,
      cells: [code(p.key), num(p.count), errors(p), bytes(p.bytes)],
    })),
  );
  $("errors5").innerHTML = r.serverErrors.length
    ? table(
        ["Адрес", "Ошибок", ...(r.hasTiming ? ["p95"] : [])],
        r.serverErrors.slice(0, 10).map((p) => ({
          attrs: `data-f="path" data-v="${esc(p.key)}"`,
          cells: [code(p.key), num(p.count), ...(r.hasTiming ? [dur(p.p95)] : [])],
        })),
      )
    : `<p class="ok">Ни одной ошибки 5xx.</p>`;
  $("errors404").innerHTML = r.notFound.length
    ? table(
        ["Адрес", "Раз"],
        r.notFound.slice(0, 10).map((p) => ({ attrs: `data-f="path" data-v="${esc(p.key)}"`, cells: [code(p.key), num(p.count)] })),
      )
    : `<p class="ok">Ни одного 404, если не считать сканеров.</p>`;

  $("slow-panel").hidden = !r.hasTiming;
  if (r.hasTiming) {
    const totalRt = r.slowPaths.reduce((s, p) => s + p.rtSum, 0);
    $("slow").innerHTML = table(
      ["Адрес", "Запросов", "Медиана", "p95", "Дольше 1 с", "Всего"],
      r.slowPaths.slice(0, 10).map((p) => ({
        attrs: `data-f="path" data-v="${esc(p.key)}"`,
        cells: [
          code(p.key),
          num(p.count),
          dur(p.p50),
          dur(p.p95),
          p.over1s ? `<span class="t4">${num(p.over1s)}</span>` : `<span class="muted">—</span>`,
          `${dur(p.rtSum)} <small>${pct(p.rtSum, totalRt)}</small>`,
        ],
      })),
    );
    $("slowest").innerHTML = table(
      ["Когда", "Запрос", "Код", "Время", "IP"],
      r.slowest.slice(0, 10).map((s) => ({
        attrs: `data-f="ip" data-v="${esc(s.ip)}"`,
        cells: [when(s.time, r.tz, true), code(`${s.method} ${s.path}`), status(s.status), `<b>${dur(s.rt)}</b>`, code(s.ip)],
      })),
      "llrrr",
    );
  }

  $("scan-panel").hidden = !r.scanners.length;
  $("scanners").innerHTML = table(
    ["IP", "Попыток", "Когда", "Что искал"],
    r.scanners.slice(0, 10).map((s) => ({
      attrs: `data-f="ip" data-v="${esc(s.ip)}"`,
      cells: [code(s.ip), num(s.count), `${when(s.first, r.tz)} — ${clock(s.last, r.tz)}`, s.paths.map((p) => code(p)).join(" ")],
    })),
    "lrll",
  );

  const bots = r.botRequests;
  $("clients").innerHTML = `<div class="split"><span style="width:${(bots / r.parsed) * 100}%"></span></div>
    <p class="split-note"><b>${pct(bots, r.parsed)}</b> запросов — боты и скрипты, <b>${pct(r.parsed - bots, r.parsed)}</b> — браузеры</p>` +
    table(
      ["Клиент", "Запросов", ""],
      r.clients.slice(0, 10).map((c) => ({ attrs: "", cells: [esc(c.name), num(c.count), c.bot ? `<span class="tag bot">бот</span>` : `<span class="tag">браузер</span>`] })),
    );
  $("referers").innerHTML =
    (r.referers.length
      ? table(["Сайт", "Переходов"], r.referers.slice(0, 10).map(([h, n]) => ({ attrs: "", cells: [esc(h), num(n)] })))
      : `<p class="muted">Переходов с других сайтов нет.</p>`) +
    (r.ownHost ? `<p class="muted">Переходы между страницами самого сайта (${esc(r.ownHost)}) не считаются.</p>` : "");
  $("statuses").innerHTML = table(
    ["Код", "Запросов", "Доля"],
    r.statuses.slice(0, 12).map(([s, n]) => ({ attrs: `data-f="class" data-v="${Math.floor(s / 100)}"`, cells: [status(s), num(n), pct(n, r.parsed)] })),
  );
  $("methods").innerHTML = table(["Метод", "Запросов"], r.methods.slice(0, 8).map(([m, n]) => ({ attrs: "", cells: [code(m), num(n)] })));

  $("unparsed-panel").hidden = !r.unparsed;
  $("unparsed").innerHTML = `<p class="muted">${num(r.unparsed)} ${plural(r.unparsed, "строка", "строки", "строк")} из ${num(r.lines)} не подошли под формат. Первые из них:</p>
    <pre>${r.unparsedSamples.map(esc).join("\n")}</pre>`;
}

function renderFileBar(r: Report) {
  // Скорость — по распакованному тексту: у .gz файл в 20 раз меньше того, что пришлось разобрать.
  const speed = lastRun.ms ? `${bytes(r.textSize / (lastRun.ms / 1000))}/с` : "";
  const size = r.textSize > lastRun.bytes * 1.5 ? `${bytes(lastRun.bytes)}, распаковано ${bytes(r.textSize)}` : bytes(lastRun.bytes);
  $("filebar").innerHTML = `<div>
      <b>${esc(names.join(", "))}</b>
      <span class="muted">${size} · ${num(r.lines)} ${plural(r.lines, "строка", "строки", "строк")} за ${dur(lastRun.ms / 1000)}${speed ? ` (${speed})` : ""}</span>
      <span class="muted">${when(r.from, r.tz)} — ${when(r.to, r.tz)}</span>
    </div>
    <button class="ghost" id="another">Открыть другие файлы</button>`;
  $("another").addEventListener("click", () => {
    worker?.terminate();
    reportEl.hidden = true;
    openEl.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

function renderFilters(r: Report) {
  const chips: string[] = [];
  if (filter.ip) chips.push(`<button data-f="clear" data-v="ip">IP ${esc(filter.ip)} ×</button>`);
  if (filter.path) chips.push(`<button data-f="clear" data-v="path">${esc(filter.path)} ×</button>`);
  if (filter.statusClass) chips.push(`<button data-f="clear" data-v="statusClass">только ${filter.statusClass}xx ×</button>`);
  if (filter.from !== undefined) chips.push(`<button data-f="clear" data-v="time">${when(filter.from, r.tz)} — ${clock(filter.to!, r.tz)} ×</button>`);
  const shown = chips.length ? `<span class="muted">Показано ${num(r.parsed)} из ${num(r.parsed + r.filteredOut)} запросов.</span>` : `<span class="muted">Нажмите на адрес, IP, код ответа или столбик графика, чтобы оставить только его.</span>`;
  $("filters").innerHTML = `<div class="chips">${chips.join("")}${shown}</div>
    <label class="check"><input type="checkbox" id="merge" ${mergeIds ? "checked" : ""}> склеивать /product/1 и /product/2 в /product/:id</label>`;
  $("merge").addEventListener("change", (e) => {
    mergeIds = (e.target as HTMLInputElement).checked;
    delete filter.path;
    run();
  });
}

function renderTiles(r: Report) {
  const [, , c4, c5] = r.classes;
  const tile = (label: string, value: string, note: string, cls = "", attrs = "") =>
    `<${attrs ? "button" : "div"} class="tile ${cls}" ${attrs}><span>${label}</span><b>${value}</b><small>${note}</small></${attrs ? "button" : "div"}>`;
  const hours = Math.max(1, (r.to - r.from) / 3600_000);
  $("tiles").innerHTML = [
    tile("Запросов", short(r.parsed), `${short(Math.round(r.parsed / hours))} в час в среднем`),
    tile("Уникальных IP", `${short(r.uniqueIps)}${r.uniqueCapped ? "+" : ""}`, `ботов и скриптов ${pct(r.botRequests, r.parsed)}`),
    tile("Ошибки сервера", num(c5), `5xx, ${pct(c5, r.parsed)} запросов`, c5 ? "bad" : "good", c5 ? `data-f="class" data-v="5"` : ""),
    tile("Ошибки клиента", num(c4), `4xx, ${pct(c4, r.parsed)} запросов`, c4 ? "warn" : "", c4 ? `data-f="class" data-v="4"` : ""),
    tile("Отдано трафика", bytes(r.bytes), "тела ответов без заголовков"),
    r.hasTiming
      ? tile("Время ответа", dur(r.p50), `медиана; 95% быстрее ${dur(r.p95)}`)
      : tile("Время ответа", "—", "добавьте $request_time в log_format"),
  ].join("");
}

function drawTimeline() {
  if (report) $("timeline").innerHTML = timeline(report, $("timeline").clientWidth);
}
let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(drawTimeline, 150);
});

// ---------- таблицы ----------

const code = (s: string) => `<code>${esc(s)}</code>`;
const status = (s: number) => `<span class="st c${Math.floor(s / 100)}">${s}</span>`;
const errors = (p: TopRow) => {
  const e = p.e4 + p.e5;
  if (!e) return `<span class="muted">—</span>`;
  return `<span class="${p.e5 ? "t5" : "t4"}">${pct(e, p.count)}</span>`;
};

/** align — по букве на колонку: l — текст влево, r — числа вправо. По умолчанию первая колонка текст, остальные числа. */
function table(head: string[], rows: { attrs: string; cells: string[] }[], align = "l" + "r".repeat(head.length - 1)): string {
  if (!rows.length) return `<p class="muted">Пусто.</p>`;
  const cls = (i: number) => (align[i] === "r" ? ' class="r"' : "");
  return `<div class="table-wrap"><table>
    <thead><tr>${head.map((h, i) => `<th${cls(i)}>${h}</th>`).join("")}</tr></thead>
    <tbody>${rows
      .map((r) => `<tr ${r.attrs}${r.attrs ? ' class="click"' : ""}>${r.cells.map((c, i) => `<td${cls(i)}>${c}</td>`).join("")}</tr>`)
      .join("")}</tbody></table></div>`;
}
