/**
 * dsh-image-canvas —— 宿主半边。
 *
 * 职责很小（画布数据与交互全部在浏览器半边）：
 *   1) 挂一条探活路由 `/plugins/dsh-image-canvas/probe`，让浏览器半边能确认宿主路由是否已生效
 *      （装了插件但宿主没重启时，这条会 404 —— 客户端据此给出明确提示，而不是"点了没反应"）。
 *   2) 挂一个极小的画布状态暂存区，供以后的 Agent 工具读取：
 *        GET  /plugins/dsh-image-canvas/state?sessionId=...  → 该会话的画布快照 JSON（没有则 {}）
 *        PUT  /plugins/dsh-image-canvas/state?sessionId=...  → 写入（body 为 JSON）
 *      存在 $DSH_HOME/storages/dsh-image-canvas/<安全化的 sessionId>.json，原子写。
 *
 * 约定：本插件的组合包层在 cordis.patch.yml 里（id=image-canvas / name=dsh-image-canvas）。
 * 设计原则：宿主半边任何异常都不能拖垮 DSH —— 全部 try/catch，失败只打日志。
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本插件的包名，同时是 `__ModuleLoader__` 注册 id 与路由命名空间。 */
export const name = 'dsh-image-canvas'

/** 需要宿主服务：webServer（没有它则宿主半边静默降级，客户端会用 localStorage 兜底）。 */
export const inject = ['webServer']

const ROUTE = '/plugins/dsh-image-canvas'

/** 本地 ComfyUI 地址（可用环境变量覆盖）。 */
const COMFY_URL = (process.env.DSH_IMAGE_CANVAS_COMFY ?? 'http://127.0.0.1:8189').replace(/\/+$/, '')

/** 提交一次生成后，最多等多久（毫秒）。 */
const COMFY_JOB_TIMEOUT_MS = 15 * 60 * 1000

/** 日志前缀。 */
function log(...args) {
  try { console.log('[dsh-image-canvas]', ...args) } catch { /* 日志失败不影响运行 */ }
}

/** 画布快照目录：$DSH_HOME/storages/dsh-image-canvas。 */
function storeDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-image-canvas')
}

/** 把会话 id 变成安全文件名（只留字母数字与 - _）。 */
function safeId(sessionId) {
  const cleaned = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120)
  return cleaned === '' ? 'unknown' : cleaned
}

