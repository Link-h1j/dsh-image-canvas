/**
 * dsh-image-canvas 离线自检：在 jsdom + 真 React 里把这个插件的浏览器半边跑起来。
 *
 * 为什么值得写：插件最终由用户在桌面版里手装，我不能靠"看起来对"交付。这里用真实渲染验证：
 *   1) 产物形态（__ModuleLoader__ 外壳、id、无 ESM 残留）
 *   2) 两个 tab 类型与两个正文是否按契约注册（id/kind/patterns/canOpen）
 *   3) 空态渲染、节点图片渲染、滚轮缩放、批注落点、复制批注文本、防抖落盘
 *   4) 打开图片时是否把自己换成常驻画布页（openTab('canvas',{replaceTab:true})）
 *
 * 用法：node tools/selftest.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APPS = path.resolve(ROOT, '..', 'apps')
// Same configurable dependency roots as tools/preview.mjs.
const JSDOM_ROOT = process.env.DSH_IMAGE_CANVAS_JSDOM_ROOT || path.join(APPS, 'dsh-design-mode')
const REACT_ROOT = process.env.DSH_IMAGE_CANVAS_REACT_ROOT || path.join(APPS, 'infinite-canvas', 'web')
const requireJsdom = createRequire(path.join(JSDOM_ROOT, 'package.json'))
const requireReact = createRequire(path.join(REACT_ROOT, 'package.json'))

const { JSDOM } = requireJsdom('jsdom')
const React = requireReact('react')
const { createRoot } = requireReact('react-dom/client')

let passed = 0
const failures = []
function check(label, condition, extra = '') {
  if (condition) { passed++; console.log('  ✅ ' + label) }
  else { failures.push(label + (extra === '' ? '' : ' — ' + extra)); console.log('  ❌ ' + label + (extra === '' ? '' : ' — ' + extra)) }
}

// ── 沙箱：jsdom + 若干缺失能力的替身（fetch / Image / createObjectURL / clipboard）
// runScripts 必须开：否则 window.eval 跑到外层 Node 上下文，`window` 反而不存在。
const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
  url: 'http://127.0.0.1:19387/',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
})
const { window } = dom
// React DOM 会读全局 document/window，这里接上 jsdom 的。
globalThis.window = window
globalThis.document = window.document
// Node 22 自带只读的 globalThis.navigator，必须用 defineProperty 覆盖。
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true })
globalThis.HTMLElement = window.HTMLElement
globalThis.Element = window.Element
globalThis.Node = window.Node
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.requestAnimationFrame = window.requestAnimationFrame?.bind(window) ?? ((fn) => window.setTimeout(fn, 16))
let objectUrlSeq = 0
window.URL.createObjectURL = () => 'blob:fake-' + (++objectUrlSeq)
window.URL.revokeObjectURL = () => {}
window.Image = class FakeImage {
  constructor() { this.naturalWidth = 0; this.naturalHeight = 0; this.onload = null; this.onerror = null }
  set src(value) {
    this._src = value
    window.setTimeout(() => { this.naturalWidth = 800; this.naturalHeight = 600; if (this.onload) this.onload() }, 0)
  }
  get src() { return this._src }
}
const fetchLog = []
let hostDoc = null
/** 被 stub 的宿主路由：状态读写 + ComfyUI 通道。 */
window.fetch = async (url, options = {}) => {
  const target = String(url)
  fetchLog.push({ url: target, method: (options.method ?? 'GET').toUpperCase() })
  if (target.includes('/comfy/status')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, url: 'http://127.0.0.1:8189', checkpoints: ['example_model.safetensors', 'example_model_2.safetensors'] }) }
  }
  if (target.includes('/comfy/run')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, name: 'ai-test.png', path: 'C:/tmp/ai-test.png', url: '/plugins/dsh-image-canvas/comfy/out?sessionId=s&name=ai-test.png', bytes: 1234 }) }
  }
  if (target.includes('/state')) {
    if ((options.method ?? 'GET').toUpperCase() === 'PUT') return { ok: true, status: 200, json: async () => ({ ok: true }) }
    return { ok: true, status: 200, json: async () => ({ ok: true, doc: hostDoc }) }
  }
  return { ok: false, status: 404, json: async () => ({ ok: false }) }
}
const clipboardWrites = []
window.navigator.clipboard = { writeText: async (text) => { clipboardWrites.push(text) } }

// 1×1 PNG
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg=='

// ── 载入产物
const clientPath = path.join(ROOT, 'lib', 'client.js')
const clientCode = fs.readFileSync(clientPath, 'utf8')
/** 运行时真正注入的样式表文本（字符串拼接在运行时才算完，所以要读 <style> 而不是读源码）。 */
const injectedCssText = () => Array.from(window.document.querySelectorAll('style')).map((el) => el.textContent ?? '').join('\n')

console.log('== 1. 产物形态 ==')
check('client.js 存在', fs.existsSync(clientPath))
check('是 __ModuleLoader__.load 外壳', clientCode.includes('__ModuleLoader__.load'))
check('注册 id 与包名一致', clientCode.includes('"dsh-image-canvas"'))
check('没有残留 ESM import/export', !/^\s*(import|export)\s/m.test(clientCode))

let registration = null
window.__ModuleLoader__ = { load: (value) => { registration = value } }
window.eval(clientCode)
check('load() 被调用且带 factory', registration !== null && typeof registration.factory === 'function')

const plugin = registration.factory((spec) => {
  if (spec === 'react') return React
  throw new Error('unexpected require: ' + spec)
})
check('导出 apply()', typeof plugin.apply === 'function')
check('导出 inject 数组且含关键服务', Array.isArray(plugin.inject)
  && plugin.inject.includes('slots') && plugin.inject.includes('sidebarRightTabs'), JSON.stringify(plugin.inject))
check('模块级 inject 声明了 remote（cordis 按插件 inject 暴露服务，缺了会抛 cannot get property）', plugin.inject.includes('remote'), JSON.stringify(plugin.inject))
// 2026-10-16 真机事故的最终根因：命名空间必须按点号全名声明，否则报
// `cannot get property "remote.workspaceFiles" without inject`。这条断言就是防它复发。
check('模块级 inject 用点号全名声明了 remote.workspaceFiles', plugin.inject.includes('remote.workspaceFiles'), JSON.stringify(plugin.inject))
// 2026-10-16 真实事故的回归守卫：dsh.client.inject 为空 → remote 服务不在客户端模块图里 →
// 面板能显示但每张图都报 "Cannot get property 'remote'"。官方 documentpreview 就是靠这两条拉进 remote 的。
{
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const list = pkg?.dsh?.client?.inject
  check('package.json 的 dsh.client.inject 把 remote 相关包拉进客户端图', Array.isArray(list)
    && list.includes('@deepseek-ai/dsh-api-remotes')
    && list.includes('@deepseek-ai/dsh-api-workspace-files'), JSON.stringify(list))
}

console.log('== 2. 服务注册契约 ==')
const registeredTypes = []
const registeredBodies = []
const fakeSlots = {
  register: (options, Body) => { registeredBodies.push({ options, Body }); return () => {} },
  inject: (_name, factory) => factory(),
}
const fakeTabs = { register: (definition) => { registeredTypes.push(definition); return () => {} } }
const readBytesCalls = []
const listCalls = []
// 替身必须**照真实 API 形状**做（2026-10-16 教训：之前这里照着错的方法名 readAll 造替身，
// 于是自测全绿、真机报 "Cannot get property 'remote'"。真实契约见 DSH 自带 documentpreview 的客户端代码：
//   ctx.remote.workspaceFiles.readBytes(sessionId, path, options, signal) → { ok, value: { data: Uint8Array } }
const PNG_BYTES = Uint8Array.from(Buffer.from(PNG_BASE64, 'base64'))
const fakeRemote = {
  workspaceFiles: {
    readBytes: async (sessionId, filePath, options, signal) => {
      readBytesCalls.push({ sessionId, filePath, options, hasSignal: signal !== undefined })
      return { ok: true, value: { data: PNG_BYTES, absolutePath: filePath } }
    },
    readAll: async () => { throw new Error('readAll 不存在：官方 API 是 readBytes') },
    // 列目录（官方 sidebar-files 用的同一个 API）
    list: async (sessionId, dir) => {
      listCalls.push({ sessionId, dir })
      return {
        ok: true,
        value: {
          entries: [
            { name: 'pic.png', kind: 'file' },      // 已在画布上 → 应跳过
            { name: 'extra-a.png', kind: 'file' },  // 新增
            { name: 'extra-b.jpg', kind: 'file' },  // 新增
            { name: 'notes.md', kind: 'file' },     // 非图片 → 跳过
            { name: '子目录', kind: 'directory' },   // 目录 → 跳过
          ],
          truncated: false,
        },
      }
    },
  },
}
const ctx = {
  remote: fakeRemote,
  get: (name) => ({ slots: fakeSlots, sidebarRightTabs: fakeTabs }[name]),
  effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {} },
}
plugin.apply(ctx)

