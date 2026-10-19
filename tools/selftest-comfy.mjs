/**
 * 端到端验收：用**真实 ComfyUI** 跑通宿主半边的 comfy 通道。
 *   ① /comfy/status 探活与模型列表
 *   ② txt2img（空潜变量）
 *   ③ img2img（用①的产出当源图，验证 /upload/image + VAEEncode）
 *   ④ inpaint（自造黑白掩码，验证 ImageToMask + SetLatentNoiseMask）
 *   ⑤ /comfy/out 能把结果图片原样发回（PNG 魔数校验）
 *
 * 需要 ComfyUI 已在 8189 运行（PYTHONUTF8=1 启动，否则 GBK 会让它崩）。
 * 用法：node tools/selftest-comfy.mjs [checkpoint]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { EventEmitter } from 'node:events'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-canvas-comfy-'))
process.env.DSH_HOME = TEMP_HOME
if (process.env.DSH_IMAGE_CANVAS_COMFY === undefined) process.env.DSH_IMAGE_CANVAS_COMFY = 'http://127.0.0.1:8189'

const CHECKPOINT = process.argv[2] ?? 'dreamshaper_8.safetensors'

let passed = 0
const failures = []
const check = (label, ok, extra = '') => {
  if (ok) { passed++; console.log('  ✅ ' + label) }
  else { failures.push(label); console.log('  ❌ ' + label + (extra === '' ? '' : ' — ' + extra)) }
}

/** 造一个 8bit 灰度 PNG（黑底 + 中间白方块），用作 inpaint 掩码。 */
function makeMaskPng(size = 512) {
  const raw = Buffer.alloc((size * 3 + 1) * size)
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 3 + 1)
    raw[rowStart] = 0
    for (let x = 0; x < size; x++) {
      const inside = x > size * 0.3 && x < size * 0.7 && y > size * 0.3 && y < size * 0.7
      const value = inside ? 255 : 0
      const offset = rowStart + 1 + x * 3
      raw[offset] = value; raw[offset + 1] = value; raw[offset + 2] = value
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ])
}
let CRC_TABLE = null
function crc32(buffer) {
  if (CRC_TABLE === null) {
    CRC_TABLE = []
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0 }
  }
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

// ── 启动宿主半边
const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
const routes = []
const webServer = { register: (route) => { routes.push(route); return () => {} } }
mod.apply({ inject: (_n, cb) => cb({ webServer }), effect: (fn) => { fn(); return () => {} }, reflect: { get: () => webServer } })

function fakeRes() {
  return {
    statusCode: 0, headers: {}, json: undefined, binary: undefined,
    setHeader(key, value) { this.headers[key] = value },
    end(value) {
      if (Buffer.isBuffer(value)) { this.binary = value; return }
      try { this.json = JSON.parse(String(value)) } catch { this.json = { raw: String(value) } }
    },
  }
}
const handler = (suffix) => routes.find((r) => r.path.endsWith(suffix)).handler

async function callRun(payload) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = '/plugins/dsh-image-canvas/comfy/run'
  const res = fakeRes()
  handler('/comfy/run')(req, res)
  req.emit('data', Buffer.from(JSON.stringify(payload)))
  req.emit('end')
  const deadline = Date.now() + 16 * 60 * 1000
  while (res.json === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300))
  return res.json ?? { ok: false, error: 'timeout waiting for handler' }
}