/** 读取一个请求的 body（上限 8 MiB，防止无限膨胀）。 */
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 读取一个请求的 **二进制** body（图片转码用；默认上限 300 MiB）。 */
function readBodyBuffer(req, limit = 300 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        const error = new Error('图片太大（超过 ' + String(Math.round(limit / 1024 / 1024)) + ' MiB），转码服务不收')
        error.code = 'BODY_TOO_LARGE'
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 统一的 JSON 响应。 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/** 从 URL 里取 sessionId 查询参数。 */
function sessionIdOf(url) {
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
  const found = new URLSearchParams(query).get('sessionId')
  return found === null || found === '' ? undefined : found
}

// ─────────────────────────────────────────── 本地 ComfyUI 通道

/** 结果图片目录：$DSH_HOME/storages/dsh-image-canvas/out/<会话>/。 */
function outDir(sessionId) {
  return join(storeDir(), 'out', safeId(sessionId))
}

/** 带超时的 fetch（ComfyUI 是本地服务，控制面请求不该无限等）。 */
async function comfyFetch(pathname, init = {}, timeoutMs = 20000) {
  const response = await fetch(COMFY_URL + pathname, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  return response
}

/** 把 base64 图片上传给 ComfyUI，返回它那边的文件名。 */
async function comfyUpload(name, base64) {
  const bytes = Buffer.from(base64, 'base64')
  const form = new FormData()
  form.append('image', new Blob([bytes], { type: 'image/png' }), name)
  form.append('overwrite', 'true')
  const response = await comfyFetch('/upload/image', { method: 'POST', body: form })
  if (!response.ok) throw new Error('上传图片失败：HTTP ' + String(response.status))
  const body = await response.json()
  const subfolder = typeof body.subfolder === 'string' && body.subfolder !== '' ? body.subfolder + '/' : ''
  return subfolder + String(body.name)
}

/**
 * 组装 ComfyUI 的 API 格式工作流。
 * 只用最通用的核心节点（CheckpointLoaderSimple / KSampler / VAEEncode / SetLatentNoiseMask …），
 * 不依赖任何自定义节点。
 */
function buildWorkflow(options) {
  const graph = {}
  graph['1'] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: options.checkpoint } }
  graph['2'] = { class_type: 'CLIPTextEncode', inputs: { text: options.prompt, clip: ['1', 1] } }
  graph['3'] = { class_type: 'CLIPTextEncode', inputs: { text: options.negative, clip: ['1', 1] } }

  if (options.mode === 'txt2img') {
    graph['4'] = { class_type: 'EmptyLatentImage', inputs: { width: options.width, height: options.height, batch_size: 1 } }
    graph['5'] = {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0],
        seed: options.seed, steps: options.steps, cfg: options.cfg,
        sampler_name: options.sampler, scheduler: options.scheduler, denoise: 1,
      },
    }
  } else {
    graph['4'] = { class_type: 'LoadImage', inputs: { image: options.sourceImage } }
    graph['5'] = { class_type: 'VAEEncode', inputs: { pixels: ['4', 0], vae: ['1', 2] } }
    let latent = ['5', 0]
    if (options.mode === 'inpaint' && options.maskImage !== undefined) {
      graph['6'] = { class_type: 'LoadImage', inputs: { image: options.maskImage } }
      graph['7'] = { class_type: 'ImageToMask', inputs: { image: ['6', 0], channel: 'red' } }
      graph['8'] = { class_type: 'SetLatentNoiseMask', inputs: { samples: ['5', 0], mask: ['7', 0] } }
      latent = ['8', 0]
    }
    graph['9'] = {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: latent,
        seed: options.seed, steps: options.steps, cfg: options.cfg,
        sampler_name: options.sampler, scheduler: options.scheduler, denoise: options.denoise,
      },
    }
  }

  const samplerId = options.mode === 'txt2img' ? '5' : '9'
  graph['20'] = { class_type: 'VAEDecode', inputs: { samples: [samplerId, 0], vae: ['1', 2] } }
  graph['21'] = { class_type: 'SaveImage', inputs: { images: ['20', 0], filename_prefix: 'dsh-canvas' } }
  return graph
}

/** 轮询历史直到这一单出图。 */
async function waitForJob(promptId) {
  const deadline = Date.now() + COMFY_JOB_TIMEOUT_MS
  while (Date.now() < deadline) {
    const response = await comfyFetch('/history/' + encodeURIComponent(promptId), {}, 20000)
    if (response.ok) {
      const history = await response.json()
      const entry = history[promptId]
      if (entry !== undefined) {
        const outputs = entry.outputs ?? {}
        for (const nodeId of Object.keys(outputs)) {
          const images = outputs[nodeId].images
          if (Array.isArray(images) && images.length > 0) return images[0]
        }
        const status = entry.status ?? {}
        if (status.status_str === 'error' || Array.isArray(status.messages) && status.messages.some((m) => Array.isArray(m) && m[0] === 'execution_error')) {
          throw new Error('ComfyUI 执行出错：' + JSON.stringify(status).slice(0, 400))
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1200))
  }
  throw new Error('等 ComfyUI 出图超时（' + String(Math.round(COMFY_JOB_TIMEOUT_MS / 1000)) + 's）')
}

/** 探活 + 列出可用的 checkpoint。 */
async function comfyStatus() {
  try {
    const stats = await comfyFetch('/system_stats', {}, 6000)
    if (!stats.ok) return { ok: false, url: COMFY_URL, error: 'ComfyUI 返回 HTTP ' + String(stats.status) }
    let checkpoints = []
    try {
      const info = await comfyFetch('/object_info/CheckpointLoaderSimple', {}, 15000)
      const body = await info.json()
      const list = body?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]
      if (Array.isArray(list)) checkpoints = list
    } catch { /* 列不出来不算致命，UI 里手填即可 */ }
    return { ok: true, url: COMFY_URL, checkpoints }
  } catch (error) {
    return { ok: false, url: COMFY_URL, error: String(error?.message ?? error) }
  }
}