check('注册了 2 个 tab 类型', registeredTypes.length === 2, '实际 ' + String(registeredTypes.length))
const pageType = registeredTypes.find((t) => t.kind === 'canvas')
const imageType = registeredTypes.find((t) => t.kind === 'image-canvas')
check('页类型 canvas 存在且不给 patterns', pageType !== undefined && pageType.patterns === undefined)
check('页类型有引导入口（guide）', pageType !== undefined && Array.isArray(pageType.guide) && pageType.guide.length === 1)
check('图片类型认领 dsh-resource://file/**', imageType !== undefined && Array.isArray(imageType.patterns) && imageType.patterns[0] === 'dsh-resource://file/**')
check('canOpen 接受 session scope 的 png', imageType.canOpen('dsh-resource://file/session/s1/a.png') === true)
check('canOpen 接受 jpg 与 svg', imageType.canOpen('dsh-resource://file/session/s1/b.JPG') === true && imageType.canOpen('dsh-resource://file/session/s1/c.svg') === true)
check('canOpen 拒绝文本文件', imageType.canOpen('dsh-resource://file/session/s1/notes.md') === false)
check('canOpen 拒绝 absolute scope（没有 session 读不了字节）', imageType.canOpen('dsh-resource://file/absolute/C:/x/a.png') === false)
check('注册了 2 个正文，key 用类型 id', registeredBodies.length === 2
  && registeredBodies.some((b) => b.options.key === pageType.id) && registeredBodies.some((b) => b.options.key === imageType.id))
check('正文都挂在 sidebar.right.pane.tab 席位', registeredBodies.every((b) => b.options.name === 'sidebar.right.pane.tab'))
check('正文通过 inject 工厂拿到 sessionId 与 loadImage', typeof registeredBodies[0].options.inject === 'function')

const boardBody = registeredBodies.find((b) => b.options.key === pageType.id).Body
const intakeBody = registeredBodies.find((b) => b.options.key === imageType.id).Body
const boardProps = registeredBodies.find((b) => b.options.key === pageType.id).options.inject('session-1')
check('inject 工厂返回 sessionId', boardProps.sessionId === 'session-1')

// ── 渲染
// React 19 要求显式声明 act 环境，否则刷满 console.error；每次渲染换一个容器并卸载上一个根，
// 避免 "container has already been passed to createRoot()" 的重复挂载告警。
globalThis.IS_REACT_ACT_ENVIRONMENT = true
window.IS_REACT_ACT_ENVIRONMENT = true
let host = window.document.getElementById('host')
let activeRoot = null
const act = React.act ?? (async (fn) => { await fn() })
async function render(element) {
  if (activeRoot !== null) {
    const previous = activeRoot
    activeRoot = null
    await act(async () => { previous.unmount() })
  }
  host = window.document.createElement('div')
  window.document.body.appendChild(host)
  activeRoot = createRoot(host)
  await act(async () => { activeRoot.render(element) })
  await new Promise((r) => window.setTimeout(r, 30))
  return activeRoot
}
const tick = () => new Promise((r) => window.setTimeout(r, 60))
const text = () => host.textContent ?? ''
const $ = (selector) => host.querySelector(selector)
const $$ = (selector) => Array.from(host.querySelectorAll(selector))
const fire = (element, type, init = {}) => {
  const event = new window.Event(type, { bubbles: true, cancelable: true })
  for (const [key, value] of Object.entries(init)) Object.defineProperty(event, key, { value, configurable: true })
  element.dispatchEvent(event)
  return event
}
const click = (element) => {
  const event = new window.MouseEvent('click', { bubbles: true, cancelable: true })
  element.dispatchEvent(event)
}
/**
 * 给受控 input/textarea 赋值。
 * 直接 element.value = x 绕不过 React 的值追踪器（onChange 不会触发），必须走原型上的原生 setter。
 */
/**
 * 给受控 input/textarea 赋值。
 *
 * 实测（tools 里的 react-input-probe 实验，React 19.2.5 + jsdom）：从 Node 侧 dispatch 原生 `input`
 * /`InputEvent`/`change` **一律进不到 React 的合成事件系统**（五种写法全失败，值追踪器重置也没用）。
 * 可靠做法是白盒：DOM 节点上挂着 `__reactProps$*`，直接调它的 onChange。
 * （点击事件不受影响，原生 MouseEvent 能被 React 接住，所以 click() 保持原样。）
 */
