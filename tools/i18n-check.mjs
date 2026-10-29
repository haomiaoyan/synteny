import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 中英切换验收。
 *
 * 三件事，任何一件不对都算失败：
 *   1. 中文模式下页面文字必须与改动前逐字一致（对比 tools/shots/zh-before.json）；
 *   2. 切到英文后，可见文字里不能再有中文字符（词典漏一条就会露出来）；
 *   3. 切回中文后要与中文模式完全一致，也就是来回切换不掉字。
 *
 * 第 2 条比“看起来翻译完了”可靠得多：它把漏译直接变成一个数字。
 */

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = process.env.SYNTENY_URL || "http://127.0.0.1:5174/";
const baseline = JSON.parse(readFileSync("tools/shots/zh-before.json", "utf8"));

const port = 9500 + Math.floor(Math.random() * 90);
const profile = mkdtempSync(join(tmpdir(), "i18n-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--lang=zh-CN", "--disable-gpu", "--no-first-run",
  "--no-default-browser-check", "--hide-scrollbars",
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  "--window-size=1440,1100", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 150; i += 1) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const p = tabs.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  throw new Error("chrome 没有起来");
}

const ws = new WebSocket(await wsUrl());
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });

let seq = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  const p = m.id && pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
});
const send = (method, params = {}) => {
  const id = ++seq;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("timeout " + method)); } }, 120000);
  });
};
const evalIn = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: BASE });
await sleep(1000);

const GRAB = `(() => {
  const txt = document.body.textContent.replace(/\\s+/g, ' ').trim();
  const cjk = txt.match(/[\\u4e00-\\u9fff]+/g) || [];
  return {
    lang: document.documentElement.lang,
    dataLang: document.documentElement.getAttribute('data-lang'),
    title: document.title,
    norm: txt,
    cjkCount: cjk.length,
    cjkWords: Array.from(new Set(cjk)).slice(0, 25),
    th: Array.from(document.querySelectorAll('th')).map((e) => e.textContent.trim()),
    btn: document.getElementById('btnLang')?.textContent?.trim(),
    hidden: document.getElementById('btnLang')?.hasAttribute('hidden'),
  };
})()`;

const empty = await evalIn(GRAB);

// 跑一遍示例数据，让动态文案（提示、图注、表头、类型名）也出现在页面上。
await evalIn(`document.getElementById('btnDemo').click(), true`);
for (let i = 0; i < 120; i += 1) {
  if (await evalIn(`!!document.getElementById('figDot')?.classList.contains('ready')`)) break;
  await sleep(200);
}
await sleep(400);
const zh = await evalIn(GRAB);

await evalIn(`document.getElementById('btnLang').click(), true`);
await sleep(400);
const en = await evalIn(GRAB);

await evalIn(`document.getElementById('btnLang').click(), true`);
await sleep(400);
const zhAgain = await evalIn(GRAB);

// 英文全文落盘，方便逐句读一遍；机器只能测出漏翻，读不通要人看。
writeFileSync('tools/shots/en-text.txt', `${en.norm}
`, 'utf8');
const same = (a, b) => a === b;
console.log(JSON.stringify({
  zhMatchesBaseline: same(zh.norm, baseline.filled.norm),
  emptyMatchesBaseline: same(empty.norm, baseline.empty.norm),
  zhChars: zh.norm.length,
  enCjkLeft: en.cjkCount,
  enLeftover: en.cjkWords,
  enTitle: en.title,
  enLangAttr: `${en.lang} / ${en.dataLang}`,
  enTh: en.th,
  enBtn: en.btn,
  enHidden: en.hidden,
  zhAfterToggleBack: same(zhAgain.norm, zh.norm),
  zhTitleBack: zhAgain.title,
  // 中文基线第一处不一致，方便定位是哪个词条写错了
  firstDiff: (() => {
    const a = baseline.filled.norm, b = zh.norm;
    if (a === b) return null;
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) return { at: i, was: a.slice(i, i + 40), now: b.slice(i, i + 40) };
    }
    return null;
  })(),
  emptyLen: { was: baseline.empty.norm.length, now: empty.norm.length },
  emptyFirstDiff: (() => {
    const a = baseline.empty.norm, b = empty.norm;
    if (a === b) return null;
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) return { at: i, was: a.slice(i, i + 40), now: b.slice(i, i + 40) };
    }
    return null;
  })(),
}, null, 2));
chrome.kill();
process.exit(0);