/** 取 ComfyUI 产出的一张图。 */
async function comfyView(image) {
  const query = new URLSearchParams({
    filename: String(image.filename),
    subfolder: String(image.subfolder ?? ''),
    type: String(image.type ?? 'output'),
  })
  const response = await comfyFetch('/view?' + query.toString(), {}, 120000)
  if (!response.ok) throw new Error('取图失败：HTTP ' + String(response.status))
  return Buffer.from(await response.arrayBuffer())
}

/** 处理一次生成请求（宿主半边全权负责与 ComfyUI 打交道）。 */
async function handleComfyRun(req, res) {
  try {
    const text = await readBody(req, 64 * 1024 * 1024)
    const payload = JSON.parse(text)
    const sessionId = typeof payload.sessionId === 'string' && payload.sessionId !== '' ? payload.sessionId : 'unknown'
    const mode = payload.mode === 'txt2img' || payload.mode === 'inpaint' ? payload.mode : 'img2img'
    if (typeof payload.checkpoint !== 'string' || payload.checkpoint === '') {
      sendJson(res, 400, { ok: false, error: '缺少 checkpoint（先在画布面板里选一个模型）' })
      return
    }
    if (mode !== 'txt2img' && typeof payload.sourcePng !== 'string') {
      sendJson(res, 400, { ok: false, error: '该模式需要源图（请选中一张画布上的图片）' })
      return
    }

    const sourceImage = mode === 'txt2img' ? undefined : await comfyUpload('dsh-source.png', payload.sourcePng)
    const maskImage = mode === 'inpaint' && typeof payload.maskPng === 'string'
      ? await comfyUpload('dsh-mask.png', payload.maskPng)
      : undefined

    const workflow = buildWorkflow({
      mode,
      checkpoint: payload.checkpoint,
      prompt: typeof payload.prompt === 'string' && payload.prompt !== '' ? payload.prompt : 'high quality',
      negative: typeof payload.negative === 'string' ? payload.negative : '',
      steps: Number.isFinite(payload.steps) ? Math.max(1, Math.min(150, payload.steps)) : 22,
      cfg: Number.isFinite(payload.cfg) ? Math.max(0, Math.min(30, payload.cfg)) : 6,
      seed: Number.isFinite(payload.seed) ? Math.floor(payload.seed) : Math.floor(Math.random() * 1e15),
      denoise: Number.isFinite(payload.denoise) ? Math.max(0.05, Math.min(1, payload.denoise)) : 0.6,
      width: Number.isFinite(payload.width) ? Math.max(64, Math.min(2048, Math.round(payload.width / 8) * 8)) : 832,
      height: Number.isFinite(payload.height) ? Math.max(64, Math.min(2048, Math.round(payload.height / 8) * 8)) : 1216,
      sampler: typeof payload.sampler === 'string' && payload.sampler !== '' ? payload.sampler : 'dpmpp_2m',
      scheduler: typeof payload.scheduler === 'string' && payload.scheduler !== '' ? payload.scheduler : 'karras',
      sourceImage,
      maskImage,
    })

    const queued = await comfyFetch('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: 'dsh-image-canvas' }),
    }, 30000)
    const queuedBody = await queued.json().catch(() => ({}))
    if (!queued.ok || typeof queuedBody.prompt_id !== 'string') {
      sendJson(res, 502, { ok: false, error: 'ComfyUI 拒绝了这个工作流：' + JSON.stringify(queuedBody).slice(0, 600) })
      return
    }

    const image = await waitForJob(queuedBody.prompt_id)
    const bytes = await comfyView(image)

    const dir = outDir(sessionId)
    mkdirSync(dir, { recursive: true })
    const name = 'ai-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + Math.random().toString(36).slice(2, 6) + '.png'
    const absolute = join(dir, name)
    writeFileSync(absolute, bytes)
    log('生成完成:', name, '(' + String(bytes.length) + ' B)')
    sendJson(res, 200, {
      ok: true,
      name,
      path: absolute,
      url: ROUTE + '/comfy/out?sessionId=' + encodeURIComponent(sessionId) + '&name=' + encodeURIComponent(name),
      bytes: bytes.length,
    })
  } catch (error) {
    log('生成失败:', error?.message ?? error)
    sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
  }
}