console.log('== ① 探活 ==')
const statusRes = fakeRes()
handler('/comfy/status')({ method: 'GET', url: '/plugins/dsh-image-canvas/comfy/status' }, statusRes)
{
  const deadline = Date.now() + 60000
  while (statusRes.json === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
}
const status = statusRes.json ?? {}
check('ComfyUI 可达', status.ok === true, JSON.stringify(status).slice(0, 200))
check('列出 checkpoint', Array.isArray(status.checkpoints) && status.checkpoints.length > 0, String(status.checkpoints?.length))
check('指定的 checkpoint 存在', (status.checkpoints ?? []).includes(CHECKPOINT), CHECKPOINT)
if (status.ok !== true) { console.log('ComfyUI 不可达，后续用例跳过'); process.exit(1) }
console.log('  使用模型: ' + CHECKPOINT)

console.log('== ② 文生图（512×512 / 6 步，验证 KSampler + EmptyLatentImage）==')
const t0 = Date.now()
const txt2img = await callRun({
  sessionId: 'comfy-test', mode: 'txt2img', checkpoint: CHECKPOINT,
  prompt: 'a single red cube on a white background, product photo, soft light',
  negative: 'blurry, text', steps: 6, cfg: 6, width: 512, height: 512, seed: 12345,
})
check('文生图返回 ok', txt2img.ok === true, JSON.stringify(txt2img).slice(0, 300))
check('结果文件已落盘', typeof txt2img.path === 'string' && fs.existsSync(txt2img.path))
// 关键：返回的 url 必须命中真正注册的路由（写错路径会 404，这条就是用来抓它的）
const returnedPath = typeof txt2img.url === 'string' ? new URL(txt2img.url, 'http://127.0.0.1').pathname : ''
check('返回的 url 命中已注册路由', routes.some((r) => r.path === returnedPath), `${String(txt2img.url)} vs 已注册 ${routes.map((r) => r.path).join(', ')}`)
console.log(`  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，${txt2img.bytes ?? 0} B`)

console.log('== ⑤ 结果图片能原样发回 ==')
if (typeof txt2img.url === 'string') {
  const outRes = fakeRes()
  routes.find((r) => r.path === returnedPath).handler({ method: 'GET', url: txt2img.url }, outRes)
  const png = outRes.binary
  check('返回 PNG 字节', Buffer.isBuffer(png) && png.length > 1000, String(png?.length))
  check('PNG 魔数正确', Buffer.isBuffer(png) && png[0] === 0x89 && png.toString('ascii', 1, 4) === 'PNG')
  const badRes = fakeRes()
  handler('/comfy/out')({ method: 'GET', url: '/plugins/dsh-image-canvas/comfy/out?sessionId=comfy-test&name=..%2F..%2Fstate.json' }, badRes)
  check('拒绝目录穿越的文件名', badRes.statusCode === 400, JSON.stringify(badRes.json))
}

console.log('== ③ 图生图（把上一张当源图，验证 /upload/image + VAEEncode）==')
if (typeof txt2img.path === 'string' && fs.existsSync(txt2img.path)) {
  const source = fs.readFileSync(txt2img.path).toString('base64')
  const img2img = await callRun({
    sessionId: 'comfy-test', mode: 'img2img', checkpoint: CHECKPOINT,
    prompt: 'the same cube but blue, product photo, soft light', negative: 'blurry',
    steps: 6, cfg: 6, denoise: 0.55, sourcePng: source, seed: 999,
  })
  check('图生图返回 ok', img2img.ok === true, JSON.stringify(img2img).slice(0, 300))
  check('图生图产出新文件', typeof img2img.path === 'string' && img2img.path !== txt2img.path && fs.existsSync(img2img.path))

  console.log('== ④ 局部重绘（自造掩码，验证 ImageToMask + SetLatentNoiseMask）==')
  const mask = makeMaskPng(512).toString('base64')
  const inpaint = await callRun({
    sessionId: 'comfy-test', mode: 'inpaint', checkpoint: CHECKPOINT,
    prompt: 'a golden sphere', negative: 'blurry',
    steps: 6, cfg: 6, denoise: 0.9, sourcePng: source, maskPng: mask, seed: 777,
  })
  check('局部重绘返回 ok', inpaint.ok === true, JSON.stringify(inpaint).slice(0, 300))
  check('局部重绘产出新文件', typeof inpaint.path === 'string' && fs.existsSync(inpaint.path))
}

console.log('== 参数守门 ==')
const noCheckpoint = await callRun({ sessionId: 'comfy-test', mode: 'txt2img', prompt: 'x' })
check('缺 checkpoint 返回 400 语义', noCheckpoint.ok === false && String(noCheckpoint.error).includes('checkpoint'), JSON.stringify(noCheckpoint))
const noSource = await callRun({ sessionId: 'comfy-test', mode: 'img2img', checkpoint: CHECKPOINT, prompt: 'x' })
check('img2img 缺源图返回 400 语义', noSource.ok === false && String(noSource.error).includes('源图'), JSON.stringify(noSource))

console.log(`\n产物目录: ${path.join(TEMP_HOME, 'storages', 'dsh-image-canvas', 'out', 'comfy-test')}`)
console.log(fs.readdirSync(path.join(TEMP_HOME, 'storages', 'dsh-image-canvas', 'out', 'comfy-test')).join('\n  '))
fs.rmSync(TEMP_HOME, { recursive: true, force: true })

console.log('')
if (failures.length === 0) { console.log(`全部通过：${passed} 项 ✅`); process.exit(0) }
console.log(`通过 ${passed} 项，失败 ${failures.length} 项 ❌`)
for (const failure of failures) console.log('  - ' + failure)
process.exit(1)
