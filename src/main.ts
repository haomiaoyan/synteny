import "./styles/app.css";
import { parseFasta, autoParams } from "./core/fasta.js";
import { makeDemo, demoCaption, type Demo } from "./core/demo.js";
import type { Sequence, Segment } from "./core/types.js";
import { drawPlot, invertPointer, pointerFraction, viewFromDrag, zoomView, zoomFactor, isZoomed, fullView, type PlotState, type View } from "./ui/plot.js";
import type { RunRequest, RunReply, RunSuccess } from "./ui/worker.js";
import { startGlyph } from "./ui/glyph.js";
import { initTheme } from "./ui/theme.js";

/**
 * Page controller.
 *
 * Deliberately thin: it owns the file inputs, hands the sequences to a worker,
 * and paints whatever comes back. No comparison logic lives here, so the whole
 * engine stays testable in Node without a DOM.
 */

interface State {
  ref: Sequence | null;
  qry: Sequence | null;
  result: RunSuccess | null;
  geom: PlotState | null;
  /** Visible window over both genomes; null means "not drawn yet". */
  view: View | null;
  selected: string | null;
  busy: boolean;
  requestId: number;
}

const S: State = {
  ref: null,
  qry: null,
  result: null,
  geom: null,
  view: null,
  selected: null,
  busy: false,
  requestId: 0,
};

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing element #${id}`);
  return el as T;
};

/* ------------------------------------------------------------------ setup */

const worker = new Worker(new URL("./ui/worker.ts", import.meta.url), { type: "module" });

const el = {
  slotRef: $("slotRef"),
  slotQry: $("slotQry"),
  fileRef: $<HTMLInputElement>("fileRef"),
  fileQry: $<HTMLInputElement>("fileQry"),
  nameRef: $("nameRef"),
  nameQry: $("nameQry"),
  metaRef: $("metaRef"),
  metaQry: $("metaQry"),
  btnDemo: $<HTMLButtonElement>("btnDemo"),
  btnRun: $<HTMLButtonElement>("btnRun"),
  btnCsv: $<HTMLButtonElement>("btnCsv"),
  hint: $("hint"),
  plot: $<HTMLCanvasElement>("plot"),
  plotEmpty: $("plotEmpty"),
  readout: $("readout"),
  dragRect: $("dragRect"),
  figDot: $("figDot"),
  figTitle: $("figTitle"),
  figSize: $("figSize"),
  figK: $("figK"),
  figTime: $("figTime"),
  nCol: $("nCol"),
  nInv: $("nInv"),
  nTrn: $("nTrn"),
  nNoise: $("nNoise"),
  nCov: $("nCov"),
  nSeeds: $("nSeeds"),
  tbody: $("tbody"),
  tableCap: $("tableCap"),
  caption: $("caption"),
  xaxis: $("xaxis"),
  ylab: $("ylab"),
  figZoom: $<HTMLButtonElement>("figZoom"),
  advToggle: $<HTMLInputElement>("advToggle"),
  advBody: $("advBody"),
  inK: $<HTMLInputElement>("inK"),
  inW: $<HTMLInputElement>("inW"),
};

/* --------------------------------------------------------------- helpers */

const fmtInt = (n: number): string => n.toLocaleString("en-US");

const setHint = (text: string, cls: "" | "busy" | "err" = ""): void => {
  el.hint.textContent = text;
  el.hint.className = "hint" + (cls ? " " + cls : "");
};

const setDot = (cls: "" | "ready" | "busy"): void => {
  el.figDot.className = "dot" + (cls ? " " + cls : "");
};

function showSlot(role: "ref" | "qry", seq: Sequence | null): void {
  const nameEl = role === "ref" ? el.nameRef : el.nameQry;
  const metaEl = role === "ref" ? el.metaRef : el.metaQry;
  const slotEl = role === "ref" ? el.slotRef : el.slotQry;

  if (seq === null) {
    nameEl.textContent = "未选择";
    nameEl.classList.add("empty");
    metaEl.textContent = "拖入 FASTA，或点击选择";
    slotEl.classList.remove("filled");
    return;
  }
  nameEl.textContent = seq.name;
  nameEl.classList.remove("empty");
  const n = seq.seq.length;
  metaEl.textContent =
    n >= 1e6 ? `${(n / 1e6).toFixed(2)} Mbp · ${fmtInt(n)} bp` : `${fmtInt(n)} bp`;
  slotEl.classList.add("filled");
}