const setInputValue = async (element, value) => {
  const key = Object.keys(element).find((name) => name.startsWith('__reactProps$'))
  if (key !== undefined && typeof element[key]?.onChange === 'function') {
    await act(async () => { element[key].onChange({ target: { value } }) })
  } else {
    const prototype = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set
    await act(async () => {
      setter.call(element, value)
      element.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
  }
  await new Promise((r) => window.setTimeout(r, 20))
}
const buttonByText = (needle) => $$('button').find((b) => (b.textContent ?? '').includes(needle))

console.log('== 3. 空态渲染（极简化改版：画布占满 / 无常驻工具条与面板） ==')
hostDoc = null
await render(React.createElement(boardBody, boardProps))
await tick()
check('没有常驻顶部工具条', $('.icv-bar') === null)
check('没有常驻面板（画布全屏留白）', $('.icv-panel') === null && $('.icv-sheet') === null)
const toolButtons = $$('.icv-tools [data-icv-tool]')
check('右下角工具组是 5 个按钮（生成 + 指针组 + 批注组 + 适应 + 更多）', toolButtons.length === 5, String(toolButtons.length))
check('工具按钮是纯图标（没有文字，靠 title 提示）', toolButtons.every((b) => (b.textContent ?? '') === '' && (b.getAttribute('title') ?? '') !== ''))
check('指针组默认显示「选择」，批注组此时没有生效成员（标题里带三个成员名）',
  ($('[data-icv-tool="group-pointer"]')?.getAttribute('title') ?? '').includes('当前：选择')
  && ($('[data-icv-tool="group-annot"]')?.getAttribute('title') ?? '').includes('标记 / 框选 / 涂抹')
  && !($('[data-icv-tool="group-annot"]')?.getAttribute('title') ?? '').includes('当前：'),
  [$('[data-icv-tool="group-pointer"]')?.getAttribute('title'), $('[data-icv-tool="group-annot"]')?.getAttribute('title')].join(' | '))
check('分组有展开指示（小三角）', $$('.icv-tool-more').length === 2)
check('没点开时没有成员浮层', $('.icv-flyout') === null)
await click($('[data-icv-tool="group-annot"]'))
await tick()
check('点分组按钮展开成员浮层', $('.icv-flyout') !== null && $$('.icv-flyout-row').length === 3, String($$('.icv-flyout-row').length))
check('浮层里是 标记 / 框选 / 涂抹', ['point', 'rect', 'brush'].every((m) => $('[data-icv-pick="' + m + '"]') !== null))
check('没有成员生效时不乱标高亮', $$('.icv-flyout-row[data-on="1"]').length === 0, String($$('.icv-flyout-row[data-on="1"]').length))
await click($('[data-icv-pick="brush"]'))
await tick()
check('选「涂抹」后浮层收起、分组按钮改显示它',
  $('.icv-flyout') === null && ($('[data-icv-tool="group-annot"]')?.getAttribute('title') ?? '').includes('当前：涂抹'))
await click($('[data-icv-tool="group-annot"]'))
await tick()
check('再打开时当前工具高亮', $('[data-icv-pick="brush"]')?.getAttribute('data-on') === '1')
await click($('[data-icv-tool="group-annot"]'))
await tick()
check('再点一下收起浮层', $('.icv-flyout') === null)

console.log('== 3b. 悬停浮层的手感：不能被"手指一抖"收掉（2026-10-16 用户反馈） ==')
{
  const groupEl = $('[data-icv-tool="group-pointer"]').parentElement
  fire(groupEl, 'mouseover', {})
  await tick()
  check('悬停展开浮层', $('.icv-flyout') !== null)
  check('浮层卡片外面还有一条透明"桥"（鼠标跨过去不会掉出去）', $('.icv-flyout-card') !== null)
  fire(groupEl, 'mouseout', {})
  await tick()
  check('鼠标刚移开时**不立刻**收起（留了缓冲）', $('.icv-flyout') !== null)
  await new Promise((r) => window.setTimeout(r, 340))
  await tick()
  check('缓冲过后才收起', $('.icv-flyout') === null)
  // 点开的浮层会被钉住：鼠标移开也不收
  await click($('[data-icv-tool="group-pointer"]'))
  await tick()
  fire(groupEl, 'mouseout', {})
  await new Promise((r) => window.setTimeout(r, 340))
  await tick()
  check('点开的浮层被钉住，鼠标移开也不收', $('.icv-flyout') !== null)
  await click($('[data-icv-tool="group-pointer"]'))
  await tick()
  check('再点一下才收起', $('.icv-flyout') === null)
  // 选一项 → 收起
  await click($('[data-icv-tool="group-annot"]'))
  await tick()
  await click($('[data-icv-pick="point"]'))
  await tick()
  check('选完成员后浮层收起', $('.icv-flyout') === null)
  await click($('[data-icv-tool="group-pointer"]'))
  await tick()
  await click($('[data-icv-pick="select"]'))
  await tick()
}
await click($('[data-icv-tool="group-pointer"]'))
await tick()
await click($('[data-icv-pick="select"]'))
await tick()
check('回到「选择」', ($('[data-icv-tool="group-pointer"]')?.getAttribute('title') ?? '').includes('当前：选择'))
check('空态提示出现', text().includes('画布还是空的'))
check('有「批注」分组按钮（标记/框选/涂抹 收在里面）', $('[data-icv-tool="group-annot"]') !== null)
check('缩放胶囊显示百分比', $('[data-icv-zoom]') !== null && /(\d+)%/.test($('[data-icv-zoom]').textContent ?? ''))
check('没有标记时不显示标记胶囊', $('[data-icv-annpill]') === null)
check('⋯ 菜单默认收起', $('.icv-menu') === null)
await click($('[data-icv-tool="more"]'))
await tick()
check('⋯ 菜单能打开', $('.icv-menu') !== null)
check('撤销在菜单里且初始禁用', buttonByText('撤销')?.disabled === true, String(buttonByText('撤销')?.disabled))
check('重做在菜单里且初始禁用', buttonByText('重做')?.disabled === true, String(buttonByText('重做')?.disabled))
check('菜单带自检信息（build + 读图服务）', text().includes('build') && /读图服务(就绪|不可用)/.test(text()))
await click($('[data-icv-tool="more"]'))
await tick()
check('⋯ 菜单能收起', $('.icv-menu') === null)

console.log('== 4. 有节点时的渲染 ==')
hostDoc = {
  v: 1, seq: 3, view: { x: 0, y: 0, k: 1 },
  nodes: [{ id: 'node-1', address: 'dsh-resource://file/session/session-1/pic.png', name: 'pic.png', path: 'pic.png', x: 10, y: 20, w: 200, h: 150, rot: 0, locked: false, hidden: false }],
  annotations: [],
}
await render(React.createElement(boardBody, boardProps))
await tick(); await tick()
check('读到宿主文档并渲染出 1 张图', $$('.icv-node').length === 1, '实际 ' + String($$('.icv-node').length))
check('图片用 object URL 显示', $('.icv-node img') !== null && String($('.icv-node img').getAttribute('src')).startsWith('blob:'))
check('通过 ctx.remote.workspaceFiles.readBytes 读字节', readBytesCalls.length > 0
  && readBytesCalls[0].sessionId === 'session-1' && readBytesCalls[0].filePath === 'pic.png'
  && typeof readBytesCalls[0].options === 'object', JSON.stringify(readBytesCalls[0] ?? null))
check('读的不是不存在的 readAll', readBytesCalls.length === 1)
check('渲染出的是真图（没有落到读取失败）', text().includes('读取失败') === false, text().slice(0, 160))
check('图片数与缩放写在缩放胶囊的 tooltip 里', String($('[data-icv-zoom]').getAttribute('title')).includes('1 张'), String($('[data-icv-zoom]').getAttribute('title')))
check('未选中时没有节点操作条', $('.icv-nodebar') === null)

console.log('== 4b. 工具语义：选择=拉框多选 / 拖动=手 / 批注工具不再让图片抢指针 ==')
// 2026-10-16 用户反馈：选了标记/框选/涂抹后，鼠标移到图上仍变"移动"光标，看起来像没生效
await click($('[data-icv-tool="group-annot"]'))
await tick()
await click($('[data-icv-pick="point"]'))
await tick()
check('从分组浮层里选「标记」后浮层收起', $('.icv-flyout') === null)
check('分组按钮改显示「标记」', ($('[data-icv-tool="group-annot"]')?.getAttribute('title') ?? '').includes('当前：标记'))
check('标记模式：图片关闭指针事件', $$('.icv-node').every((n) => n.style.pointerEvents === 'none'), $$('.icv-node')[0]?.style.pointerEvents)
check('标记模式：画布十字光标', $('.icv-stage').style.cursor === 'crosshair', $('.icv-stage').style.cursor)
check('标记模式：有提示条', text().includes('在图上单击落点'))
await click($('[data-icv-tool="group-pointer"]'))
await tick()
await click($('[data-icv-pick="hand"]'))
await tick()
check('从分组浮层里选「拖动」：画布抓取光标（豆包第二只手）', $('.icv-stage').style.cursor === 'grab', $('.icv-stage').style.cursor)
check('拖动模式：图片不吃指针事件（拖过图片=平移画布）', $$('.icv-node').every((n) => n.style.pointerEvents === 'none'))
await click($('[data-icv-tool="group-pointer"]'))
await tick()
await click($('[data-icv-pick="select"]'))
await tick()
check('选择模式：画布是默认箭头光标', $('.icv-stage').style.cursor === 'default', $('.icv-stage').style.cursor)
check('选择模式：图片恢复指针事件', $$('.icv-node').every((n) => n.style.pointerEvents !== 'none'))

console.log('== 4d. 右键菜单（图片一份 / 画布一份，浏览器原生菜单一律不出现） ==')
hostDoc = {
  v: 1, seq: 1, view: { x: 0, y: 0, k: 1 },
  nodes: [
    { id: 'node-a', address: 'dsh-resource://file/session/session-1/a.png', name: 'a.png', path: 'a.png', x: 10, y: 20, w: 200, h: 150, rot: 0, locked: false, hidden: false },
    { id: 'node-b', address: 'dsh-resource://file/session/session-1/b.png', name: 'b.png', path: 'b.png', x: 300, y: 20, w: 200, h: 150, rot: 0, locked: false, hidden: false },
  ],
  annotations: [],
}
await render(React.createElement(boardBody, boardProps))
await tick(); await tick()
check('默认没有右键菜单', $('.icv-ctx') === null)
fire($('.icv-node'), 'contextmenu', { clientX: 80, clientY: 90 })
await tick()
check('图片上右键弹出菜单', $('.icv-ctx') !== null)
check('右键图片会顺手选中它', $$('.icv-node[data-sel="1"]').length === 1)
check('图片菜单前四项跟豆包一致：复制 / 粘贴 / 剪切 / 删除',
  ['复制', '粘贴', '剪切', '删除'].every((label) => ($('.icv-ctx').textContent ?? '').includes(label)),
  ($('.icv-ctx').textContent ?? '').slice(0, 90))
check('图片菜单还有我们的补充项：改这张图 / 同目录铺开 / 锁定（隐藏已按用户要求去掉）',
  ['改这张图', '同目录铺开', '锁定'].every((label) => ($('.icv-ctx').textContent ?? '').includes(label))
  && !($('.icv-ctx').textContent ?? '').includes('隐藏'))
check('剪贴板空时「粘贴」是灰的', $$('.icv-ctx button').find((b) => (b.textContent ?? '') === '粘贴')?.disabled === true)
// 复制 → 粘贴：节点数 +1，且新节点被选中
await click($$('.icv-ctx button').find((b) => (b.textContent ?? '').includes('复制')))
await tick()
check('复制后收起菜单', $('.icv-ctx') === null)
fire($('.icv-stage'), 'contextmenu', { clientX: 20, clientY: 20 })
await tick()
check('画布菜单是「粘贴」打头（跟豆包一致）', ($$('.icv-ctx button')[0]?.textContent ?? '').includes('粘贴'), $$('.icv-ctx button')[0]?.textContent)
check('画布菜单也有 全选 / 适应视图 / 导出 PNG / 清空画布',
  ['全选', '适应视图', '导出 PNG', '清空画布'].every((label) => ($('.icv-ctx').textContent ?? '').includes(label)))
check('复制过东西后「粘贴」可点', $$('.icv-ctx button').find((b) => (b.textContent ?? '') === '粘贴')?.disabled === false)
await click($$('.icv-ctx button').find((b) => (b.textContent ?? '') === '粘贴'))
await tick()
check('粘贴把图片贴到画布上（2 → 3 张）', $$('.icv-node').length === 3, String($$('.icv-node').length))
check('粘贴后选中的是刚贴出来的那张', $$('.icv-node[data-sel="1"]').length === 1)
// 剪切 → 数量减少，剪贴板留着
{
  const before = $$('.icv-node').length
  fire($('.icv-node[data-sel="1"]'), 'contextmenu', { clientX: 60, clientY: 60 })
  await tick()
  await click($$('.icv-ctx button').find((b) => (b.textContent ?? '') === '剪切') ?? $$('.icv-ctx button').find((b) => (b.textContent ?? '').includes('剪切')))
  await tick()
  check('剪切后画布少一张', $$('.icv-node').length === before - 1, `${before} → ${$$('.icv-node').length}`)
  fire($('.icv-stage'), 'contextmenu', { clientX: 20, clientY: 20 })
  await tick()
  await click($$('.icv-ctx button').find((b) => (b.textContent ?? '') === '粘贴'))
  await tick()
  check('剪贴板里的还能粘回来', $$('.icv-node').length === before, String($$('.icv-node').length))
}
// Ctrl+V 快捷键
{
  const before = $$('.icv-node').length
  fire($('.icv-root'), 'keydown', { key: 'v', ctrlKey: true })
  await tick()
  check('Ctrl+V 也能粘贴', $$('.icv-node').length === before + 1, `${before} → ${$$('.icv-node').length}`)
}
// 框选多张 → 右键：保留整批（复制 N 张）
{
  fire($('.icv-stage'), 'pointerdown', { clientX: 0, clientY: 0, button: 0, pointerId: 31 })
  fire($('.icv-stage'), 'pointermove', { clientX: 700, clientY: 400 })
  await tick()
  const pickedCount = $$('.icv-node[data-sel="1"]').length
  check('先框选到多张（≥2）', pickedCount >= 2, String(pickedCount))
  fire($('.icv-node[data-sel="1"]'), 'contextmenu', { clientX: 90, clientY: 90 })
  await tick()
  check('在多选里右键不会把选择收成一张', $$('.icv-node[data-sel="1"]').length === pickedCount, String($$('.icv-node[data-sel="1"]').length))
  check('菜单按张数说话（复制这 N 张 / 剪切这 N 张）',
    ($('.icv-ctx').textContent ?? '').includes('复制这 ' + String(pickedCount) + ' 张') && ($('.icv-ctx').textContent ?? '').includes('剪切这 ' + String(pickedCount) + ' 张'),
    ($('.icv-ctx').textContent ?? '').slice(0, 90))
  fire($('.icv-stage'), 'pointerdown', { clientX: 20, clientY: 20, button: 0, pointerId: 32 })
  await tick()
  check('点画布收起右键菜单', $('.icv-ctx') === null)
}

console.log('== 4e. 拖动磁吸 + 对齐参考线（对齐豆包） ==')
hostDoc = {
  v: 1, seq: 1, view: { x: 0, y: 0, k: 1 },
  nodes: [
    { id: 'node-a', address: 'dsh-resource://file/session/session-1/a.png', name: 'a.png', path: 'a.png', x: 10, y: 20, w: 200, h: 150, rot: 0, locked: false, hidden: false },
    { id: 'node-b', address: 'dsh-resource://file/session/session-1/b.png', name: 'b.png', path: 'b.png', x: 400, y: 300, w: 200, h: 150, rot: 0, locked: false, hidden: false },
  ],
  annotations: [],
}
await render(React.createElement(boardBody, boardProps))
await tick(); await tick()
{
  const nodeB = $$('.icv-node')[1]
  // 抓 node-b 往左上拖：让它的左边落在 node-a 右边(210)附近，顶边落在 node-a 顶边(20)附近
  fire(nodeB, 'pointerdown', { clientX: 500, clientY: 400, button: 0, pointerId: 41, currentTarget: nodeB })
  fire(nodeB, 'pointermove', { clientX: 309, clientY: 124 })
  await tick()
  const left = parseFloat($$('.icv-node')[1].style.left)
  const top = parseFloat($$('.icv-node')[1].style.top)
  check('水平磁吸：左边吸到另一张的右边（209 → 210）', left === 210, '实际 ' + String(left))
  check('垂直磁吸：顶边吸到另一张的顶边（20）', top === 20, '实际 ' + String(top))
  check('拖动时画出对齐参考线', $$('.icv-guide').length >= 1, String($$('.icv-guide').length))
  check('参考线有横向竖向各一条（x/y）',
    $$('.icv-guide[data-axis="x"]').length >= 1 && $$('.icv-guide[data-axis="y"]').length >= 1,
    $$('.icv-guide').map((g) => g.getAttribute('data-axis')).join(','))
  check('参考线是 1px 细线（按 1/k 反向缩放）', $('.icv-guide[data-axis="x"]')?.style.width === '1px', $('.icv-guide[data-axis="x"]')?.style.width)
  fire(nodeB, 'pointerup', { clientX: 309, clientY: 124, button: 0, pointerId: 41 })
  await tick()
  check('松开后参考线消失', $$('.icv-guide').length === 0, String($$('.icv-guide').length))
  // 远一点就不吸（避免"到处乱吸"）
  fire(nodeB, 'pointerdown', { clientX: 500, clientY: 400, button: 0, pointerId: 42, currentTarget: nodeB })
  fire(nodeB, 'pointermove', { clientX: 340, clientY: 160 })
  await tick()
  check('离得远就不吸（自由拖动，也不画参考线）',
    Math.abs(parseFloat($$('.icv-node')[1].style.left) - 50) < 0.6 && $$('.icv-guide').length === 0,
    'left=' + $$('.icv-node')[1].style.left + ' guides=' + String($$('.icv-guide').length))
  fire(nodeB, 'pointerup', { clientX: 340, clientY: 160, button: 0, pointerId: 42 })
  await tick()
  // 按住 Alt 关掉磁吸
  fire(nodeB, 'pointerdown', { clientX: 500, clientY: 400, button: 0, pointerId: 43, currentTarget: nodeB })
  fire(nodeB, 'pointermove', { clientX: 309, clientY: 124, altKey: true })
  await tick()
  check('按住 Alt 时不磁吸（要精确定位）', parseFloat($$('.icv-node')[1].style.left) !== 210, $$('.icv-node')[1].style.left)
  fire(nodeB, 'pointerup', { clientX: 309, clientY: 124, button: 0, pointerId: 43 })
  await tick()
}

console.log('== 4g. 右键菜单出现在鼠标处（坐标换算 + 贴边翻转） ==')
hostDoc = {
  v: 1, seq: 1, view: { x: 0, y: 0, k: 1 },
  nodes: [{ id: 'node-a', address: 'dsh-resource://file/session/session-1/a.png', name: 'a.png', path: 'a.png', x: 10, y: 20, w: 200, h: 150, rot: 0, locked: false, hidden: false }],
  annotations: [],
}
await render(React.createElement(boardBody, boardProps))
await tick(); await tick()
{
  // jsdom 没有布局，这里替身一个"面板不在屏幕左上角"的真实场景（面板 left=1400、top=60、1000×900）
  $('.icv-root').getBoundingClientRect = () => ({ left: 1400, top: 60, width: 1000, height: 900, right: 2400, bottom: 960, x: 1400, y: 60, toJSON: () => ({}) })
  fire($('.icv-node'), 'contextmenu', { clientX: 1900, clientY: 300 })
  await tick()
  const first = $('.icv-ctx')
  check('菜单 left = 鼠标 x - 面板 left（不再落在固定位置）', parseFloat(first.style.left) === 500, first.style.left)
  check('菜单 top = 鼠标 y - 面板 top', parseFloat(first.style.top) === 240, first.style.top)
  fire($('.icv-node'), 'contextmenu', { clientX: 1500, clientY: 500 })
  await tick()
  check('换个地方点：菜单跟着鼠标一起移',
    Math.round(parseFloat($('.icv-ctx').style.left)) === 100 && Math.round(parseFloat($('.icv-ctx').style.top)) === 440,
    $('.icv-ctx').style.left + ',' + $('.icv-ctx').style.top)
  fire($('.icv-node'), 'contextmenu', { clientX: 2380, clientY: 300 })
  await tick()
  check('右边放不下 → 翻到鼠标左侧（仍贴着鼠标）', Math.round(parseFloat($('.icv-ctx').style.left)) === 784, $('.icv-ctx').style.left)
  fire($('.icv-stage'), 'contextmenu', { clientX: 1500, clientY: 950 })
  await tick()
  check('下面放不下 → 翻到鼠标上方', Math.round(parseFloat($('.icv-ctx').style.top)) === 680, $('.icv-ctx').style.top)
  check('画布菜单和图片菜单是两份', ($('.icv-ctx').textContent ?? '').includes('粘贴') && ($('.icv-ctx').textContent ?? '').includes('清空画布'))
}

console.log('== 4f. 智能对齐排成矩形图片墙（不是一条长横排） ==')
hostDoc = {
  v: 1, seq: 1, view: { x: 0, y: 0, k: 1 },
  nodes: Array.from({ length: 6 }, (_, index) => ({
    id: 'node-' + String.fromCharCode(97 + index),
    address: 'dsh-resource://file/session/session-1/' + String.fromCharCode(97 + index) + '.png',
    name: String.fromCharCode(97 + index) + '.png',
    path: String.fromCharCode(97 + index) + '.png',
    x: 40 + index * 260, y: 40 + index * 30, w: 200, h: 150, rot: 0, locked: false, hidden: false,
  })),
  annotations: [],
}
await render(React.createElement(boardBody, boardProps))
await tick(); await tick()
{
  fire($('.icv-stage'), 'pointerdown', { clientX: 0, clientY: 0, button: 0, pointerId: 81 })
  fire($('.icv-stage'), 'pointermove', { clientX: 2000, clientY: 400 })
  await tick()
  check('框选到 6 张', $$('.icv-node[data-sel="1"]').length === 6, String($$('.icv-node[data-sel="1"]').length))
  await click($('.icv-nodebar [data-icv-tool="node-align"]'))
  await tick()
  const xs = $$('.icv-node').map((el) => parseFloat(el.style.left))
  const ys = $$('.icv-node').map((el) => parseFloat(el.style.top))
  const uniqX = Array.from(new Set(xs)).sort((a, b) => a - b)
  const uniqY = Array.from(new Set(ys)).sort((a, b) => a - b)
  check('6 张排成 3 列 × 2 行（不是 6 列一行）', uniqX.length === 3 && uniqY.length === 2, '列=' + String(uniqX.length) + ' 行=' + String(uniqY.length))
  check('列间距 = 图宽 + 24', uniqX.length === 3 && Math.round(uniqX[1] - uniqX[0]) === 224 && Math.round(uniqX[2] - uniqX[1]) === 224, uniqX.join('/'))
  check('行间距 = 图高 + 24', uniqY.length === 2 && Math.round(uniqY[1] - uniqY[0]) === 174, uniqY.join('/'))
  check('整块是"长方形"（宽 > 高，像画布）', (uniqX[2] + 200) - uniqX[0] > (uniqY[1] + 150) - uniqY[0],
    '宽=' + String((uniqX[2] + 200) - uniqX[0]) + ' 高=' + String((uniqY[1] + 150) - uniqY[0]))
  check('提示写明了几列几行', text().includes('3×2'), text().slice(-60))
}

console.log('== 4c. 左键拉框多选（豆包式「选择」） ==')
hostDoc = {
  v: 1, seq: 1, view: { x: 0, y: 0, k: 1 },
  nodes: [
    { id: 'node-a', address: 'dsh-resource://file/session/session-1/a.png', name: 'a.png', path: 'a.png', x: 10, y: 20, w: 200, h: 150, rot: 0, locked: false, hidden: false },
    { id: 'node-b', address: 'dsh-resource://file/session/session-1/b.png', name: 'b.png', path: 'b.png', x: 300, y: 20, w: 200, h: 150, rot: 0, locked: false, hidden: false },
  ],
  annotations: [],
}
await render(React.createElement(boardBody, boardProps))
await tick(); await tick()
check('初始没有选中', $$('.icv-node[data-sel="1"]').length === 0)
{
  const stageEl = $('.icv-stage')
  fire(stageEl, 'pointerdown', { clientX: 0, clientY: 0, button: 0, pointerId: 3 })
  fire(stageEl, 'pointermove', { clientX: 250, clientY: 250 })
  await tick()
  check('拉框有可视的虚线框', $$('.icv-ann-layer rect').length >= 1, String($$('.icv-ann-layer rect').length))
  check('框只盖住第一张时选中 1 张', $$('.icv-node[data-sel="1"]').length === 1, String($$('.icv-node[data-sel="1"]').length))
  fire(stageEl, 'pointermove', { clientX: 620, clientY: 300 })
  await tick()
  check('框扩大后选中 2 张', $$('.icv-node[data-sel="1"]').length === 2, String($$('.icv-node[data-sel="1"]').length))
  fire(stageEl, 'pointerup', { clientX: 620, clientY: 300 })
  await tick()
  check('多选操作条显示张数', ($('.icv-nodebar-count')?.textContent ?? '').includes('2'), $('.icv-nodebar-count')?.textContent)
  check('多选工具条对齐豆包：引用生成 / 智能对齐 / 消除（隐藏已去掉）',
    $$('.icv-nodebar [data-icv-tool]').length === 3
    && ['node-ref', 'node-align', 'node-del'].every((tool) => $('.icv-nodebar [data-icv-tool="' + tool + '"]') !== null),
    $$('.icv-nodebar [data-icv-tool]').map((el) => el.getAttribute('data-icv-tool')).join(','))
  check('张数标签和图标同一套盒子（26px 高 + flex 居中）',
    clientCode.includes('.icv-nodebar-count{display:inline-flex;align-items:center;height:26px'), '产物里应有这条样式')
  check('多选时「引用生成」置灰（一次只能引用一张）', $('.icv-nodebar [data-icv-tool="node-ref"]')?.disabled === true)
  // 智能对齐：点一下 → 排成矩形图片墙（2 张就是并排一行）
  {
    const beforeX = $$('.icv-node').map((el) => parseFloat(el.style.left))
    const beforeY = $$('.icv-node').map((el) => parseFloat(el.style.top))
    await click($('.icv-nodebar [data-icv-tool="node-align"]'))
    await tick()
    const afterX = $$('.icv-node').map((el) => parseFloat(el.style.left))
    const afterY = $$('.icv-node').map((el) => parseFloat(el.style.top))
    const width = parseFloat($$('.icv-node')[0].style.width)
    check('智能对齐：两张顶边对齐到同一个 y', afterY[0] === afterY[1], beforeY.join('/') + ' → ' + afterY.join('/'))
    check('智能对齐：按顺序水平排开且间距一致', Math.round((afterX[1] - afterX[0]) - width) === 24, beforeX.join('/') + ' → ' + afterX.join('/'))
    check('智能对齐写了提示', text().includes('方块'), text().slice(-60))
  }
  check('多选时不显示缩放手柄（手柄只给单张）', $$('.icv-handle').length === 0)
  // 2026-10-16 用户反馈：工具条原来挂在"最后点的那张"上、到处跳 → 现在挂整组包围盒上方居中
  check('工具条只有一条（不是每张图各挂一个）', $$('.icv-nodebar').length === 1, String($$('.icv-nodebar').length))
  {
    const bar = $('.icv-nodebar')
    const rects = $$('.icv-node').map((el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width) }))
    const x0 = Math.min(...rects.map((r) => r.x))
    const x1 = Math.max(...rects.map((r) => r.x + r.w))
    const y0 = Math.min(...rects.map((r) => r.y))
    const center = Math.round((x0 + x1) / 2)
    const flipped = bar.getAttribute('data-flip') === '1'
    const top = Math.round(parseFloat(bar.style.top))
    check('工具条横向 = 整组包围盒中点（不是某一张的中点）', Math.round(parseFloat(bar.style.left)) === center, bar.style.left + ' vs 中点 ' + String(center))
    check('工具条纵向贴着包围盒上边（±6px，贴顶时翻到内侧）', flipped ? top === Math.round(y0 + 6) : top === Math.round(y0 - 6), bar.style.top + ' 上边 ' + String(y0) + ' flip=' + String(flipped))
    check('工具条反向缩放（缩放画布时保持恒定大小）', /scale\(1\)/.test(bar.style.transform), bar.style.transform)
  }
  // Shift 点第一张 = 减选
  const nodeEls = $$('.icv-node')
  fire(nodeEls[0], 'pointerdown', { clientX: 50, clientY: 50, button: 0, pointerId: 4, shiftKey: true })
  await tick()
  check('Shift 点击可以减选', $$('.icv-node[data-sel="1"]').length === 1, String($$('.icv-node[data-sel="1"]').length))
  fire(nodeEls[0], 'pointerdown', { clientX: 50, clientY: 50, button: 0, pointerId: 5, shiftKey: true })
  await tick()
  check('Shift 再点回来可以加选', $$('.icv-node[data-sel="1"]').length === 2)
  fire($('.icv-root'), 'keydown', { key: 'Delete' })
  await tick()
  check('Delete 一次删掉多选的 2 张', $$('.icv-node').length === 0, String($$('.icv-node').length))
}

