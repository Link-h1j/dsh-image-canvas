// 零依赖截图工具：直接驱动本机 Chromium（Edge 优先）的 DevTools 协议（Node 22 自带 WebSocket）。
// 为什么不用 `chrome --headless --screenshot`：本机实测那条命令会被静默转发到已在运行的浏览器会话，
// exit 0、不给文件（2026-10-16 记录在长期记忆里）。走 CDP 才能精确控视口、抓真实渲染像素。
// 与「匿名提问箱\tools\shot.mjs」同源，这里改成一次会话连拍多张。
//
// 用法：node tools/shot.mjs <width> <height> <outDir> <html1> [<html2> ...]
//   → 为每个 html 生成 <outDir>/<name>.png
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'

const [W, H, outDir, ...htmls] = process.argv.slice(2)
const WIDTH = Number(W || 560)
const HEIGHT = Number(H || 980)
if (outDir === undefined || htmls.length === 0) { console.error('用法: node tools/shot.mjs <width> <height> <outDir> <html...>'); process.exit(2) }
fs.mkdirSync(outDir, { recursive: true })

const PORT = 9500 + Math.floor(Math.random() * 400)
const PROFILE = path.join(os.tmpdir(), 'icv-shot-' + Date.now().toString(36))
// Edge 优先：避免和用户正在用的 Chrome 会话打交道
const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]
const exe = CANDIDATES.find((candidate) => fs.existsSync(candidate))
if (exe === undefined) { console.error('没找到 Edge/Chrome'); process.exit(2) }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const child = spawn(exe, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  `--window-size=${WIDTH},${HEIGHT}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--disable-extensions', '--disable-background-networking', '--force-device-scale-factor=1',
  '--disable-features=Translate,MediaRouter',
  '--headless=new',
  'about:blank',
], { detached: true, stdio: 'ignore' })
child.unref()

let wsUrl = null
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    // 只挑真正能导航的空白页：Edge 首次启动会先塞一个 edge://sync-confirmation 页面进来，
    // 抓到那个页面会让 Page.navigate 静默失败（实测卡在 Runtime.evaluate 30s 超时）
    const blank = list.find((target) => target.type === 'page' && target.url === 'about:blank' && target.webSocketDebuggerUrl)
    const other = list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl
      && !target.url.startsWith('edge://') && !target.url.startsWith('devtools://') && !target.url.startsWith('chrome://'))
    const page = blank ?? other
    if (page !== undefined) { wsUrl = page.webSocketDebuggerUrl; break }
  } catch { /* 还没起来 */ }
  await sleep(250)
}
if (wsUrl === null) { console.error('浏览器没暴露调试目标'); try { process.kill(child.pid) } catch {} process.exit(3) }

const ws = new WebSocket(wsUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('ws error')) })
let seq = 0
const pending = new Map()
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    message.error ? reject(new Error(message.error.message)) : resolve(message.result)
  }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)) } }, 30000)
})

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })

const results = []
for (const html of htmls) {
  const filePath = path.resolve(html)
  const url = 'file:///' + filePath.replace(/\\/g, '/')
  const out = path.join(outDir, path.basename(html).replace(/\.html?$/, '') + '.png')
  await send('Page.navigate', { url })
  await sleep(600)
  // 导航没生效就再来一次（首帧可能还在 about:blank）
  const where = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }).then((r) => String(r.result.value ?? '')).catch(() => '')
  if (!where.startsWith('file:')) { await send('Page.navigate', { url }); await sleep(800) }
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
  // 自证渲染成功（探针失败不影响出图）
  let probe = {}
  try {
    const value = await send('Runtime.evaluate', {
      expression: `JSON.stringify({ root: !!document.querySelector('.icv-root'), tools: document.querySelectorAll('[data-icv-tool]').length, sheet: !!document.querySelector('.icv-sheet'), nodes: document.querySelectorAll('.icv-node').length, imgs: Array.from(document.querySelectorAll('.icv-node img')).filter((i) => i.complete && i.naturalWidth > 0).length })`,
      returnByValue: true,
    })
    probe = JSON.parse(value.result.value || '{}')
  } catch (error) { probe = { probeError: String(error.message) } }
  results.push({ state: path.basename(html, '.html'), png: out, bytes: fs.statSync(out).size, probe })
}

console.log(JSON.stringify({ ok: true, exe: path.basename(exe), size: `${WIDTH}x${HEIGHT}`, results }, null, 1))
try { ws.close() } catch {}
// 必须收掉整棵进程树：只 kill 根 PID 会留下渲染/GPU 子进程（实测第二次跑会卡在 Runtime.evaluate）
try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已经退出就算了 */ }
for (const signal of ['SIGTERM', 'SIGKILL']) { try { process.kill(child.pid, signal) } catch {} }
process.exit(0)