/** Read a file as text, reporting the failure mode rather than swallowing it. */
async function readText(file: File): Promise<string> {
  if (file.size === 0) throw new Error(`「${file.name}」是空文件`);
  if (file.size > 200 * 1024 * 1024) {
    throw new Error(`「${file.name}」有 ${(file.size / 1048576).toFixed(0)} MB，超过浏览器可处理的上限`);
  }

  // Files straight from NCBI/Ensembl are almost always gzipped, and a visitor
  // who downloads one should not have to know that. DecompressionStream is
  // built into the browser, so this costs no dependency — only a check that it
  // exists, because Safari added it later than the others.
  if (isGzip(file)) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error(`「${file.name}」是 gzip 压缩文件，当前浏览器不支持直接解压。请先解压成 .fa 再拖进来`);
    }
    const stream = file.stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).text();
  }
  return file.text();
}

/**
 * Detect gzip by magic bytes rather than by extension: a file named `.fa` that
 * is actually gzip is common enough, and trusting the name would emit the
 * misleading "no FASTA sequence found" error for a perfectly good file.
 */
function isGzip(file: File): boolean {
  if (/\.gz$/i.test(file.name)) return true;
  return file.type === "application/gzip" || file.type === "application/x-gzip";
}

async function loadFile(role: "ref" | "qry", file: File): Promise<void> {
  try {
    setHint(`正在读取 ${file.name}…`, "busy");
    const text = await readText(file);
    const seqs = parseFasta(text);
    if (seqs.length === 0) throw new Error(`「${file.name}」里没有找到 FASTA 序列`);
    // Multi-record files are common; the first record is used and the UI says so,
    // rather than silently concatenating chromosomes into one bogus sequence.
    const seq = seqs[0];
    if (seqs.length > 1) {
      setHint(`「${file.name}」含 ${seqs.length} 条序列，已取第一条（${seq.name}）`, "busy");
    }
    if (seq.seq.length < 2000) {
      throw new Error(`「${seq.name}」只有 ${seq.seq.length} bp，太短了，比对结果没有意义`);
    }
    if (role === "ref") S.ref = seq;
    else S.qry = seq;
    showSlot(role, seq);
    refreshRunButton();
    if (seqs.length === 1) setHint("两个文件都就位后即可开始。", "");
  } catch (err) {
    setHint(err instanceof Error ? err.message : String(err), "err");
  }
}

function refreshRunButton(): void {
  el.btnRun.disabled = S.busy || S.ref === null || S.qry === null;
}

/* ------------------------------------------------------------ run a pair */

function resolveParams(): { k: number; w: number } {
  if (S.ref === null || S.qry === null) throw new Error("sequences missing");
  const auto = autoParams(S.ref.seq.length, S.qry.seq.length);
  if (!el.advToggle.checked) return auto;
  const k = Number.parseInt(el.inK.value, 10);
  const w = Number.parseInt(el.inW.value, 10);
  return {
    k: Number.isFinite(k) && k >= 9 && k <= 21 ? k : auto.k,
    w: Number.isFinite(w) && w >= 4 && w <= 256 ? w : auto.w,
  };
}

function run(): void {
  if (S.ref === null || S.qry === null || S.busy) return;
  const params = resolveParams();

  S.busy = true;
  S.requestId += 1;
  refreshRunButton();
  setDot("busy");
  setHint(`比对中… k=${params.k}, w=${params.w}`, "busy");

  const msg: RunRequest = {
    id: S.requestId,
    ref: S.ref.seq,
    qry: S.qry.seq,
    k: params.k,
    w: params.w,
  };
  worker.postMessage(msg);
}

worker.onmessage = (ev: MessageEvent<RunReply>): void => {
  const reply = ev.data;
  // Ignore a stale reply if the user started another run while this one was
  // in flight; otherwise the older result would overwrite the newer one.
  if (reply.id !== S.requestId) return;

  S.busy = false;
  refreshRunButton();

  if (!reply.ok) {
    setDot("");
    setHint(`比对失败：${reply.error}`, "err");
    return;
  }

  S.result = reply;
  S.selected = null;
  paint(reply);
  setDot("ready");
  const s = reply.stats;
  setHint(
    `${fmtInt(reply.segs.length)} 个区段 · ${(s.elapsed / 1000).toFixed(2)} s · 覆盖 ${(s.coverage * 100).toFixed(1)}%`,
    "",
  );
};