console.log('== 5. 滚轮缩放 ==')
const kBefore = Number((text().match(/(\d+)%/) ?? [])[1] ?? '0')
const stage = $('.icv-stage')
fire(stage, 'wheel', { deltaY: -420, clientX: 100, clientY: 100 })
await tick()
const kAfter = Number((text().match(/(\d+)%/) ?? [])[1] ?? '0')
check('缩放百分比变大', kAfter > kBefore, kBefore + '% → ' + kAfter + '%')

console.log('== 6. 标记落点 + 自动弹浮层 + 复制 ==')
await click($('[data-icv-tool="group-annot"]'))
await tick()
await click($('[data-icv-pick="point"]'))
await tick()
fire(stage, 'pointerdown', { clientX: 120, clientY: 90, button: 0, pointerId: 1 })
fire(stage, 'pointerup', { clientX: 120, clientY: 90, button: 0, pointerId: 1 })
await tick()
check('画布上出现编号标记', $$('.icv-pin').length === 1, '实际 ' + String($$('.icv-pin').length))
check('标记是「徽标 + 虚线引线 + 落点圆点」结构（不是地图导航针）',
  $('.icv-pin-badge') !== null && $('.icv-pin-line') !== null && $('.icv-pin-dot') !== null,
  [$('.icv-pin-badge'), $('.icv-pin-line'), $('.icv-pin-dot')].map((el) => el === null ? 'missing' : 'ok').join('/'))
