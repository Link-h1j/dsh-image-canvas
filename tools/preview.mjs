/**
 * 画布视觉预览：jsdom 里真渲染 → dump 成静态 HTML → 本机 Chromium 截图。
 *
 * 为什么要有它：这套 UI 的改版目标（2026-10-16 对齐豆包无限画布）是**视觉**，
 * 而 jsdom 没有排版引擎——断言测试能验行为、验不了"看起来对不对"。
 * 这里把 React 渲染出的真实 DOM + 插件自己注入的 CSS 一起落盘，图片换成 data URL 让真浏览器渲染，
 * 于是每个状态都能出一张真像素的图（不需要打开用户正在用的桌面版）。
 *
 * 用法：node tools/preview.mjs [--out <目录>] [--width 560] [--height 980]
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APPS = path.resolve(ROOT, '..', 'apps')
// Dependency locations are configurable for machines that do not keep the
// author's development layout; both env vars point at a project directory whose
// node_modules contains jsdom / react respectively.
const JSDOM_ROOT = process.env.DSH_IMAGE_CANVAS_JSDOM_ROOT || path.join(APPS, 'dsh-design-mode')
const REACT_ROOT = process.env.DSH_IMAGE_CANVAS_REACT_ROOT || path.join(APPS, 'infinite-canvas', 'web')
const requireJsdom = createRequire(path.join(JSDOM_ROOT, 'package.json'))
const requireReact = createRequire(path.join(REACT_ROOT, 'package.json'))
const { JSDOM } = requireJsdom('jsdom')
const React = requireReact('react')
const { createRoot } = requireReact('react-dom/client')

const argv = process.argv.slice(2)
const arg = (name, fallback) => { const i = argv.indexOf(name); return i === -1 ? fallback : argv[i + 1] }
const OUT = path.resolve(arg('--out', path.join(ROOT, '..', '.dsh', 'tmp', 'canvas-preview')))
const WIDTH = Number(arg('--width', 560))
const HEIGHT = Number(arg('--height', 980))

// 预览用的真图：把角色设定图缩到 260 宽放在 .dsh/tmp/canvas-preview/img/（由 ffmpeg 预先缩好）
const IMG_DIR = path.join(OUT, 'img')
const IMAGES = fs.existsSync(IMG_DIR)
  ? fs.readdirSync(IMG_DIR).filter((name) => name.endsWith('.png')).sort().map((name) => path.join(IMG_DIR, name))
  : []
const DATA_URLS = IMAGES.map((file) => 'data:image/png;base64,' + fs.readFileSync(file).toString('base64'))

// ── 沙箱（替身形状与 tools/selftest.mjs 保持一致，那边是契约的单一真源）
const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
  url: 'http://127.0.0.1:19387/', pretendToBeVisual: true, runScripts: 'outside-only',
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true })
globalThis.HTMLElement = window.HTMLElement
globalThis.Element = window.Element
globalThis.Node = window.Node
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.requestAnimationFrame = window.requestAnimationFrame?.bind(window) ?? ((fn) => window.setTimeout(fn, 16))
let urlSeq = 0
window.URL.createObjectURL = () => DATA_URLS[urlSeq++ % DATA_URLS.length] ?? 'data:image/png;base64,'
window.URL.revokeObjectURL = () => {}
window.Image = class FakeImage {
  constructor() { this.naturalWidth = 260; this.naturalHeight = 380; this.onload = null; this.onerror = null }
  set src(value) { this._src = value; window.setTimeout(() => { if (this.onload) this.onload() }, 0) }
  get src() { return this._src }
}
let hostDoc = null
window.fetch = async (url, options = {}) => {
  const target = String(url)
  if (target.includes('/comfy/status')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, url: 'http://127.0.0.1:8189', checkpoints: ['example_model.safetensors', 'another_example_model.safetensors'] }) }
  }
  if (target.includes('/state')) {
    if ((options.method ?? 'GET').toUpperCase() === 'PUT') return { ok: true, status: 200, json: async () => ({ ok: true }) }
    return { ok: true, status: 200, json: async () => ({ ok: true, doc: hostDoc }) }
  }
  return { ok: false, status: 404, json: async () => ({ ok: false }) }
}
window.navigator.clipboard = { writeText: async () => {} }

// ── 载入产物 + 注册
const clientCode = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')
let registration = null
window.__ModuleLoader__ = { load: (value) => { registration = value } }
window.eval(clientCode)
const plugin = registration.factory((spec) => {
  if (spec === 'react') return React
  throw new Error('unexpected require: ' + spec)
})
const registeredTypes = []
const registeredBodies = []
const PNG = Uint8Array.from(Buffer.from(DATA_URLS[0]?.split(',')[1] ?? '', 'base64'))
plugin.apply({
  remote: {
    workspaceFiles: {
      readBytes: async () => ({ ok: true, value: { data: PNG } }),
      list: async () => ({ ok: true, value: { entries: [], truncated: false } }),
    },
  },
  get: (name) => ({
    slots: { register: (options, Body) => { registeredBodies.push({ options, Body }); return () => {} }, inject: (_n, factory) => factory() },
    sidebarRightTabs: { register: (definition) => { registeredTypes.push(definition); return () => {} } },
  }[name]),
  effect: (fn) => fn(),
})
const pageType = registeredTypes.find((type) => type.kind === 'canvas')
const boardEntry = registeredBodies.find((body) => body.options.key === pageType.id)

// ── 渲染工具
globalThis.IS_REACT_ACT_ENVIRONMENT = true
window.IS_REACT_ACT_ENVIRONMENT = true
let activeRoot = null
let host = window.document.getElementById('host')
const act = React.act ?? (async (fn) => { await fn() })
async function render(element) {
  if (activeRoot !== null) { const previous = activeRoot; activeRoot = null; await act(async () => { previous.unmount() }) }
  host = window.document.createElement('div')
  window.document.body.appendChild(host)
  activeRoot = createRoot(host)
  await act(async () => { activeRoot.render(element) })
  await new Promise((resolve) => window.setTimeout(resolve, 40))
}
const tick = () => new Promise((resolve) => window.setTimeout(resolve, 60))
const $ = (selector) => host.querySelector(selector)
const $$ = (selector) => Array.from(host.querySelectorAll(selector))
const click = (element) => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
const fire = (element, type, init = {}) => {
  const event = new window.Event(type, { bubbles: true, cancelable: true })
  for (const [key, value] of Object.entries(init)) Object.defineProperty(event, key, { value, configurable: true })
  element.dispatchEvent(event)
}

const NODES = IMAGES.map((file, index) => ({
  id: 'node-' + String(index + 1),
  address: 'dsh-resource://file/session/session-1/' + path.basename(file),
  name: path.basename(file),
  path: path.basename(file),
  x: 24 + (index % 2) * 268,
  y: 24 + Math.floor(index / 2) * 400,
  w: 240,
  h: 350,
  rot: 0, locked: false, hidden: false,
}))
const boardProps = boardEntry.options.inject('session-1')

const styles = () => Array.from(window.document.querySelectorAll('style')).map((style) => style.textContent).join('\n')
function dump(state) {
  const html = '<!doctype html><html><head><meta charset="utf-8"><style>' + styles() + '</style></head>'
    + '<body style="margin:0;background:#f6f6f7"><div id="panel" style="position:relative;width:' + WIDTH + 'px;height:' + HEIGHT + 'px;overflow:hidden;background:#f6f6f7">'
    + host.innerHTML + '</div></body></html>'
  const file = path.join(OUT, state + '.html')
  fs.writeFileSync(file, html)
  return file
}

const states = []

// 1) 空态
hostDoc = null
await render(React.createElement(boardEntry.Body, boardProps))
await tick()
states.push(dump('01-empty'))

// 2) 有图（3 张，按 2 列排开）
hostDoc = { v: 1, seq: 1, view: { x: 0, y: 0, k: 0.9 }, nodes: NODES, annotations: [] }
await render(React.createElement(boardEntry.Body, boardProps))
await tick(); await tick()
states.push(dump('02-nodes'))

// 3) 选中一张（节点上方出现操作条 + 缩放手柄）
{
  const nodeEl = $('.icv-node')
  await act(async () => { nodeEl.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 60, clientY: 60, button: 0, pointerId: 1 })) })
  await tick()
  states.push(dump('03-selected'))
}

// 4) 左键拉框多选（框还在手上时的样子）
hostDoc = { v: 1, seq: 1, view: { x: 0, y: 0, k: 0.9 }, nodes: NODES, annotations: [] }
await render(React.createElement(boardEntry.Body, boardProps))
await tick(); await tick()
{
  const stage = $('.icv-stage')
  fire(stage, 'pointerdown', { clientX: 0, clientY: 0, button: 0, pointerId: 11 })
  fire(stage, 'pointermove', { clientX: 600, clientY: 380 })
}
await tick()
states.push(dump('04-marquee'))
fire($('.icv-stage'), 'pointerup', { clientX: 600, clientY: 380 })
await tick()

// 5) ⋯ 菜单
await click($('[data-icv-tool="more"]'))
await tick()
states.push(dump('05-menu'))
await click($('[data-icv-tool="more"]'))
await tick()

// 6) 分组浮层（悬停/点击展开的成员列表）
await click($('[data-icv-tool="group-annot"]'))
await tick()
states.push(dump('06-flyout'))
await tick()

// 7) 落一个标记 → 标记浮层自动弹出
await click($('[data-icv-pick="point"]'))
await tick()
{
  const stage = $('.icv-stage')
  fire(stage, 'pointerdown', { clientX: 150, clientY: 210, button: 0, pointerId: 2 })
  fire(stage, 'pointerup', { clientX: 150, clientY: 210, button: 0, pointerId: 2 })
}
await tick()
{
  const area = $$('.icv-panel textarea')[0]
  if (area !== undefined) {
    const key = Object.keys(area).find((name) => name.startsWith('__reactProps$'))
    await act(async () => { area[key].onChange({ target: { value: '这里的颜色偏冷，改成暖色调' } }) })
  }
}
await tick()
states.push(dump('07-marker'))

// 8) 图片上右键 → 右键菜单（复制/粘贴/剪切/删除 + 我们的补充项）
fire($('.icv-node'), 'contextmenu', { clientX: 150, clientY: 200 })
await tick()
states.push(dump('08-ctx-image'))
fire($('.icv-stage'), 'pointerdown', { clientX: 150, clientY: 200, button: 0, pointerId: 21 })
await tick()

// 9) 画布空白右键 → 画布菜单（粘贴打头）
fire($('.icv-stage'), 'contextmenu', { clientX: 320, clientY: 620 })
await tick()
states.push(dump('09-ctx-canvas'))
fire($('.icv-stage'), 'pointerdown', { clientX: 320, clientY: 620, button: 0, pointerId: 22 })
await tick()

// 11) 拖动磁吸：把第 3 张拖到"与第 2 张左边对齐、与第 1 张底边对齐"（差 3px 时被吸上去 + 参考线）
{
  const world = $('.icv-world')
  const k = Number((world.style.transform.match(/scale\(([\d.]+)\)/) ?? [])[1] ?? '1')
  const el = $$('.icv-node')[2]
  if (el !== undefined) {
    const startX = 200
    const startY = 700
    const deltaWx = (292 + 3) - 24     // 目标左边 295 → 吸到 292
    const deltaWy = (374 + 3) - 424    // 目标顶边 377 → 吸到 374
    fire(el, 'pointerdown', { clientX: startX, clientY: startY, button: 0, pointerId: 51, currentTarget: el })
    fire(el, 'pointermove', { clientX: startX + deltaWx * k, clientY: startY + deltaWy * k })
    await tick()
    states.push(dump('10-snap'))
    fire(el, 'pointerup', { clientX: startX, clientY: startY, button: 0, pointerId: 51 })
    await tick()
  }
}

// 11) 智能对齐 → 矩形图片墙（6 张排成 3×2，不是一个长横排）
{
  const six = Array.from({ length: 6 }, (_, index) => {
    const source = NODES[index % NODES.length]
    return {
      id: 'grid-' + String(index), address: source.address, name: source.name, path: source.path,
      x: 40 + index * 300, y: 40 + index * 40, w: 240, h: 350, rot: 0, locked: false, hidden: false,
    }
  })
  hostDoc = { v: 1, seq: 1, view: { x: 0, y: 0, k: 0.3 }, nodes: six, annotations: [] }
  await render(React.createElement(boardEntry.Body, boardProps))
  await tick(); await tick()
  const stage = $('.icv-stage')
  fire(stage, 'pointerdown', { clientX: 0, clientY: 0, button: 0, pointerId: 91 })
  fire(stage, 'pointermove', { clientX: 4000, clientY: 4000 })
  await tick()
  const alignButton = $('.icv-nodebar [data-icv-tool="node-align"]')
  if (alignButton !== null) {
    await click(alignButton)
    await tick()
    states.push(dump('11-grid'))
  }
  fire(stage, 'pointerup', { clientX: 4000, clientY: 4000, button: 0, pointerId: 91 })
  await tick()
}

// 12) 生成 / 改图浮层（高级参数展开）
await click($('[data-icv-tool="gen"]'))
await tick()
await click($$('.icv-panel button').find((button) => (button.textContent ?? '').includes('高级')))
await tick()
states.push(dump('12-gen'))

console.log('生成 ' + String(states.length) + ' 个状态 HTML：')
for (const state of states) console.log('  ' + path.relative(ROOT, state))

// ── 截图（调 tools/shot.mjs，一个浏览器会话连拍）
const shot = path.join(ROOT, 'tools', 'shot.mjs')
const output = execFileSync(process.execPath, [shot, String(WIDTH), String(HEIGHT), OUT, ...states], { encoding: 'utf8' })
console.log(output)