worker.onerror = (ev: ErrorEvent): void => {
  S.busy = false;
  refreshRunButton();
  setDot("");
  setHint(`Worker 出错：${ev.message || "未知错误"}`, "err");
};

/* ---------------------------------------------------------------- paint */

function paint(res: RunSuccess): void {
  if (S.ref === null || S.qry === null) return;
  const s = res.stats;

  el.plotEmpty.classList.add("hidden");

  el.figTitle.textContent = `${S.ref.name} × ${S.qry.name}`;
  el.figSize.textContent = (Math.max(s.nRef, s.nQry) / 1e6).toFixed(2);
  el.figK.textContent = String(s.k);
  el.figTime.textContent = (s.elapsed / 1000).toFixed(2);

  const counts = { col: 0, inv: 0, trn: 0 };
  for (const seg of res.segs) counts[seg.type] += 1;
  el.nCol.textContent = String(counts.col);
  el.nInv.textContent = String(counts.inv);
  el.nTrn.textContent = String(counts.trn);
  let noise = 0;
  for (let i = 0; i < res.pts.cls.length; i++) if (res.pts.cls[i] === 3) noise++;
  el.nNoise.textContent = fmtInt(noise);
  el.nCov.textContent = (s.coverage * 100).toFixed(1) + "%";
  el.nSeeds.textContent = fmtInt(s.seeds);

  S.view = fullView(s.nRef, s.nQry);
  redraw();

  paintTable(res.segs, s.nRef);
  paintCaption(res);

  el.btnCsv.disabled = res.segs.length === 0;
}

/** Repaint the canvas from current state. Every visual change goes through
 * here so the window, the selection and the axis labels cannot disagree. */
function redraw(): void {
  if (S.result === null) return;
  const s = S.result.stats;
  const seg = S.result.segs.find((x) => x.id === S.selected) ?? null;
  S.geom = drawPlot(el.plot, {
    pts: S.result.pts,
    nRef: s.nRef,
    nQry: s.nQry,
    view: S.view ?? fullView(s.nRef, s.nQry),
    highlight: seg,
  });
  paintAxes();
}

/** Axis titles must name the unit the tick labels are actually in. */
function paintAxes(): void {
  const s = S.result?.stats;
  if (s === undefined || S.view === null) return;
  const ux = unitName(S.view.r1 - S.view.r0);
  const uy = unitName(S.view.q1 - S.view.q0);
  el.xaxis.textContent = `Reference · ${ux}`;
  el.ylab.textContent = `Query · ${uy}`;

  const zoom = zoomFactor(S.view, s.nRef, s.nQry);
  const zoomed = isZoomed(S.view, s.nRef, s.nQry);
  el.figZoom.hidden = !zoomed;
  el.figZoom.textContent = `${zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}×`;
}

function unitName(span: number): string {
  if (span >= 2_000_000) return "Mbp";
  if (span >= 2_000) return "kbp";
  return "bp";
}

function paintCaption(res: RunSuccess): void {
  const inv = res.segs.filter((x) => x.type === "inv").length;
  const trn = res.segs.filter((x) => x.type === "trn").length;
  const col = res.segs.filter((x) => x.type === "col").length;

  if (res.segs.length === 0) {
    el.caption.innerHTML =
      '<span class="n">图</span>没有找到任何保守区段。两条序列可能没有同源关系，或者 k 太大、w 太小。<b>先确认输入</b>，再动手调参。';
    return;
  }
  const bits: string[] = [];
  bits.push(`<span class="n">图</span>共线 ${col} 段`);
  if (inv > 0) bits.push(`倒位 ${inv} 段（反斜线）`);
  if (trn > 0) bits.push(`易位 ${trn} 段（脱离主轴的正斜率方块）`);
  bits.push(
    `覆盖参考的 ${(res.stats.coverage * 100).toFixed(1)}%，共 ${fmtInt(res.stats.seeds)} 个种子`,
  );
  el.caption.innerHTML = bits.join("，") + "。";
}

function mmbp(v: number): string {
  return (v / 1e6).toFixed(2);
}

/**
 * Position for the hover readout.
 *
 * The readout follows the cursor across four orders of magnitude, so a fixed
 * unit would be wrong at one end or the other: "4.20 Mbp" is noise when the
 * window spans 3 kbp, and "4203 kbp" is unreadable at genome scale.
 */
function fmtPos(v: number): string {
  if (v >= 1e6) return (v / 1e6).toFixed(2) + " Mbp";
  if (v >= 1e4) return (v / 1e3).toFixed(1) + " kbp";
  return v.toLocaleString("en-US") + " bp";
}