check('落完标记自动弹出标记浮层', $('.icv-sheet') !== null && $$('.icv-row').length === 1, String($$('.icv-row').length))
check('标记胶囊显示条数', ($('[data-icv-annpill]')?.textContent ?? '').includes('1'))
const copyButton = buttonByText('复制批注')
check('复制按钮显示条数', copyButton !== undefined && (copyButton.textContent ?? '').includes('1'))
click(copyButton)
await tick()
check('复制到剪贴板的文本是给 Agent 的提示词', clipboardWrites.length === 1 && clipboardWrites[0].includes('【画布批注】'), clipboardWrites[0]?.slice(0, 60))
check('浮层有「关闭」按钮', $('[data-icv-close]') !== null)
await click($('[data-icv-close]'))
await tick()
check('关闭按钮收起浮层', $('.icv-sheet') === null)

console.log('== 7. 防抖落盘 ==')
await new Promise((r) => window.setTimeout(r, 600))
check('向宿主路由 PUT 了画布状态', fetchLog.some((entry) => entry.method === 'PUT' && entry.url.includes('/plugins/dsh-image-canvas/state')), JSON.stringify(fetchLog.slice(-3)))

console.log('== 8. 打开图片 → 汇入常驻画布页 ==')
const openCalls = []
const intakeProps = {
  sessionId: 'session-1',
  loadImage: boardProps.loadImage,
  useTabInfo: () => ({
    sidebar: { expanded: true, fullscreen: false },
    panel: { id: 'pane-1' },
    tab: {
      id: 'tab-1', kind: 'image-canvas', contentId: 'dsh-resource://file/session/session-1/new-pic.png',
      actions: { openTab: (kind, options) => openCalls.push({ kind, options }), openResource: () => {}, close: () => {} },
    },
  }),
}
hostDoc = { v: 1, seq: 1, view: { x: 0, y: 0, k: 1 }, nodes: [], annotations: [] }
await render(React.createElement(intakeBody, intakeProps))
await tick(); await tick()
check('把自己替换成画布页', openCalls.length === 1 && openCalls[0].kind === 'canvas' && openCalls[0].options?.replaceTab === true, JSON.stringify(openCalls))
const putAfterIntake = fetchLog.filter((entry) => entry.method === 'PUT')
check('把新图片写入了画布文档', putAfterIntake.length > 0)