/** 把生成结果图片发回浏览器（只允许读结果目录内的文件）。 */
function handleComfyOut(req, res) {
  const sessionId = sessionIdOf(req.url ?? '')
  const query = (req.url ?? '').includes('?') ? (req.url ?? '').slice((req.url ?? '').indexOf('?') + 1) : ''
  const name = new URLSearchParams(query).get('name') ?? ''
  if (sessionId === undefined || name === '' || /[\\/]/.test(name)) {
    sendJson(res, 400, { ok: false, error: 'bad request' })
    return
  }
  const file = join(outDir(sessionId), name)
  try {
    const bytes = readFileSync(file)
    res.statusCode = 200
    res.setHeader('content-type', 'image/png')
    res.setHeader('cache-control', 'no-store')
    res.end(bytes)
  } catch {
    sendJson(res, 404, { ok: false, error: 'not found' })
  }
}


// ─────────────────────────────────────────── 图片转码（浏览器解不了的格式 → PNG）
//
// 2026-10-21：画布原来只认浏览器能解码的格式（png/jpg/gif/webp/bmp/ico/svg/avif/apng），
// 用户问「其他图片格式能不能加载」。tif/tiff/heic/heif 这类 Chromium 解不了，这里用 sharp
// （libvips）转成 PNG 再回给浏览器。字节是浏览器半边通过官方 workspaceFiles.readBytes 读出来的，
// 这里只做格式转换，不碰文件系统 —— 权限仍由官方 RPC 把关。
//
// sharp 是插件的可选依赖（npm i sharp）；没装/装坏了时返回 501 和一句人话，
// 画布那边会原样显示，不会静默失败。

/** 缓存 sharp 的加载结果（只加载一次；失败也缓存，避免每张图都去 import 一遍）。 */
let sharpModule
let sharpFailure

/** 动态加载 sharp（可选依赖）。 */
async function loadSharp() {
  if (sharpModule !== undefined) return sharpModule
  if (sharpFailure !== undefined) throw sharpFailure
  try {
    const imported = await import('sharp')
    sharpModule = imported?.default ?? imported
    return sharpModule
  } catch (error) {
    sharpFailure = new Error('图片转码器不可用（没装 sharp 或 native 二进制不匹配）：' + String(error?.message ?? error))
    sharpFailure.code = 'SHARP_MISSING'
    throw sharpFailure
  }
}

/** 把任意图片字节转成 PNG（第一页/第一帧；EXIF 方向自动摆正）。 */
async function convertToPng(bytes) {
  const sharp = await loadSharp()
  const pipeline = sharp(bytes, {
    pages: 1,                    // 多页 TIFF / 动画图只取第一页
    failOn: 'none',              // 截断/元数据告警不至于整张图失败
    limitInputPixels: 268402689, // 16384×16384：再大就不解（防止内存爆掉）
  })
  // rotate() 不带参数 = 按 EXIF Orientation 摆正；png 带 alpha，CMYK 会转 sRGB
  return await pipeline.rotate().png({ compressionLevel: 6 }).toBuffer()
}