function paintTable(segs: readonly Segment[], _nRef: number): void {
  const tb = el.tbody;
  tb.replaceChildren();

  if (segs.length === 0) {
    const tr = document.createElement("tr");
    tr.className = "empt";
    const td = document.createElement("td");
    td.colSpan = 6;
    td.textContent = "没有检出区段";
    tr.append(td);
    tb.append(tr);
    el.tableCap.textContent = "没有可列出的区段。";
    return;
  }

  const LABEL: Record<Segment["type"], string> = { col: "共线", inv: "倒位", trn: "易位" };
  const CLS: Record<Segment["type"], string> = { col: "m-col", inv: "m-inv", trn: "m-tr" };

  for (const seg of segs) {
    const tr = document.createElement("tr");
    tr.dataset.id = seg.id;
    if (seg.id === S.selected) tr.classList.add("sel");

    const idTd = document.createElement("td");
    idTd.className = "id";
    idTd.textContent = seg.id;

    const typeTd = document.createElement("td");
    const mark = document.createElement("span");
    mark.className = "mark " + CLS[seg.type];
    typeTd.append(mark, document.createTextNode(LABEL[seg.type]));

    const rTd = document.createElement("td");
    rTd.className = "mono";
    rTd.textContent = `${mmbp(seg.r0)}–${mmbp(seg.r1)}`;

    const qTd = document.createElement("td");
    qTd.className = "mono";
    qTd.textContent = `${mmbp(Math.min(seg.q0, seg.q1))}–${mmbp(Math.max(seg.q0, seg.q1))}`;

    const lenTd = document.createElement("td");
    lenTd.className = "n";
    lenTd.textContent = (seg.len / 1e6).toFixed(2);

    const idenTd = document.createElement("td");
    idenTd.className = "n";
    idenTd.textContent = (seg.identity * 100).toFixed(1) + "%";

    tr.append(idTd, typeTd, rTd, qTd, lenTd, idenTd);
    tb.append(tr);
  }

  el.tableCap.textContent = `共 ${segs.length} 段，按参考位置排序。坐标以 Mbp 计；一致性由种子密度反推。`;
}

/* ----------------------------------------------------------------- hover */

el.plot.addEventListener("mousemove", (ev) => {
  if (S.geom === null || S.result === null) return;
  const rect = el.plot.getBoundingClientRect();
  const px = ev.clientX - rect.left;
  const py = ev.clientY - rect.top;

  if (drag !== null) {
    drag.x1 = px;
    drag.y1 = py;
    paintDragRect();
    return;
  }

  const pos = invertPointer(S.geom, px, py);
  if (pos === null) {
    el.readout.hidden = true;
    el.plot.style.cursor = "";
    return;
  }
  el.readout.hidden = false;
  el.readout.style.left = px + "px";
  el.readout.style.top = py + "px";
  el.readout.innerHTML =
    `ref <b>${fmtPos(pos.r)}</b><br>qry <b>${fmtPos(pos.q)}</b>`;
  el.plot.style.cursor = "crosshair";
});

el.plot.addEventListener("mouseleave", () => {
  el.readout.hidden = true;
  if (drag === null) el.plot.style.cursor = "";
});

/* ------------------------------------------------------------ zoom & pan */

/**
 * Drag state, or null.
 *
 * A drag is a rectangle to zoom into; the whole interaction is deliberately
 * one gesture the reader already knows from genome browsers rather than a
 * mode palette nobody would discover.
 */
let drag: { x0: number; y0: number; x1: number; y1: number } | null = null;

/** Position the selection rectangle over the plot while dragging. */
function paintDragRect(): void {
  if (drag === null) {
    el.dragRect.hidden = true;
    return;
  }
  const left = Math.min(drag.x0, drag.x1);
  const top = Math.min(drag.y0, drag.y1);
  el.dragRect.hidden = false;
  el.dragRect.style.left = left + "px";
  el.dragRect.style.top = top + "px";
  el.dragRect.style.width = Math.abs(drag.x1 - drag.x0) + "px";
  el.dragRect.style.height = Math.abs(drag.y1 - drag.y0) + "px";
}

el.plot.addEventListener("mousedown", (ev) => {
  if (S.geom === null || ev.button !== 0) return;
  const rect = el.plot.getBoundingClientRect();
  const px = ev.clientX - rect.left;
  const py = ev.clientY - rect.top;
  if (pointerFraction(S.geom, px, py) === null) return;
  drag = { x0: px, y0: py, x1: px, y1: py };
  paintDragRect();
  ev.preventDefault();
});