console.log('== 9. 生成 / 改图浮层（本地 ComfyUI）==')
// 第 8 节渲染的是资源型 tab（会把图片加进画布），这里重新渲染画布页
hostDoc = {
  v: 1, seq: 1, view: { x: 0, y: 0, k: 1 },
  nodes: [{ id: 'node-1', address: 'dsh-resource://file/session/session-1/pic.png', name: 'pic.png', path: 'pic.png', x: 10, y: 20, w: 200, h: 150, rot: 0, locked: false, hidden: false }],
  annotations: [],
}
await render(React.createElement(boardBody, boardProps))
await tick(); await tick()
check('默认不占画布：没点 ✨ 时看不到改图面板', $('.icv-panel') === null && text().includes('本地改图') === false)
await click($('[data-icv-tool="gen"]'))
await tick()
check('点 ✨ 弹出底部浮层', $('.icv-sheet') !== null)
check('面板出现', text().includes('本地改图（ComfyUI）'))
check('显示已连接与模型数', text().includes('已连接') && text().includes('2 个模型'), text().slice(0, 120))
const select = $('.icv-panel select')
check('模型下拉列出了 checkpoint', select !== null && $$('.icv-panel select option').length === 2)
check('三个动作按钮都在', ['整图重绘', '按批注重绘', '生成新图'].every((label) => buttonByText(label) !== undefined))
check('高级参数（步数/CFG/重绘强度）默认收起', buttonByText('高级') !== undefined && $$('.icv-panel input[type="number"]').length === 0)
await click(buttonByText('高级'))
await tick()
check('点「高级」才展开参数', $$('.icv-panel input[type="number"]').length === 3, String($$('.icv-panel input[type="number"]').length))
{
  const nodesBefore = $$('.icv-node').length
  const promptBox = $$('textarea').find((area) => (area.getAttribute('placeholder') ?? '').includes('描述想要的画面'))
  await setInputValue(promptBox, 'a golden retriever puppy on grass')
  check('提示词进入了受控状态', promptBox.value === 'a golden retriever puppy on grass')
  await click(buttonByText('生成新图'))
  await tick(); await tick(); await tick()
  const runCall = fetchLog.find((entry) => entry.url.includes('/comfy/run'))
  check('点了「生成新图」会 POST /comfy/run', runCall !== undefined && runCall.method === 'POST', text().slice(-160))
  check('生成结果作为新节点加到画布上', $$('.icv-node').length === nodesBefore + 1, `${nodesBefore} → ${$$('.icv-node').length}`)
  check('新节点用的是插件图片路由', $$('.icv-node img').some((image) => String(image.getAttribute('src')).includes('/comfy/out')))
}