/** POST /plugins/dsh-image-canvas/convert?name=xxx.tif —— body 是原始字节，返回 image/png。 */
async function handleConvert(req, res) {
  try {
    const bytes = await readBodyBuffer(req)
    if (bytes.length === 0) {
      sendJson(res, 400, { ok: false, error: '空文件，没法转码' })
      return
    }
    const query = (req.url ?? '').includes('?') ? (req.url ?? '').slice((req.url ?? '').indexOf('?') + 1) : ''
    const name = new URLSearchParams(query).get('name') ?? ''
    const png = await convertToPng(bytes)
    log('转码完成:', name === '' ? '(unnamed)' : name, '→ PNG', String(png.length) + ' B')
    res.statusCode = 200
    res.setHeader('content-type', 'image/png')
    res.setHeader('content-length', String(png.length))
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-icv-source-bytes', String(bytes.length))
    res.end(png)
  } catch (error) {
    const code = String(error?.code ?? '')
    if (code === 'BODY_TOO_LARGE') { sendJson(res, 413, { ok: false, error: String(error.message) }); return }
    if (code === 'SHARP_MISSING') { sendJson(res, 501, { ok: false, error: String(error.message) }); return }
    const message = String(error?.message ?? error)
    log('转码失败:', message)
    // sharp/libvips 常见的「认不出这个格式」文案统一成一句人话
    const unsupported = /unsupported|not supported|Input buffer contains unsupported|bad image format|premature end|corrupt/i.test(message)
    sendJson(res, unsupported ? 415 : 500, {
      ok: false,
      error: unsupported ? '这个格式解码不了：' + message : '转码失败：' + message,
    })
  }
}


// ─────────────────────────────────────────── 3D 运行时（vendor 静态资源）
//
// 无限画布的 3D 预览要往页面里 `import()` 一个 ES 模块（three.js + loaders + viewer.js）。
// 浏览器侧只认同源 URL，所以由宿主把插件目录下的 vendor/ 原样发出去：
//   GET /plugins/dsh-image-canvas/vendor/three.module.js  →  text/javascript
//
// 2026-10-28：为什么不把 three 内联进 client.js —— 内联会让 client.js 涨到 1.5 MB+，
// 每次 HMR 都要重新解析整块；走 HTTP 还能吃到浏览器缓存（强缓存 1 小时）。
// 安全口径：只发 vendor/ 目录内、扩展名白名单、不允许 `..` 穿越。

/** vendor 根目录（随插件走，不是用户目录）。 */
const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor')

/** 允许发出去的扩展名 → content-type（不在这张表里的一律 404）。 */
const VENDOR_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

/**
 * 发一个 vendor 文件。
 * 用 prefix 路由而不是逐文件 exact：vendor 里文件会随 three 升级增减，逐条注册迟早漏。
 */
function handleVendor(req, res) {
  const requestUrl = req.url ?? ''
  const prefix = `${ROUTE}/vendor/`
  const cut = requestUrl.indexOf('?')
  const pathname = cut === -1 ? requestUrl : requestUrl.slice(0, cut)
  if (pathname.indexOf(prefix) !== 0) {
    sendJson(res, 404, { ok: false, error: 'not found' })
    return
  }
  const sub = decodeURIComponent(pathname.slice(prefix.length))
  // 白名单字符 + 明确禁止穿越/绝对路径/空段
  if (sub === '' || /[\\]/.test(sub) || sub.includes('..') || sub.startsWith('/') || sub.includes('//')) {
    sendJson(res, 400, { ok: false, error: 'bad vendor path' })
    return
  }
  const dot = sub.lastIndexOf('.')
  const ext = dot === -1 ? '' : sub.slice(dot).toLowerCase()
  const type = VENDOR_TYPES[ext]
  if (type === undefined) {
    sendJson(res, 403, { ok: false, error: 'vendor: 这个扩展名不对外发' })
    return
  }
  const absolute = normalize(join(VENDOR_DIR, sub.split('/').join(sep)))
  if (!absolute.startsWith(VENDOR_DIR + sep)) {
    sendJson(res, 400, { ok: false, error: 'bad vendor path' })
    return
  }
  try {
    const bytes = readFileSync(absolute)
    res.statusCode = 200
    res.setHeader('content-type', type)
    res.setHeader('content-length', String(bytes.length))
    // 强缓存：three 是一个版本一个文件，文件名不变内容就不变（升级时改目录名/加版本查询即可）
    res.setHeader('cache-control', 'public, max-age=3600')
    res.end(bytes)
  } catch (error) {
    if (error?.code !== 'ENOENT') log('vendor 读取失败:', sub, String(error?.message ?? error))
    sendJson(res, 404, { ok: false, error: 'vendor 里没有这个文件：' + sub })
  }
}

