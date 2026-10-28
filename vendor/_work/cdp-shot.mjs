/**
 * 用 headless Chrome + CDP 打开发布在本地端口的 test.html，等 window.__TEST_STATE__
 * 变成 ready-for-shot，抓 __probe / __samplePixels，并截一张图。
 *
 * node cdp-shot.mjs <port> <model> <theme> <outPng>
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

for (const k of ['HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','https_proxy','http_proxy','all_proxy']) delete process.env[k];

const PORT = Number(process.argv[2] || 7401);
const MODEL = process.argv[3] || 'whale';
const THEME = process.argv[4] || 'dark';
const OUT = process.argv[5] || 'C:\\Users\\Administrator\\Documents\\deepseek-harness\\默认工作区\\dsh-image-canvas\\vendor\\_verify\\shot.png';
const VER = process.argv[6] || '';           // 输出文件后缀标识

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DBG_PORT = 9333 + Math.floor(Math.random() * 200);
const PROFILE = 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\dsh-cdp-profile-' + Date.now();

const URL_TO_OPEN = process.argv[7]
  || `http://127.0.0.1:${PORT}/test.html?model=${MODEL}&theme=${THEME}`;
const IS_SELFTEST = /selftest/.test(URL_TO_OPEN);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = [
  '--headless=new',
  `--remote-debugging-port=${DBG_PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--window-size=1280,860',
  '--hide-scrollbars',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
  'about:blank',
];

console.log('LAUNCH', CHROME, '\n  ' + URL_TO_OPEN);
const chrome = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

async function getWsUrl() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DBG_PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome devtools 端口没起来\n' + chromeErr.slice(-2000));
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 60000);
    });
  }
}

async function evalJS(cdp, expression, awaitPromise = true) {
  const r = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise, userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error('JS 异常: ' + (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)));
  }
  return r.result?.value;
}

let exitCode = 0;
try {
  const wsUrl = await getWsUrl();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
    setTimeout(() => rej(new Error('ws open timeout')), 15000);
  });
  const cdp = new CDP(ws);

  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: URL_TO_OPEN });

  // ---- 等状态机走到终点 ----
  let state = null;
  const t0 = Date.now();
  for (let i = 0; i < 320; i++) {
    await sleep(250);
    try {
      if (IS_SELFTEST) {
        state = await evalJS(cdp, 'window.__SELFTEST__ || null');
        if (state && (state.status === 'done' || state.status === 'fatal')) break;
      } else {
        state = await evalJS(cdp, 'window.__TEST_STATE__ || null');
        if (state && (state.status === 'ready-for-shot' || state.status === 'error')) break;
      }
    } catch (_) { state = null; }
    if (Date.now() - t0 > 90000) break;
  }
  console.log('STATE', JSON.stringify(state));

  // ---- 控制台/异常日志 ----
  const consoleMsgs = [];
  for (const ev of cdp.events) {
    if (ev.method === 'Runtime.consoleAPICalled') {
      consoleMsgs.push(ev.params.type + ': ' +
        ev.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    } else if (ev.method === 'Runtime.exceptionThrown') {
      consoleMsgs.push('EXCEPTION: ' + (ev.params.exceptionDetails.exception?.description ||
        ev.params.exceptionDetails.text));
    }
  }
  if (consoleMsgs.length) console.log('CONSOLE\n  ' + consoleMsgs.slice(0, 30).join('\n  '));

  let probe = null;
  let pixels = null;
  if (!IS_SELFTEST && state && state.status === 'ready-for-shot') {
    await sleep(400);
    probe = await evalJS(cdp, 'window.__probe ? window.__probe() : null');
    pixels = await evalJS(cdp, 'window.__samplePixels ? window.__samplePixels() : null');
    console.log('PROBE', JSON.stringify(probe));
    console.log('PIXELS', JSON.stringify(pixels));
  }

  // ---- 截图 ----
  await sleep(300);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  mkdirSync(join(OUT, '..'), { recursive: true });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('SHOT_SAVED', OUT);

  const summary = {
    model: MODEL, theme: THEME, state, probe, pixels, console: consoleMsgs.slice(0, 40), shot: OUT,
  };
  const jsonPath = OUT.replace(/\.png$/i, '') + (VER ? '.' + VER : '') + '.json';
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log('SUMMARY_SAVED', jsonPath);

  const okStatus = IS_SELFTEST ? (state && state.status === 'done' && state.fail === 0)
                               : (state && state.status === 'ready-for-shot');
  if (!okStatus) exitCode = 2;

  ws.close();
} catch (e) {
  console.log('DRIVER_ERROR', e && e.stack ? e.stack : e);
  exitCode = 1;
} finally {
  try { chrome.kill('SIGKILL'); } catch (_) { /* ignore */ }
  await sleep(600);
  try { if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}
process.exit(exitCode);