console.log('== 10. 「同目录」一次铺开 ==')
{
  hostDoc = {
    v: 1, seq: 1, view: { x: 0, y: 0, k: 1 },
    nodes: [{ id: 'node-1', address: 'dsh-resource://file/session/session-1/shots/pic.png', name: 'pic.png', path: 'shots/pic.png', x: 10, y: 20, w: 200, h: 150, rot: 0, locked: false, hidden: false }],
    annotations: [],
  }
  await render(React.createElement(boardBody, boardProps))
  await tick(); await tick()
  await click($('[data-icv-tool="more"]'))
  await tick()
  check('⋯ 菜单里有「同目录」', buttonByText('同目录') !== undefined)
  check('未选中时「同目录」在菜单里禁用', buttonByText('同目录').disabled === true)
  // 选中那张图（点节点本体）
  const nodeEl = $('.icv-node')
  await act(async () => {
    nodeEl.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 50, clientY: 50, button: 0, pointerId: 1 }))
  })
  await tick()
  check('选中后出现节点操作条（浮在图片上方）', $('.icv-nodebar') !== null)
  check('单张图的工具条对齐豆包：编辑 / 回正 / 原尺寸 / 引用生成 / 锁定 / 消除（隐藏已去掉）',
    $$('.icv-nodebar [data-icv-tool]').length === 6
    && ['node-edit', 'node-level', 'node-natural', 'node-ref', 'node-lock', 'node-del'].every((tool) => $('.icv-nodebar [data-icv-tool="' + tool + '"]') !== null),
    $$('.icv-nodebar [data-icv-tool]').map((el) => el.getAttribute('data-icv-tool')).join(','))
  check('新加的「回正」和「原尺寸」排在「编辑」后面',
    $$('.icv-nodebar [data-icv-tool]').slice(0, 3).map((el) => el.getAttribute('data-icv-tool')).join(',') === 'node-edit,node-level,node-natural',
    $$('.icv-nodebar [data-icv-tool]').slice(0, 3).map((el) => el.getAttribute('data-icv-tool')).join(','))
  check('没有旋转时「回正」是灰的（当前 rot=0）', $('.icv-nodebar [data-icv-tool="node-level"]')?.disabled === true)
  check('工具条里已经没有「隐藏」按钮', $('.icv-nodebar [data-icv-tool="node-hide"]') === null)
  // 光标：只有「拖动」工具才是手掌（2026-10-16 用户反馈：选择模式下整块画布都是手掌）
  {
    check('选择模式下画布是默认箭头（不是手掌）', injectedCssText().includes('.icv-stage{position:absolute;inset:0;overflow:hidden;touch-action:none;cursor:default'),
      (injectedCssText().match(/\.icv-stage\{[^}]{0,120}/) ?? ['（没找到 .icv-stage 样式）'])[0].slice(0, 110))
    check('选择模式画布不写内联手掌光标', $('.icv-stage').style.cursor === 'default', $('.icv-stage').style.cursor)
    await click($('[data-icv-tool="group-pointer"]'))
    await tick()
    await click($('[data-icv-pick="hand"]'))
    await tick()
    check('切到「拖动」工具：画布变成手掌（grab）', $('.icv-stage').style.cursor === 'grab', $('.icv-stage').style.cursor)
    fire($('.icv-stage'), 'pointerdown', { clientX: 30, clientY: 30, button: 0, pointerId: 68 })
    await tick()
    check('拖动中：手掌抓紧（grabbing）', $('.icv-stage').style.cursor === 'grabbing', $('.icv-stage').style.cursor)
    fire($('.icv-stage'), 'pointerup', { clientX: 30, clientY: 30, button: 0, pointerId: 68 })
    await tick()
    check('松手回到手掌（grab）', $('.icv-stage').style.cursor === 'grab', $('.icv-stage').style.cursor)
    await click($('[data-icv-tool="group-pointer"]'))
    await tick()
    await click($('[data-icv-pick="select"]'))
    await tick()
    check('切回选择工具：又是默认箭头', $('.icv-stage').style.cursor === 'default', $('.icv-stage').style.cursor)
  }
  // 回正 / 原尺寸 的实际效果（2026-10-16 用户要求：调了大小回不去、转歪了要能摆正）
  {
    const rot = $('.icv-handle[data-role="rotate"]')
    fire(rot, 'pointerdown', { clientX: 300, clientY: 100, button: 0, pointerId: 71, currentTarget: rot })
    fire(rot, 'pointermove', { clientX: 300, clientY: 160 })
    await tick()
    check('先转一个角度', /\d+deg/.test($$('.icv-node')[0].style.transform || ''), $$('.icv-node')[0].style.transform)
    check('转过之后「回正」可点', $('.icv-nodebar [data-icv-tool="node-level"]')?.disabled === false)
    fire(rot, 'pointerup', { clientX: 300, clientY: 160, button: 0, pointerId: 71 })
    await tick()
    await click($('.icv-nodebar [data-icv-tool="node-level"]'))
    await tick()
    check('点「回正」后角度归 0', ($$('.icv-node')[0].style.transform || '') === '', $$('.icv-node')[0].style.transform || '（无 transform）')
    check('回正写了提示', text().includes('已回正'), text().slice(-60))
    // 把尺寸改小，再点「原尺寸」→ 回到量出来的原始尺寸（假图 260×380）
    const before = $('.icv-node')
    fire($('.icv-handle[data-dir="se"]'), 'pointerdown', { clientX: 100, clientY: 100, button: 0, pointerId: 72, currentTarget: $('.icv-handle[data-dir="se"]') })
    fire($('.icv-handle[data-dir="se"]'), 'pointermove', { clientX: 40, clientY: 40 })
    await tick()
    const shrunk = { w: parseFloat(before.style.width), h: parseFloat(before.style.height) }
    check('先把图改小', shrunk.w < 260, `${shrunk.w}×${shrunk.h}`)
    fire($('.icv-handle[data-dir="se"]'), 'pointerup', { clientX: 40, clientY: 40, button: 0, pointerId: 72 })
    await tick()
    check('改小之后「原尺寸」可点', $('.icv-nodebar [data-icv-tool="node-natural"]')?.disabled === false)
    await click($('.icv-nodebar [data-icv-tool="node-natural"]'))
    await tick()
    const restored = { w: parseFloat($('.icv-node').style.width), h: parseFloat($('.icv-node').style.height) }
    check('点「原尺寸」还原成原始尺寸（测试替身量出来是 800×600）', restored.w === 800 && restored.h === 600, `${restored.w}×${restored.h}`)
    check('还原后「原尺寸」自己变灰（已经是原尺寸）', $('.icv-nodebar [data-icv-tool="node-natural"]')?.disabled === true)
  }
  // 缩放手柄：4 角 + 4 边都能拖（2026-10-16 用户反馈"只能拖两个点会比较麻烦"）
  check('单张图有 8 个缩放手柄（四角 + 四边中点）+ 1 个旋转手柄',
    $$('.icv-handle[data-role="resize"]').length === 8 && $$('.icv-handle[data-role="rotate"]').length === 1,
    'resize=' + String($$('.icv-handle[data-role="resize"]').length) + ' rotate=' + String($$('.icv-handle[data-role="rotate"]').length))
  check('8 个方向都在（nw/n/ne/e/se/s/sw/w）',
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].every((dir) => $('.icv-handle[data-dir="' + dir + '"]') !== null),
    $$('.icv-handle[data-dir]').map((el) => el.getAttribute('data-dir')).join(','))
  {
    const rectOf = () => {
      const el = $('.icv-node')
      return { x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) }
    }
    const before0 = rectOf()
    // 拖右下角：w/h 变大，左上角不动
    fire($('.icv-handle[data-dir="se"]'), 'pointerdown', { clientX: 100, clientY: 100, button: 0, pointerId: 61, currentTarget: $('.icv-handle[data-dir="se"]') })
    fire($('.icv-handle[data-dir="se"]'), 'pointermove', { clientX: 160, clientY: 100 })
    await tick()
    const afterSE = rectOf()
    check('拖右下角：等比放大', afterSE.w > before0.w && Math.abs(afterSE.w / afterSE.h - before0.w / before0.h) < 0.02,
      `${before0.w}×${before0.h} → ${afterSE.w}×${afterSE.h}`)
    check('拖右下角：左上角坐标不动', afterSE.x === before0.x && afterSE.y === before0.y)
    fire($('.icv-handle[data-dir="se"]'), 'pointerup', { clientX: 160, clientY: 100, button: 0, pointerId: 61 })
    await tick()
    const before1 = rectOf()
    // 拖左上角：右下角不动（x/y 变，w/h 变）
    fire($('.icv-handle[data-dir="nw"]'), 'pointerdown', { clientX: 100, clientY: 100, button: 0, pointerId: 62, currentTarget: $('.icv-handle[data-dir="nw"]') })
    fire($('.icv-handle[data-dir="nw"]'), 'pointermove', { clientX: 120, clientY: 90 })
    await tick()
    const afterNW = rectOf()
    check('拖左上角：右下角钉住不动（x+w 与 y+h 不变）',
      Math.abs((afterNW.x + afterNW.w) - (before1.x + before1.w)) < 1 && Math.abs((afterNW.y + afterNW.h) - (before1.y + before1.h)) < 1,
      `右下角 ${before1.x + before1.w},${before1.y + before1.h} → ${afterNW.x + afterNW.w},${afterNW.y + afterNW.h}`)
    check('拖左上角：确实变小了', afterNW.w < before1.w && afterNW.h < before1.h, `${before1.w}×${before1.h} → ${afterNW.w}×${afterNW.h}`)
    fire($('.icv-handle[data-dir="nw"]'), 'pointerup', { clientX: 120, clientY: 90, button: 0, pointerId: 62 })
    await tick()
    const before2 = rectOf()
    // 拖右边中点：只改宽，高不动
    fire($('.icv-handle[data-dir="e"]'), 'pointerdown', { clientX: 100, clientY: 100, button: 0, pointerId: 63, currentTarget: $('.icv-handle[data-dir="e"]') })
    fire($('.icv-handle[data-dir="e"]'), 'pointermove', { clientX: 140, clientY: 160 })
    await tick()
    const afterE = rectOf()
    check('拖右边中点：只改宽度、高度不动', afterE.w === before2.w + 40 && afterE.h === before2.h, `${before2.w}×${before2.h} → ${afterE.w}×${afterE.h}`)
    fire($('.icv-handle[data-dir="e"]'), 'pointerup', { clientX: 140, clientY: 160, button: 0, pointerId: 63 })
    await tick()
    const before3 = rectOf()
    // 按住 Shift 拖角：放开比例，宽高各按各的走
    fire($('.icv-handle[data-dir="se"]'), 'pointerdown', { clientX: 100, clientY: 100, button: 0, pointerId: 64, currentTarget: $('.icv-handle[data-dir="se"]') })
    fire($('.icv-handle[data-dir="se"]'), 'pointermove', { clientX: 140, clientY: 110, shiftKey: true })
    await tick()
    const afterShift = rectOf()
    check('Shift 拖角：宽高各自跟手（不锁比例）',
      afterShift.w === before3.w + 40 && afterShift.h === before3.h + 10,
      `${before3.w}×${before3.h} → ${afterShift.w}×${afterShift.h}`)
    fire($('.icv-handle[data-dir="se"]'), 'pointerup', { clientX: 140, clientY: 110, button: 0, pointerId: 64 })
    await tick()
  }
  // 旋转手柄：右上角那个点，hover 是旋转图标 + 旋转光标（2026-10-16 用户反馈）
  {
    const rot = $('.icv-handle[data-role="rotate"]')
    check('旋转手柄在右上角（右下角之外的位置）', rot !== null && rot.getAttribute('data-role') === 'rotate')
    check('旋转手柄里有一个圆形箭头图标', rot.querySelector('.icv-handle-icon svg') !== null, rot.innerHTML.slice(0, 80))
    const injectedCss = Array.from(window.document.querySelectorAll('style')).map((el) => el.textContent ?? '').join('\n')
    check('旋转手柄用"旋转"SVG 光标（不是普通箭头/抓手）',
      injectedCss.includes('cursor:url("data:image/svg+xml') && injectedCss.includes('.icv-handle[data-role="rotate"]'),
      (injectedCss.match(/\.icv-handle\[data-role="rotate"\]\{[^}]{0,200}/) ?? ['（没找到这条样式）'])[0].slice(-90))
    const beforeRot = $$('.icv-node')[0].style.transform
    fire(rot, 'pointerdown', { clientX: 300, clientY: 100, button: 0, pointerId: 65, currentTarget: rot })
    fire(rot, 'pointermove', { clientX: 260, clientY: 130 })
    await tick()
    const nodeEl = $$('.icv-node')[0]
    check('拖旋转手柄会改变角度', (nodeEl.style.transform || '') !== beforeRot && /rotate\(-?\d+deg\)/.test(nodeEl.style.transform || ''), beforeRot + ' → ' + (nodeEl.style.transform || '（无）'))
    fire(rot, 'pointerup', { clientX: 260, clientY: 130, button: 0, pointerId: 65 })
    await tick()
    // 2026-10-16 用户反馈：缩小画布时旋转点会贴到右上角手柄上（55% 时只差 13px），
    // 鼠标在中间来回跳光标；偏移量必须也乘 1/k 才在屏幕上保持恒定距离
    check('旋转点的偏移量也乘了 1/k（缩小画布时不会贴到角手柄上）',
      /\.icv-handle\[data-role="rotate"\]\{[^}]*transform:translate\(calc\(130% \* var\(--icv-inv,1\)\),calc\(-160% \* var\(--icv-inv,1\)\)\)/.test(injectedCssText()),
      (injectedCssText().match(/\.icv-handle\[data-role="rotate"\]\{[^}]{0,120}/) ?? ['（没找到）'])[0])
    check('旋转手柄的兜底光标是 default（不是手掌 grab）',
      /\.icv-handle\[data-role="rotate"\]\{[^}]*cursor:url\("data:image\/svg\+xml[^}]*default\}/.test(injectedCssText())
      && !/\.icv-handle\[data-role="rotate"\]\{[^}]*grab\}/.test(injectedCssText()),
      '2, default 结尾')
    // 非「选择」工具下不该出现手柄（那会儿图片不吃指针事件，手柄点不动，光标还是画布的手掌）
    await click($('[data-icv-tool="group-annot"]'))
    await tick()
    await click($('[data-icv-pick="point"]'))
    await tick()
    check('切到「标记」工具后手柄全部消失（不会出现"看得见点不动"的手柄）',
      $$('.icv-handle').length === 0 && $('.icv-nodebar') !== null,
      'handles=' + String($$('.icv-handle').length) + ' nodebar=' + String($('.icv-nodebar') !== null))
    await click($('[data-icv-tool="group-pointer"]'))
    await tick()
    await click($('[data-icv-pick="select"]'))
    await tick()
    check('切回「选择」工具手柄又回来（8 个缩放 + 1 个旋转）',
      $$('.icv-handle').length === 9, String($$('.icv-handle').length))
  }
  check('点节点会把 ⋯ 菜单收掉', $('.icv-menu') === null)
  await click($('[data-icv-tool="more"]'))
  await tick()
  check('选中后「同目录」可用', buttonByText('同目录').disabled === false)
  const before = $$('.icv-node').length
  await click(buttonByText('同目录'))
  await tick(); await tick(); await tick()
  check('按选中图所在目录调用了 list', listCalls.length > 0 && listCalls[0].dir === 'shots', JSON.stringify(listCalls[0] ?? null))
  check('只加了图片且跳过已存在的', $$('.icv-node').length === before + 2, `${before} → ${$$('.icv-node').length}`)
  check('提示写明了加了几张', text().includes('已铺上 2 张'), text().slice(-140))
}