window.addEventListener("mouseup", (ev) => {
  el.dragRect.hidden = true;
  if (drag === null || S.geom === null || S.result === null) return;
  const rect = el.plot.getBoundingClientRect();
  const d = drag;
  drag = null;
  const x1 = ev.clientX - rect.left;
  const y1 = ev.clientY - rect.top;

  const moved = Math.abs(x1 - d.x0) > 6 || Math.abs(y1 - d.y0) > 6;
  if (!moved) {
    // A click, not a drag: select the block under the pointer, the same
    // gesture and the same result as clicking its row in the table.
    selectAt(x1, y1);
    return;
  }

  const s = S.result.stats;
  const next = viewFromDrag(
    S.geom,
    { px: d.x0, py: d.y0 },
    { px: x1, py: y1 },
    s.nRef,
    s.nQry,
  );
  if (next !== null) {
    S.view = next;
    redraw();
  }
});

el.plot.addEventListener("dblclick", () => {
  if (S.result === null) return;
  S.view = fullView(S.result.stats.nRef, S.result.stats.nQry);
  redraw();
});

/**
 * Wheel zoom about the pointer.
 *
 * Ctrl/Cmd is not required: on a figure whose only interaction is looking
 * closer, the wheel is unambiguously a zoom, and requiring a modifier would
 * make it undiscoverable.
 */
el.plot.addEventListener(
  "wheel",
  (ev) => {
    if (S.geom === null || S.result === null) return;
    ev.preventDefault();
    const rect = el.plot.getBoundingClientRect();
    const f = pointerFraction(S.geom, ev.clientX - rect.left, ev.clientY - rect.top);
    if (f === null) return;
    const s = S.result.stats;
    const factor = Math.exp(ev.deltaY * 0.0016);
    S.view = zoomView(S.view ?? fullView(s.nRef, s.nQry), f.fx, f.fy, factor, s.nRef, s.nQry);
    redraw();
  },
  { passive: false },
);

el.figZoom.addEventListener("click", () => {
  if (S.result === null) return;
  S.view = fullView(S.result.stats.nRef, S.result.stats.nQry);
  redraw();
});

/* ------------------------------------------------------------------ misc */

el.btnDemo.addEventListener("click", () => {
  if (S.busy) return;
  setHint("正在生成示例基因组…", "busy");
  const demo: Demo = makeDemo();
  S.ref = demo.ref;
  S.qry = demo.qry;
  showSlot("ref", demo.ref);
  showSlot("qry", demo.qry);
  refreshRunButton();
  el.caption.textContent = demoCaption(demo);
  run();
});

el.btnRun.addEventListener("click", run);

el.btnCsv.addEventListener("click", () => {
  if (S.result === null) return;
  const rows = [["id", "type", "ref_start", "ref_end", "qry_start", "qry_end", "length_bp", "identity"]];
  for (const s of S.result.segs) {
    rows.push([
      s.id,
      s.type,
      String(s.r0),
      String(s.r1),
      String(Math.min(s.q0, s.q1)),
      String(Math.max(s.q0, s.q1)),
      String(s.len),
      s.identity.toFixed(4),
    ]);
  }
  const csv = rows.map((r) => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "synteny-segments.csv";
  a.click();
  URL.revokeObjectURL(url);
});

/* wire file inputs by click and by drag */

for (const role of ["ref", "qry"] as const) {
  const slot = role === "ref" ? el.slotRef : el.slotQry;
  const input = role === "ref" ? el.fileRef : el.fileQry;

  slot.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const f = input.files?.[0];
    if (f !== undefined) void loadFile(role, f);
    // Reset so selecting the same file twice still fires a change event.
    input.value = "";
  });

  slot.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    slot.classList.add("drag");
  });
  slot.addEventListener("dragleave", () => slot.classList.remove("drag"));
  slot.addEventListener("drop", (ev) => {
    ev.preventDefault();
    slot.classList.remove("drag");
    const f = ev.dataTransfer?.files?.[0];
    if (f !== undefined) void loadFile(role, f);
  });
}

el.advToggle.addEventListener("change", () => {
  el.advBody.hidden = !el.advToggle.checked;
  if (el.advToggle.checked && S.ref !== null && S.qry !== null) {
    const auto = autoParams(S.ref.seq.length, S.qry.seq.length);
    el.inK.value = String(auto.k);
    el.inW.value = String(auto.w);
  }
});