/** 探活：返回本插件身份与版本，客户端据此判断宿主路由是否挂上。 */
function probeHandler(_req, res) {
  sendJson(res, 200, { ok: true, plugin: name, version: '0.6.0', store: storeDir(), vendor: VENDOR_DIR })
}

/** 读画布快照。 */
function stateGetHandler(req, res) {
  const sessionId = sessionIdOf(req.url ?? '')
  if (sessionId === undefined) { sendJson(res, 400, { ok: false, error: 'sessionId required' }); return }
  const file = join(storeDir(), safeId(sessionId) + '.json')
  try {
    sendJson(res, 200, { ok: true, doc: JSON.parse(readFileSync(file, 'utf8')) })
  } catch (error) {
    if (error?.code === 'ENOENT') { sendJson(res, 200, { ok: true, doc: null }); return }
    log('读画布快照失败:', error?.message ?? error)
    sendJson(res, 500, { ok: false, error: 'read failed' })
  }
}

/** 写画布快照（原子写：先写 .tmp 再 rename）。 */
async function statePutHandler(req, res) {
  const sessionId = sessionIdOf(req.url ?? '')
  if (sessionId === undefined) { sendJson(res, 400, { ok: false, error: 'sessionId required' }); return }
  try {
    const text = await readBody(req)
    const doc = JSON.parse(text)
    const dir = storeDir()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, safeId(sessionId) + '.json')
    const temporary = join(dir, `.${safeId(sessionId)}.tmp`)
    writeFileSync(temporary, JSON.stringify(doc), 'utf8')
    renameSync(temporary, file)
    sendJson(res, 200, { ok: true })
  } catch (error) {
    log('写画布快照失败:', error?.message ?? error)
    sendJson(res, 400, { ok: false, error: String(error?.message ?? error) })
  }
}

/**
 * 挂路由。webServer 对重复 (kind, path) 会抛错，所以用 mounted 标记 + 幂等。
 * @param ctx - 插件上下文。
 */
export function apply(ctx) {
  let mounted = false
  const mount = (webServer) => {
    if (mounted || webServer === undefined || webServer === null) return
    if (typeof webServer.register !== 'function') return
    mounted = true
    ctx.effect(() => {
      const disposers = [
        webServer.register({ kind: 'exact', path: `${ROUTE}/probe`, handler: probeHandler }),
        webServer.register({ kind: 'exact', path: `${ROUTE}/state`, handler: (req, res) => {
          if ((req.method ?? 'GET').toUpperCase() === 'PUT') { void statePutHandler(req, res); return }
          stateGetHandler(req, res)
        } }),
        webServer.register({ kind: 'exact', path: `${ROUTE}/comfy/status`, handler: (req, res) => {
          void comfyStatus().then((value) => sendJson(res, 200, value))
        } }),
        webServer.register({ kind: 'exact', path: `${ROUTE}/comfy/run`, handler: (req, res) => {
          void handleComfyRun(req, res)
        } }),
        webServer.register({ kind: 'exact', path: `${ROUTE}/comfy/out`, handler: handleComfyOut }),
        webServer.register({ kind: 'exact', path: `${ROUTE}/convert`, handler: (req, res) => {
          if ((req.method ?? 'GET').toUpperCase() !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST only' }); return }
          void handleConvert(req, res)
        } }),
        // 3D 运行时静态资源（prefix：vendor/ 下的文件随 three 版本增删，不逐条注册）
        webServer.register({ kind: 'prefix', path: `${ROUTE}/vendor/`, handler: handleVendor }),
      ]
      return () => { for (const dispose of disposers) { try { dispose() } catch { /* 卸载时忽略 */ } } }
    }, 'dsh-image-canvas: probe + state + comfy + convert routes')
    log('路由已挂载:', ROUTE, '（含 comfy 通道 + 图片转码，ComfyUI =', COMFY_URL + '）')
  }

  try {
    ctx.inject(['webServer'], (webCtx) => {
      mount(webCtx.webServer ?? webCtx.reflect?.get?.('webServer'))
    })
  } catch (error) {
    log('注入 webServer 失败:', error?.message ?? error)
  }
}