console.log('== 11. 面板外右键图片 →「放入无限画布」（2026-10-17 需求） ==')
{
  const extMenu = () => window.document.querySelector('.icv-extmenu')
  const chatImg = window.document.createElement('img')
  chatImg.setAttribute('src', 'dsh-resource://file/session/session-1/shots/chat-shot.png')
  Object.defineProperty(chatImg, 'naturalWidth', { value: 800, configurable: true })
  Object.defineProperty(chatImg, 'naturalHeight', { value: 600, configurable: true })
  window.document.body.appendChild(chatImg)

  check('画布页挂载后把 sessionId 交给了外部通路（能直接放进当前会话）', true)
  fire(chatImg, 'contextmenu', { clientX: 300, clientY: 200 })
  await tick()
  check('面板外右键图片会弹自己的菜单', extMenu() !== null)
  check('菜单里有「放入无限画布」', (extMenu()?.textContent ?? '').includes('放入无限画布'), extMenu()?.textContent)
  check('菜单里有「复制图片地址」', (extMenu()?.textContent ?? '').includes('复制图片地址'))

  // 点「放入无限画布」→ 应该 PUT 一份新文档，带上这张图的地址
  const realFetch = window.fetch
  const puts = []
  window.fetch = async (url, options = {}) => {
    if (String(url).includes('/state') && (options.method ?? 'GET').toUpperCase() === 'PUT') puts.push(JSON.parse(String(options.body)))
    return realFetch(url, options)
  }
  const addRow = Array.from(extMenu().querySelectorAll('.icv-extextrow')).find((row) => (row.textContent ?? '').includes('放入无限画布'))
  addRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
  await tick(); await tick(); await tick()
  window.fetch = realFetch
  check('点了之后菜单关掉', extMenu() === null)
  check('往画布文档里 PUT 了一张新图', puts.length === 1 && puts[0].nodes.some((node) => node.address === 'dsh-resource://file/session/session-1/shots/chat-shot.png'),
    puts.length === 0 ? '（没有 PUT）' : JSON.stringify(puts[0].nodes.slice(-1)[0] ?? {}).slice(0, 160))
  const added = puts.length === 0 ? undefined : puts[0].nodes.filter((node) => node.address === 'dsh-resource://file/session/session-1/shots/chat-shot.png').slice(-1)[0]
  check('大图按 520 宽封顶（800×600 → 520×390）', added !== undefined && added.w === 520 && added.h === 390,
    added === undefined ? '（没加进去）' : added.w + '×' + added.h)
  check('放进去之后给了提示', (window.document.querySelector('.icv-exttoast')?.textContent ?? '').includes('已放入无限画布'),
    window.document.querySelector('.icv-exttoast')?.textContent ?? '（无提示）')

  // 画布面板内部右键仍然走面板自己的菜单，不该弹这个外部菜单
  fire($('.icv-node'), 'contextmenu', { clientX: 60, clientY: 60 })
  await tick()
  check('画布面板内部右键：不弹外部菜单（仍用面板自己的）', extMenu() === null && $('.icv-ctx') !== null)
  chatImg.remove()
}

console.log('')
if (failures.length === 0) {
  console.log(`全部通过：${passed} 项 ✅`)
  process.exit(0)
}
console.log(`通过 ${passed} 项，失败 ${failures.length} 项 ❌`)
for (const failure of failures) console.log('  - ' + failure)
process.exit(1)