// The plot is canvas, so a size change must redraw it; there is nothing for CSS
// to rescale.
//
// Watching the canvas itself rather than the window matters more than it looks:
// the figure settles to its final size after first layout and after the webfont
// arrives, and a window-resize listener never hears about either. The plot
// would then be drawn at one size while hit-testing used another, so hovering
// would read slightly wrong and clicking would miss — which is exactly the
// kind of bug that is invisible in a screenshot.
let drawnW = 0;
let drawnH = 0;
const ro = new ResizeObserver((entries) => {
  const box = entries[0]?.contentRect;
  if (box === undefined || box.width < 10 || box.height < 10) return;
  if (Math.abs(box.width - drawnW) < 0.5 && Math.abs(box.height - drawnH) < 0.5) return;
  drawnW = box.width;
  drawnH = box.height;
  if (S.result !== null) redraw();
});
ro.observe(el.plot);

// Escape drops the selection and restores the full view: the two "undo"s a
// reader reaches for after poking at the figure.
window.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  if (S.selected !== null) {
    select(null);
    return;
  }
  if (S.result !== null && S.view !== null) {
    const s = S.result.stats;
    if (isZoomed(S.view, s.nRef, s.nQry)) {
      S.view = fullView(s.nRef, s.nQry);
      redraw();
    }
  }
});

// Row click highlights the matching block; kept simple because the canvas does
// not carry per-block hit regions.
el.tbody.addEventListener("click", (ev) => {
  const tr = (ev.target as HTMLElement).closest("tr");
  if (tr === null || tr.dataset.id === undefined) return;
  select(tr.dataset.id === S.selected ? null : tr.dataset.id);
});

/** Single place that changes the selection, so plot, table and hint agree. */
function select(id: string | null): void {
  S.selected = id;
  for (const row of el.tbody.querySelectorAll("tr")) {
    row.classList.toggle("sel", row.dataset.id === S.selected);
  }
  const row = id === null ? null : el.tbody.querySelector(`tr[data-id="${id}"]`);
  if (row !== null) row.scrollIntoView({ block: "nearest" });
  redraw();
}

/**
 * Pick the block nearest a pointer position on the canvas.
 *
 * Distance is measured in pixels on the drawn box, not in bases: the two axes
 * are scaled differently, so a base-space distance would favour whichever
 * genome happens to be longer.
 */
function selectAt(px: number, py: number): void {
  if (S.geom === null || S.result === null) return;
  const { pad, inner, view } = S.geom;
  const spanR = Math.max(1, view.r1 - view.r0);
  const spanQ = Math.max(1, view.q1 - view.q0);
  const toX = (r: number): number => pad + ((r - view.r0) / spanR) * inner;
  const toY = (q: number): number => pad + inner - ((q - view.q0) / spanQ) * inner;

  let best: { id: string; d: number } | null = null;
  for (const seg of S.result.segs) {
    // Normalise the corners in *pixel* space. The query axis grows upward,
    // so toY of the smaller base gives the larger y: taking the base-order
    // corners as (top-left, bottom-right) inverts the rectangle and makes every
    // inside click look like it landed above the block.
    const ax = toX(seg.r0);
    const bx = toX(seg.r1);
    const ay = toY(seg.q0);
    const by = toY(seg.q1);
    const left = Math.min(ax, bx);
    const right = Math.max(ax, bx);
    const top = Math.min(ay, by);
    const bottom = Math.max(ay, by);
    // Distance to the rectangle: zero when the pointer is inside it.
    const dx = Math.max(left - px, 0, px - right);
    const dy = Math.max(top - py, 0, py - bottom);
    const d = Math.hypot(dx, dy);
    if (best === null || d < best.d) best = { id: seg.id, d };
  }

  // Only claim a selection when the pointer is genuinely near a block;
  // otherwise a click on blank canvas would silently pick a distant segment.
  if (best !== null && best.d <= 14) select(best.id === S.selected ? null : best.id);
  else select(null);
}

showSlot("ref", null);
showSlot("qry", null);
setDot("");
refreshRunButton();

const glyph = document.getElementById("glyph") as HTMLCanvasElement | null;
if (glyph !== null) startGlyph(glyph);

// 换配色后必须重画：画布上的颜色是从 CSS 变量算出来的，不会自己跟着变。
initTheme(redraw);
