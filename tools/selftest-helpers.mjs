/**
 * 纯函数自测（2026-10-21 加）。
 *
 * 为什么单独一个文件：tools/selftest.mjs 是 jsdom + 真 React 的全量渲染（~11 s），
 * 纯函数（magic bytes / 路径补分隔符 / 分块拼接）改动要秒级反馈；这里不做任何渲染，~0.3 s 跑完。
 *
 * 用法（cwd 无所谓）：
 *   node tools/selftest-helpers.mjs            # 默认按脚本位置推 <repo>
 *   node tools/selftest-helpers.mjs <repoDir>  # 显式指定仓库根
 *
 * 前置：lib/client.js 必须是最新的（node tools/build-client.mjs）；`npm run check` 会替你守这条。
 * 依赖：只在「载入模块」时 require('react')，所以 react 仍需在
 *   $DSH_IMAGE_CANVAS_REACT_ROOT 或 <repo>/../apps/infinite-canvas/web 里（与 selftest.mjs 同源）。
 * 不依赖 jsdom：client.js 用 new Function('window', code) 跑一遍，window 只要一个 __ModuleLoader__ 替身。
 *
 * 契约：lib/client.body.js 末尾必须有
 *   module.exports.__test = { sniffImageFormat, repairPathCandidates, readImageBytes, ... }
 * 少导出一个，本文件会以「缺导出」明确失败，而不是静默跳过。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(process.argv[2] ?? process.env.DSH_IMAGE_CANVAS_REPO ?? path.join(HERE, '..'))
const REACT_ROOT = process.env.DSH_IMAGE_CANVAS_REACT_ROOT
  || path.join(ROOT, '..', 'apps', 'infinite-canvas', 'web')

let passed = 0
const failures = []
function check(label, ok, extra = '') {
  if (ok) { passed++; console.log('  ✅ ' + label) }
  else { failures.push(label + (extra === '' ? '' : ' — ' + extra)); console.log('  ❌ ' + label + (extra === '' ? '' : ' — ' + extra)) }
}
const same = (label, actual, expected) => check(
  label + ' → ' + JSON.stringify(expected),
  JSON.stringify(actual) === JSON.stringify(expected),
  '实际 ' + JSON.stringify(actual),
)

// ── 载入产物（无 jsdom）────────────────────────────────────────────────────
const requireReact = createRequire(path.join(REACT_ROOT, 'package.json'))
const React = requireReact('react')
const clientPath = path.join(ROOT, 'lib', 'client.js')
const code = fs.readFileSync(clientPath, 'utf8')
let registration = null
const fakeWindow = { __ModuleLoader__: { load: (value) => { registration = value } } }
new Function('window', code)(fakeWindow) // 只建模块，不调用 apply()（apply 才碰 DOM）
if (registration === null) throw new Error('client.js 没有调用 window.__ModuleLoader__.load')
const plugin = registration.factory((spec) => {
  if (spec === 'react') return React
  throw new Error('unexpected require: ' + spec)
})

console.log('== 0. 测试钩子 ==')
check('产物仍导出 apply()', typeof plugin.apply === 'function')
const api = plugin.__test
check('client.body.js 导出了 module.exports.__test', api !== undefined && typeof api === 'object',
  api === undefined ? '（忘了在 body 末尾加 module.exports.__test = {...}）' : typeof api)
if (api === undefined) {
  console.log('\n通过 ' + String(passed) + ' 项，失败 ' + String(failures.length + 1) + ' 项 ❌')
  process.exit(1)
}
for (const name of ['sniffImageFormat', 'repairPathCandidates', 'readImageBytes', 'readImage', 'bytesToImageUrl', 'sessionFileAddress']) {
  check('钩子里有 ' + name + '()', typeof api[name] === 'function', typeof api[name])
}

const bytes = (...list) => Uint8Array.from(list)
const ascii = (text) => Uint8Array.from(Array.from(text, (ch) => ch.charCodeAt(0) & 0xff))

// ── 1. sniffImageFormat：只信文件头 ───────────────────────────────────────
console.log('== 1. sniffImageFormat(bytes) 魔术字节 ==')
same('PNG', api.sniffImageFormat(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'png')
same('JPEG', api.sniffImageFormat(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10)), 'jpeg')
same('GIF89a', api.sniffImageFormat(ascii('GIF89a')), 'gif')
same('WEBP (RIFF....WEBP)', api.sniffImageFormat(Uint8Array.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')])), 'webp')
same('BMP (BM)', api.sniffImageFormat(ascii('BM')), 'bmp')
same('ICO (00 00 01 00)', api.sniffImageFormat(bytes(0x00, 0x00, 0x01, 0x00)), 'ico')
same('TIFF 小端 (II*\\0)', api.sniffImageFormat(bytes(0x49, 0x49, 0x2a, 0x00)), 'tiff')
same('TIFF 大端 (MM\\0*)', api.sniffImageFormat(bytes(0x4d, 0x4d, 0x00, 0x2a)), 'tiff')
same('AVIF (ftyp avif)', api.sniffImageFormat(Uint8Array.from([0, 0, 0, 0x20, ...ascii('ftyp'), ...ascii('avif')])), 'avif')
same('HEIC (ftyp heic)', api.sniffImageFormat(Uint8Array.from([0, 0, 0, 0x20, ...ascii('ftyp'), ...ascii('heic')])), 'heic')
same('HEIF (ftyp mif1)', api.sniffImageFormat(Uint8Array.from([0, 0, 0, 0x20, ...ascii('ftyp'), ...ascii('mif1')])), 'heic')
same('SVG 纯文本', api.sniffImageFormat(ascii('<svg xmlns="http://www.w3.org/2000/svg"/>')), 'svg')
same('SVG 带 XML 头（无 BOM）', api.sniffImageFormat(ascii('\n  <?xml version="1.0"?>\n<svg/>')), 'svg')
same('BOM 开头的 SVG（BOM 按字节跳过后认得）', api.sniffImageFormat(Uint8Array.from([0xEF, 0xBB, 0xBF, ...ascii('<svg/>')])), 'svg')
same('BOM + XML 头的 SVG', api.sniffImageFormat(Uint8Array.from([0xEF, 0xBB, 0xBF, ...ascii('\n<?xml version="1.0"?>\n<svg/>')])), 'svg')
same('空数组', api.sniffImageFormat(new Uint8Array(0)), undefined)
same('undefined', api.sniffImageFormat(undefined), undefined)
same('纯文本（无头）', api.sniffImageFormat(ascii('hello world')), undefined)
check('只给 4 字节 PNG 头也认（不要求更长）', api.sniffImageFormat(bytes(0x89, 0x50, 0x4e, 0x47)) === 'png')

// ── 2. repairPathCandidates：把 Markdown 吃掉的 / 补回来 ─────────────────
console.log('== 2. repairPathCandidates(path) 补分隔符 ==')
{
  const broken = 'B:/ComfyUI_cloud_test/x.png'
  const candidates = api.repairPathCandidates(broken)
  check('返回数组', Array.isArray(candidates))
  check('包含 B:/ComfyUI/_cloud_test/x.png',
    candidates.includes('B:/ComfyUI/_cloud_test/x.png'),
    JSON.stringify(candidates.slice(0, 6)))
  check('原串不在候选里（候选是"改过的"）', !candidates.includes(broken))
  check('不在已有分隔符前重复插（没有 "//"）', candidates.every((one) => !one.includes('//')), JSON.stringify(candidates.find((one) => one.includes('//'))))
  same('每个 ASCII 标点位置各出一条候选（这条路径有 2 个 "_"）', candidates,
    ['B:/ComfyUI/_cloud_test/x.png', 'B:/ComfyUI_cloud/_test/x.png'])
  check('候选都是原串插一个 "/"（长度 +1）', candidates.every((one) => one.length === broken.length + 1))
  check('没有 ASCII 标点的路径不给候选', api.repairPathCandidates('B:/ComfyUI/中文.png').length === 0)
  const many = api.repairPathCandidates('C:/a_b_c_d_e_f_g_h_i_j_k_l_m_n_o_p_q_r_s_t_u_v_w_x_y_z_1_2_3_4_5_6_7_8_9.png')
  check('标点很多时被限流（32 条封顶）', many.length === 32, String(many.length))
  const chinese = api.repairPathCandidates('B:/ComfyUI/中文_文件.png')
  same('中文路径只在 ASCII "_" 前插一次（插在标点前，不是后）', chinese, ['B:/ComfyUI/中文/_文件.png'])
}

// ── 3. readImageBytes：整读失败 → range 分块拼回来 ────────────────────────
console.log('== 3. readImageBytes() 分块拼接 ==')
{
  const calls = []
  const fakeLoad = async (sessionId, filePath, options = {}) => {
    calls.push({ sessionId, filePath, range: options.range })
    if (options.range === undefined) return { ok: false, error: { code: 'workspace-file/too-large', message: '超过 32 MiB' } }
    const offset = options.range.offset
    if (offset === 0) return { ok: true, value: { data: bytes(1, 2), offset: 0, eof: false } }
    if (offset === 2) return { ok: true, value: { data: bytes(3), offset: 2, eof: true } }
    throw new Error('意外的 offset: ' + String(offset))
  }
  const merged = await api.readImageBytes(fakeLoad, 'session-1', 'a.png')
  same('三次调用：整读 + 两个 range', calls.map((one) => (one.range === undefined ? 'full' : one.range.offset)), ['full', 0, 2])
  same('拼出来的字节是 [1,2,3]', Array.from(merged), [1, 2, 3])
  check('返回的是 Uint8Array', merged instanceof Uint8Array)

  const okLoad = async () => ({ ok: true, value: { data: bytes(9, 8, 7), offset: 0, eof: true } })
  same('整读成功就不分块', Array.from(await api.readImageBytes(okLoad, 's', 'b.png')), [9, 8, 7])

  const notFound = async () => ({ ok: false, error: { code: 'workspace-file/not-found', message: 'nope' } })
  let caught = null
  try { await api.readImageBytes(notFound, 's', 'c.png') } catch (error) { caught = error }
  check('非 too-large 的错误原样抛出（带 code）', caught !== null && caught.code === 'workspace-file/not-found', caught === null ? '没抛' : String(caught.code))
}

// ── 4. readImage：路径自愈 + 格式分流（用替身浏览器环境） ────────────────
console.log('== 4. readImage() 路径自愈 / 格式分流 ==')
{
  // 注意：client.js 是在 new Function('window', code) 里求值的，函数里的 window 是**闭包参数**
  // （就是 fakeWindow），所以替身要挂在 fakeWindow 上；URL/Blob 是全局引用，改 globalThis 即可。
  const originalURL = globalThis.URL
  const originalBlob = globalThis.Blob
  const made = []
  class FakeURL {
    static createObjectURL(blob) { made.push(blob); return 'blob:fake/' + String(made.length) }
    static revokeObjectURL() {}
  }
  fakeWindow.Image = class {
    constructor() { this.naturalWidth = 0; this.naturalHeight = 0 }
    set src(value) {
      this._src = value
      setTimeout(() => { this.naturalWidth = 3000; this.naturalHeight = 2000; if (this.onload) this.onload() }, 0)
    }
    get src() { return this._src }
  }
  fakeWindow.navigator = { clipboard: { writeText: async () => {} } }
  globalThis.URL = FakeURL
  globalThis.Blob = class { constructor(parts, options) { this.parts = parts; this.type = options?.type ?? '' } }

  try {
    const PNGBYTES = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13)
    const broken = 'dsh-resource://file/session/session-1/B:/ComfyUI_cloud_test/dalle_test.png'
    const fixed = 'B:/ComfyUI/_cloud_test/dalle_test.png'
    const load = async (sessionId, filePath, options = {}) => {
      if (filePath === 'B:/ComfyUI_cloud_test/dalle_test.png') return { ok: false, error: { code: 'workspace-file/not-found', message: 'ENOENT' } }
      if (filePath === fixed) {
        const range = options.range
        if (range !== undefined) return { ok: true, value: { data: PNGBYTES.subarray(0, 1), offset: 0, eof: false } }
        return { ok: true, value: { data: PNGBYTES, offset: 0, eof: true } }
      }
      return { ok: false, error: { code: 'workspace-file/not-found', message: 'ENOENT' } }
    }
    const asset = await api.readImage(load, broken)
    same('自愈后的路径写回 asset.repairedPath', asset.repairedPath, fixed)
    same('自愈后的地址', asset.repairedAddress, 'dsh-resource://file/session/session-1/' + fixed)
    check('PNG 走原生 Blob（不送宿主转码）', asset.converted === false)
    check('量出了自然尺寸', asset.w === 3000 && asset.h === 2000)

    // HEIC：直接给人话（不送 /convert）
    const heic = Uint8Array.from([0, 0, 0, 0x20, ...ascii('ftyp'), ...ascii('heic'), 0, 0, 0, 0])
    let heicError = null
    try { await api.bytesToImageUrl(heic, 'B:/x/a.heic') } catch (error) { heicError = error }
    check('HEIC 报「没编 HEVC 解码器」而不是静默', heicError !== null && /HEVC/.test(heicError.message), heicError === null ? '没抛' : heicError.message)

    // TIFF：必须送宿主 /convert（fetch 替身返回 PNG）
    let convertedCalls = 0
    globalThis.fetch = async (_url, _init) => {
      convertedCalls++
      return { ok: true, status: 200, blob: async () => new Blob([bytes(0x89, 0x50, 0x4e, 0x47)], { type: 'image/png' }) }
    }
    const tiff = bytes(0x49, 0x49, 0x2a, 0x00, 0x08, 0, 0, 0)
    const decoded = await api.bytesToImageUrl(tiff, 'B:/x/a.tif')
    check('TIFF 走宿主转码（converted=true）', decoded.converted === true && convertedCalls === 1, 'calls=' + String(convertedCalls))
  } finally {
    delete fakeWindow.Image
    delete fakeWindow.navigator
    globalThis.URL = originalURL
    globalThis.Blob = originalBlob
  }
}

console.log('')
if (failures.length === 0) { console.log('全部通过：' + String(passed) + ' 项 ✅'); process.exit(0) }
console.log('通过 ' + String(passed) + ' 项，失败 ' + String(failures.length) + ' 项 ❌')
for (const failure of failures) console.log('  - ' + failure)
process.exit(1)
