/**
 * 生成物 —— 不要手改。源码在 lib/client.body.js，改完跑：node tools/build-client.mjs
 * 包名 dsh-image-canvas 必须与 __ModuleLoader__.load({ id }) 以及 profile 里的 loader 行一致。
 */
window.__ModuleLoader__.load({
	id: "dsh-image-canvas",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		/**
		 * dsh-image-canvas —— 浏览器半边（可读源码；产物是 lib/client.js，由 tools/build-client.mjs 生成）。
		 *
		 * 做三件事：
		 *   1) 往右侧栏注册两个 tab 类型：
		 *        · 资源型 `image-canvas`：认领 dsh-resource://file/** 里的图片 → 打开图片时把图收进画布，
		 *          然后把自己换成那一张常驻的「无限画布」页（同格内页 tab 会去重 → 所有图最终汇到同一张画布）。
		 *        · 页型 `canvas`：无限画布本体（平移/缩放、拖动/缩放/旋转/隐藏/锁定、撤销重做、批注、导出 PNG）。
		 *   2) 画布文档按会话持久化：优先写宿主路由 /plugins/dsh-image-canvas/state，失败回落 localStorage。
		 *   3) 批注（点/框选/涂抹）可一键复制成给 Agent 的提示词 —— 不调用任何外部 AI 服务。
		 *
		 * 形态约束（浏览器侧加载器只认这个）：
		 *   - 必须是 CJS：require / module.exports；不能有 ESM import/export（构建闸门会拦）。
		 *   - 只能 require 平台模块表里的包：react / react-dom / @deepseek-ai/cordis / …；本文件只用了 react。
		 */
		const React = require('react')

		const h = React.createElement
		const { useCallback, useEffect, useMemo, useRef, useState } = React

		/** 本插件包名（= profile loader 行 = __ModuleLoader__ 注册 id）。 */
		const PKG = 'dsh-image-canvas'
		const PAGE_ID = PKG
		const PAGE_KIND = 'canvas'
		const IMAGE_ID = PKG + ':image'
		const IMAGE_KIND = 'image-canvas'
		const ROUTE = '/plugins/' + PKG
		const DOC_VERSION = 1

		/**
		 * 画布认领的图片扩展名（2026-10-21 扩展）。
		 * 前半段是**浏览器能直接解码**的格式，直接 Blob 显示；
		 * tif/tiff 浏览器解不了，由宿主半边用 sharp 转成 PNG 再显示。
		 * 注意：heic/heif 不在列表里 —— DSH 自带 libvips 没编 HEVC 解码器（实测 2026-10-21），
		 * 解不了就别假装支持；误标成 .png 的 HEIC 会在下面 sniff 出来后给人话报错。
		 */
		const IMAGE_EXT = [
		  'png', 'jpg', 'jpeg', 'jfif', 'jpe', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif', 'apng',
		  'tif', 'tiff',
		]
		const MEDIA = {
		  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', jpe: 'image/jpeg',
		  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
		  avif: 'image/avif', apng: 'image/apng', tif: 'image/tiff', tiff: 'image/tiff',
		}
		/** 浏览器（Chromium）自己就能解码的格式：按**文件头**判断，不信扩展名。 */
		const BROWSER_IMAGE_FORMATS = ['png', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif']
		/** 需要宿主 sharp 转码的扩展名（只用于 tab 认领/文案，实际以文件头为准）。 */
		const CONVERT_IMAGE_EXT = ['tif', 'tiff']

		/**
		 * 画布认领的 3D 模型扩展名（2026-10-28 新增）。
		 * 这些文件不会进 <img>，而是交给 vendor/viewer.js 里的 three.js 渲染（可旋转/缩放/平移）。
		 * 不收 .blend（Blender 私有格式，浏览器端没有解码器）—— 想看 .blend 先用 Blender 导出 glb。
		 */
		const MODEL_EXT = ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply']
		/** 资源 tab 类型（与 image 并列，各自 canOpen 认自己的扩展名）。 */
		const MODEL_KIND = 'model-3d'
		const MODEL_ID = PKG + ':model'
		/** 单个模型字节上限：官方 readBytes 整文件上限 32 MiB，这里按分块读放宽到 96 MiB。 */
		const MODEL_BYTES_LIMIT = 96 * 1024 * 1024
		/** 3D 运行时（ES 模块）的地址：由宿主半边的 prefix 路由发出去。 */
		const VIEWER_URL = ROUTE + '/vendor/viewer.js'

		/** 是否是本插件认领的 3D 模型。 */
		function isModelPath(path) {
		  return MODEL_EXT.indexOf(extOf(path)) !== -1
		}

		/** 节点是不是 3D 节点（老文档没有 kind 字段 → 一律当图片）。 */
		function isModelNode(node) {
		  return node !== null && node !== undefined && node.kind === 'model'
		}


		/**
		 * 配色：**跟随系统**（prefers-color-scheme）。
		 * 这里只放变量的引用，真正的色值定义在 CSS 的 .icv-root 里（浅色默认 + 深色媒体查询覆盖），
		 * 这样内联样式和样式表走同一批变量，系统切换主题时即时生效、不需要 JS 监听。
		 */
		const COLORS = {
		  bg: 'var(--icv-bg)', grid: 'var(--icv-grid)', panel: 'var(--icv-panel)', border: 'var(--icv-border)',
		  text: 'var(--icv-text)', dim: 'var(--icv-dim)', accent: 'var(--icv-accent)',
		  danger: 'var(--icv-danger)', ok: 'var(--icv-ok)',
		  input: 'var(--icv-input)', raised: 'var(--icv-raised)', shadow: 'var(--icv-shadow)',
		  overlay: 'var(--icv-overlay)', hover: 'var(--icv-hover)',
		  overlayStrong: 'var(--icv-overlay-strong)', hairline: 'var(--icv-hairline)', ring: 'var(--icv-ring)',
		  warn: 'var(--icv-warn)', warnBg: 'var(--icv-warn-bg)',
		  onBg: 'var(--icv-on-bg)', onBorder: 'var(--icv-on-border)', onText: 'var(--icv-on-text)',
		}

		// ─────────────────────────────────────────── 纯函数工具

		/** 取路径扩展名（小写、不含点）。 */
		function extOf(path) {
		  const name = String(path).replace(/\\/g, '/')
		  const dot = name.lastIndexOf('.')
		  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
		}

		/** 是否是本插件认领的图片。 */
		function isImagePath(path) {
		  return IMAGE_EXT.indexOf(extOf(path)) !== -1
		}

		/** 取最后一段文件名（已解码）。 */
		function basenameOf(address) {
		  const name = String(address).slice(String(address).lastIndexOf('/') + 1)
		  if (name === '') return String(address)
		  try { return decodeURIComponent(name) } catch { return name }
		}

		/**
		 * 解析 dsh-resource://file/<scope>/… 地址（与官方 util 的 parseFileAddress 等价）。
		 * absolute scope 没有 session，读不了字节，所以这里只接受 session scope。
		 */
		function parseFileAddress(address) {
		  const PREFIX = 'dsh-resource://file/'
		  const text = String(address)
		  if (text.indexOf(PREFIX) !== 0) return undefined
		  const cut = text.search(/[?#]/)
		  const parts = text.slice(PREFIX.length, cut === -1 ? undefined : cut).split('/')
		  const scope = parts.shift()
		  if (scope !== 'session') return undefined
		  const sessionId = parts.shift()
		  if (sessionId === undefined || sessionId === '' || parts.length === 0) return undefined
		  return { sessionId: decodeURIComponent(sessionId), path: parts.map(decodeURIComponent).join('/') }
		}

		/** 生成短 id。 */
		function newId(prefix) {
		  return prefix + '-' + Math.random().toString(36).slice(2, 10)
		}

		/** 节点在资源缓存里的键：AI 结果节点用 url，普通节点用资源地址。 */
		function assetKey(node) {
		  return typeof node.url === 'string' && node.url !== '' ? 'url:' + node.url : 'addr:' + String(node.address)
		}

		/** 拉框多选 / 磁吸共用的容差：屏幕像素（换算到世界单位见 computeSnap）。 */
		const SNAP_PX = 7

		/** 缩放手柄的 8 个方向（4 角 + 4 边）。 */
		const RESIZE_DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

		/**
		 * 旋转手柄的鼠标指针：细一点的圆形箭头（Chromium 支持 SVG 光标，末尾 grab 兜底）。
		 * 24px、白色描边打底保证任何背景上都看得清，箭头用近黑而不是高饱和蓝（2026-10-16 用户反馈"有点丑"）。
		 */
		const ROTATE_CURSOR = 'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'24\' height=\'24\' viewBox=\'0 0 24 24\'><g fill=\'none\' stroke-linecap=\'round\'><path d=\'M18.6 8.4A7.4 7.4 0 1 0 20.4 14.1\' stroke=\'%23ffffff\' stroke-width=\'4.2\'/><path d=\'M18.6 8.4A7.4 7.4 0 1 0 20.4 14.1\' stroke=\'%231f2328\' stroke-width=\'1.9\'/><path d=\'M19.4 3.9v4.6h-4.6\' stroke=\'%23ffffff\' stroke-width=\'4.2\'/><path d=\'M19.4 3.9v4.6h-4.6\' stroke=\'%231f2328\' stroke-width=\'1.9\'/></g></svg>") 12 12, default'

		/** 拉框多选：世界坐标里的框与节点矩形相交（AABB 命中，够用且可预测）。 */
		function intersects(box, node) {
		  const x0 = Math.min(box.x0, box.x1)
		  const x1 = Math.max(box.x0, box.x1)
		  const y0 = Math.min(box.y0, box.y1)
		  const y1 = Math.max(box.y0, box.y1)
		  return node.x < x1 && node.x + node.w > x0 && node.y < y1 && node.y + node.h > y0
		}

		/** 右键落点往上找，看点在哪个图片节点上（没点在图上是空串）。 */
		function nodeIdUnder(element) {
		  let el = element
		  for (let depth = 0; depth < 12 && el !== null && el !== undefined; depth++) {
		    if (typeof el.getAttribute === 'function') {
		      const id = el.getAttribute('data-node')
		      if (id !== null && id !== '') return id
		    }
		    el = el.parentElement
		  }
		  return ''
		}

		/** 量一张图的自然尺寸（量不到就给个默认值，不阻塞渲染）。 */
		function measureUrl(url) {
		  return new Promise((resolve) => {
		    const image = new window.Image()
		    image.onload = () => resolve({ w: image.naturalWidth || 600, h: image.naturalHeight || 400 })
		    image.onerror = () => resolve({ w: 600, h: 400 })
		    image.src = url
		  })
		}

		/**
		 * 尽力捕获指针。某些宿主/无头环境没有 setPointerCapture，缺了它不能打断拖拽。
		 * @param element - 目标元素。
		 * @param pointerId - 指针 id。
		 */
		function capturePointer(element, pointerId) {
		  try {
		    if (element !== null && element !== undefined && typeof element.setPointerCapture === 'function') {
		      element.setPointerCapture(pointerId)
		    }
		  } catch { /* 拿不到捕获也能继续拖，只是指针移出元素时会断 */ }
		}

		/** 画布文档的形状（任何字段缺失都能自愈）。 */
		function emptyDoc() {
		  return { v: DOC_VERSION, nodes: [], annotations: [], view: { x: 0, y: 0, k: 1 }, seq: 1 }
		}

		/** 规范化读回来的文档。 */
		function normalizeDoc(raw) {
		  const doc = emptyDoc()
		  if (raw === null || typeof raw !== 'object') return doc
		  if (Array.isArray(raw.nodes)) doc.nodes = raw.nodes.filter((n) => n && typeof n.address === 'string')
		  if (Array.isArray(raw.annotations)) doc.annotations = raw.annotations.filter((a) => a && typeof a.kind === 'string')
		  if (raw.view && typeof raw.view === 'object') {
		    doc.view = { x: Number(raw.view.x) || 0, y: Number(raw.view.y) || 0, k: Number(raw.view.k) || 1 }
		  }
		  const maxSeq = doc.annotations.reduce((max, a) => Math.max(max, Number(a.n) || 0), 0)
		  doc.seq = Math.max(Number(raw.seq) || 1, maxSeq + 1)
		  return doc
		}

		/** localStorage 键。 */
		const THEME_KEY = PKG + ':theme'
		/** 画布配色模式：跟随系统 / 强制浅色 / 强制深色。 */
		const THEME_MODES = ['system', 'light', 'dark']
		const THEME_LABEL = { system: '跟随系统', light: '浅色', dark: '深色' }

		/** localStorage 键。 */
		function lsKey(sessionId) {
		  return PKG + ':' + sessionId
		}

		/** 读文档：宿主路由优先，失败回落 localStorage。 */
		async function loadDoc(sessionId) {
		  try {
		    const response = await fetch(ROUTE + '/state?sessionId=' + encodeURIComponent(sessionId))
		    if (response.ok) {
		      const body = await response.json()
		      if (body && body.ok === true && body.doc !== null && body.doc !== undefined) return normalizeDoc(body.doc)
		    }
		  } catch { /* 宿主路由没挂上（没重启）→ 用本地兜底 */ }
		  try {
		    const text = window.localStorage.getItem(lsKey(sessionId))
		    return text === null ? emptyDoc() : normalizeDoc(JSON.parse(text))
		  } catch { return emptyDoc() }
		}

		/** 保存文档：两边都写（localStorage 立刻、宿主路由异步）。 */
		function saveDoc(sessionId, doc) {
		  try { window.localStorage.setItem(lsKey(sessionId), JSON.stringify(doc)) } catch { /* 配额满就只靠宿主 */ }
		  try {
		    void fetch(ROUTE + '/state?sessionId=' + encodeURIComponent(sessionId), {
		      method: 'PUT',
		      headers: { 'content-type': 'application/json' },
		      body: JSON.stringify(doc),
		    }).catch(() => { /* 宿主不可用时静默 */ })
		  } catch { /* 同上 */ }
		}

		// ─────────────────────────────────────────── 样式（不引 CSS 文件，全部内联/注入）

		const STYLE_ID = PKG + ':style'
		/**
		 * 两套配色变量。
		 * 默认跟随系统（prefers-color-scheme）；工具条的「主题」按钮会用 .icv-root[data-icv-theme] 覆盖它
		 * （属性选择器特异性更高，能压过媒体查询）。
		 * 注意：DSH 自己会把 app 主题同步给 Electron 的 nativeTheme，所以 prefers-color-scheme 反映的是
		 * app 设置而不是操作系统——用户想强制浅色时，用那个按钮。
		 */
		const LIGHT_VARS = [
		  '--icv-bg:#f6f6f7;--icv-grid:rgba(0,0,0,.07);--icv-panel:rgba(255,255,255,.94);--icv-border:rgba(0,0,0,.14)',
		  ';--icv-text:#1b1b1f;--icv-dim:#6b6b73;--icv-accent:#2f6feb;--icv-danger:#d63a3f;--icv-ok:#1c8a5c;--icv-warn:#b26a00',
		  ';--icv-input:rgba(0,0,0,.05);--icv-hover:rgba(0,0,0,.06);--icv-raised:#ffffff;--icv-shadow:rgba(0,0,0,.18)',
		  ';--icv-overlay:rgba(255,255,255,.94);--icv-overlay-strong:rgba(255,255,255,.97)',
		  ';--icv-on-bg:rgba(47,111,235,.14);--icv-on-border:rgba(47,111,235,.55);--icv-on-text:#123f9e',
		  ';--icv-hairline:rgba(0,0,0,.08);--icv-warn-bg:rgba(255,176,32,.18);--icv-ring:#ffffff;--icv-pin:#2f6feb;--icv-pin-ink:#ffffff',
		  ';--icv-3d-bg:#eef1f6', // 浅色主题下 3D 视口用浅灰，模型轮廓更清楚
		].join('')
		const DARK_VARS = [
		  '--icv-bg:#141414;--icv-grid:rgba(255,255,255,.055);--icv-panel:rgba(24,24,26,.92);--icv-border:rgba(255,255,255,.12)',
		  ';--icv-text:#e8e8e8;--icv-dim:#9a9a9a;--icv-accent:#4f8ef7;--icv-danger:#f2555a;--icv-ok:#3ecf8e;--icv-warn:#ffb020',
		  ';--icv-input:rgba(0,0,0,.35);--icv-hover:rgba(255,255,255,.08);--icv-raised:#0f0f10;--icv-shadow:rgba(0,0,0,.45)',
		  ';--icv-overlay:rgba(0,0,0,.72);--icv-overlay-strong:rgba(0,0,0,.8)',
		  ';--icv-on-bg:rgba(79,142,247,.18);--icv-on-border:rgba(79,142,247,.55);--icv-on-text:#cfe0ff',
		  ';--icv-hairline:rgba(255,255,255,.06);--icv-warn-bg:rgba(255,176,32,.16);--icv-ring:#0f0f10;--icv-pin:#4f8ef7;--icv-pin-ink:#0b1220',
		  ';--icv-3d-bg:#0f1115', // 深色主题下 3D 视口用近黑，和画布底色一致
		].join('')
		const THEME_VARS = [
		  '.icv-root{' + LIGHT_VARS + '}',
		  '@media (prefers-color-scheme: dark){.icv-root{' + DARK_VARS + '}}',
		  '.icv-root[data-icv-theme="light"]{' + LIGHT_VARS + '}',
		  '.icv-root[data-icv-theme="dark"]{' + DARK_VARS + '}',
		].join('\n')
		const CSS = [
		  THEME_VARS,
		  '.icv-root{position:absolute;inset:0;background:' + COLORS.bg + ';color:' + COLORS.text + ';font:12px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}',
		  '.icv-btn{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:1px solid transparent;border-radius:6px;background:transparent;color:' + COLORS.text + ';cursor:default;font:inherit;white-space:nowrap}',
		  '.icv-btn:hover{background:' + COLORS.hover + '}',
		  '.icv-btn[data-on="1"]{background:var(--icv-on-bg);border-color:var(--icv-on-border);color:var(--icv-on-text)}',
		  '.icv-btn:disabled{opacity:.38;cursor:default}',
		  // 右下角悬浮工具组：图标按钮，默认无底色，只在 hover / 选中态给反馈（对齐豆包画布的低视觉重量）
		  '.icv-float{position:absolute;right:10px;bottom:10px;display:flex;flex-direction:column;align-items:flex-end;gap:6px;z-index:7}',
		  '.icv-tools{display:flex;align-items:center;gap:2px;padding:3px;border-radius:11px;background:' + COLORS.overlay + ';border:1px solid ' + COLORS.hairline + ';box-shadow:0 6px 20px ' + COLORS.shadow + '}',
		  '.icv-tool{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:none;border-radius:8px;background:transparent;color:' + COLORS.text + ';cursor:default;font:inherit}',
		  '.icv-tool:hover{background:' + COLORS.hover + '}',
		  '.icv-tool[data-on="1"]{background:var(--icv-on-bg);color:var(--icv-on-text)}',
		  '.icv-tool:disabled{opacity:.35;cursor:default}',
		  '.icv-tool-sep{width:1px;height:18px;background:' + COLORS.hairline + ';margin:0 2px}',
		  // 分组按钮右下角的小三角：提示"这里面还有别的工具"（豆包那个也是这个套路）
		  '.icv-group{position:relative;display:inline-flex}',
		  '.icv-tool-more{position:absolute;right:3px;bottom:3px;width:0;height:0;border-left:4px solid transparent;border-bottom:4px solid currentColor;opacity:.42}',
		  // 分组浮层：外层是一条透明"桥"（padding-bottom 把按钮到卡片之间的缝盖住），
		  // 卡片才是看得见的那块。少了这条桥，鼠标从按钮移向卡片时会穿过 7px 空隙 →
		  // wrapper 的 mouseleave 立刻触发 → 浮层"我都没选就消失了"（2026-10-16 用户反馈）
		  '.icv-flyout{position:absolute;left:50%;bottom:100%;transform:translateX(-50%);padding-bottom:10px;z-index:9}',
		  '.icv-flyout-card{min-width:212px;padding:4px;border-radius:10px;background:var(--icv-overlay-strong);border:1px solid ' + COLORS.border + ';box-shadow:0 10px 30px ' + COLORS.shadow + '}',
		  // 浮层开着时工具组会挪到右上角，这时成员浮层改朝下展开（否则会被面板上沿裁掉）
		  '.icv-flyout[data-drop="1"]{bottom:auto;top:100%;padding-bottom:0;padding-top:10px}',
		  '.icv-flyout-row{display:flex;align-items:center;gap:8px;width:100%;height:30px;padding:0 8px;border:none;border-radius:7px;background:transparent;color:' + COLORS.text + ';cursor:default;font:inherit;text-align:left}',
		  '.icv-flyout-row:hover{background:' + COLORS.hover + '}',
		  '.icv-flyout-row[data-on="1"]{background:var(--icv-on-bg);color:var(--icv-on-text)}',
		  '.icv-flyout-label{flex:0 0 auto}',
		  '.icv-flyout-hint{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:' + COLORS.dim + ';font-size:10px}',
		  '.icv-pill{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;border-radius:999px;background:' + COLORS.overlay + ';border:1px solid ' + COLORS.hairline + ';color:' + COLORS.dim + ';font-size:11px;cursor:default;font-family:inherit}',
		  '.icv-pill:hover{color:' + COLORS.text + '}',
		  // ⋯ 菜单
		  '.icv-menu{position:absolute;right:10px;bottom:52px;min-width:186px;padding:4px;border-radius:10px;background:var(--icv-overlay-strong);border:1px solid ' + COLORS.border + ';box-shadow:0 10px 30px ' + COLORS.shadow + ';z-index:8}',
		  '.icv-menu button{display:flex;align-items:center;gap:8px;width:100%;height:28px;padding:0 8px;border:none;border-radius:7px;background:transparent;color:' + COLORS.text + ';cursor:default;font:inherit;text-align:left}',
		  '.icv-menu button:hover{background:' + COLORS.hover + '}',
		  '.icv-menu button:disabled{opacity:.38;cursor:default}',
		  '.icv-menu-sep{height:1px;background:' + COLORS.hairline + ';margin:4px 2px}',
		  '.icv-menu-meta{padding:5px 8px;color:' + COLORS.dim + ';font-size:10px;line-height:1.5;word-break:break-all}',
		  // 右键菜单：跟 ⋯ 菜单同一套皮，只是位置跟着光标走
		  '.icv-ctx{position:absolute;min-width:196px;padding:4px;border-radius:10px;background:var(--icv-overlay-strong);border:1px solid ' + COLORS.border + ';box-shadow:0 10px 30px ' + COLORS.shadow + ';z-index:12}',
		  '.icv-ctx button{display:flex;align-items:center;gap:8px;width:100%;height:28px;padding:0 8px;border:none;border-radius:7px;background:transparent;color:' + COLORS.text + ';cursor:default;font:inherit;text-align:left}',
		  '.icv-ctx button:hover{background:' + COLORS.hover + '}',
		  '.icv-ctx button:disabled{opacity:.38;cursor:default}',
		  // 底部浮层（改图 / 标记）：默认不占画布，按需弹出
		  '.icv-sheet{position:absolute;left:0;right:0;bottom:0;z-index:9;max-height:66%;overflow:auto;padding:8px 10px 10px;border-radius:12px 12px 0 0;border-top:1px solid ' + COLORS.border + ';background:' + COLORS.panel + ';box-shadow:0 -8px 28px ' + COLORS.shadow + '}',
		  '.icv-sheet-head{position:sticky;top:-8px;display:flex;align-items:center;gap:4px;padding:4px 0 6px;background:' + COLORS.panel + '}',
		  '.icv-tab{height:24px;padding:0 10px;border:1px solid transparent;border-radius:999px;background:transparent;color:' + COLORS.dim + ';cursor:default;font:inherit}',
		  '.icv-tab:hover{color:' + COLORS.text + '}',
		  '.icv-tab[data-on="1"]{background:var(--icv-on-bg);border-color:var(--icv-on-border);color:var(--icv-on-text)}',
		  // 选中节点时贴在图片上方的小操作条（跟着节点走，反向缩放保持恒定大小）
		  // 选中工具条：挂在"整个选中区的包围盒"上方居中（豆包那样）。位置与翻转都由 JS 算好写成内联值，
		  // 免得它跟着"最后点的那张图"到处跳（2026-10-16 用户反馈）
		  '.icv-nodebar{position:absolute;padding:2px;border-radius:9px;background:var(--icv-overlay-strong);border:1px solid ' + COLORS.border + ';box-shadow:0 6px 18px ' + COLORS.shadow + ';white-space:nowrap}',
		  '.icv-nodebar .icv-tool{width:26px;height:26px}',
		  // 拖动磁吸参考线：1px 细线（线宽由内联 width/height 按 1/k 反向缩放给出）
		  '.icv-guide{position:absolute;background:' + COLORS.accent + ';opacity:.85;pointer-events:none;z-index:6}',
		  // 张数标签跟图标同一套盒子：同高 26px、flex 居中，不然文字会"飘"在图标上方（2026-10-16 用户反馈）
		  '.icv-nodebar-count{display:inline-flex;align-items:center;height:26px;padding:0 7px 0 5px;font-size:11px;line-height:1;color:' + COLORS.dim + ';white-space:nowrap}',
		  // 画布底布的光标：默认**箭头**，只有「拖动」工具才由内联样式换成手掌（2026-10-16 用户反馈：
		  // 原来这里写死 cursor:grab，选择模式下整块画布都是手掌）
		  '.icv-stage{position:absolute;inset:0;overflow:hidden;touch-action:none;cursor:default;background-image:radial-gradient(' + COLORS.grid + ' 1px,transparent 1px);background-size:24px 24px}',
		  '.icv-stage[data-panning="1"]{cursor:grabbing}',
		  '.icv-world{position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform}',
		  '.icv-node{position:absolute;box-shadow:0 6px 24px ' + COLORS.shadow + ';border-radius:6px;overflow:visible;background:' + COLORS.raised + '}',
		  '.icv-node[data-sel="1"]{outline:1px solid ' + COLORS.accent + ';outline-offset:1px}',
		  '.icv-node img{display:block;width:100%;height:100%;border-radius:6px;object-fit:contain;pointer-events:none;user-select:none}',
		  '.icv-node-label{position:absolute;left:0;top:-16px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:' + COLORS.dim + ';font-size:10px}',
		  '.icv-handle{position:absolute;width:11px;height:11px;border-radius:3px;background:var(--icv-overlay-strong);border:1.5px solid ' + COLORS.accent + ';box-shadow:0 1px 3px ' + COLORS.shadow + '}',
		  // 四个角 + 四条边中点都能拖（对齐豆包：不是只有右下角一个点）
		  // 每个方向自带 scale(var(--icv-inv))：缩放画布时手柄保持 11px 恒定大小
		  '.icv-handle[data-role="resize"][data-dir="nw"]{left:0;top:0;transform:translate(-50%,-50%) scale(var(--icv-inv,1));cursor:nwse-resize}',
		  '.icv-handle[data-role="resize"][data-dir="ne"]{right:0;top:0;transform:translate(50%,-50%) scale(var(--icv-inv,1));cursor:nesw-resize}',
		  '.icv-handle[data-role="resize"][data-dir="sw"]{left:0;bottom:0;transform:translate(-50%,50%) scale(var(--icv-inv,1));cursor:nesw-resize}',
		  '.icv-handle[data-role="resize"][data-dir="se"]{right:0;bottom:0;transform:translate(50%,50%) scale(var(--icv-inv,1));cursor:nwse-resize}',
		  '.icv-handle[data-role="resize"][data-dir="n"]{left:50%;top:0;transform:translate(-50%,-50%) scale(var(--icv-inv,1));cursor:ns-resize}',
		  '.icv-handle[data-role="resize"][data-dir="s"]{left:50%;bottom:0;transform:translate(-50%,50%) scale(var(--icv-inv,1));cursor:ns-resize}',
		  '.icv-handle[data-role="resize"][data-dir="e"]{right:0;top:50%;transform:translate(50%,-50%) scale(var(--icv-inv,1));cursor:ew-resize}',
		  '.icv-handle[data-role="resize"][data-dir="w"]{left:0;top:50%;transform:translate(-50%,-50%) scale(var(--icv-inv,1));cursor:ew-resize}',
		  // 旋转点：偏移量必须也乘 1/k（--icv-inv），否则缩小画布时它会往缩放手柄上贴——
		  // 2026-10-16 实测 55% 缩放下两者只差 13px，鼠标在中间会来回跳光标
		  // 兜底光标用 default 而不是 grab：万一自定义 SVG 光标没生效，也不能变成"手掌"
		  '.icv-handle[data-role="rotate"]{right:0;top:0;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;color:' + COLORS.accent + ';transform:translate(calc(130% * var(--icv-inv,1)),calc(-160% * var(--icv-inv,1))) scale(var(--icv-inv,1));border-radius:50%;z-index:2;cursor:' + ROTATE_CURSOR + '}',
		  '.icv-handle[data-role="rotate"] .icv-handle-icon{width:12px;height:12px;display:block}',
		  '.icv-handle[data-role="rotate"]:hover{background:' + COLORS.accent + ';color:var(--icv-overlay-strong)}',
		  '.icv-ann-layer{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}',
		  '.icv-pin{position:absolute;display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-100%) scale(var(--icv-inv,1));transform-origin:bottom center;pointer-events:auto;cursor:default}',
		  '.icv-pin-badge{width:18px;height:18px;border-radius:50%;background:var(--icv-pin);color:var(--icv-pin-ink);font-size:11px;line-height:18px;text-align:center;box-shadow:0 0 0 1.5px var(--icv-ring),0 2px 6px rgba(0,0,0,.24)}',
		  '.icv-pin-line{width:0;height:11px;border-left:1.5px dashed var(--icv-pin)}',
		  '.icv-pin-dot{width:5px;height:5px;margin-bottom:-2.5px;border-radius:50%;background:var(--icv-pin);box-shadow:0 0 0 1.5px var(--icv-ring)}',
		  '.icv-pin[data-active="1"] .icv-pin-badge{background:var(--icv-warn)}',
		  '.icv-pin[data-active="1"] .icv-pin-dot{background:var(--icv-warn)}',
		  '.icv-draw{position:absolute;left:0;top:0;pointer-events:none}',
		  '.icv-draw[data-mode="rect"],.icv-draw[data-mode="point"],.icv-draw[data-mode="brush"]{pointer-events:auto;cursor:crosshair}',
		  '.icv-panel{display:block}',
		  '.icv-row{display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--icv-hairline);align-items:flex-start}',
		  '.icv-row:last-child{border-bottom:none}',
		  '.icv-badge{flex:0 0 auto;min-width:18px;height:18px;border-radius:9px;background:' + COLORS.accent + ';color:#fff;font-size:11px;display:flex;align-items:center;justify-content:center}',
		  '.icv-row-body{flex:1 1 auto;min-width:0}',
		  '.icv-row-meta{color:' + COLORS.dim + ';font-size:10px}',
		  '.icv-hint{position:absolute;left:50%;top:10px;transform:translateX(-50%);background:' + COLORS.overlay + ';border:1px solid ' + COLORS.border + ';padding:6px 10px;border-radius:8px;max-width:82%;text-align:center;z-index:5}',
		  '.icv-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;color:' + COLORS.dim + ';text-align:center;padding:24px;pointer-events:none}',
		  '.icv-toast{position:absolute;left:50%;bottom:56px;transform:translateX(-50%);background:var(--icv-overlay-strong);border:1px solid ' + COLORS.border + ';padding:6px 12px;border-radius:8px;z-index:10}',
		  '.icv-kbd{font-family:ui-monospace,Consolas,monospace;color:' + COLORS.text + '}',
		  // ── 3D 节点（three.js 视口）：canvas 铺满节点，角标只在没加载完/出错时出现
		  '.icv-3d{position:relative;width:100%;height:100%;overflow:hidden;border-radius:8px;background:var(--icv-3d-bg,#0f1115)}',
		  '.icv-3d-canvas{display:block;width:100%;height:100%;border-radius:8px;touch-action:none}',
		  '.icv-node[data-kind="model"]{background:var(--icv-3d-bg,#0f1115);border-radius:10px}',
		  '.icv-3d-tip{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#9aa4b2;font-size:12px;pointer-events:none}',
		  '.icv-3d-info{position:absolute;left:8px;bottom:6px;padding:2px 7px;border-radius:6px;background:rgba(15,17,21,.62);color:#cfd6df;font-size:10px;line-height:1.5;pointer-events:none}',
		  '.icv-3d-hint{position:absolute;right:8px;bottom:6px;padding:2px 7px;border-radius:6px;background:rgba(15,17,21,.62);color:#cfd6df;font-size:10px;line-height:1.5;pointer-events:none}',
		  '.icv-3d-err{position:absolute;left:8px;right:8px;top:8px;padding:6px 8px;border-radius:7px;background:rgba(180,35,24,.14);border:1px solid rgba(180,35,24,.35);color:' + COLORS.danger + ';font-size:10px;line-height:1.45;max-height:66px;overflow:hidden;word-break:break-word}',
		].join('\n')

		/**
		 * 注入样式（幂等，但**按内容判定**）。
		 *
		 * 2026-10-28 踩过的坑：原来只按 `id` 判断"已注入过就跳过"，于是 HMR 热更后新加的 CSS 规则
		 * （.icv-3d 那些）根本没进页面，3D 节点渲染成一块空白 —— 画布页明明打开了、节点也在，
		 * 就是什么都看不见。现在每次都比对内容，不一致就换掉。
		 */
		function ensureStyle() {
		  const existing = document.getElementById(STYLE_ID)
		  if (existing !== null) {
		    if (existing.textContent === CSS) return
		    existing.remove()
		  }
		  const style = document.createElement('style')
		  style.id = STYLE_ID
		  style.textContent = CSS
		  document.head.appendChild(style)
		}

		/** 轻量 Toast（挂在画布容器内，不依赖宿主 API）。 */
		function useToast() {
		  const [text, setText] = useState('')
		  const timer = useRef(0)
		  const show = useCallback((value) => {
		    setText(value)
		    window.clearTimeout(timer.current)
		    timer.current = window.setTimeout(() => setText(''), 2200)
		  }, [])
		  useEffect(() => () => { window.clearTimeout(timer.current) }, [])
		  return [text, show]
		}

		// ─────────────────────────────────────────── 图片读取（走官方 RPC，不用 http 文件路由）
		//
		// 2026-10-21 用户反馈「无限画布加载图片失败」，查下来的真实原因有三类，这里逐条兜住：
		//   ① **路径错了**：聊天里 Markdown 图片地址写了 Windows 反斜杠，`\_` 被 Markdown 当成
		//      转义字符吃掉，`B:\ComfyUI\_cloud_test\x.png` 变成 `B:/ComfyUI_cloud_test/x.png`
		//      （少了一个分隔符）→ 文件明明在，却报 not-found。这里加「路径自愈」：按 ASCII 标点
		//      位置补回分隔符，逐个探测，能读到就顺手修正画布文档。
		//   ② **文件太大**：官方 workspaceFiles.readBytes 整文件读上限 32 MiB（宿主默认配置），
		//      超了报 workspace-file/too-large。这里退化成 1 MiB 的 range 分块读，拼回来再显示。
		//   ③ **格式浏览器不认**：tif/tiff 这类 Chromium 解不了，交给宿主 /convert 用 sharp 转 PNG；
		//      扩展名不可信，一律按文件头（magic bytes）判断。HEIC/HEIF（HEVC）连 sharp 都解不了，
		//      直接给人话（见 bytesToImageUrl）。

		/** 分块读的窗口大小（必须 ≤ 宿主 maxBytes 默认 2 MiB）。 */
		const READ_CHUNK_BYTES = 1024 * 1024
		/** 单张图上限：再大就不往画布塞了（避免把渲染进程内存打爆；宿主转码 body 上限 300 MiB）。 */
		const MAX_IMAGE_BYTES = 256 * 1024 * 1024
		/** 路径自愈：可能被 Markdown 反斜杠转义吃掉的 ASCII 标点（吃掉后字符前少了分隔符）。 */
		const REPAIR_PUNCT = '_[]()#!~+&;=@$%^*{}'

		/** 读一个文件头字节序列（小工具）。 */
		function asciiAt(bytes, start, length) {
		  let text = ''
		  for (let i = start; i < start + length && i < bytes.length; i++) text += String.fromCharCode(bytes[i])
		  return text
		}

		/**
		 * 按**文件头**判断图片真实格式（不信扩展名）。
		 * @returns {'png'|'jpeg'|'gif'|'webp'|'bmp'|'ico'|'tiff'|'avif'|'heic'|'svg'|undefined}
		 */
		function sniffImageFormat(bytes) {
		  if (bytes === undefined || bytes === null || bytes.length < 2) return undefined
		  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
		  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
		  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif'   // GIF87a / GIF89a
		  if (asciiAt(bytes, 0, 4) === 'RIFF' && asciiAt(bytes, 8, 4) === 'WEBP') return 'webp'
		  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp'                        // BM
		  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) return 'ico'
		  if (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) return 'tiff'  // II*\0
		  if (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a) return 'tiff'  // MM\0*
		  if (asciiAt(bytes, 4, 4) === 'ftyp') {
		    const brand = asciiAt(bytes, 8, 4).toLowerCase()
		    if (brand === 'avif' || brand === 'avis') return 'avif'
		    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].indexOf(brand) !== -1) return 'heic'
		  }
		  // SVG 是文本：跳过 UTF-8 BOM / 空白 / <?xml ...?> / 注释后再看有没有 <svg
		  //（BOM 是 EF BB BF 三个字节，必须按字节跳；asciiAt 按 Latin-1 取字符，'\uFEFF' 匹配不上）
		  const start = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0
		  const head = asciiAt(bytes, start, Math.min(bytes.length - start, 1024)).trimStart().toLowerCase()
		  if (head.indexOf('<svg') === 0) return 'svg'
		  if ((head.indexOf('<?xml') === 0 || head.indexOf('<!--') === 0 || head.indexOf('<!doctype') === 0) && head.indexOf('<svg') !== -1) return 'svg'
		  return undefined
		}

		/** 把官方 Remote 的错误对象转成带 code 的 Error。 */
		function readErrorOf(result) {
		  const error = result !== undefined && result !== null && result.error ? result.error : {}
		  const message = typeof error.message === 'string' && error.message !== '' ? error.message : '读取失败'
		  const wrapped = new Error(message)
		  wrapped.code = typeof error.code === 'string' ? error.code : ''
		  return wrapped
		}

		/** 换一条更适合给人看的文案（保留原 code 供上层判断）。 */
		function describeReadError(error, path) {
		  const code = String(error !== undefined && error !== null && error.code ? error.code : '')
		  const raw = String(error !== undefined && error !== null && error.message ? error.message : error)
		  const out = new Error('')
		  out.code = code
		  if (/not-found|ENOENT/i.test(code + ' ' + raw)) {
		    out.message = '文件不存在：' + path + '（可能被移动/改名；如果路径里有下划线、括号等符号，多半是被 Markdown 转义吃掉了分隔符）'
		    return out
		  }
		  if (/too-large|too_large/i.test(code + ' ' + raw)) {
		    out.message = '文件太大，读不了：' + path
		    return out
		  }
		  if (/not-regular-file|not-text|not-directory/i.test(code)) {
		    out.message = '这个路径不是普通文件：' + path
		    return out
		  }
		  if (/outside-workspace/i.test(code)) {
		    out.message = '工作区外读不了：' + path
		    return out
		  }
		  out.message = raw === '' ? '读取失败：' + path : '读取失败：' + raw
		  return out
		}

		/** 是不是「文件不存在」类错误（只有这类才值得尝试路径自愈）。 */
		function isNotFoundError(error) {
		  const code = String(error !== undefined && error !== null && error.code ? error.code : '')
		  const raw = String(error !== undefined && error !== null && error.message ? error.message : '')
		  return /not-found|ENOENT/i.test(code + ' ' + raw)
		}

		/**
		 * 生成「被 Markdown 转义吃掉分隔符」的候选路径：
		 * `B:/ComfyUI_cloud_test/x.png` → `B:/ComfyUI/_cloud_test/x.png`。
		 * 只在 ASCII 标点前插一个 `/`，数量有上限，成本很低。
		 */
		function repairPathCandidates(path) {
		  const text = String(path)
		  const candidates = []
		  for (let i = 1; i < text.length; i++) {
		    if (REPAIR_PUNCT.indexOf(text[i]) === -1) continue
		    const previous = text[i - 1]
		    if (previous === '/' || previous === '\\' || previous === ':') continue
		    candidates.push(text.slice(0, i) + '/' + text.slice(i))
		    if (candidates.length >= 32) break
		  }
		  return candidates
		}

		/**
		 * 路径自愈：逐个候选探测（只读 1 字节，很便宜），命中就返回可读路径。
		 * @returns 修好的路径；修不好返回 undefined
		 */
		async function repairImagePath(loadImage, sessionId, path, signal) {
		  for (const candidate of repairPathCandidates(path)) {
		    try {
		      const probe = await loadImage(sessionId, candidate, { range: { offset: 0, length: 1 } }, signal)
		      if (probe !== undefined && probe !== null && probe.ok === true) return candidate
		    } catch { /* 探测失败就试下一个 */ }
		  }
		  return undefined
		}

		/**
		 * 读一张图的全部字节：先整文件读；超宿主 32 MiB 上限时退化成 range 分块拼回来。
		 * @param loadImage - (sessionId, path, options, signal) => Promise<RemoteResult<WorkspaceFileBytes>>
		 */
		async function readImageBytes(loadImage, sessionId, path, signal) {
		  const full = await loadImage(sessionId, path, {}, signal)
		  if (full !== undefined && full !== null && full.ok === true) return bytesOf(full.value)
		  const first = readErrorOf(full)
		  // 兼容三种说法：typed code `workspace-file/too-large`、下划线写法、以及 older host 的
		  // `"..." exceeds the 33554432 byte full-file cap` 文案（remote-client 不同版本措辞不一样）。
		  const firstText = String(first.code) + ' ' + String(first.message)
		  if (!/too-large|too_large|exceeds the \d+ byte|full-file cap/i.test(firstText)) throw first

		  const chunks = []
		  let total = 0
		  let offset = 0
		  for (let index = 0; index < 4096; index++) {
		    const part = await loadImage(sessionId, path, { range: { offset, length: READ_CHUNK_BYTES } }, signal)
		    if (part === undefined || part === null || part.ok !== true) throw readErrorOf(part)
		    const value = part.value !== undefined && part.value !== null ? part.value : {}
		    const chunk = bytesOf(value)
		    if (chunk.length === 0) break
		    chunks.push(chunk)
		    total += chunk.length
		    if (total > MAX_IMAGE_BYTES) {
		      const tooBig = new Error('文件太大（超过 ' + String(Math.round(MAX_IMAGE_BYTES / 1024 / 1024)) + ' MiB），画布放不下')
		      tooBig.code = 'too-large'
		      throw tooBig
		    }
		    if (value.eof === true) break
		    offset = typeof value.offset === 'number' ? value.offset + chunk.length : offset + chunk.length
		  }
		  if (chunks.length === 0) return new Uint8Array(0)
		  if (chunks.length === 1) return chunks[0]
		  const merged = new Uint8Array(total)
		  let at = 0
		  for (const chunk of chunks) { merged.set(chunk, at); at += chunk.length }
		  return merged
		}

		/**
		 * 让宿主把任意图片字节转成 PNG（走 sharp；浏览器解不了的格式用它兜底）。
		 * @returns PNG 字节的 object URL
		 */
		async function convertImageToPngUrl(bytes, path) {
		  const name = basenameOf(path)
		  let response
		  try {
		    response = await fetch(ROUTE + '/convert?name=' + encodeURIComponent(name), {
		      method: 'POST',
		      headers: { 'content-type': 'application/octet-stream' },
		      body: bytes,
		    })
		  } catch (error) {
		    throw new Error('转码服务连不上（' + String(error && error.message ? error.message : error) + '）')
		  }
		  if (response.status === 404) {
		    throw new Error('转码服务还没启动：这个版本是刚装的，需要把 DSH 桌面版**重启一次**才能用多格式转码')
		  }
		  if (!response.ok) {
		    const body = await response.json().catch(() => ({}))
		    const detail = body !== null && body !== undefined && typeof body.error === 'string' && body.error !== '' ? body.error : ('HTTP ' + String(response.status))
		    throw new Error(detail)
		  }
		  return URL.createObjectURL(await response.blob())
		}

		/**
		 * 字节 → 能放进 <img> 的 object URL。
		 * 浏览器能解的格式直接 Blob；其余（tiff/heic/未知）让宿主转 PNG。
		 */
		async function bytesToImageUrl(bytes, path) {
		  const format = sniffImageFormat(bytes)
		  const ext = extOf(path)
		  const type = format !== undefined ? (MEDIA[format] !== undefined ? MEDIA[format] : MEDIA[format === 'jpeg' ? 'jpg' : format]) : MEDIA[ext]
		  const native = format !== undefined && BROWSER_IMAGE_FORMATS.indexOf(format) !== -1
		  if (native && type !== undefined) {
		    return { url: URL.createObjectURL(new Blob([bytes], { type })), converted: false, format }
		  }
		  // HEIC/HEIF 是 HEVC 压缩：DSH 自带的 libvips 没编 HEVC 解码器（2026-10-21 实测报
		  // "Support for this compression format has not been built in: HEVC"），送宿主也是白跑一趟，
		  // 这里直接给人话，省一次 roundtrip。
		  if (format === 'heic') {
		    throw new Error('HEIC/HEIF 用的是 HEVC 压缩，画布自带的解码器没编 HEVC（解不了）；先用别的工具转成 PNG/JPG 再放进来')
		  }
		  return { url: await convertImageToPngUrl(bytes, path), converted: true, format }
		}

		/**
		 * 读一个资源地址的字节并变成可显示的 object URL。
		 * @param loadImage - 由宿主半边注入： (sessionId, path, options, signal) => Promise<RemoteResult<WorkspaceFileBytes>>
		 * @param address - dsh-resource:// 地址
		 */
		async function readImage(loadImage, address) {
		  const parsed = parseFileAddress(address)
		  if (parsed === undefined) throw new Error('不支持的地址（只支持 session scope 的工作区文件）')
		  let path = parsed.path
		  let bytes
		  let repairedPath
		  try {
		    bytes = await readImageBytes(loadImage, parsed.sessionId, path)
		  } catch (error) {
		    if (!isNotFoundError(error)) throw describeReadError(error, path)
		    const fixed = await repairImagePath(loadImage, parsed.sessionId, path)
		    if (fixed === undefined) throw describeReadError(error, path)
		    repairedPath = fixed
		    try {
		      bytes = await readImageBytes(loadImage, parsed.sessionId, fixed)
		    } catch (error2) {
		      throw describeReadError(error2, fixed)
		    }
		    path = fixed
		  }
		  const decoded = await bytesToImageUrl(bytes, path)
		  const size = await measureUrl(decoded.url)
		  const asset = { url: decoded.url, w: size.w, h: size.h, path, sessionId: parsed.sessionId, converted: decoded.converted }
		  if (repairedPath !== undefined) {
		    asset.repairedPath = repairedPath
		    asset.repairedAddress = sessionFileAddress(parsed.sessionId, repairedPath)
		    asset.originalPath = parsed.path
		  }
		  return asset
		}

		/** 把 `/`-分隔的路径按 DSH 的地址规则编码（与官方 sessionFileAddress 等价）。 */
		function encodeAddressSegment(segment) {
		  return encodeURIComponent(segment).replace(/%3A/gi, ':')
		}
		/** 生成 dsh-resource://file/session/<会话>/<路径> 地址（路径自愈后写回文档用）。 */
		function sessionFileAddress(sessionId, path) {
		  const normalized = String(path).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
		  return 'dsh-resource://file/session/' + encodeAddressSegment(sessionId) + '/' + normalized.split('/').map(encodeAddressSegment).join('/')
		}

		// ─────────────────────────────────────────── 本地 ComfyUI（改图/出图）

		/** ComfyUI 的 LoadImage 能直接吃的格式；其余先转 PNG 再上传，免得服务端解不了。 */
		const COMFY_SAFE_FORMATS = ['png', 'jpeg', 'webp']

		/**
		 * 画布节点 → base64 PNG。
		 * 资源型节点走官方 RPC（支持超大文件分块读、路径自愈、非浏览器格式转码）；
		 * AI 结果型节点（带 url）直接 fetch 回来。
		 */
		async function nodeToBase64(loadImage, sessionId, node) {
		  if (typeof node.url === 'string' && node.url !== '') {
		    const response = await fetch(node.url)
		    if (!response.ok) throw new Error('取源图失败：HTTP ' + String(response.status))
		    const buffer = await response.arrayBuffer()
		    return arrayBufferToBase64(buffer)
		  }
		  const parsed = parseFileAddress(node.address)
		  if (parsed === undefined) throw new Error('该节点不是可读的工作区图片')
		  let path = parsed.path
		  let bytes
		  try {
		    bytes = await readImageBytes(loadImage, parsed.sessionId, path)
		  } catch (error) {
		    if (!isNotFoundError(error)) throw describeReadError(error, path)
		    const fixed = await repairImagePath(loadImage, parsed.sessionId, path)
		    if (fixed === undefined) throw describeReadError(error, path)
		    path = fixed
		    bytes = await readImageBytes(loadImage, parsed.sessionId, fixed)
		  }
		  const format = sniffImageFormat(bytes)
		  if (format !== undefined && COMFY_SAFE_FORMATS.indexOf(format) !== -1) return arrayBufferToBase64(bytes)
		  // 其余（tiff/heic/svg/gif/bmp/avif…）先让宿主转 PNG：ComfyUI 那边只认常见格式
		  const url = await convertImageToPngUrl(bytes, path)
		  try {
		    const response = await fetch(url)
		    const buffer = await response.arrayBuffer()
		    return arrayBufferToBase64(buffer)
		  } finally {
		    URL.revokeObjectURL(url)
		  }
		}

		/**
		 * 官方 Remote 返回的字节统一成 Uint8Array。
		 * readBytes 正常给 Uint8Array；这里用鸭子类型判断而不是 instanceof——
		 * 跨 realm（iframe / 结构化克隆 / 测试沙箱）的 Uint8Array 用 instanceof 会认不出来。
		 */
		function bytesOf(value) {
		  const data = value === undefined || value === null ? undefined : value.data
		  if (data === undefined || data === null) throw new Error('返回里没有 bytes 数据')
		  if (typeof data === 'string') {
		    if (data === '') throw new Error('返回的字节是空字符串')
		    const binary = window.atob(data)
		    const bytes = new Uint8Array(binary.length)
		    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
		    return bytes
		  }
		  if (typeof data.byteLength === 'number' && typeof data.length !== 'number') {
		    // 纯 ArrayBuffer（没有 length，只有 byteLength）
		    const view = new Uint8Array(data)
		    const copy = new Uint8Array(view.length)
		    copy.set(view)
		    return copy
		  }
		  if (typeof data.length === 'number' && typeof data.byteLength === 'number') {
		    // 任何 TypedArray / ArrayBufferView（含跨 realm 的）
		    const copy = new Uint8Array(data.byteLength)
		    for (let i = 0; i < copy.length; i++) copy[i] = data[i]
		    return copy
		  }
		  if (Array.isArray(data)) return Uint8Array.from(data)
		  throw new Error('返回里的字节格式不认识：' + Object.prototype.toString.call(data))
		}

		/** ArrayBuffer / Uint8Array → base64（分块，避免大图爆栈）。 */
		function arrayBufferToBase64(buffer) {
		  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
		  let binary = ''
		  const step = 0x8000
		  for (let i = 0; i < bytes.length; i += step) {
		    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step))
		  }
		  return window.btoa(binary)
		}

		/**
		 * 用落在该节点上的批注生成掩码 PNG：白 = 要改的区域，黑 = 保持不动。
		 * @returns base64（不含 data: 前缀）
		 */
		function nodeMaskBase64(node, annotations) {
		  const width = Math.max(64, Math.round(node.w))
		  const height = Math.max(64, Math.round(node.h))
		  const canvas = document.createElement('canvas')
		  canvas.width = width
		  canvas.height = height
		  const context = canvas.getContext('2d')
		  if (context === null) throw new Error('浏览器不支持 2D 画布')
		  context.fillStyle = '#000'
		  context.fillRect(0, 0, width, height)
		  context.fillStyle = '#fff'
		  context.strokeStyle = '#fff'
		  context.lineWidth = Math.max(8, Math.round(Math.min(width, height) * 0.06))
		  context.lineCap = 'round'
		  context.lineJoin = 'round'
		  let used = 0
		  for (const annotation of annotations) {
		    if (annotation.kind === 'point') {
		      const x = annotation.x - node.x
		      const y = annotation.y - node.y
		      if (x < 0 || y < 0 || x > width || y > height) continue
		      context.beginPath()
		      context.arc(x, y, Math.max(12, width * 0.08), 0, Math.PI * 2)
		      context.fill()
		      used++
		      continue
		    }
		    if (annotation.kind === 'rect') {
		      const x = Math.max(annotation.x, node.x) - node.x
		      const y = Math.max(annotation.y, node.y) - node.y
		      const right = Math.min(annotation.x + annotation.w, node.x + node.w) - node.x
		      const bottom = Math.min(annotation.y + annotation.h, node.y + node.h) - node.y
		      if (right <= x || bottom <= y) continue
		      context.fillRect(x, y, right - x, bottom - y)
		      used++
		      continue
		    }
		    if (annotation.kind === 'brush' && Array.isArray(annotation.points)) {
		      let started = false
		      context.beginPath()
		      for (const point of annotation.points) {
		        const x = point[0] - node.x
		        const y = point[1] - node.y
		        if (x < -width || y < -height || x > width * 2 || y > height * 2) { started = false; continue }
		        if (!started) { context.moveTo(x, y); started = true } else { context.lineTo(x, y) }
		      }
		      context.stroke()
		      used++
		    }
		  }
		  if (used === 0) return undefined
		  return canvas.toDataURL('image/png').split(',')[1]
		}

		/** 默认 checkpoint 的偏好键。 */
		const CHECKPOINT_KEY = PKG + ':comfy:checkpoint'

		// ─────────────────────────────────────────── 图标（内联 SVG，不引任何图标库）

		/**
		 * 工具图标。24 视框、线性描边（currentColor）——浅色/深色两套主题下都不用换色值。
		 * 为什么不用文字按钮：重新设计（2026-10-16 对齐豆包画布）后画布占满整个面板，
		 * 13 个文字按钮挤在 560px 宽的右侧栏里会折成两三行，把画布压掉一大截。
		 */
		const ICON_PATHS = {
		  hand: ['M9.2 11.4V6.4a1.5 1.5 0 0 1 3 0v4.4', 'M12.2 10.6V5.2a1.5 1.5 0 0 1 3 0v5.4', 'M15.2 11.2V8.6a1.5 1.5 0 0 1 3 0V14a6.2 6.2 0 0 1-6.2 6.2h-.6A5.4 5.4 0 0 1 7.5 18.4L5 15.6a1.5 1.5 0 0 1 2.2-2l2 2.1'],
		  cursor: ['M5.5 3.2l13 7.6-5.6 1.4-1.4 5.6z'],
		  pin: ['M12 21c3.8-4.2 5.7-7.3 5.7-10a5.7 5.7 0 1 0-11.4 0c0 2.7 1.9 5.8 5.7 10z', 'M12 8.4v4.6', 'M9.7 10.7h4.6'],
		  frame: ['M4.5 6.5h15v11h-15z'],
		  brush: ['M4.5 19.5l1-3.4 8.2-8.2 2.4 2.4-8.2 8.2z', 'M15.6 6.2l2.1-2.1 2.4 2.4-2.1 2.1'],
		  fit: ['M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9', 'M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9', 'M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15', 'M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15'],
		  sparkle: ['M11 4l1.6 4.3L17 10l-4.4 1.7L11 16l-1.6-4.3L5 10l4.4-1.7z', 'M18.4 14.6l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z'],
		  more: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
		  copy: ['M9 9.5A1.5 1.5 0 0 1 10.5 8h7A1.5 1.5 0 0 1 19 9.5v9A1.5 1.5 0 0 1 17.5 20h-9A1.5 1.5 0 0 1 7 18.5v-7A1.5 1.5 0 0 1 8.5 10z', 'M5 15V5.5A1.5 1.5 0 0 1 6.5 4H15'],
		  paste: ['M9 4.5h6a1 1 0 0 1 1 1v1H8v-1a1 1 0 0 1 1-1z', 'M8 6.5H6.5A1.5 1.5 0 0 0 5 8v12A1.5 1.5 0 0 0 6.5 21.5h11A1.5 1.5 0 0 0 19 20V8a1.5 1.5 0 0 0-1.5-1.5H16'],
		  cut: ['M6 4l12 12', 'M18 4L6 16', 'M7.5 18.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z', 'M16.5 18.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z'],
		  edit: ['M4.5 19.5l.9-3.2L15.8 6a1.6 1.6 0 0 1 2.3 0l1.9 1.9a1.6 1.6 0 0 1 0 2.3L9.7 20.6z', 'M14.2 7.6l2.6 2.6'],
		  align: ['M4 5.5h16', 'M6.5 9.5h3.6v9H6.5z', 'M13.9 9.5h3.6v9h-3.6z'],
		  rotate: ['M19.6 9.2A8 8 0 1 0 20.2 13.4', 'M20.4 4.4v4.9h-4.9'],
		  level: ['M3 12h18', 'M6.6 8.4L3 12l3.6 3.6', 'M17.4 8.4L21 12l-3.6 3.6'],
		  // 「回正」用 U 形回转箭头（用户点名要 U Turn 那种）：两条腿 + 顶上 180° 弯 + 左边腿末尾的箭头
		  uturn: ['M8.5 19.5V11a3.5 3.5 0 0 1 7 0v8.5', 'M5.5 16.5L8.5 19.5l3-3'],
		  natural: ['M4.5 9.5v-5h5', 'M19.5 14.5v5h-5', 'M4.5 4.5l6 6', 'M19.5 19.5l-6-6'],
		  lock: ['M7.5 11V8.5a4.5 4.5 0 0 1 9 0V11', 'M6 11h12v8a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1z'],
		  eyeOff: ['M4 4l16 16', 'M9.9 5.7A9.6 9.6 0 0 1 12 5.5c4.6 0 8 6.5 8 6.5a17 17 0 0 1-2.4 3.3', 'M6.8 8.2A16 16 0 0 0 4 12s3.4 6.5 8 6.5c1.3 0 2.5-.4 3.6-1.1'],
		  trash: ['M4.5 7h15', 'M9.5 7V5h5v2', 'M6.5 7l.9 12.1a1 1 0 0 0 1 .9h7.2a1 1 0 0 0 1-.9L17.5 7'],
		  close: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
		  download: ['M12 4v10', 'M8 10.5l4 4 4-4', 'M4.5 20h15'],
		  folder: ['M4 7.5A1.5 1.5 0 0 1 5.5 6h3.2l1.8 2h7A1.5 1.5 0 0 1 19 9.5v7A1.5 1.5 0 0 1 17.5 18h-12A1.5 1.5 0 0 1 4 16.5z'],
		  refresh: ['M19.5 12a7.5 7.5 0 1 1-2.2-5.3', 'M20 4.5V9h-4.5'],
		  undo: ['M9 7H5.5V3.5', 'M5.7 7.2A7.5 7.5 0 1 1 6 16'],
		  redo: ['M15 7h3.5V3.5', 'M18.3 7.2A7.5 7.5 0 1 0 18 16'],
		  theme: ['M12 7.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z', 'M12 3v1.8', 'M12 19.2V21', 'M3 12h1.8', 'M19.2 12H21', 'M5.6 5.6l1.3 1.3', 'M17.1 17.1l1.3 1.3', 'M18.4 5.6l-1.3 1.3', 'M6.9 17.1l-1.3 1.3'],
		  eraser: ['M8.5 19.5H20', 'M15.5 4.6l4 4-8.4 8.4H7.4l-3-3z'],
		  // 3D：一个等轴测立方体（三个面各一条线）
		  cube: ['M12 3.4l7.4 4.2v8.8L12 20.6l-7.4-4.2V7.6z', 'M12 3.4v8.9', 'M4.6 7.6l7.4 4.7 7.4-4.7', 'M12 20.6v-8.3'],
		}

		function Icon(name) {
		  const paths = ICON_PATHS[name] ?? []
		  return h('svg', {
		    viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true', fill: 'none',
		    stroke: 'currentColor', strokeWidth: name === 'more' ? 2.4 : 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
		    // 框选 = 虚线框（和"适应视图"的四角图标区分开）
		    strokeDasharray: name === 'frame' ? '3 2.4' : undefined,
		    style: { display: 'block' },
		  }, paths.map((d, index) => h('path', { key: index, d })))
		}

		/**
		 * 侧栏「开始」入口图标：一块画布/画板（线性描边，随主题变色）。
		 * 与工具条同一套 24 视框风格；guide 入口会按传入的 size（22/26）渲染。
		 */
		function CanvasGuideIcon(props) {
		  const size = props !== null && props !== undefined && props.size !== undefined ? props.size : 16
		  return h(
		    'svg',
		    {
		      viewBox: '0 0 24 24',
		      width: size,
		      height: size,
		      'aria-hidden': 'true',
		      fill: 'none',
		      stroke: 'currentColor',
		      strokeWidth: 1.6,
		      strokeLinecap: 'round',
		      strokeLinejoin: 'round',
		      style: { display: 'block', flex: 'none' },
		    },
		    h('rect', { x: 3.2, y: 4.4, width: 17.6, height: 15.2, rx: 3 }),
		    h('circle', { cx: 8.6, cy: 9.4, r: 1.5 }),
		    h('path', { d: 'M4.4 17.6l4.2-4.5a1.2 1.2 0 0 1 1.8 0l2.1 2.25 2.2-2.35a1.2 1.2 0 0 1 1.8 0l3.1 3.35' }),
		  )
		}

		/** 悬浮工具按钮：图标 + 原生 tooltip（豆包画布也是图标 + hover 提示）。 */
		function ToolButton(props) {
		  return h('button', {
		    type: 'button',
		    className: 'icv-tool',
		    'data-icv-tool': props.tool,
		    'data-on': props.on === true ? '1' : '0',
		    title: props.title,
		    'aria-label': props.title,
		    disabled: props.disabled === true,
		    onPointerDown: (event) => event.stopPropagation(),
		    onClick: (event) => { event.stopPropagation(); props.onClick() },
		  }, Icon(props.icon))
		}

		// ─────────────────────────────────────────── 无限画布主体

		/**
		 * 画布页正文。
		 * @param props.sessionId - 会话 id（由 slot 的 inject 工厂给）
		 * @param props.loadImage - 读字节的绑定函数
		 */
		function CanvasBoard(props) {
		  const sessionId = props.sessionId
		  const loadImage = props.loadImage
		  const listDir = props.listDir
		  const diagnostics = props.diagnostics
		  const serviceOk = props.serviceOk
		  const [busyDir, setBusyDir] = useState(false)
		  // 画布配色：默认跟随系统，可用工具条按钮强制浅色/深色（记住选择）
		  const [theme, setTheme] = useState(() => {
		    try {
		      const saved = window.localStorage.getItem(THEME_KEY)
		      return THEME_MODES.indexOf(saved) !== -1 ? saved : 'system'
		    } catch { return 'system' }
		  })
		  const systemDark = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches === true
		  const effectiveDark = theme === 'dark' || (theme === 'system' && systemDark)
		  const cycleTheme = useCallback(() => {
		    setTheme((current) => {
		      const next = THEME_MODES[(THEME_MODES.indexOf(current) + 1) % THEME_MODES.length]
		      try { window.localStorage.setItem(THEME_KEY, next) } catch { /* 存不进就只在本次生效 */ }
		      return next
		    })
		  }, [])
		  const containerRef = useRef(null)
		  const stageRef = useRef(null)
		  const [doc, setDoc] = useState(() => emptyDoc())
		  const [ready, setReady] = useState(false)
		  const [selected, setSelected] = useState([])
		  const [activeAnn, setActiveAnn] = useState('')
		  const [mode, setMode] = useState('select')
		  // 浮层（默认不占画布）：'' 收起 / 'ann' 标记 / 'gen' 生成改图
		  const [sheet, setSheet] = useState('')
		  const [openGroup, setOpenGroup] = useState('')
		  // 拖动时的对齐参考线（[{axis:'x'|'y', at, from, to}]）
		  const [guides, setGuides] = useState([])
		  const [ctxMenu, setCtxMenu] = useState(null)
		  const [groupPinned, setGroupPinned] = useState(false)
		  // 悬停浮层的延迟收起计时器（见 holdGroup / releaseGroup）
		  const groupTimer = useRef(0)
		  const [menuOpen, setMenuOpen] = useState(false)
		  const [adv, setAdv] = useState(false)
		  const [toast, showToast] = useToast()
		  // 本地 ComfyUI 通道
		  const [comfy, setComfy] = useState({ loading: true, ok: false, url: '', checkpoints: [], error: '' })
		  const [ai, setAi] = useState(() => ({
		    prompt: '', negative: '', steps: 20, cfg: 6, denoise: 0.6,
		    checkpoint: (() => { try { return window.localStorage.getItem(CHECKPOINT_KEY) ?? '' } catch { return '' } })(),
		    busy: '', error: '', info: '',
		  }))
		  const assets = useRef(new Map())
		  const [, forceRender] = useState(0)
		  const history = useRef({ past: [], future: [] })
		  const drag = useRef(null)
		  const pendingSave = useRef(0)
		  // 3D 面板：扫描目录 / 扫出来的模型列表 / 手填路径
		  const [modelPick, setModelPick] = useState({ dir: '.', files: [], busy: false, error: '', manual: '' })

		  // 载入文档
		  useEffect(() => {
		    let live = true
		    void (async () => {
		      const loaded = await loadDoc(sessionId)
		      if (!live) return
		      setDoc(loaded)
		      setReady(true)
		    })()
		    return () => { live = false }
		  }, [sessionId])

		  // 把会话 id 交给"面板外右键图片 → 放入无限画布"那条通路，并监听它插完图后的刷新广播
		  useEffect(() => {
		    canvasBridge.sessionId = sessionId
		    const onExternalAdd = () => {
		      void (async () => {
		        const fresh = await loadDoc(sessionId)
		        setDoc(fresh)
		        showToast('已从面板外加入图片')
		      })()
		    }
		    window.addEventListener('dsh-image-canvas:reload', onExternalAdd)
		    return () => { window.removeEventListener('dsh-image-canvas:reload', onExternalAdd) }
		  }, [sessionId, showToast])

		  // 文档变更后防抖落盘
		  useEffect(() => {
		    if (!ready) return undefined
		    window.clearTimeout(pendingSave.current)
		    pendingSave.current = window.setTimeout(() => saveDoc(sessionId, doc), 400)
		    return () => { window.clearTimeout(pendingSave.current) }
		  }, [doc, ready, sessionId])

		  // 卸载时释放 object URL
		  useEffect(() => () => {
		    for (const asset of assets.current.values()) URL.revokeObjectURL(asset.url)
		    assets.current.clear()
		  }, [])

		  // 按需拉取节点图片的 effect 在下面 commit/undo/redo 之后定义
		  //（它要用 commit 修路径，而 commit 必须先初始化 —— 否则依赖数组会踩 TDZ）

		  // 探一次本地 ComfyUI（不可达也不影响画布本身）
		  useEffect(() => {
		    let live = true
		    void (async () => {
		      try {
		        const response = await fetch(ROUTE + '/comfy/status')
		        const body = await response.json()
		        if (!live) return
		        const list = Array.isArray(body.checkpoints) ? body.checkpoints : []
		        setComfy({ loading: false, ok: body.ok === true, url: String(body.url ?? ''), checkpoints: list, error: String(body.error ?? '') })
		        setAi((current) => {
		          if (current.checkpoint !== '' && list.includes(current.checkpoint)) return current
		          const preferred = list.find((name) => /juggernaut|dreamshaper|realistic|majicmix|anything/i.test(name)) ?? list[0] ?? ''
		          return Object.assign({}, current, { checkpoint: preferred })
		        })
		      } catch (error) {
		        if (live) setComfy({ loading: false, ok: false, url: '', checkpoints: [], error: String(error && error.message ? error.message : error) })
		      }
		    })()
		    return () => { live = false }
		  }, [])


		  const commit = useCallback((mutate) => {
		    setDoc((current) => {
		      const snapshot = { nodes: current.nodes, annotations: current.annotations }
		      const next = mutate({ nodes: current.nodes.slice(), annotations: current.annotations.slice(), view: current.view, seq: current.seq })
		      if (next === undefined) return current
		      history.current.past.push(snapshot)
		      if (history.current.past.length > 60) history.current.past.shift()
		      history.current.future.length = 0
		      return Object.assign({}, current, next)
		    })
		  }, [])

		  const undo = useCallback(() => {
		    setDoc((current) => {
		      const previous = history.current.past.pop()
		      if (previous === undefined) return current
		      history.current.future.push({ nodes: current.nodes, annotations: current.annotations })
		      return Object.assign({}, current, { nodes: previous.nodes, annotations: previous.annotations })
		    })
		  }, [])

		  const redo = useCallback(() => {
		    setDoc((current) => {
		      const next = history.current.future.pop()
		      if (next === undefined) return current
		      history.current.past.push({ nodes: current.nodes, annotations: current.annotations })
		      return Object.assign({}, current, { nodes: next.nodes, annotations: next.annotations })
		    })
		  }, [])

		  // 按需拉取节点图片：资源节点走 RPC，AI 结果节点（带 url）直接用插件路由。
		  // 三条经验：
		  //   ① 只跳过**已成功**的——读失败的要重试，否则一次失败被永久缓存，界面永远"读取失败"（2026-10-16 实测）；
		  //   ② **限并发**：22 张一起发 RPC 会整批失败（2 张时正常）。这里最多 3 张同时在读，其余排队（2026-10-16 实测）；
		  //   ③ 路径被 Markdown 转义吃坏时（读不到但自愈能读到），顺手把文档里的坏地址改对（2026-10-21 加）。
		  useEffect(() => {
		    if (!ready) return
		    let cancelled = false
		    const pending = doc.nodes.filter((node) => {
		      const cached = assets.current.get(assetKey(node))
		      return cached === undefined || cached.error !== undefined
		    })
		    if (pending.length === 0) return

		    const queue = pending.slice()
		    const loadOne = async (node) => {
		      const key = assetKey(node)
		      assets.current.set(key, { loading: true })
		      forceRender((n) => n + 1)
		      try {
		        if (typeof node.url === 'string' && node.url !== '') {
		          const size = await measureUrl(node.url)
		          assets.current.set(key, { url: node.url, w: size.w, h: size.h })
		        } else {
		          const asset = await readImage(loadImage, node.address)
		          if (asset.repairedAddress !== undefined && asset.repairedAddress !== node.address) {
		            // 路径是被 Markdown 转义吃坏的：图片已经能读了，顺手把文档里的坏地址改对
		            //（缓存也挪到新 key 上，避免文档一改又重读一遍）
		            assets.current.set(assetKey({ address: asset.repairedAddress }), asset)
		            assets.current.delete(key)
		            commit((draft) => {
		              draft.nodes = draft.nodes.map((item) => (item.id === node.id ? Object.assign({}, item, {
		                address: asset.repairedAddress,
		                path: asset.repairedPath,
		                name: basenameOf(asset.repairedAddress),
		              }) : item))
		              return draft
		            })
		            showToast('图片路径已自动修复：' + asset.repairedPath)
		          } else {
		            assets.current.set(key, asset)
		          }
		        }
		      } catch (error) {
		        assets.current.set(key, { error: String(error && error.message ? error.message : error) })
		      }
		      forceRender((n) => n + 1)
		    }

		    void (async () => {
		      const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
		        while (queue.length > 0 && !cancelled) {
		          const node = queue.shift()
		          if (node === undefined) return
		          await loadOne(node)
		        }
		      })
		      await Promise.all(workers)
		    })()

		    return () => { cancelled = true }
		  }, [commit, doc.nodes, ready, loadImage, showToast])

		  /** 屏幕坐标 → 世界坐标（必须用 stage 的矩形，工具条会占掉顶部高度）。 */
		  const toWorld = useCallback((clientX, clientY) => {
		    const box = stageRef.current ? stageRef.current.getBoundingClientRect() : { left: 0, top: 0 }
		    return {
		      x: (clientX - box.left - doc.view.x) / doc.view.k,
		      y: (clientY - box.top - doc.view.y) / doc.view.k,
		    }
		  }, [doc.view])

		  /** 适应视图：把所有可见节点装进视口。 */
		  const fitView = useCallback(() => {
		    const box = stageRef.current ? stageRef.current.getBoundingClientRect() : undefined
		    if (box === undefined) return
		    const visible = doc.nodes.filter((node) => node.hidden !== true)
		    if (visible.length === 0) { setDoc((c) => Object.assign({}, c, { view: { x: 0, y: 0, k: 1 } })); return }
		    const minX = Math.min(...visible.map((n) => n.x))
		    const minY = Math.min(...visible.map((n) => n.y))
		    const maxX = Math.max(...visible.map((n) => n.x + n.w))
		    const maxY = Math.max(...visible.map((n) => n.y + n.h))
		    const pad = 24
		    const k = Math.min((box.width - pad * 2) / Math.max(1, maxX - minX), (box.height - pad * 2) / Math.max(1, maxY - minY), 4)
		    const scale = k > 0.02 ? k : 0.02
		    setDoc((c) => Object.assign({}, c, {
		      view: { k: scale, x: pad - minX * scale, y: pad - minY * scale },
		    }))
		  }, [doc.nodes])

		  // 滚轮缩放（以指针为中心）
		  const onWheel = useCallback((event) => {
		    event.preventDefault()
		    const box = stageRef.current ? stageRef.current.getBoundingClientRect() : { left: 0, top: 0 }
		    const px = event.clientX - box.left
		    const py = event.clientY - box.top
		    setDoc((current) => {
		      const k = Math.min(16, Math.max(0.04, current.view.k * Math.exp(-event.deltaY / 420)))
		      const ratio = k / current.view.k
		      return Object.assign({}, current, { view: { k, x: px - (px - current.view.x) * ratio, y: py - (py - current.view.y) * ratio } })
		    })
		  }, [])

		  /**
		   * 滚轮缩放要**非 passive** 监听：React 在根节点上把 wheel 注册成 passive，
		   * 在里面调 preventDefault() 只会刷一屏 "Unable to preventDefault inside passive event
		   * listener invocation" 警告（2026-10-16 崩溃日志里那 250 行就是它），而且拦不住页面缩放。
		   * 所以这里绕过 React，直接在 stage 元素上挂 { passive: false } 的原生监听。
		   */
		  useEffect(() => {
		    const stage = stageRef.current
		    if (stage === null || stage === undefined) return undefined
		    const handler = (event) => onWheel(event)
		    stage.addEventListener('wheel', handler, { passive: false })
		    return () => stage.removeEventListener('wheel', handler)
		  }, [onWheel])

		  // 工具语义（对齐豆包画布）：选择=箭头（左键拉框多选 / 拖动图片）；拖动=手（平移画布）；其余三个是批注工具。
		  // 中键、Alt 拖动在任何工具下都当平移用（老习惯不用改）。
		  const drawing = mode === 'point' || mode === 'rect' || mode === 'brush'
		  const onStagePointerDown = useCallback((event) => {
		    // 点画布任意处 = 点"外面"，把 ⋯ 菜单/分组浮层/右键菜单收掉（没有全局 document 监听，画布是最大的那块）
		    setMenuOpen(false)
		    window.clearTimeout(groupTimer.current)
		    setGroupPinned(false)
		    setOpenGroup('')
		    setCtxMenu(null)
		    const wantsPan = mode === 'hand' || event.button === 1 || event.altKey === true
		    if (wantsPan) {
		      drag.current = { kind: 'pan', x: event.clientX, y: event.clientY }
		      capturePointer(event.currentTarget, event.pointerId)
		      // 立刻重渲染一次：光标要马上从"手掌"变成"抓紧"（drag 是 ref，不主动刷不会重画）
		      forceRender((n) => n + 1)
		      return
		    }
		    if (event.button !== 0) return
		    const point = toWorld(event.clientX, event.clientY)
		    if (mode === 'point') {
		      commit((draft) => {
		        draft.annotations.push({ id: newId('ann'), n: draft.seq, kind: 'point', x: point.x, y: point.y, text: '', time: Date.now() })
		        draft.seq = draft.seq + 1
		        return draft
		      })
		      setMode('select')
		      // 落完点直接把标记浮层推上来：豆包那条链路也是"标完就地写说明"
		      setSheet('ann')
		      return
		    }
		    if (mode === 'rect' || mode === 'brush') {
		      drag.current = mode === 'rect'
		        ? { kind: 'rect', x0: point.x, y0: point.y, x1: point.x, y1: point.y }
		        : { kind: 'brush', points: [[point.x, point.y]] }
		      capturePointer(event.currentTarget, event.pointerId)
		      forceRender((n) => n + 1)
		      return
		    }
		    // 选择模式：空白处左键拖动 = 拉框多选（Shift 在原有选择上加）
		    drag.current = { kind: 'marquee', x0: point.x, y0: point.y, x1: point.x, y1: point.y, base: event.shiftKey === true ? selected.slice() : [] }
		    if (event.shiftKey !== true) setSelected([])
		    capturePointer(event.currentTarget, event.pointerId)
		    forceRender((n) => n + 1)
		  }, [commit, mode, selected, toWorld])

		  const onStagePointerMove = useCallback((event) => {
		    const state = drag.current
		    if (state === null) return
		    if (state.kind === 'pan') {
		      const dx = event.clientX - state.x
		      const dy = event.clientY - state.y
		      state.x = event.clientX
		      state.y = event.clientY
		      setDoc((current) => Object.assign({}, current, { view: { k: current.view.k, x: current.view.x + dx, y: current.view.y + dy } }))
		      return
		    }
		    const point = toWorld(event.clientX, event.clientY)
		    if (state.kind === 'rect') { state.x1 = point.x; state.y1 = point.y }
		    if (state.kind === 'brush') state.points.push([point.x, point.y])
		    if (state.kind === 'marquee') {
		      state.x1 = point.x
		      state.y1 = point.y
		      // 边拉边选（豆包也是这个手感）：与框相交的图片实时进选中集
		      const hit = doc.nodes.filter((node) => node.hidden !== true && intersects(state, node)).map((node) => node.id)
		      setSelected(state.base.length === 0 ? hit : state.base.concat(hit.filter((id) => state.base.indexOf(id) === -1)))
		    }
		    forceRender((n) => n + 1)
		  }, [doc.nodes, toWorld])

		  const onStagePointerUp = useCallback(() => {
		    const state = drag.current
		    drag.current = null
		    if (state === null) return
		    if (state.kind === 'rect') {
		      const x = Math.min(state.x0, state.x1)
		      const y = Math.min(state.y0, state.y1)
		      const w = Math.abs(state.x1 - state.x0)
		      const hh = Math.abs(state.y1 - state.y0)
		      if (w > 4 && hh > 4) {
		        commit((draft) => {
		          draft.annotations.push({ id: newId('ann'), n: draft.seq, kind: 'rect', x, y, w, h: hh, text: '', time: Date.now() })
		          draft.seq = draft.seq + 1
		          return draft
		        })
		      }
		      setMode('select')
		      setSheet('ann')
		    }
		    if (state.kind === 'brush') {
		      if (state.points.length > 2) {
		        commit((draft) => {
		          draft.annotations.push({ id: newId('ann'), n: draft.seq, kind: 'brush', points: state.points, text: '', time: Date.now() })
		          draft.seq = draft.seq + 1
		          return draft
		        })
		      }
		      setMode('select')
		      setSheet('ann')
		    }
		    forceRender((n) => n + 1)
		  }, [commit])

		  /**
		   * 拖动时的磁吸（对齐豆包）：把拖动的这一组与"别的图 / 视口中心"的边和中线对齐，
		   * 命中就吸过去并画参考线。容差是**屏幕 7px**（换算成世界单位，缩放后手感一致）。
		   */
		  const computeSnap = useCallback((state, dx, dy) => {
		    const k = doc.view.k
		    const tol = SNAP_PX / k
		    const movingIds = state.group.map((entry) => entry.id)
		    const moved = state.group.map((entry) => ({ x0: entry.ox + dx, y0: entry.oy + dy, x1: entry.ox + dx + entry.w, y1: entry.oy + dy + entry.h }))
		    const box = {
		      x0: Math.min(...moved.map((m) => m.x0)),
		      y0: Math.min(...moved.map((m) => m.y0)),
		      x1: Math.max(...moved.map((m) => m.x1)),
		      y1: Math.max(...moved.map((m) => m.y1)),
		    }
		    const anchorsX = [box.x0, (box.x0 + box.x1) / 2, box.x1]
		    const anchorsY = [box.y0, (box.y0 + box.y1) / 2, box.y1]
		    const targets = []   // { axis, at, from, to }
		    for (const node of doc.nodes) {
		      if (node.hidden === true || movingIds.indexOf(node.id) !== -1) continue
		      const nx = [node.x, node.x + node.w / 2, node.x + node.w]
		      const ny = [node.y, node.y + node.h / 2, node.y + node.h]
		      for (const value of nx) targets.push({ axis: 'x', at: value, from: Math.min(box.y0, node.y), to: Math.max(box.y1, node.y + node.h) })
		      for (const value of ny) targets.push({ axis: 'y', at: value, from: Math.min(box.x0, node.x), to: Math.max(box.x1, node.x + node.w) })
		    }
		    // 视口中心也给一条（居中对齐）
		    const stage = stageRef.current
		    if (stage !== null && stage !== undefined) {
		      const centerX = (stage.clientWidth / 2 - doc.view.x) / k
		      const centerY = (stage.clientHeight / 2 - doc.view.y) / k
		      targets.push({ axis: 'x', at: centerX, from: box.y0, to: box.y1 })
		      targets.push({ axis: 'y', at: centerY, from: box.x0, to: box.x1 })
		    }
		    let bestX = null
		    let bestY = null
		    for (const target of targets) {
		      const anchors = target.axis === 'x' ? anchorsX : anchorsY
		      for (const anchor of anchors) {
		        const delta = target.at - anchor
		        if (Math.abs(delta) > tol) continue
		        if (target.axis === 'x' && (bestX === null || Math.abs(delta) < Math.abs(bestX.delta))) bestX = { delta, target }
		        if (target.axis === 'y' && (bestY === null || Math.abs(delta) < Math.abs(bestY.delta))) bestY = { delta, target }
		      }
		    }
		    const guides = []
		    if (bestX !== null) guides.push({ axis: 'x', at: bestX.target.at, from: bestX.target.from, to: bestX.target.to })
		    if (bestY !== null) guides.push({ axis: 'y', at: bestY.target.at, from: bestY.target.from, to: bestY.target.to })
		    return { dx: dx + (bestX === null ? 0 : bestX.delta), dy: dy + (bestY === null ? 0 : bestY.delta), guides }
		  }, [doc.nodes, doc.view.k, doc.view.x, doc.view.y])

		  /** 拖动节点（多选时整组一起动），带磁吸与参考线。 */
		  const onNodePointerDown = useCallback((event, node) => {
		    if (mode !== 'select' || node.locked === true) return
		    event.stopPropagation()
		    setMenuOpen(false)
		    // Shift = 加选/减选，不进入拖动
		    if (event.shiftKey === true) {
		      setSelected((current) => (current.indexOf(node.id) === -1 ? current.concat(node.id) : current.filter((id) => id !== node.id)))
		      return
		    }
		    const group = selected.indexOf(node.id) === -1 ? [node.id] : selected.slice()
		    setSelected(group)
		    drag.current = {
		      kind: 'node',
		      id: node.id,
		      x: event.clientX,
		      y: event.clientY,
		      group: doc.nodes.filter((item) => group.indexOf(item.id) !== -1).map((item) => ({ id: item.id, ox: item.x, oy: item.y, w: item.w, h: item.h })),
		    }
		    capturePointer(event.currentTarget, event.pointerId)
		  }, [doc.nodes, mode, selected])

		  const onNodePointerMove = useCallback((event) => {
		    const state = drag.current
		    if (state === null || state.kind !== 'node') return
		    event.stopPropagation()
		    const k = doc.view.k
		    const rawDx = (event.clientX - state.x) / k
		    const rawDy = (event.clientY - state.y) / k
		    // 按住 Alt 时不做磁吸（想精确定位就用它）
		    const snapped = event.altKey === true ? { dx: rawDx, dy: rawDy, guides: [] } : computeSnap(state, rawDx, rawDy)
		    setGuides(snapped.guides)
		    setDoc((current) => Object.assign({}, current, {
		      nodes: current.nodes.map((node) => {
		        const item = state.group.find((entry) => entry.id === node.id)
		        return item === undefined ? node : Object.assign({}, node, { x: item.ox + snapped.dx, y: item.oy + snapped.dy })
		      }),
		    }))
		  }, [computeSnap, doc.view.k])

		  const onNodePointerUp = useCallback(() => {
		    if (drag.current !== null && drag.current.kind === 'node') drag.current = null
		    setGuides([])
		  }, [])

		  /** 缩放 / 旋转手柄（缩放支持 4 角 + 4 边，共 8 个方向）。 */
		  const onHandlePointerDown = useCallback((event, node, role, dir) => {
		    event.stopPropagation()
		    if (node.locked === true) return
		    setSelected([node.id])
		    drag.current = {
		      kind: role, id: node.id, x: event.clientX, y: event.clientY,
		      w0: node.w, h0: node.h, x0: node.x, y0: node.y, rot0: node.rot || 0,
		      dir: dir === undefined ? 'se' : dir,
		      ratio: node.w / Math.max(1, node.h),
		    }
		    capturePointer(event.currentTarget, event.pointerId)
		  }, [])

		  const onHandlePointerMove = useCallback((event) => {
		    const state = drag.current
		    if (state === null || (state.kind !== 'resize' && state.kind !== 'rotate')) return
		    event.stopPropagation()
		    if (state.kind === 'resize') {
		      const k = doc.view.k
		      const dx = (event.clientX - state.x) / k
		      const dy = (event.clientY - state.y) / k
		      const dir = state.dir
		      const min = 24
		      let w = state.w0
		      let h = state.h0
		      if (dir.indexOf('e') !== -1) w = state.w0 + dx
		      if (dir.indexOf('w') !== -1) w = state.w0 - dx
		      if (dir.indexOf('s') !== -1) h = state.h0 + dy
		      if (dir.indexOf('n') !== -1) h = state.h0 - dy
		      const corner = dir.length === 2
		      // 拖角默认**保持比例**（按住 Shift 放开比例）；拖边只改那一个方向
		      if (corner && event.shiftKey !== true) {
		        h = w / Math.max(0.0001, state.ratio)
		      }
		      w = Math.max(min, Math.round(w))
		      h = Math.max(min, Math.round(h))
		      // 锚点在对面：往西/北长的时候坐标要跟着挪，才能"从那边拉"
		      const x = dir.indexOf('w') !== -1 ? state.x0 + (state.w0 - w) : state.x0
		      const y = dir.indexOf('n') !== -1 ? state.y0 + (state.h0 - h) : state.y0
		      setDoc((current) => Object.assign({}, current, {
		        nodes: current.nodes.map((node) => (node.id === state.id ? Object.assign({}, node, { x, y, w, h }) : node)),
		      }))
		      return
		    }
		    const box = stageRef.current ? stageRef.current.getBoundingClientRect() : { left: 0, top: 0 }
		    const node = doc.nodes.find((item) => item.id === state.id)
		    if (node === undefined) return
		    const centerX = box.left + doc.view.x + (node.x + node.w / 2) * doc.view.k
		    const centerY = box.top + doc.view.y + (node.y + node.h / 2) * doc.view.k
		    const angle = Math.atan2(event.clientY - centerY, event.clientX - centerX) * 180 / Math.PI + 135
		    const snapped = event.shiftKey ? Math.round(angle / 15) * 15 : Math.round(angle)
		    setDoc((current) => Object.assign({}, current, {
		      nodes: current.nodes.map((item) => (item.id === state.id ? Object.assign({}, item, { rot: snapped }) : item)),
		    }))
		  }, [doc.nodes, doc.view])

		  const onHandlePointerUp = useCallback(() => {
		    if (drag.current !== null && (drag.current.kind === 'resize' || drag.current.kind === 'rotate')) drag.current = null
		    setGuides([])
		  }, [])

		  /**
		   * 画布内置剪贴板（对齐豆包画布右键：画布=粘贴，图片/多选=复制·粘贴·剪切·删除）。
		   * 存的是节点快照（不带 id），粘贴时重新发 id 并整体偏移一点，可以反复贴。
		   * 注意：这几个回调必须定义在 onKeyDown 之前——onKeyDown 的依赖数组在渲染时就要读到它们。
		   */
		  const clipboard = useRef([])

		  const copySelection = useCallback(() => {
		    const picked = doc.nodes.filter((node) => selected.indexOf(node.id) !== -1)
		    if (picked.length === 0) { showToast('先选中要复制的图片'); return }
		    clipboard.current = picked.map((node) => Object.assign({}, node))
		    showToast('已复制 ' + String(picked.length) + ' 张（粘贴到画布：右键或 Ctrl+V）')
		  }, [doc.nodes, selected, showToast])

		  const cutSelection = useCallback(() => {
		    const picked = doc.nodes.filter((node) => selected.indexOf(node.id) !== -1)
		    if (picked.length === 0) { showToast('先选中要剪切的图片'); return }
		    clipboard.current = picked.map((node) => Object.assign({}, node))
		    commit((draft) => { draft.nodes = draft.nodes.filter((node) => selected.indexOf(node.id) === -1); return draft })
		    setSelected([])
		    showToast('已剪切 ' + String(picked.length) + ' 张（Ctrl+V 粘回来）')
		  }, [commit, doc.nodes, selected, showToast])

		  /** 粘贴：贴到画布上（整体偏移，多次粘贴会级联错开），并选中贴出来的那些。 */
		  const pasteClipboard = useCallback(() => {
		    if (clipboard.current.length === 0) { showToast('剪贴板是空的（先在图片上右键复制/剪切）'); return }
		    // 新节点必须在外面先造好：commit 的 updater 是延后执行的（setDoc 里跑），
		    // 在里面收集 id 再 setSelected 会拿到空数组（2026-10-16 实测踩过）
		    const additions = clipboard.current.map((snapshot) => Object.assign({}, snapshot, {
		      id: newId('node'),
		      x: snapshot.x + 32,
		      y: snapshot.y + 32,
		      locked: false,
		    }))
		    commit((draft) => { draft.nodes = draft.nodes.concat(additions); return draft })
		    setSelected(additions.map((node) => node.id))
		    showToast('已粘贴 ' + String(additions.length) + ' 张')
		  }, [commit, showToast])

		  /**
		   * 智能对齐（对齐豆包多选后的「智能对齐」）：把选中的图片排成**一块矩形图片墙**，
		   * 而不是一条长横排——按当前左右顺序、统一格子与间距（24px）、每行居中，
		   * 块的整体长宽比尽量接近"画布那种"横向矩形（目标 1.5:1）。纯画布操作，不依赖模型。
		   */
		  const alignSelection = useCallback(() => {
		    const picked = doc.nodes
		      .filter((node) => selected.indexOf(node.id) !== -1)
		      .slice()
		      .sort((a, b) => (a.x - b.x) || (a.y - b.y))
		    if (picked.length < 2) { showToast('先框选两张以上再对齐'); return }
		    const count = picked.length
		    const gap = 24
		    const cellW = Math.max(...picked.map((node) => node.w))
		    const cellH = Math.max(...picked.map((node) => node.h))
		    const blockW = (cols) => cols * cellW + (cols - 1) * gap
		    const blockH = (cols) => Math.ceil(count / cols) * cellH + (Math.ceil(count / cols) - 1) * gap
		    let cols = count
		    if (count > 3) {
		      // 1~count 列都试一遍，选"整块长宽比"最接近 1.5 的那个（用对数比，宽窄偏差对称）
		      const target = 1.5
		      let best = null
		      for (let candidate = 1; candidate <= count; candidate++) {
		        const score = Math.abs(Math.log(blockW(candidate) / blockH(candidate) / target))
		        if (best === null || score < best.score) best = { candidate, score }
		      }
		      cols = best.candidate
		    }
		    const rows = Math.ceil(count / cols)
		    const totalW = blockW(cols)
		    const startX = Math.min(...picked.map((node) => node.x))
		    const startY = Math.min(...picked.map((node) => node.y))
		    const layout = new Map()
		    for (let index = 0; index < count; index++) {
		      const row = Math.floor(index / cols)
		      const column = index % cols
		      const inRow = Math.min(cols, count - row * cols)
		      const rowW = inRow * cellW + (inRow - 1) * gap
		      const rowStartX = startX + (totalW - rowW) / 2
		      const node = picked[index]
		      layout.set(node.id, {
		        x: Math.round(rowStartX + column * (cellW + gap) + (cellW - node.w) / 2),
		        y: Math.round(startY + row * (cellH + gap) + (cellH - node.h) / 2),
		      })
		    }
		    commit((draft) => {
		      draft.nodes = draft.nodes.map((node) => (layout.has(node.id) ? Object.assign({}, node, layout.get(node.id)) : node))
		      return draft
		    })
		    showToast('已排成 ' + String(cols) + '×' + String(rows) + ' 的方块（' + String(count) + ' 张）')
		  }, [commit, doc.nodes, selected, showToast])

		  /** 键盘：删除、撤销重做、剪贴板、对齐、取消选择。 */
		  const onKeyDown = useCallback((event) => {
		    const target = event.target
		    if (target !== null && target !== undefined && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
		    if (event.key === 'Delete' || event.key === 'Backspace') {
		      if (selected.length === 0) return
		      event.preventDefault()
		      commit((draft) => {
		        draft.nodes = draft.nodes.filter((node) => selected.indexOf(node.id) === -1)
		        return draft
		      })
		      setSelected([])
		      return
		    }
		    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && event.shiftKey !== true) { event.preventDefault(); undo() }
		    else if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'y' || (event.key.toLowerCase() === 'z' && event.shiftKey === true))) { event.preventDefault(); redo() }
		    // 智能对齐快捷键：Shift+A（对齐豆包多选后的那件事）
		    else if (event.shiftKey === true && event.key.toLowerCase() === 'a') { event.preventDefault(); alignSelection() }
		    // 画布内置剪贴板：Ctrl+C / Ctrl+X / Ctrl+V（跟豆包右键里那三件事同一套）
		    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') { event.preventDefault(); copySelection() }
		    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'x') { event.preventDefault(); cutSelection() }
		    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') { event.preventDefault(); pasteClipboard() }
		    else if (event.key === 'Escape') {
		      setSelected([])
		      setMode('select')
		      setMenuOpen(false)
		      window.clearTimeout(groupTimer.current)
		      setGroupPinned(false)
		      setOpenGroup('')
		      setCtxMenu(null)
		      // 浮层开着时，Esc 先收浮层（第二次才取消选择/退出工具）
		      setSheet((current) => (current === '' ? current : ''))
		    }
		    else if (event.key === 'f' && selected.length > 0) {
		      // 单选就铺满它；多选就铺满整组的包围盒
		      const picked = doc.nodes.filter((item) => selected.indexOf(item.id) !== -1)
		      const box = stageRef.current ? stageRef.current.getBoundingClientRect() : undefined
		      if (picked.length > 0 && box !== undefined) {
		        const minX = Math.min(...picked.map((item) => item.x))
		        const minY = Math.min(...picked.map((item) => item.y))
		        const maxX = Math.max(...picked.map((item) => item.x + item.w))
		        const maxY = Math.max(...picked.map((item) => item.y + item.h))
		        const w = Math.max(1, maxX - minX)
		        const h = Math.max(1, maxY - minY)
		        const k = Math.min(box.width / w, box.height / h, 4) * 0.86
		        setDoc((current) => Object.assign({}, current, {
		          view: { k, x: box.width / 2 - (minX + w / 2) * k, y: box.height / 2 - (minY + h / 2) * k },
		        }))
		      }
		    }
		  }, [alignSelection, commit, copySelection, cutSelection, doc.nodes, pasteClipboard, redo, selected, undo])

		  /** 导出 PNG（本地合成，不经任何服务）。 */
		  const exportPng = useCallback(async () => {
		    const visible = doc.nodes.filter((node) => node.hidden !== true)
		    if (visible.length === 0) { showToast('画布上没有可见的图片'); return }
		    const pad = 32
		    const minX = Math.min(...visible.map((n) => n.x))
		    const minY = Math.min(...visible.map((n) => n.y))
		    const maxX = Math.max(...visible.map((n) => n.x + n.w))
		    const maxY = Math.max(...visible.map((n) => n.y + n.h))
		    const width = Math.ceil(maxX - minX + pad * 2)
		    const height = Math.ceil(maxY - minY + pad * 2)
		    if (width * height > 80 * 1000 * 1000) { showToast('画布太大，导出被拒绝（>8000 万像素）'); return }
		    const canvas = document.createElement('canvas')
		    canvas.width = width
		    canvas.height = height
		    const context = canvas.getContext('2d')
		    if (context === null) { showToast('浏览器不支持 2D 画布'); return }
		    // 导出图的底色跟随当前画布主题：浅色导白底、深色导深底
		    context.fillStyle = effectiveDark ? '#0f0f10' : '#ffffff'
		    context.fillRect(0, 0, width, height)
		    for (const node of visible) {
		      const asset = assets.current.get(assetKey(node))
		      if (asset === undefined || asset.url === undefined) continue
		      try {
		        const image = await new Promise((resolve, reject) => {
		          const element = new window.Image()
		          element.onload = () => resolve(element)
		          element.onerror = () => reject(new Error('load failed'))
		          element.src = asset.url
		        })
		        context.save()
		        context.translate(node.x - minX + pad, node.y - minY + pad)
		        if (node.rot) {
		          context.translate(node.w / 2, node.h / 2)
		          context.rotate(node.rot * Math.PI / 180)
		          context.translate(-node.w / 2, -node.h / 2)
		        }
		        context.drawImage(image, 0, 0, node.w, node.h)
		        context.restore()
		      } catch { /* 单张失败就跳过，不阻塞整张导出 */ }
		    }
		    canvas.toBlob((blob) => {
		      if (blob === null) { showToast('导出失败'); return }
		      const url = URL.createObjectURL(blob)
		      const anchor = document.createElement('a')
		      anchor.href = url
		      anchor.download = 'canvas-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.png'
		      anchor.click()
		      window.setTimeout(() => URL.revokeObjectURL(url), 4000)
		      showToast('已导出 PNG')
		    }, 'image/png')
		  }, [doc.nodes, showToast])

		  /** 把批注整理成给 Agent 的提示词并复制。 */
		  const copyAnnotations = useCallback(async () => {
		    if (doc.annotations.length === 0) { showToast('还没有批注'); return }
		    const lines = ['【画布批注】请按下列意见修改画布上的图片（坐标是画布坐标，原点是画布左上角）：']
		    for (const annotation of doc.annotations) {
		      const where = annotation.kind === 'point'
		        ? '点选 @(' + Math.round(annotation.x) + ',' + Math.round(annotation.y) + ')'
		        : annotation.kind === 'rect'
		          ? '框选 @(' + Math.round(annotation.x) + ',' + Math.round(annotation.y) + ') 尺寸 ' + Math.round(annotation.w) + '×' + Math.round(annotation.h)
		          : '涂抹路径（' + (annotation.points ? annotation.points.length : 0) + ' 个点，起点 @(' + Math.round(annotation.points[0][0]) + ',' + Math.round(annotation.points[0][1]) + ')）'
		      lines.push(String(annotation.n) + '. ' + where + '：' + (annotation.text === '' ? '（未填写说明）' : annotation.text))
		    }
		    const text = lines.join('\n')
		    try {
		      await navigator.clipboard.writeText(text)
		      showToast('批注已复制，可直接粘贴到对话里')
		    } catch {
		      showToast('复制被浏览器拒绝，请手动从批注列表复制')
		    }
		  }, [doc.annotations, showToast])

		  const setAnnotationText = useCallback((id, text) => {
		    commit((draft) => {
		      draft.annotations = draft.annotations.map((item) => (item.id === id ? Object.assign({}, item, { text }) : item))
		      return draft
		    })
		  }, [commit])

		  const removeAnnotation = useCallback((id) => {
		    commit((draft) => {
		      draft.annotations = draft.annotations.filter((item) => item.id !== id)
		      return draft
		    })
		    if (activeAnn === id) setActiveAnn('')
		  }, [activeAnn, commit])

		  const toggleNodeFlag = useCallback((id, flag) => {
		    commit((draft) => {
		      draft.nodes = draft.nodes.map((node) => (node.id === id ? Object.assign({}, node, { [flag]: node[flag] !== true }) : node))
		      return draft
		    })
		  }, [commit])

		  const clearCanvas = useCallback(() => {
		    commit((draft) => { draft.nodes = []; draft.annotations = []; return draft })
		    setSelected([])
		    showToast('画布已清空（可 Ctrl+Z 撤销）')
		  }, [commit, showToast])

		  /** 从宿主重新载入画布（外部改过文档、或本地状态乱了时用）。 */
		  const reloadFromHost = useCallback(async () => {
		    try {
		      const fresh = await loadDoc(sessionId)
		      assets.current.clear()
		      history.current.past.length = 0
		      history.current.future.length = 0
		      setDoc(fresh)
		      setSelected([])
		      showToast('已从宿主重新载入（' + String(fresh.nodes.length) + ' 张）')
		    } catch (error) {
		      showToast('重载失败：' + String(error && error.message ? error.message : error))
		    }
		  }, [sessionId, showToast])

		  /**
		   * 把「选中图片所在目录」里的所有图片一次加到画布（已有的自动跳过）。
		   * 这是不依赖"点开图片"这条入口的加图方式：新生成一批图后，选一张、点一下即可。
		   */
		  const addFolder = useCallback(async () => {
		    const node = doc.nodes.find((item) => selected.indexOf(item.id) !== -1)
		    if (node === undefined) { showToast('先选中一张图，我按它的目录铺开'); return }
		    if (node.path === undefined || !node.path.includes('/')) { showToast('这张图不在子目录里，没有可铺的目录'); return }
		    const dir = node.path.slice(0, node.path.lastIndexOf('/'))
		    setBusyDir(true)
		    try {
		      const result = await listDir(sessionId, dir)
		      if (result.ok !== true) throw new Error(String(result?.error?.message ?? result?.error?.code ?? '列目录失败'))
		      const entries = Array.isArray(result.value?.entries) ? result.value.entries : []
		      const existing = new Set(doc.nodes.map((item) => item.address))
		      const encode = (relative) => relative.split('/').map((part) => encodeURIComponent(part)).join('/')
		      const additions = []
		      for (const entry of entries) {
		        const name = String(entry?.name ?? entry?.path ?? '')
		        const kind = String(entry?.kind ?? 'file')
		        if (name === '' || kind === 'directory' || !isImagePath(name)) continue
		        const relative = dir + '/' + name
		        const address = 'dsh-resource://file/session/' + sessionId + '/' + encode(relative)
		        if (existing.has(address)) continue
		        additions.push({ relative, address, name })
		      }
		      if (additions.length === 0) { showToast('这个目录里的图片都已经在画布上了'); return }
		      commit((draft) => {
		        let baseY = 40
		        for (const item of draft.nodes) baseY = Math.max(baseY, item.y + item.h + 60)
		        additions.forEach((item, index) => {
		          draft.nodes.push({
		            id: newId('node'),
		            address: item.address,
		            name: item.name,
		            path: item.relative,
		            x: 40 + (index % 4) * 320,
		            y: baseY + Math.floor(index / 4) * 280,
		            w: 280,
		            h: 200,
		            rot: 0,
		            locked: false,
		            hidden: false,
		          })
		        })
		        return draft
		      })
		      showToast('已铺上 ' + String(additions.length) + ' 张')
		    } catch (error) {
		      showToast('铺开失败：' + String(error && error.message ? error.message : error))
		    } finally {
		      setBusyDir(false)
		    }
		  }, [commit, doc.nodes, listDir, selected, sessionId, showToast])

		  /**
		   * 扫一个目录里能看的 3D 模型（3D 面板用）。
		   * 路径按 DSH 口径：相对会话工作目录，或绝对路径都行。
		   */
		  const scanModels = useCallback(async (dir) => {
		    const target = (dir === undefined || dir === null || String(dir).trim() === '') ? '.' : String(dir).trim()
		    setModelPick((current) => Object.assign({}, current, { busy: true, error: '', dir: target }))
		    try {
		      const result = await listDir(sessionId, target)
		      if (result.ok !== true) throw new Error(String(result?.error?.message ?? result?.error?.code ?? '列目录失败'))
		      const entries = Array.isArray(result.value?.entries) ? result.value.entries : []
		      const base = target === '.' || target === './' ? '' : (target.replace(/[\\/]+$/, '') + '/')
		      const files = []
		      for (const entry of entries) {
		        const name = String(entry?.name ?? entry?.path ?? '')
		        const kind = String(entry?.kind ?? 'file')
		        if (name === '' || kind === 'directory' || !isModelPath(name)) continue
		        files.push({ name, path: base + name })
		      }
		      setModelPick((current) => Object.assign({}, current, { busy: false, error: '', files }))
		    } catch (error) {
		      setModelPick((current) => Object.assign({}, current, { busy: false, files: [], error: String(error && error.message ? error.message : error) }))
		    }
		  }, [listDir, sessionId])

		  /** 把一个 3D 文件加到画布上（已存在就只选中它，不重复加）。 */
		  const addModel = useCallback((relative, label) => {
		    const clean = String(relative ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '')
		    if (clean === '') { showToast('先填一个模型路径'); return }
		    if (!isModelPath(clean)) { showToast('这不是 3D 模型（认 ' + MODEL_EXT.join(' / ') + '）'); return }
		    const address = sessionFileAddress(sessionId, clean)
		    const name = (label === undefined || label === '') ? basenameOf(clean) : String(label)
		    let existed = false
		    commit((draft) => {
		      const found = draft.nodes.find((item) => item.address === address)
		      if (found !== undefined) { existed = true; return draft }
		      const spot = dropSpot(draft.nodes)
		      draft.nodes.push({
		        id: newId('node'), kind: 'model', address, name, path: clean,
		        x: spot.x, y: spot.y, w: 380, h: 320,
		        rot: 0, locked: false, hidden: false,
		      })
		      return draft
		    })
		    showToast(existed === true ? '这个模型已经画布上了' : '已加入画布：' + name)
		  }, [commit, sessionId, showToast])

		  /**
		   * 走本地 ComfyUI 出图/改图。
		   * @param kind - 'txt2img' 生成新图 / 'img2img' 整图重绘 / 'inpaint' 按批注重绘
		   */
		  const runAi = useCallback(async (kind) => {
		    const source = doc.nodes.find((item) => selected.indexOf(item.id) !== -1)
		    if (kind !== 'txt2img' && source === undefined) { showToast('先在画布上选中一张图片'); return }
		    if (ai.checkpoint === '') { showToast('先选一个模型'); return }
		    if (ai.prompt.trim() === '') { showToast('先写提示词'); return }
		    setAi((current) => Object.assign({}, current, { busy: kind, error: '', info: '' }))
		    try {
		      const payload = {
		        sessionId,
		        mode: kind,
		        checkpoint: ai.checkpoint,
		        prompt: ai.prompt,
		        negative: ai.negative,
		        steps: Number(ai.steps),
		        cfg: Number(ai.cfg),
		        denoise: Number(ai.denoise),
		      }
		      if (kind === 'txt2img') {
		        payload.width = 832
		        payload.height = 1216
		      } else {
		        payload.width = Math.round(source.w)
		        payload.height = Math.round(source.h)
		        payload.sourcePng = await nodeToBase64(loadImage, sessionId, source)
		      }
		      if (kind === 'inpaint') {
		        const mask = nodeMaskBase64(source, doc.annotations)
		        if (mask === undefined) throw new Error('这张图上没有批注：先用「框选」或「涂抹」标出要改的区域')
		        payload.maskPng = mask
		      }
		      const response = await fetch(ROUTE + '/comfy/run', {
		        method: 'POST',
		        headers: { 'content-type': 'application/json' },
		        body: JSON.stringify(payload),
		      })
		      const body = await response.json().catch(() => ({}))
		      if (response.ok !== true || body.ok !== true) throw new Error(String(body.error ?? ('HTTP ' + String(response.status))))
		      const size = await measureUrl(body.url)
		      const label = 'AI · ' + (ai.prompt.trim().slice(0, 22) || kind)
		      commit((draft) => {
		        const position = kind === 'txt2img'
		          ? { x: 40 + draft.nodes.length * 36, y: 40 + draft.nodes.length * 24 }
		          : { x: source.x + source.w + 40, y: source.y }
		        draft.nodes.push({
		          id: newId('node'), address: '', url: body.url, name: label, path: String(body.path ?? ''),
		          x: position.x, y: position.y, w: size.w, h: size.h, rot: 0, locked: false, hidden: false,
		        })
		        return draft
		      })
		      setAi((current) => Object.assign({}, current, { busy: '', info: '完成，新图已放到画布上（' + String(body.name ?? '') + '）' }))
		      showToast('生成完成')
		    } catch (error) {
		      const message = String(error && error.message ? error.message : error)
		      setAi((current) => Object.assign({}, current, { busy: '', error: message }))
		      showToast('生成失败：' + message.slice(0, 60))
		    }
		  }, [ai, commit, doc.annotations, doc.nodes, loadImage, selected, sessionId, showToast])

		  const dragging = drag.current
		  const draftRect = dragging !== null && dragging.kind === 'rect'
		    ? { x: Math.min(dragging.x0, dragging.x1), y: Math.min(dragging.y0, dragging.y1), w: Math.abs(dragging.x1 - dragging.x0), h: Math.abs(dragging.y1 - dragging.y0) }
		    : undefined
		  const draftBrush = dragging !== null && dragging.kind === 'brush' ? dragging.points : undefined
		  const draftMarquee = dragging !== null && dragging.kind === 'marquee'
		    ? { x: Math.min(dragging.x0, dragging.x1), y: Math.min(dragging.y0, dragging.y1), w: Math.abs(dragging.x1 - dragging.x0), h: Math.abs(dragging.y1 - dragging.y0) }
		    : undefined

		  const selectedNodes = doc.nodes.filter((node) => selected.indexOf(node.id) !== -1)
		  const selectedNode = selectedNodes.length === 1 ? selectedNodes[0] : undefined
		  /**
		   * 选中区的包围盒（世界坐标）：工具条就挂在它的"上边中点"。
		   * 一张时 = 那张图的上方居中；多张时 = 整组的上方居中（不会跟着主选中项跳）。
		   */
		  const selBox = selectedNodes.length === 0 ? undefined : {
		    x0: Math.min(...selectedNodes.map((node) => node.x)),
		    y0: Math.min(...selectedNodes.map((node) => node.y)),
		    x1: Math.max(...selectedNodes.map((node) => node.x + node.w)),
		    y1: Math.max(...selectedNodes.map((node) => node.y + node.h)),
		  }
		  // 选中区贴着画布上沿时，工具条翻到内侧（不然会被面板边缘裁掉）
		  const flipBar = selBox !== undefined && doc.view.y + selBox.y0 * doc.view.k < 44

		  /**
		   * ⋯ 菜单的一行。菜单里放的是"低频但要有"的动作（导出/重载/同目录/撤销重做/主题/清空/自检），
		   * 这样主画布上只留 6 个高频图标按钮。
		   */
		  const menuRow = (icon, label, run, disabled) => h('button', {
		    key: label,
		    type: 'button',
		    disabled: disabled === true,
		    onPointerDown: (event) => event.stopPropagation(),
		    onClick: (event) => { event.stopPropagation(); setMenuOpen(false); run() },
		  }, Icon(icon), h('span', null, label))

		  /**
		   * 工具分组（对齐豆包画布的"悬停可选"）：一个按钮 = 一组工具，悬停/点击展开小浮层挑成员。
		   * 分组按钮直接显示"当前生效的那个成员"，不展开也知道自己在哪个工具上。
		   */
		  const TOOL_GROUPS = [
		    {
		      id: 'pointer',
		      label: '指针',
		      items: [
		        { mode: 'select', icon: 'cursor', label: '选择', hint: '拖动=框选多张 · 拖图=移动' },
		        { mode: 'hand', icon: 'hand', label: '拖动', hint: '按住平移画布' },
		      ],
		    },
		    {
		      id: 'annot',
		      label: '批注',
		      items: [
		        { mode: 'point', icon: 'pin', label: '标记', hint: '单击落一个编号标记' },
		        { mode: 'rect', icon: 'frame', label: '框选', hint: '拖出一块区域（当掩码）' },
		        { mode: 'brush', icon: 'brush', label: '涂抹', hint: '按住自由画（当掩码）' },
		      ],
		    },
		  ]

		  /** 选中分组里的一项：切过去、收起浮层。 */
		  const pickTool = (group, item) => {
		    setMode(item.mode)
		    setSheet('')
		    window.clearTimeout(groupTimer.current)
		    setGroupPinned(false)
		    setOpenGroup('')
		  }

		  /**
		   * 悬停开合：进来就开，离开**延迟 260ms** 再收（给鼠标一点时间跨到卡片上），
		   * 点开过的浮层钉住不收（再点一下 / 选一项 / Esc / 点画布才收）。
		   */
		  const holdGroup = (id) => {
		    window.clearTimeout(groupTimer.current)
		    setOpenGroup(id)
		  }
		  const releaseGroup = (id) => {
		    if (groupPinned === true) return
		    window.clearTimeout(groupTimer.current)
		    groupTimer.current = window.setTimeout(() => {
		      setOpenGroup((now) => (now === id ? '' : now))
		    }, 260)
		  }

		  /** 分组按钮 + 悬停展开的成员浮层。 */
		  const renderToolGroup = (groupId) => {
		    const group = TOOL_GROUPS.find((entry) => entry.id === groupId)
		    const current = group.items.find((item) => item.mode === mode)
		    const open = openGroup === groupId
		    return h('div', {
		      key: group.id,
		      className: 'icv-group',
		      onMouseEnter: () => holdGroup(group.id),
		      onMouseLeave: () => releaseGroup(group.id),
		    },
		      h('button', {
		        type: 'button',
		        className: 'icv-tool',
		        'data-icv-tool': 'group-' + group.id,
		        'data-on': current !== undefined ? '1' : '0',
		        title: group.label + '：' + group.items.map((item) => item.label).join(' / ') + (current === undefined ? '' : '（当前：' + current.label + '）'),
		        'aria-label': group.label,
		        'aria-expanded': open ? 'true' : 'false',
		        onPointerDown: (event) => event.stopPropagation(),
		        onClick: (event) => {
		          event.stopPropagation()
		          // 点开 = 钉住（鼠标移开也不收）；再点一下 = 收起
		          if (open) {
		            window.clearTimeout(groupTimer.current)
		            setGroupPinned(false)
		            setOpenGroup('')
		          } else {
		            holdGroup(group.id)
		            setGroupPinned(true)
		          }
		        },
		      }, Icon(current === undefined ? group.items[0].icon : current.icon), h('span', { className: 'icv-tool-more', 'aria-hidden': 'true' })),
		      open ? h('div', { className: 'icv-flyout', role: 'menu', 'data-drop': sheet === '' ? undefined : '1' },
		        h('div', { className: 'icv-flyout-card' }, group.items.map((item) => h('button', {
		          key: item.mode,
		          type: 'button',
		          className: 'icv-flyout-row',
		          'data-icv-pick': item.mode,
		          'data-on': mode === item.mode ? '1' : '0',
		          onPointerDown: (event) => event.stopPropagation(),
		          onClick: (event) => { event.stopPropagation(); pickTool(group, item) },
		        }, Icon(item.icon), h('span', { className: 'icv-flyout-label' }, item.label), h('span', { className: 'icv-flyout-hint' }, item.hint))))) : null,
		    )
		  }

		  /** 右键菜单（对齐豆包画布）：打开时按落点决定是"图片菜单"还是"画布菜单"。 */
		  const ctxRow = (icon, label, run, disabled) => h('button', {
		    key: label,
		    type: 'button',
		    disabled: disabled === true,
		    onPointerDown: (event) => event.stopPropagation(),
		    onClick: (event) => { event.stopPropagation(); setCtxMenu(null); run() },
		  }, Icon(icon), h('span', null, label))

		  /**
		   * 展开右键菜单：位置取"鼠标处"，并且**换算成面板内坐标**（菜单是 .icv-root 里的 absolute）。
		   * 之前直接拿 clientX/clientY（视口坐标）当面板坐标用，又被夹到 panelWidth-196 上，
		   * 结果不管点哪里菜单都落在同一个偏左的位置（2026-10-16 用户反馈）。
		   * 放不下时像系统菜单那样往左/往上翻，依旧贴着鼠标。
		   */
		  const openCtxMenu = (event, node) => {
		    event.preventDefault()
		    event.stopPropagation()
		    // 右键点在"已选中的那批"里 → 保留整批（这样框选多张后能直接右键复制/剪切）；
		    // 点在别的图上 → 改成只选它
		    if (node !== undefined && selected.indexOf(node.id) === -1) setSelected([node.id])
		    const root = containerRef.current
		    const rootBox = root !== null && root !== undefined
		      ? root.getBoundingClientRect()
		      : { left: 0, top: 0, width: 960, height: 640 }
		    const width = 196
		    const height = node === undefined ? 210 : 268
		    const margin = 6
		    let x = event.clientX - rootBox.left
		    let y = event.clientY - rootBox.top
		    if (x + width > rootBox.width - margin) x = x - width   // 右边放不下 → 翻到鼠标左侧
		    if (y + height > rootBox.height - margin) y = y - height // 下面放不下 → 翻到鼠标上方
		    x = Math.max(margin, Math.min(x, Math.max(margin, rootBox.width - width - margin)))
		    y = Math.max(margin, Math.min(y, Math.max(margin, rootBox.height - height - margin)))
		    setCtxMenu({ x: Math.round(x), y: Math.round(y), nodeId: node === undefined ? '' : node.id })
		    setMenuOpen(false)
		    setOpenGroup('')
		  }

		  /** 浮层标题栏：三个页签（标记 / 生成改图 / 3D）+ 复制批注 + 关闭。 */
		  const sheetHead = h('div', { className: 'icv-sheet-head' },
		    h('button', { key: 'tab-ann', type: 'button', className: 'icv-tab', 'data-on': sheet === 'ann' ? '1' : '0', onClick: () => setSheet('ann') }, '标记 ' + String(doc.annotations.length)),
		    h('button', { key: 'tab-gen', type: 'button', className: 'icv-tab', 'data-on': sheet === 'gen' ? '1' : '0', onClick: () => setSheet('gen') }, '生成 / 改图'),
		    h('button', { key: 'tab-3d', type: 'button', className: 'icv-tab', 'data-on': sheet === 'model' ? '1' : '0', onClick: () => setSheet('model') }, '3D 模型'),
		    h('span', { key: 'sp', style: { marginLeft: 'auto' } }),
		    doc.annotations.length === 0 ? null : h('button', { key: 'copy', className: 'icv-btn', onClick: copyAnnotations, title: '把批注整理成给 Agent 的提示词并复制到剪贴板' }, '复制批注(' + doc.annotations.length + ')'),
		    h('button', { key: 'close', type: 'button', className: 'icv-tool', 'data-icv-close': '1', title: '关闭', 'aria-label': '关闭', onClick: () => setSheet('') }, Icon('close')),
		  )

		  return h('div', {
		    className: 'icv-root',
		    tabIndex: 0,
		    onKeyDown,
		    ref: containerRef,
		    'data-icv-theme': theme === 'system' ? undefined : theme,
		    // 右键统一走我们自己的菜单：浏览器原生菜单（在图片上是"另存为图片"那套）一律不出现
		    onContextMenu: (event) => {
		      const node = doc.nodes.find((item) => item.id === nodeIdUnder(event.target))
		      openCtxMenu(event, node)
		    },
		  },

		    h('div', {
		      className: 'icv-stage',
		      ref: stageRef,
		      'data-panning': drag.current !== null && drag.current.kind === 'pan' ? '1' : '0',
		      // 滚轮不走 React 的 onWheel（那是 passive 的，preventDefault 会被忽略并刷警告），
		      // 改在 useEffect 里用 { passive: false } 原生挂（见 onWheel 下面的 useEffect）
		      onPointerDown: onStagePointerDown,
		      onPointerMove: onStagePointerMove,
		      onPointerUp: onStagePointerUp,
		      // 右键统一由根节点那份 onContextMenu 处理（这里再挂一个会把选择先清掉，菜单就丢了上下文）
		      // 光标：**只有「拖动」工具是手掌**（拿起=抓、按住拖=抓紧）；批注工具十字；选择工具=默认箭头
		      style: mode === 'hand'
		        ? { cursor: drag.current !== null && drag.current.kind === 'pan' ? 'grabbing' : 'grab' }
		        : (drawing ? { cursor: 'crosshair' } : { cursor: 'default' }),
		    },
		      h('div', { className: 'icv-world', style: { transform: 'translate(' + doc.view.x + 'px,' + doc.view.y + 'px) scale(' + doc.view.k + ')' } },
		        doc.nodes.map((node) => {
		          if (node.hidden === true) return null
		          const asset = assets.current.get(assetKey(node))
		          const loadError = asset !== undefined && asset.error !== undefined ? String(asset.error) : ''
		          const model = isModelNode(node)
		          const isSelected = selected.indexOf(node.id) !== -1
		          return h('div', {
		            key: node.id,
		            className: 'icv-node',
		            'data-node': node.id,
		            'data-kind': model ? 'model' : 'image',
		            'data-sel': isSelected ? '1' : '0',
		            style: {
		              left: node.x + 'px', top: node.y + 'px', width: node.w + 'px', height: node.h + 'px',
		              transform: node.rot ? 'rotate(' + node.rot + 'deg)' : undefined,
		              // 手柄/操作条用 --icv-inv 反向缩放，缩放画布时保持恒定大小
		              '--icv-inv': String(1 / Math.max(doc.view.k, 0.05)),
		              opacity: model ? 1 : (asset !== undefined && asset.error !== undefined ? 0.35 : 1),
		              // 批注工具 / 手模式下图片不吃指针事件：不然在图上落标记会变成拖图，
		              // 而且鼠标一移上去就变移动光标，让人误以为工具没生效（2026-10-16 用户反馈）
		              // 3D 节点同理，但选中后要能转模型（见 ModelNode 内部的 pointerEvents）
		              pointerEvents: mode === 'select' ? undefined : 'none',
		              cursor: node.locked === true ? 'default' : 'move',
		            },
		            onPointerDown: (event) => onNodePointerDown(event, node),
		            onPointerMove: onNodePointerMove,
		            onPointerUp: onNodePointerUp,
		            // 3D 节点：**未选中时右键也不弹画布菜单**（用户 2026-10-28 要求）。
		            // 未选中时 canvas 本身不吃事件，事件落在这个外层节点上，所以这里也要拦一道。
		            onContextMenu: model === true ? (event) => { event.preventDefault(); event.stopPropagation() } : undefined,
		          },
		            h('div', {
		              className: 'icv-node-label',
		              title: node.address + (loadError !== '' ? '\n' + loadError : ''),
		            }, node.name + (model ? '' : (loadError !== '' ? '（读取失败）' : (asset !== undefined && asset.converted === true ? '（已转码）' : '')))),
		            model
		              ? h(ModelNode, {
		                node,
		                sessionId,
		                loadImage,
		                interactive: mode === 'select' && isSelected,
		                dark: effectiveDark,
		                viewK: doc.view.k,
		              })
		              : asset !== undefined && asset.url !== undefined
		              ? h('img', { src: asset.url, alt: node.name, draggable: false, decoding: 'async' })
		              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', justifyContent: 'center', height: '100%', color: COLORS.dim, padding: '0 10px', boxSizing: 'border-box' } },
		                h('span', null, asset === undefined || asset.loading === true ? '载入中…' : '读取失败'),
		                // 失败原因直接显示在图里（而不是只塞 label）：用户/Agent 一眼能看出是
		                // 「文件不存在」「文件太大」还是「格式浏览器不支持」，不用再猜
		                loadError !== ''
		                  ? h('div', {
		                    style: { maxWidth: '100%', maxHeight: '54px', overflow: 'hidden', textAlign: 'center', fontSize: '10px', lineHeight: '1.35', color: COLORS.danger, wordBreak: 'break-word', opacity: 0.95 },
		                    title: loadError,
		                  }, loadError.length > 160 ? loadError.slice(0, 160) + '…' : loadError)
		                  : null,
		                loadError !== ''
		                  ? h('div', { style: { display: 'flex', gap: 6 } },
		                    h('button', {
		                      className: 'icv-btn',
		                      onPointerDown: (event) => event.stopPropagation(),
		                      onClick: (event) => {
		                        // 丢掉这次失败的缓存并强制重读（一次失败不该永久卡住这张图）
		                        event.stopPropagation()
		                        assets.current.delete(assetKey(node))
		                        forceRender((n) => n + 1)
		                      },
		                    }, '重试'),
		                    h('button', {
		                      className: 'icv-btn',
		                      title: '复制这个节点的资源地址（反馈问题时贴给 Agent 很有用）',
		                      onPointerDown: (event) => event.stopPropagation(),
		                      onClick: (event) => {
		                        event.stopPropagation()
		                        const text = node.address !== undefined && node.address !== '' ? node.address : String(node.url ?? '')
		                        void window.navigator.clipboard.writeText(text).then(() => showToast('地址已复制')).catch(() => showToast('复制失败'))
		                      },
		                    }, '复制地址'),
		                  )
		                  : null,
		              ),
		            // 缩放手柄/旋转点只在「选择」工具下出现：别的工具里图片不吃指针事件，
		            // 手柄画出来也点不动、光标还会是画布的手掌，纯属误导（2026-10-16 用户反馈）
		            mode === 'select' && selectedNodes.length === 1 && node.id === selectedNodes[0].id && node.locked !== true
		              ? RESIZE_DIRS.map((dir) => h('div', {
		                key: 'h-' + dir,
		                className: 'icv-handle',
		                'data-role': 'resize',
		                'data-dir': dir,
		                title: '拖动缩放（角上保持比例，Shift 放开；边上只改一个方向）',
		                onPointerDown: (event) => onHandlePointerDown(event, node, 'resize', dir),
		                onPointerMove: onHandlePointerMove,
		                onPointerUp: onHandlePointerUp,
		              })).concat([
		                h('div', {
		                  key: 'h-rot',
		                  className: 'icv-handle',
		                  'data-role': 'rotate',
		                  title: '拖动旋转（按住 Shift 吸附 15°）',
		                  onPointerDown: (event) => onHandlePointerDown(event, node, 'rotate'),
		                  onPointerMove: onHandlePointerMove,
		                  onPointerUp: onHandlePointerUp,
		                }, h('span', { className: 'icv-handle-icon' }, Icon('rotate'))),
		              ])
		              : null,
		          )
		        }),

		        // 拖动时的对齐参考线（豆包同款）：竖线画在被对齐的 x 上，横线画在被对齐的 y 上，
		        // 线宽按 1/k 反向缩放，任何缩放下都是 1px 细线
		        guides.map((guide, index) => h('div', {
		          key: 'guide-' + String(index),
		          className: 'icv-guide',
		          'data-axis': guide.axis,
		          style: guide.axis === 'x'
		            ? { left: guide.at + 'px', top: guide.from + 'px', width: (1 / Math.max(doc.view.k, 0.05)) + 'px', height: Math.max(guide.to - guide.from, 1) + 'px' }
		            : { top: guide.at + 'px', left: guide.from + 'px', height: (1 / Math.max(doc.view.k, 0.05)) + 'px', width: Math.max(guide.to - guide.from, 1) + 'px' },
		        })),

		        // 选中工具条：整个选中区**上方居中**（一张时就等于挂在那张图上方；多张时就在整组中间上方，
		        // 不会跟着"最后点的那张"跳）。反向缩放 → 缩放画布时它保持恒定大小（豆包同款）
		        selBox === undefined ? null : h('div', {
		          key: 'nodebar',
		          className: 'icv-nodebar',
		          'data-flip': flipBar ? '1' : undefined,
		          style: {
		            left: ((selBox.x0 + selBox.x1) / 2) + 'px',
		            top: (flipBar ? selBox.y0 + 6 / Math.max(doc.view.k, 0.05) : selBox.y0 - 6 / Math.max(doc.view.k, 0.05)) + 'px',
		            transform: 'translate(-50%,' + (flipBar ? '0' : '-100%') + ') scale(' + String(1 / Math.max(doc.view.k, 0.05)) + ')',
		            transformOrigin: flipBar ? 'top center' : 'bottom center',
		            display: 'flex',
		            gap: 2,
		          },
		          onPointerDown: (event) => event.stopPropagation(),
		        },
		          selectedNodes.length > 1
		            ? h('span', { className: 'icv-nodebar-count', key: 'n' }, String(selectedNodes.length) + ' 张')
		            : null,
		          // 单个图片（对齐豆包左键点图的工具条）：编辑 / 引用生成 / 锁定 / 隐藏 / 消除
		          selectedNodes.length === 1 ? ToolButton({
		            tool: 'node-edit', icon: 'edit',
		            title: '编辑：在这张图上标注（标记 / 框选 / 涂抹）',
		            onClick: () => { setMode('point'); setSheet('ann') },
		          }) : null,
		          // 回正 / 原尺寸：都在这个工具条上（2026-10-16 用户要求）
		          selectedNodes.length === 1 ? ToolButton({
		            tool: 'node-level', icon: 'uturn',
		            title: (selectedNodes[0].rot || 0) === 0 ? '回正：当前就是正的' : '回正：把角度摆回 0°',
		            disabled: (selectedNodes[0].rot || 0) === 0,
		            onClick: () => {
		              const id = selectedNodes[0].id
		              commit((draft) => { draft.nodes = draft.nodes.map((item) => (item.id === id ? Object.assign({}, item, { rot: 0 }) : item)); return draft })
		              showToast('已回正')
		            },
		          }) : null,
		          selectedNodes.length === 1 ? (() => {
		            const asset = assets.current.get(assetKey(selectedNodes[0]))
		            const natural = asset !== undefined && asset.w !== undefined ? { w: asset.w, h: asset.h } : null
		            const same = natural !== null && Math.round(selectedNodes[0].w) === Math.round(natural.w) && Math.round(selectedNodes[0].h) === Math.round(natural.h)
		            return ToolButton({
		              tool: 'node-natural', icon: 'natural',
		              title: natural === null
		                ? '原尺寸：这张图的原始尺寸还没量出来（等它加载完）'
		                : same ? '原尺寸：现在就是原始尺寸 ' + String(natural.w) + '×' + String(natural.h) : '原尺寸：还原成 ' + String(natural.w) + '×' + String(natural.h),
		              disabled: natural === null || same,
		              onClick: () => {
		                if (natural === null) return
		                const id = selectedNodes[0].id
		                commit((draft) => { draft.nodes = draft.nodes.map((item) => (item.id === id ? Object.assign({}, item, { w: natural.w, h: natural.h }) : item)); return draft })
		                showToast('已还原原始尺寸 ' + String(natural.w) + '×' + String(natural.h))
		              },
		            })
		          })() : null,
		          ToolButton({
		            tool: 'node-ref', icon: 'sparkle',
		            title: selectedNodes.length > 1
		              ? '引用生成：一次只能引用一张，先只选一张'
		              : '引用生成：把这张当参考图去改（本地 ComfyUI）',
		            disabled: selectedNodes.length !== 1,
		            onClick: () => { if (selectedNodes.length === 1) setSheet('gen') },
		          }),
		          // 多个图片（对齐豆包框选后的工具条）：引用生成 / 智能对齐
		          selectedNodes.length > 1 ? ToolButton({
		            tool: 'node-align', icon: 'align',
		            title: '智能对齐：排成一块矩形图片墙（统一间距、每行居中、按长宽比自动定列数）',
		            onClick: alignSelection,
		          }) : null,
		          selectedNodes.length === 1 ? ToolButton({
		            tool: 'node-lock', icon: 'lock',
		            title: selectedNodes[0].locked === true ? '解锁' : '锁定',
		            on: selectedNodes[0].locked === true,
		            onClick: () => toggleNodeFlag(selectedNodes[0].id, 'locked'),
		          }) : null,
		          ToolButton({
		            tool: 'node-del', icon: 'trash',
		            title: selectedNodes.length > 1 ? '消除这 ' + String(selectedNodes.length) + ' 张（Delete）' : '消除（Delete）',
		            onClick: () => { commit((draft) => { draft.nodes = draft.nodes.filter((item) => selected.indexOf(item.id) === -1); return draft }); setSelected([]) },
		          }),
		        ),

		        h('svg', { className: 'icv-ann-layer', style: { width: 1, height: 1, position: 'absolute', left: 0, top: 0 } },
		          doc.annotations.map((annotation) => {
		            if (annotation.kind === 'rect') {
		              return h('rect', {
		                key: annotation.id, x: annotation.x, y: annotation.y, width: annotation.w, height: annotation.h,
		                fill: annotation.id === activeAnn ? COLORS.warnBg : COLORS.onBg,
		                stroke: annotation.id === activeAnn ? COLORS.warn : COLORS.accent, strokeWidth: 1.5 / Math.max(doc.view.k, 0.4), rx: 4,
		              })
		            }
		            if (annotation.kind === 'brush') {
		              return h('polyline', {
		                key: annotation.id, fill: 'none', stroke: annotation.id === activeAnn ? COLORS.warn : COLORS.danger,
		                strokeWidth: 3 / Math.max(doc.view.k, 0.4), strokeLinecap: 'round', strokeLinejoin: 'round',
		                points: (annotation.points ?? []).map((point) => point[0] + ',' + point[1]).join(' '),
		              })
		            }
		            return null
		          }),
		          draftRect !== undefined ? h('rect', { x: draftRect.x, y: draftRect.y, width: draftRect.w, height: draftRect.h, fill: COLORS.warnBg, stroke: COLORS.warn, strokeWidth: 1.5 / Math.max(doc.view.k, 0.4), rx: 4 }) : null,
		          draftBrush !== undefined ? h('polyline', { fill: 'none', stroke: COLORS.warn, strokeWidth: 3 / Math.max(doc.view.k, 0.4), strokeLinecap: 'round', points: draftBrush.map((point) => point[0] + ',' + point[1]).join(' ') }) : null,
		          // 拉框多选的框：虚线 + 淡填充（和"框选批注"区分开：那个是橙色实线）
		          draftMarquee !== undefined ? h('rect', {
		            x: draftMarquee.x, y: draftMarquee.y, width: draftMarquee.w, height: draftMarquee.h,
		            fill: COLORS.onBg, stroke: COLORS.accent, strokeDasharray: String(6 / Math.max(doc.view.k, 0.4)) + ' ' + String(4 / Math.max(doc.view.k, 0.4)),
		            strokeWidth: 1.2 / Math.max(doc.view.k, 0.4), rx: 2,
		          }) : null,
		        ),

		        doc.annotations.filter((annotation) => annotation.kind === 'point').map((annotation) => h('div', {
		          key: annotation.id,
		          className: 'icv-pin',
		          'data-active': annotation.id === activeAnn ? '1' : '0',
		          // 编号徽标 + 虚线引线 + 落点小圆点（贴在设计稿上像"批注"，不像地图导航针）
		          style: { left: annotation.x + 'px', top: annotation.y + 'px', '--icv-inv': String(1 / Math.max(doc.view.k, 0.05)) },
		          onPointerDown: (event) => { event.stopPropagation(); setActiveAnn(annotation.id); setSheet('ann') },
		          title: annotation.text === '' ? '（未填写说明）' : annotation.text,
		        },
		          h('div', { key: 'badge', className: 'icv-pin-badge' }, String(annotation.n)),
		          h('div', { key: 'line', className: 'icv-pin-line' }),
		          h('div', { key: 'dot', className: 'icv-pin-dot' }),
		        )),
		      ),

		      doc.nodes.length === 0
		        ? h('div', { className: 'icv-empty' },
		          h('div', { style: { fontSize: 13, color: COLORS.text } }, '画布还是空的'),
		          h('div', null, '在对话里打开/生成一张图片，它会自动落到这里；'),
		          h('div', null, '也可以把图片文件拖进这个面板。'),
		          h('div', { style: { marginTop: 6 } }, '滚轮缩放 · 空白处拖动平移 · 选中后可缩放/旋转 · Delete 删除 · Ctrl+Z 撤销'))
		        : null,

		      mode === 'select' ? null : h('div', { className: 'icv-hint' },
		        mode === 'hand' ? '拖动：按住鼠标平移画布（Esc 回到选择）'
		          : mode === 'point' ? '标记：在图上单击落点，落完自动弹浮层写说明（Esc 退出）'
		            : mode === 'rect' ? '框选批注：按住拖出一个区域（Esc 退出）'
		              : '涂抹批注：按住自由画任意形状（Esc 退出）'),

		      toast === '' ? null : h('div', { className: 'icv-toast' }, toast),
		    ),

		    // ── 右下角悬浮工具组：两个"悬停展开"的分组（指针组 / 批注组）+ 生成 / 适应 / ⋯
		    // 对齐豆包：分组按钮显示当前成员，悬停或点击展开小浮层挑具体工具（2026-10-16 用户反馈）
		    // 浮层弹出时工具组让位到右上角，不被浮层盖住（缩放百分比始终可见）
		    h('div', { className: 'icv-float', style: sheet === '' ? undefined : { bottom: 'auto', top: '10px' } },
		      h('div', { className: 'icv-tools' },
		        ToolButton({ tool: 'gen', icon: 'sparkle', title: '生成 / 改图（本地 ComfyUI）', on: sheet === 'gen', onClick: () => setSheet(sheet === 'gen' ? '' : 'gen') }),
		        h('span', { key: 's1', className: 'icv-tool-sep' }),
		        renderToolGroup('pointer'),
		        renderToolGroup('annot'),
		        h('span', { key: 's2', className: 'icv-tool-sep' }),
		        ToolButton({ tool: 'model', icon: 'cube', title: '3D 模型：扫描/打开 .glb .fbx .obj .stl .ply（放到画布上直接旋转查看）', on: sheet === 'model', onClick: () => setSheet(sheet === 'model' ? '' : 'model') }),
		        ToolButton({ tool: 'fit', icon: 'fit', title: '适应视图（把所有图片装进视口）', onClick: fitView }),
		        ToolButton({ tool: 'more', icon: 'more', title: '更多：导出 / 重载 / 同目录 / 撤销重做 / 主题', on: menuOpen, onClick: () => setMenuOpen(!menuOpen) }),
		      ),
		      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
		        doc.annotations.length === 0 ? null : h('button', {
		          key: 'ann', type: 'button', className: 'icv-pill', 'data-icv-annpill': '1',
		          title: '标记列表（逐条写清要改什么）',
		          onClick: () => setSheet(sheet === 'ann' ? '' : 'ann'),
		        }, '标记 ' + String(doc.annotations.length)),
		        h('button', {
		          key: 'zoom', type: 'button', className: 'icv-pill', 'data-icv-zoom': '1',
		          title: doc.nodes.length + ' 张图 · 点击适应视图',
		          onClick: fitView,
		        }, Math.round(doc.view.k * 100) + '%'),
		      ),
		    ),

		    menuOpen ? h('div', { className: 'icv-menu', onPointerDown: (event) => event.stopPropagation() },
		      menuRow('download', '导出 PNG', exportPng, doc.nodes.length === 0),
		      menuRow('cube', '打开 3D 模型…', () => { setMenuOpen(false); setSheet('model'); void scanModels(modelPick.dir) }, false),
		      menuRow('folder', busyDir ? '同目录：铺开中…' : '同目录（整目录铺上画布）', () => { void addFolder() }, busyDir || selectedNodes.length === 0),
		      menuRow('refresh', '重载（从宿主重新读文档）', () => { void reloadFromHost() }, false),
		      h('div', { key: 's1', className: 'icv-menu-sep' }),
		      menuRow('undo', '撤销', undo, history.current.past.length === 0),
		      menuRow('redo', '重做', redo, history.current.future.length === 0),
		      h('div', { key: 's2', className: 'icv-menu-sep' }),
		      menuRow('theme', '主题：' + (THEME_LABEL[theme] ?? '跟随系统'), cycleTheme, false),
		      menuRow('eraser', '清空画布', clearCanvas, doc.nodes.length === 0),
		      h('div', { key: 's3', className: 'icv-menu-sep' }),
		      h('div', { key: 'meta', className: 'icv-menu-meta' },
		        h('div', { key: 'count', style: { color: COLORS.dim } }, doc.nodes.length + ' 张图 · ' + doc.annotations.length + ' 条标记'),
		        h('div', { key: 'svc', style: { color: serviceOk === true ? COLORS.dim : COLORS.danger } },
		          'build ' + BUILD_STAMP + (serviceOk === true ? ' · 读图服务就绪' : ' · 读图服务不可用：' + String(diagnostics ?? '（无）')))),
		    ) : null,

		    // ── 右键菜单：图片上 / 画布上两份（点别处、Esc、选完都收）
		    ctxMenu === null ? null : h('div', {
		      className: 'icv-ctx',
		      style: { left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' },
		      onPointerDown: (event) => event.stopPropagation(),
		      onContextMenu: (event) => { event.preventDefault(); event.stopPropagation() },
		    },
		      ctxMenu.nodeId === ''
		        ? [
		          ctxRow('paste', '粘贴', pasteClipboard, clipboard.current.length === 0),
		          h('div', { key: 'sep1', className: 'icv-menu-sep' }),
		          ctxRow('cursor', '全选（' + String(doc.nodes.length) + ' 张）', () => setSelected(doc.nodes.map((node) => node.id)), doc.nodes.length === 0),
		          ctxRow('fit', '适应视图', fitView, false),
		          ctxRow('download', '导出 PNG', exportPng, doc.nodes.length === 0),
		          h('div', { key: 'sep2', className: 'icv-menu-sep' }),
		          ctxRow('eraser', '清空画布', clearCanvas, doc.nodes.length === 0),
		        ]
		        : [
		          // 豆包那份的顺序：复制 / 粘贴 / 剪切 / 删除
		          ctxRow('copy', selectedNodes.length > 1 ? '复制这 ' + String(selectedNodes.length) + ' 张' : '复制', copySelection, false),
		          ctxRow('paste', '粘贴', pasteClipboard, clipboard.current.length === 0),
		          ctxRow('cut', selectedNodes.length > 1 ? '剪切这 ' + String(selectedNodes.length) + ' 张' : '剪切', cutSelection, false),
		          ctxRow('trash', '删除', () => {
		            commit((draft) => { draft.nodes = draft.nodes.filter((item) => selected.indexOf(item.id) === -1); return draft })
		            setSelected([])
		          }, false),
		          h('div', { key: 'sep', className: 'icv-menu-sep' }),
		          ctxRow('sparkle', '改这张图（本地 ComfyUI）', () => setSheet('gen'), selectedNodes.length !== 1),
		          ctxRow('folder', '同目录铺开', () => { void addFolder() }, busyDir),
		          ctxRow('lock', selectedNodes.every((item) => item.locked === true) ? '解锁' : '锁定', () => {
		            const lock = selectedNodes.every((item) => item.locked === true) !== true
		            commit((draft) => { draft.nodes = draft.nodes.map((item) => (selected.indexOf(item.id) === -1 ? item : Object.assign({}, item, { locked: lock }))); return draft })
		          }, false),
		        ],
		    ),
		    // ── 底部浮层：默认不弹（点 ✨ 或落完标记才出现），这样画布平时是干净的
		    sheet === '' ? null : h('div', { className: 'icv-sheet', onPointerDown: (event) => event.stopPropagation() },
		      sheetHead,
		      sheet === 'gen' ? h('div', { className: 'icv-panel' },
		      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
		        h('span', { style: { fontWeight: 600 } }, '本地改图（ComfyUI）'),
		        comfy.loading
		          ? h('span', { className: 'icv-row-meta' }, '检测中…')
		          : comfy.ok
		            ? h('span', { className: 'icv-row-meta', style: { color: COLORS.ok } }, '已连接 ' + comfy.url + ' · ' + String(comfy.checkpoints.length) + ' 个模型')
		            : h('span', { className: 'icv-row-meta', style: { color: COLORS.danger } }, '未连接（' + (comfy.error === '' ? '先启动本地 ComfyUI' : comfy.error) + '）'),
		      ),
		      h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' } },
		        h('select', {
		          value: ai.checkpoint,
		          onChange: (event) => {
		            const value = event.target.value
		            setAi((current) => Object.assign({}, current, { checkpoint: value }))
		            try { window.localStorage.setItem(CHECKPOINT_KEY, value) } catch { /* 存不进就算了 */ }
		          },
		          style: { maxWidth: '100%', background: COLORS.input, color: COLORS.text, border: '1px solid ' + COLORS.border, borderRadius: 6, padding: '3px 6px', font: 'inherit' },
		        },
		          comfy.checkpoints.length === 0
		            ? h('option', { value: ai.checkpoint }, ai.checkpoint === '' ? '（没有可用模型）' : ai.checkpoint)
		            : comfy.checkpoints.map((name) => h('option', { key: name, value: name }, name))),
		        h('button', {
		          key: 'adv', type: 'button', className: 'icv-btn', 'data-on': adv === true ? '1' : '0',
		          onClick: () => setAdv(!adv),
		          title: '步数 / CFG / 重绘强度 / 负面提示词',
		        }, '高级'),
		        adv === true ? h('label', { key: 'steps', className: 'icv-row-meta' }, '步数',
		          h('input', {
		            type: 'number', min: 1, max: 80, value: ai.steps,
		            onChange: (event) => setAi((current) => Object.assign({}, current, { steps: event.target.value })),
		            style: { width: 52, marginLeft: 4, background: COLORS.input, color: COLORS.text, border: '1px solid ' + COLORS.border, borderRadius: 6, padding: '2px 4px', font: 'inherit' },
		          })) : null,
		        adv === true ? h('label', { key: 'cfg', className: 'icv-row-meta' }, 'CFG',
		          h('input', {
		            type: 'number', min: 0, max: 20, step: 0.5, value: ai.cfg,
		            onChange: (event) => setAi((current) => Object.assign({}, current, { cfg: event.target.value })),
		            style: { width: 46, marginLeft: 4, background: COLORS.input, color: COLORS.text, border: '1px solid ' + COLORS.border, borderRadius: 6, padding: '2px 4px', font: 'inherit' },
		          })) : null,
		        adv === true ? h('label', { key: 'denoise', className: 'icv-row-meta' }, '重绘强度',
		          h('input', {
		            type: 'number', min: 0.05, max: 1, step: 0.05, value: ai.denoise,
		            onChange: (event) => setAi((current) => Object.assign({}, current, { denoise: event.target.value })),
		            style: { width: 54, marginLeft: 4, background: COLORS.input, color: COLORS.text, border: '1px solid ' + COLORS.border, borderRadius: 6, padding: '2px 4px', font: 'inherit' },
		          })) : null,
		      ),
		      h('textarea', {
		        value: ai.prompt,
		        placeholder: '描述想要的画面或修改（例如：把背景换成雨后的城市街道，保留主体）…',
		        onChange: (event) => setAi((current) => Object.assign({}, current, { prompt: event.target.value })),
		        style: { width: '100%', minHeight: 42, marginTop: 6, resize: 'vertical', background: COLORS.input, color: COLORS.text, border: '1px solid ' + COLORS.border, borderRadius: 6, padding: '4px 6px', font: 'inherit' },
		      }),
		      adv === true ? h('textarea', {
		        key: 'neg',
		        value: ai.negative,
		        placeholder: '负面提示词（可选）',
		        onChange: (event) => setAi((current) => Object.assign({}, current, { negative: event.target.value })),
		        style: { width: '100%', minHeight: 28, marginTop: 4, resize: 'vertical', background: COLORS.input, color: COLORS.text, border: '1px solid ' + COLORS.border, borderRadius: 6, padding: '4px 6px', font: 'inherit' },
		      }) : null,
		      h('div', { style: { display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' } },
		        h('button', { className: 'icv-btn', disabled: ai.busy !== '' || comfy.ok !== true, onClick: () => { void runAi('img2img') }, title: '把选中图片按提示词整体重绘（用重绘强度控制改动幅度）' },
		          ai.busy === 'img2img' ? '重绘中…' : '整图重绘'),
		        h('button', { className: 'icv-btn', disabled: ai.busy !== '' || comfy.ok !== true, onClick: () => { void runAi('inpaint') }, title: '只改你用「框选/涂抹」标出来的区域' },
		          ai.busy === 'inpaint' ? '重绘中…' : '按批注重绘'),
		        h('button', { className: 'icv-btn', disabled: ai.busy !== '' || comfy.ok !== true, onClick: () => { void runAi('txt2img') }, title: '不依赖任何图片，直接生成一张新图放到画布上' },
		          ai.busy === 'txt2img' ? '生成中…' : '生成新图'),
		        selectedNodes.length === 0 ? h('span', { className: 'icv-row-meta' }, '选中一张图才能重绘') : null,
		        selectedNodes.length === 1 ? h('span', { className: 'icv-row-meta' }, '引用生成：源图 = ' + selectedNodes[0].name) : null,
		      ),
		      ai.error === '' ? null : h('div', { style: { color: COLORS.danger, marginTop: 4 } }, ai.error),
		      ai.info === '' ? null : h('div', { style: { color: COLORS.ok, marginTop: 4 } }, ai.info),
		      )
		      : sheet === 'model' ? h('div', { className: 'icv-panel' },
		        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
		          h('span', { style: { fontWeight: 600 } }, '3D 模型预览'),
		          h('span', { className: 'icv-row-meta' }, '认 ' + MODEL_EXT.join(' / ')),
		          h('span', { className: 'icv-row-meta' }, '选中节点后：拖动旋转 · 右键平移 · 滚轮缩放'),
		        ),
		        h('div', { style: { display: 'flex', gap: 6, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' } },
		          h('input', {
		            value: modelPick.dir,
		            onChange: (event) => {
		              const value = event.target.value
		              setModelPick((current) => Object.assign({}, current, { dir: value }))
		            },
		            onKeyDown: (event) => { if (event.key === 'Enter') { event.stopPropagation(); void scanModels(modelPick.dir) } },
		            placeholder: '目录：相对会话工作目录，或绝对路径（默认 "."）',
		            style: { flex: '1 1 220px', minWidth: 140, background: COLORS.input, color: COLORS.text, border: '1px solid ' + COLORS.border, borderRadius: 6, padding: '3px 6px', font: 'inherit' },
		          }),
		          h('button', { className: 'icv-btn', disabled: modelPick.busy, onClick: () => { void scanModels(modelPick.dir) } },
		            modelPick.busy ? '扫描中…' : '扫描目录'),
		        ),
		        modelPick.error === '' ? null : h('div', { style: { color: COLORS.danger, marginTop: 4 } }, modelPick.error),
		        modelPick.files.length === 0
		          ? h('div', { className: 'icv-row-meta', style: { marginTop: 6 } },
		            modelPick.busy ? '正在列目录…' : '这个目录里没扫到 3D 文件（点上面的「扫描目录」，或者直接在下面粘一个路径）')
		          : h('div', { style: { marginTop: 6, maxHeight: 168, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 2 } },
		            modelPick.files.map((file) => h('div', { key: file.path, className: 'icv-row' },
		              h('span', {
		                style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 },
		                title: file.path,
		              }, file.name),
		              h('button', { className: 'icv-btn', onClick: () => addModel(file.path, file.name) }, '加入画布'),
		            )),
		          ),
		        h('div', { style: { display: 'flex', gap: 6, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' } },
		          h('input', {
		            value: modelPick.manual,
		            onChange: (event) => {
		              const value = event.target.value
		              setModelPick((current) => Object.assign({}, current, { manual: value }))
		            },
		            onKeyDown: (event) => { if (event.key === 'Enter') { event.stopPropagation(); addModel(modelPick.manual, '') } },
		            placeholder: '或直接粘一个模型路径（例如 tripo-out/whale_maid_joined.glb）',
		            style: { flex: '1 1 260px', minWidth: 160, background: COLORS.input, color: COLORS.text, border: '1px solid ' + COLORS.border, borderRadius: 6, padding: '3px 6px', font: 'inherit' },
		          }),
		          h('button', { className: 'icv-btn', onClick: () => addModel(modelPick.manual, '') }, '按路径加入'),
		        ),
		        h('div', { className: 'icv-row-meta', style: { marginTop: 6 } },
		          '对话里点开 .glb / .fbx / .obj / .stl / .ply / .gltf 文件也会直接落到这张画布上。'),
		      )
		      : doc.annotations.length === 0 ? h('div', { className: 'icv-row-meta' }, '还没有标记：点工具条上的「标记」，在图上落一个编号标记。')
		      : h('div', { className: 'icv-panel' },
		      doc.annotations.map((annotation) => h('div', { key: annotation.id, className: 'icv-row', onPointerEnter: () => setActiveAnn(annotation.id) },
		        h('span', { className: 'icv-badge' }, String(annotation.n)),
		        h('div', { className: 'icv-row-body' },
		          h('div', { className: 'icv-row-meta' },
		            annotation.kind === 'point' ? '点 @(' + Math.round(annotation.x) + ',' + Math.round(annotation.y) + ')'
		              : annotation.kind === 'rect' ? '框 ' + Math.round(annotation.w) + '×' + Math.round(annotation.h) + ' @(' + Math.round(annotation.x) + ',' + Math.round(annotation.y) + ')'
		                : '涂抹 ' + (annotation.points ? annotation.points.length : 0) + ' 点'),
		          h('textarea', {
		            value: annotation.text,
		            placeholder: '说明要改什么…',
		            onChange: (event) => setAnnotationText(annotation.id, event.target.value),
		            style: { width: '100%', minHeight: 34, marginTop: 4, resize: 'vertical', background: COLORS.input, color: COLORS.text, border: '1px solid ' + COLORS.border, borderRadius: 6, padding: '4px 6px', font: 'inherit' },
		          }),
		        ),
		        h('button', { className: 'icv-btn', onClick: () => removeAnnotation(annotation.id), title: '删除这条批注' }, '×'),
		      )),
		      ),
		    ),
		  )
		}

		/**
		 * 资源型 tab 的正文：把这张图收进画布，然后把自己换成常驻的画布页。
		 * 这样"打开一张图" = "往同一张无限画布上添一张图"，不会每张图开一个 tab。
		 */
		// ─────────────────────────────────────────── 3D 预览（three.js 运行时）
		//
		// 3D 模型节点不走 <img>，而是把字节交给 vendor/viewer.js（three.js + 各格式 loader，
		// 由宿主半边的 /plugins/dsh-image-canvas/vendor/ prefix 路由发出来）。
		//
		// 为什么运行时放 vendor 而不是内联进 client.js：
		//   ① client.js 现在 160 KB；内联 three 会变成 1.5 MB+，每次 HMR 都要重解析整块；
		//   ② 走 HTTP 能吃浏览器强缓存，且换 three 版本只动 vendor 目录。

		/** 运行时模块缓存（成功就复用；失败清掉，允许下一次重试）。 */
		let viewerPromise
		/** 已经读过的模型字节缓存（同一个文件重复渲染不必再走一次 RPC）。 */
		const modelBytesCache = new Map()

		/**
		 * vendor 目录里实际会被用到的文件（viewer.js 的依赖闭包）。
		 * loaders 是 viewer.js 里按需 `import('./xxx.js')` 拉的，所以要一起读进来、一起改写。
		 */
		const VENDOR_FILES = [
		  'viewer.js', // 入口本身也在列表里：多轮解析要等它的依赖全部就绪才会给它建 blob
		  'three.module.js',
		  'OrbitControls.js',
		  'RoomEnvironment.js',
		  'BufferGeometryUtils.js',
		  'GLTFLoader.js',
		  'DRACOLoader.js',
		  'KTX2Loader.js',
		  'WorkerPool.js',
		  'zstddec.module.js',
		  'ktx-parse.module.js',
		  'OBJLoader.js',
		  'MTLLoader.js',
		  'STLLoader.js',
		  'PLYLoader.js',
		  'FBXLoader.js',
		  'fflate.module.js',
		  'NURBSCurve.js',
		  'NURBSUtils.js',
		]

		/** 取一份文件的文本。 */
		async function readVendorText(readFile, name) {
		  const bytes = await readFile(name)
		  if (bytes === undefined || bytes === null || bytes.length === 0) throw new Error('vendor 里读不到 ' + name)
		  return new TextDecoder('utf-8').decode(bytes)
		}

		/**
		 * 把 vendor 目录里的 ES 模块拼成一棵 **blob 模块树**再 import。
		 *
		 * 为什么不是直接 `import('./xxx.js')`：blob URL 没有目录概念，相对导入会 404。
		 * 所以按依赖顺序逐个建 blob，并把每个文件里的 `'./dep.js'` 字面量替换成上游的 blob URL。
		 * 依赖图很浅（three 在最底，viewer 在最顶），多轮扫描即可全部就绪。
		 *
		 * @param readFile - async (vendorFileName) => Uint8Array
		 */
		async function importViewerFromVendorDir(readFile) {
		  const texts = new Map()
		  await Promise.all(VENDOR_FILES.map(async (fileName) => {
		    texts.set(fileName, await readVendorText(readFile, fileName))
		  }))

		  /**
		   * 匹配任意位置的相对模块路径字面量：`from './x.js'`、`import('./x.js')`，
		   * 以及 **`await getModule('./FBXLoader.js')` 这种把路径当参数传的写法**。
		   *
		   * 2026-10-28 的真 bug：原来只认前两种，viewer.js 的懒加载是第三种 →
		   * blob 里 `import('./FBXLoader.js')` 解析不到（blob URL 没有目录），FBX/GLB 全报"文件损坏"。
		   */
		  const depPattern = /(['"])\.\/([A-Za-z0-9_.\-]+\.js)\1/g
		  const depsOf = (source) => {
		    const found = new Set()
		    let match
		    depPattern.lastIndex = 0
		    while ((match = depPattern.exec(source)) !== null) found.add(match[2])
		    return found
		  }

		  const blobs = new Map()
		  const pending = new Set(VENDOR_FILES)
		  for (let round = 0; round < 8 && pending.size > 0; round++) {
		    let progressed = false
		    for (const fileName of Array.from(pending)) {
		      const source = texts.get(fileName)
		      const deps = depsOf(source)
		      let blocked = false
		      for (const dep of deps) {
		        if (!blobs.has(dep)) { blocked = true; break }
		      }
		      if (blocked) continue
		      const rewritten = source.replace(depPattern, (_full, quote, dep) => quote + blobs.get(dep) + quote)
		      const blobUrl = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }))
		      blobs.set(fileName, blobUrl)
		      pending.delete(fileName)
		      progressed = true
		    }
		    if (!progressed) break
		  }
		  if (!blobs.has('viewer.js')) {
		    const missing = Array.from(pending).join(', ')
		    throw new Error('vendor 依赖没解完（缺：' + missing + '）')
		  }
		  // blob URL 不 revoke：模块一旦 import 就引用着它，撤销会让已加载的模块失效
		  return await import(blobs.get('viewer.js'))
		}

		/** vendor 目录的绝对路径（由宿主探活路由告诉我们；宿主没重启时拿不到）。 */
		let vendorDirPromise
		function loadVendorDir() {
		  if (vendorDirPromise !== undefined) return vendorDirPromise
		  vendorDirPromise = (async () => {
		    try {
		      const response = await fetch(ROUTE + '/probe')
		      if (!response.ok) return ''
		      const body = await response.json()
		      return body !== null && typeof body === 'object' && typeof body.vendor === 'string' ? body.vendor : ''
		    } catch { return '' }
		  })()
		  return vendorDirPromise
		}

		/**
		 * 读一个 vendor 文件的字节（回退路径才用）：
		 *   ① 先按会话工作目录下的 `dsh-image-canvas/vendor/` 找（插件是 link 进 profile 的，通常就在工作区里）；
		 *   ② 找不到再用宿主探活回报的绝对路径（别的工作区里也能用）。
		 */
		async function readVendorFile(loadImage, sessionId, fileName) {
		  const relative = 'dsh-image-canvas/vendor/' + fileName
		  try {
		    return await readImageBytes(loadImage, sessionId, relative)
		  } catch (first) {
		    const dir = await loadVendorDir()
		    if (dir === '') throw first
		    return await readImageBytes(loadImage, sessionId, dir.replace(/\\/g, '/') + '/' + fileName)
		  }
		}

		/**
		 * 取 3D 运行时模块（两条路，先快后稳）：
		 *   ① 同源路由 `/plugins/dsh-image-canvas/vendor/viewer.js`（宿主重启后可用，吃浏览器强缓存）；
		 *   ② 回退到从工作区目录 `dsh-image-canvas/vendor/` 读字节 + blob 模块树（不用重启就能跑）。
		 *
		 * @param readFile - async (fileName) => Uint8Array（只有回退路径才会用到）
		 */
		function loadViewerModule(readFile) {
		  if (viewerPromise !== undefined) return viewerPromise
		  viewerPromise = (async () => {
		    try {
		      return await import(VIEWER_URL)
		    } catch (routeError) {
		      try {
		        return await importViewerFromVendorDir(readFile)
		      } catch (dirError) {
		        const a = String(routeError && routeError.message ? routeError.message : routeError)
		        const b = String(dirError && dirError.message ? dirError.message : dirError)
		        const friendly = new Error('3D 运行时没加载起来。路由：' + a + ' / 目录：' + b)
		        friendly.code = 'viewer-unavailable'
		        throw friendly
		      }
		    }
		  })().catch((error) => {
		    viewerPromise = undefined // 失败允许下次重试（例如重启后路由好了）
		    throw error
		  })
		  return viewerPromise
		}

		/**
		 * 读一个 3D 节点的全部字节（复用图片那条分块读逻辑：整文件 → 太大就 range 拼）。
		 * readImageBytes 虽然叫 image，做的其实就是"把文件完整读回来"，模型照样能用。
		 */
		async function readModelBytes(loadImage, sessionId, node, signal) {
		  const address = typeof node.address === 'string' ? node.address : ''
		  const parsed = parseFileAddress(address)
		  const targetSession = parsed !== undefined ? parsed.sessionId : sessionId
		  const path = parsed !== undefined ? parsed.path : (typeof node.path === 'string' ? node.path : '')
		  if (path === '') throw new Error('这个 3D 节点没有可读的文件路径')
		  const bytes = await readImageBytes(loadImage, targetSession, path, signal)
		  if (bytes.length > MODEL_BYTES_LIMIT) {
		    throw new Error('模型太大（超过 ' + String(Math.round(MODEL_BYTES_LIMIT / 1024 / 1024)) + ' MiB），先在 Blender 里减面/压缩再看')
		  }
		  return bytes
		}

		/** 把 viewer 回报的模型信息拼成一行人话。 */
		function describeModelInfo(info) {
		  if (info === undefined || info === null) return ''
		  const parts = []
		  if (info.meshes !== undefined) parts.push(String(info.meshes) + ' 个网格')
		  if (info.triangles !== undefined) parts.push(String(Math.round(info.triangles)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' 面')
		  return parts.join(' · ')
		}

		/**
		 * 诊断开关：默认**关**。
		 * 排查 3D 问题时在控制台执行 `localStorage.setItem('dsh-image-canvas:diag', '1')` 再刷新，
		 * 加载过程就会写到宿主 state 的 `icv-3d-diag` / `icv-diag` 假会话里，Agent 侧可以直接读回。
		 */
		function diagEnabled() {
		  try { return window.localStorage.getItem(PKG + ':diag') === '1' } catch { return false }
		}

		/** 3D 节点诊断：把关键节点的状态写到宿主 state（假会话 id），Agent 侧可读回。失败静默。 */
		function report3dDiag(line) {
		  if (diagEnabled() !== true) return
		  try {
		    void fetch(ROUTE + '/state?sessionId=' + encodeURIComponent('icv-3d-diag'), {
		      method: 'PUT',
		      headers: { 'content-type': 'application/json' },
		      body: JSON.stringify({ doc: { at: new Date().toISOString(), line: String(line).slice(0, 700) } }),
		    }).catch(() => { /* 诊断写不进去不影响功能 */ })
		  } catch { /* 同上 */ }
		}

		/**
		 * 画布上的一个 3D 节点。
		 *
		 * 交互口径（和图片节点保持一致的心智模型）：
		 *   - 没选中：canvas 不吃指针事件 → 拖动画布、拉框多选都能穿过它；
		 *   - 选中之后：canvas 吃事件 → 左键转、右键平移、滚轮缩放（不让画布跟着缩放）；
		 *   - 滚轮/按键一律 stopPropagation，不然会把画布的 view 一起改了。
		 */
		function ModelNode(props) {
		  const node = props.node
		  const sessionId = props.sessionId
		  const loadImage = props.loadImage
		  const interactive = props.interactive === true
		  const dark = props.dark === true
		  const viewK = props.viewK
		  const canvasRef = useRef(null)
		  const viewerRef = useRef(undefined)
		  const applied = useRef('')
		  const [state, setState] = useState({ status: 'loading', error: '', info: '' })

		  // 建 viewer + 读字节 + 载模型（节点换了才重建）
		  useEffect(() => {
		    let disposed = false
		    const canvas = canvasRef.current
		    if (canvas === null) return undefined
		    void (async () => {
		      try {
		        setState({ status: 'loading', error: '', info: '' })
		        // vendor 回退路径：先按会话工作目录找 dsh-image-canvas/vendor/，再退到宿主回报的绝对路径
		        const readVendor = (fileName) => readVendorFile(loadImage, sessionId, fileName)
		        const mod = await loadViewerModule(readVendor)
		        if (disposed) return
		        const viewer = await mod.createViewer(canvas, { dark })
		        if (disposed) { try { viewer.dispose() } catch { /* 已卸载 */ } return }
		        viewerRef.current = viewer
		        const key = String(node.address ?? '') + '|' + String(node.path ?? '')
		        let bytes = modelBytesCache.get(key)
		        if (bytes === undefined) {
		          bytes = await readModelBytes(loadImage, sessionId, node)
		          // 只缓存小文件，避免把几十 MB 的模型常驻内存
		          if (bytes.length <= 24 * 1024 * 1024) modelBytesCache.set(key, bytes)
		        }
		        if (disposed) return
		        const info = await viewer.load({ bytes, name: node.name, ext: extOf(node.path ?? node.address ?? '') })
		        if (disposed) return
		        try { console.log('[image-canvas] 3D 节点已载入:', node.name, info) } catch { /* 日志失败无所谓 */ }
		        if (typeof viewer.setPixelRatio === 'function') {
		          try { viewer.setPixelRatio(Math.min((window.devicePixelRatio || 1) * Math.max(viewK, 0.5), 3)) } catch { /* 可选能力 */ }
		        }
		        viewer.resize()
		        // 画布页可能是在"面板不可见"的时候挂载的：那会儿 rAF 不跑，viewer 的省电渲染不会出第一帧
		        // → 用户打开面板看到一块空白。这里主动补一帧，并记下真实渲染调用数（calls>0 才叫画出来了）。
		        try {
		          if (typeof viewer.frame === 'function') viewer.frame()
		          if (typeof viewer.render === 'function') viewer.render()
		        } catch { /* 补帧失败不影响加载 */ }
		        setState({ status: 'ready', error: '', info: describeModelInfo(info) })
		        try {
		          const rect = canvas.getBoundingClientRect()
		          const computed = window.getComputedStyle(canvas)
		          const info2 = viewer.renderer !== undefined && viewer.renderer.info !== undefined ? viewer.renderer.info.render : {}
		          report3dDiag('rect ' + [rect.width, rect.height].map((n) => Math.round(n * 10) / 10).join('x') +
		            ' css=' + computed.width + 'x' + computed.height + ' display=' + computed.display +
		            ' buffer=' + String(canvas.width) + 'x' + String(canvas.height) +
		            ' parent=' + String(canvas.parentElement === null ? 'none' : Math.round(canvas.parentElement.getBoundingClientRect().height)) +
		            ' calls=' + String(info2.calls) + ' tris=' + String(info2.triangles))
		        } catch (error) { report3dDiag('rect-error ' + String(error && error.message ? error.message : error)) }
		      } catch (error) {
		        if (disposed) return
		        const message = String(error && error.message ? error.message : error)
		        report3dDiag('ERROR ' + message)
		        setState({ status: 'error', error: message, info: '' })
		      }
		    })()
		    return () => {
		      disposed = true
		      const viewer = viewerRef.current
		      viewerRef.current = undefined
		      applied.current = ''
		      try { if (viewer !== undefined) viewer.dispose() } catch { /* 释放失败不影响界面 */ }
		    }
		    // 只跟着"节点身份"重建：w/h/view.k 的变化走下面的 resize effect
		  }, [sessionId, node.address, node.path, node.name])

		  // 主题变化：只换背景/环境，不重新载模型
		  useEffect(() => {
		    const viewer = viewerRef.current
		    if (viewer === undefined) return
		    try { viewer.setTheme(dark === true ? 'dark' : 'light') } catch { /* 可选能力 */ }
		  }, [dark])

		  // 节点尺寸 / 画布缩放变化 → 重设渲染分辨率（按缩放提升像素比，放大后不发糊）
		  useEffect(() => {
		    const viewer = viewerRef.current
		    if (viewer === undefined) return
		    const key = String(Math.round(node.w)) + 'x' + String(Math.round(node.h)) + '@' + String(Math.round(viewK * 100))
		    if (applied.current === key) return
		    applied.current = key
		    const run = () => {
		      const current = viewerRef.current
		      if (current === undefined) return
		      try {
		        if (typeof current.setPixelRatio === 'function') {
		          current.setPixelRatio(Math.min((window.devicePixelRatio || 1) * Math.max(viewK, 0.5), 3))
		        }
		        current.resize()
		      } catch { /* 尺寸变化失败下一帧会再试 */ }
		    }
		    // 缩放拖动时 view.k 每帧都在变，合并到下一帧，别把一个滚轮拆成几十次 setSize
		    const timer = window.setTimeout(run, 40)
		    return () => { window.clearTimeout(timer) }
		  }, [viewK, node.w, node.h, state.status])

		  // 选中后 canvas 才吃指针事件：滚轮交给 OrbitControls，但不能再冒泡去缩放画布
		  useEffect(() => {
		    const canvas = canvasRef.current
		    if (canvas === null) return undefined
		    const stopWheel = (event) => {
		      if (interactive !== true) return
		      event.stopPropagation()
		    }
		    canvas.addEventListener('wheel', stopWheel, { passive: true })
		    return () => { canvas.removeEventListener('wheel', stopWheel) }
		  }, [interactive])

		  return h('div', {
		    className: 'icv-3d',
		    'data-state': state.status,
		    // 选中态才让模型接管鼠标；否则这一层完全透明，画布照常拖
		    style: { pointerEvents: interactive ? 'auto' : 'none' },
		    onPointerDown: (event) => { if (interactive === true) event.stopPropagation() },
		    onPointerMove: (event) => { if (interactive === true) event.stopPropagation() },
		    onPointerUp: (event) => { if (interactive === true) event.stopPropagation() },
		    onDoubleClick: (event) => { event.stopPropagation() },
		    /**
		     * 右键菜单的口径（2026-10-28 用户两轮反馈定稿）：
		     *   **只要鼠标在 3D 视口上，右键就只服务于视角操作，一律不弹画布菜单** ——
		     *   不管是按住拖动（平移视角）还是单击。
		     * 原先按"拖没拖过"区分是错的：右键单击那一瞬间 OrbitControls 也会收到一次 pan 起手，
		     * 视角会轻微动一下，再弹菜单就更别扭。节点操作改走选中后上方的工具条 / Delete 键。
		     */
		    onContextMenu: (event) => {
		      if (interactive !== true) return
		      event.preventDefault()
		      event.stopPropagation()
		    },
		  },
		    h('canvas', { ref: canvasRef, className: 'icv-3d-canvas' }),
		    state.status === 'ready'
		      ? null
		      : h('div', { className: 'icv-3d-tip' }, state.status === 'loading' ? '3D 载入中…' : '3D 加载失败'),
		    state.status === 'ready' && state.info !== ''
		      ? h('div', { className: 'icv-3d-info' }, state.info)
		      : null,
		    state.error !== ''
		      ? h('div', { className: 'icv-3d-err', title: state.error }, state.error)
		      : null,
		    interactive === true && state.status === 'ready'
		      ? h('div', { className: 'icv-3d-hint' }, '拖动旋转 · 右键平移 · 滚轮缩放')
		      : null,
		  )
		}

		function ImageIntake(props) {
		  const info = props.useTabInfo()
		  const tab = info.tab
		  const address = tab.contentId
		  const sessionId = props.sessionId
		  const [error, setError] = useState('')
		  const done = useRef(false)

		  useEffect(() => {
		    if (done.current) return
		    done.current = true
		    void (async () => {
		      try {
		        const doc = await loadDoc(sessionId)
		        if (doc.nodes.some((node) => node.address === address)) {
		          tab.actions.openTab(PAGE_KIND, { replaceTab: true })
		          return
		        }
		        const index = doc.nodes.length
		        const parsed = parseFileAddress(address)
		        doc.nodes.push({
		          id: newId('node'),
		          address,
		          name: basenameOf(address),
		          path: parsed === undefined ? '' : parsed.path,
		          x: 40 + (index % 4) * 320,
		          y: 40 + Math.floor(index / 4) * 280,
		          w: 280,
		          h: 200,
		          rot: 0,
		          locked: false,
		          hidden: false,
		        })
		        saveDoc(sessionId, doc)
		        tab.actions.openTab(PAGE_KIND, { replaceTab: true })
		      } catch (caught) {
		        setError(String(caught && caught.message ? caught.message : caught))
		      }
		    })()
		  }, [address, sessionId, tab])

		  return h('div', { className: 'icv-root' },
		    h('div', { className: 'icv-hint', style: { position: 'static', transform: 'none', margin: 16 } },
		      error === '' ? '正在把图片加入无限画布…' : '加入失败：' + error),
		  )
		}

		/**
		 * 3D 资源 tab 的接引页：把一个 dsh-resource:// 的 3D 文件收进画布（然后换成画布页）。
		 * 与 ImageIntake 同一套做法，区别只有：节点带 kind='model'、默认画大一点。
		 */
		function ModelIntake(props) {
		  const info = props.useTabInfo()
		  const tab = info.tab
		  const address = tab.contentId
		  const sessionId = props.sessionId
		  const [error, setError] = useState('')
		  const done = useRef(false)

		  useEffect(() => {
		    if (done.current) return
		    done.current = true
		    void (async () => {
		      try {
		        const doc = await loadDoc(sessionId)
		        if (doc.nodes.some((node) => node.address === address)) {
		          tab.actions.openTab(PAGE_KIND, { replaceTab: true })
		          return
		        }
		        const parsed = parseFileAddress(address)
		        const relative = parsed === undefined ? '' : parsed.path
		        const spot = dropSpot(doc.nodes)
		        doc.nodes.push({
		          id: newId('node'),
		          kind: 'model',
		          address,
		          name: basenameOf(address),
		          path: relative,
		          // 模型按包围盒自适应，给个偏方形的框更好看
		          x: spot.x, y: spot.y, w: 380, h: 320,
		          rot: 0,
		          locked: false,
		          hidden: false,
		        })
		        saveDoc(sessionId, doc)
		        tab.actions.openTab(PAGE_KIND, { replaceTab: true })
		      } catch (caught) {
		        setError(String(caught && caught.message ? caught.message : caught))
		      }
		    })()
		  }, [address, sessionId, tab])

		  return h('div', { className: 'icv-root' },
		    h('div', { className: 'icv-hint', style: { position: 'static', transform: 'none', margin: 16 } },
		      error === '' ? '正在把 3D 模型加入无限画布…' : '加入失败：' + error),
		  )
		}

		/** 新节点落点：按已有节点数错开铺（避免全叠在左上角）。 */
		function dropSpot(nodes) {
		  let baseY = 40
		  for (const node of nodes) baseY = Math.max(baseY, node.y + node.h + 60)
		  const index = nodes.length
		  return { x: 40 + (index % 3) * 420, y: index < 3 ? 40 : baseY }
		}

		// ─────────────────────────────────────────── 画布面板外部：右键图片「放入无限画布」
		// 2026-10-17 用户需求：聊天里/文件树里的图片，鼠标移上去只有"左键放大"；
		// 想要右键一个「放入无限画布」。这里的菜单挂在 document.body 上（画布面板外面没有 React 容器），
		// 插入走宿主的 /state 路由，插完广播一个事件让已打开的画布页重新读文档。

		/** 画布页 ↔ 面板外菜单 的桥：画布页挂载时把 sessionId 记在这儿。 */
		const canvasBridge = { sessionId: '' }

		const EXT_MENU_CLASS = 'icv-extmenu'
		const EXT_TOAST_CLASS = 'icv-exttoast'

		/** 关掉面板外的右键菜单。 */
		function closeExtMenu() {
		  const current = window.document.querySelector('.' + EXT_MENU_CLASS)
		  if (current !== null && current !== undefined) current.remove()
		}

		/** 弹一条 3 秒就消失的提示（画布面板外没有 React，直接写 DOM）。 */
		function extToast(text) {
		  const old = window.document.querySelector('.' + EXT_TOAST_CLASS)
		  if (old !== null && old !== undefined) old.remove()
		  const el = window.document.createElement('div')
		  el.className = EXT_TOAST_CLASS
		  el.textContent = text
		  el.style.cssText = 'position:fixed;left:50%;bottom:40px;transform:translateX(-50%);z-index:2147483000;' +
		    'padding:8px 14px;border-radius:10px;background:rgba(24,26,30,.92);color:#fff;font:13px/1.4 "Microsoft YaHei",sans-serif;' +
		    'box-shadow:0 8px 24px rgba(0,0,0,.28);pointer-events:none;cursor:default'
		  window.document.body.appendChild(el)
		  window.setTimeout(() => { el.remove() }, 3000)
		}

		/**
		 * 在鼠标处弹一个小菜单（面板外用）。位置用视口坐标 + position:fixed，贴边自动往左/往上翻。
		 * @param items - [{ label, run }]，run 里抛错会被 catch 成提示。
		 * @param event - contextmenu 事件（取 clientX/clientY）。
		 */
		function openExtMenu(items, event) {
		  closeExtMenu()
		  const el = window.document.createElement('div')
		  el.className = EXT_MENU_CLASS
		  el.style.cssText = 'position:fixed;z-index:2147483000;min-width:176px;padding:4px;border-radius:10px;' +
		    'background:#fff;border:1px solid rgba(0,0,0,.08);box-shadow:0 12px 32px rgba(15,23,42,.18);' +
		    'font:13px/1 "Microsoft YaHei",sans-serif;cursor:default'
		  for (const item of items) {
		    const row = window.document.createElement('button')
		    row.type = 'button'
		    row.className = 'icv-extextrow'
		    row.textContent = item.label
		    row.style.cssText = 'display:block;width:100%;height:30px;padding:0 10px;border:none;border-radius:7px;' +
		      'background:transparent;color:#1f2328;font:inherit;text-align:left;cursor:default'
		    row.addEventListener('mouseenter', () => { row.style.background = 'rgba(15,23,42,.06)' })
		    row.addEventListener('mouseleave', () => { row.style.background = 'transparent' })
		    row.addEventListener('click', (clickEvent) => {
		      clickEvent.preventDefault()
		      clickEvent.stopPropagation()
		      closeExtMenu()
		      Promise.resolve()
		        .then(() => item.run())
		        .catch((error) => { extToast(String(error && error.message ? error.message : error)) })
		    })
		    el.appendChild(row)
		  }
		  window.document.body.appendChild(el)
		  const width = el.offsetWidth || 180
		  const height = el.offsetHeight || 40 * items.length + 8
		  let x = event.clientX
		  let y = event.clientY
		  if (x + width > window.innerWidth - 8) x = x - width
		  if (y + height > window.innerHeight - 8) y = y - height
		  el.style.left = Math.max(8, Math.round(x)) + 'px'
		  el.style.top = Math.max(8, Math.round(y)) + 'px'
		}

		/** 把一张图塞进当前会话的画布（已存在就只提示，不重复加）。 */
		async function pushImageToCanvas(source, size) {
		  if (canvasBridge.sessionId === '') {
		    throw new Error('先打开一次右侧「无限画布」页，我才能知道放进哪个会话')
		  }
		  const sessionId = canvasBridge.sessionId
		  const isResource = source.indexOf('dsh-resource://file/') === 0
		  const address = isResource ? source : ''
		  const url = isResource ? '' : source
		  const doc = await loadDoc(sessionId)
		  const exists = doc.nodes.some((node) => (address !== '' && node.address === address) || (url !== '' && node.url === url))
		  if (exists) { extToast('这张图已经在画布里了'); return }
		  const index = doc.nodes.length
		  const parsed = address === '' ? undefined : parseFileAddress(address)
		  // 尺寸按"自然尺寸封顶 520 宽"，避免一张 4K 图把画布撑爆
		  const naturalW = size !== undefined && size.w > 0 ? size.w : 520
		  const naturalH = size !== undefined && size.h > 0 ? size.h : 390
		  const scale = Math.min(1, 520 / naturalW)
		  doc.nodes.push({
		    id: newId('node'),
		    address,
		    url,
		    name: address !== '' ? basenameOf(address) : '聊天图片 ' + String(index + 1),
		    path: parsed === undefined ? '' : parsed.path,
		    x: 40 + (index % 4) * 320,
		    y: 40 + Math.floor(index / 4) * 300,
		    w: Math.round(naturalW * scale),
		    h: Math.round(naturalH * scale),
		    rot: 0,
		    locked: false,
		    hidden: false,
		  })
		  const response = await fetch(ROUTE + '/state?sessionId=' + encodeURIComponent(sessionId), {
		    method: 'PUT',
		    headers: { 'content-type': 'application/json' },
		    body: JSON.stringify(doc),
		  })
		  const body = await response.json().catch(() => ({}))
		  if (response.ok !== true || body.ok !== true) throw new Error(String(body.error ?? ('HTTP ' + String(response.status))))
		  // 已打开的画布页收到事件后自己重读文档（面板外改了存储，页面不会知道）
		  window.dispatchEvent(new window.CustomEvent('dsh-image-canvas:reload'))
		  extToast('已放入无限画布')
		}

		/**
		 * 挂"面板外右键图片"的监听。**HMR 安全**：每次 apply 先撤掉上一次的监听再重挂，
		 * 否则热更新几次以后会叠出好几份菜单。
		 */
		function installExtMenu() {
		  const previous = window.__icvExtMenuCleanup
		  if (typeof previous === 'function') previous()

		  const onContextMenu = (event) => {
		    const target = event.target
		    if (target === null || target === undefined || typeof target.closest !== 'function') return
		    if (target.closest('.icv-root') !== null) return   // 画布面板内部有自己的右键菜单
		    const img = target.closest('img')
		    if (img === null) return
		    // 只对"内容图"生效：小图标/头像（<120px 宽）右键保持系统菜单，免得满屏都是这个菜单
		    if ((img.naturalWidth || 0) < 120) return
		    const source = String(img.currentSrc || img.getAttribute('src') || '')
		    if (source === '') return
		    event.preventDefault()
		    event.stopPropagation()
		    openExtMenu([
		      { label: '放入无限画布', run: () => pushImageToCanvas(source, { w: img.naturalWidth, h: img.naturalHeight }) },
		      { label: '复制图片地址', run: () => window.navigator.clipboard.writeText(source).then(() => { extToast('地址已复制') }) },
		    ], event)
		  }
		  const onAnyDown = (event) => {
		    const target = event.target
		    if (target !== null && target !== undefined && typeof target.closest === 'function' && target.closest('.' + EXT_MENU_CLASS) !== null) return
		    closeExtMenu()
		  }
		  const onKey = (event) => { if (event.key === 'Escape') closeExtMenu() }
		  window.document.addEventListener('contextmenu', onContextMenu, true)
		  window.document.addEventListener('pointerdown', onAnyDown, true)
		  window.document.addEventListener('keydown', onKey, true)
		  window.addEventListener('resize', closeExtMenu)
		  window.__icvExtMenuCleanup = () => {
		    window.document.removeEventListener('contextmenu', onContextMenu, true)
		    window.document.removeEventListener('pointerdown', onAnyDown, true)
		    window.document.removeEventListener('keydown', onKey, true)
		    window.removeEventListener('resize', closeExtMenu)
		    closeExtMenu()
		  }
		}

		// ─────────────────────────────────────────── 插件入口

		/** 构建标记：用来在界面上确认"跑的是哪一版代码"（HMR 到底有没有生效）。 */
		const BUILD_STAMP = '2026-10-28T19:40 3D 模型节点（three.js vendor）+ 多格式转码 + 大图分块'

		/**
		 * 把插件上下文的真实情况写成一行字，显示在画布工具条上。
		 * 排查"服务拿不到"这类问题时，这比猜有用得多——直接在界面上看事实。
		 */
		function describeContext(ctx) {
		  const short = (value) => {
		    const text = String(value && value.message ? value.message : value)
		    return text.length > 90 ? text.slice(0, 90) + '…' : text
		  }
		  const probe = (label, run) => {
		    try {
		      const value = run()
		      return label + '=' + (value === undefined ? 'undefined' : typeof value)
		    } catch (error) {
		      return label + '↯ ' + short(error)
		    }
		  }
		  const parts = []
		  parts.push(probe('remote', () => ctx.remote))
		  parts.push(probe('remote.keys', () => Object.keys(ctx.remote).join('/')))
		  parts.push(probe('wf', () => ctx.remote.workspaceFiles))
		  parts.push(probe('wf.keys', () => Object.keys(ctx.remote.workspaceFiles).join('/')))
		  parts.push(probe('readBytes', () => ctx.remote.workspaceFiles.readBytes))
		  return parts.join(' ｜ ')
		}

		/**
		 * cordis 服务注入（模块级）。读图要**三个条件同时满足**（2026-10-16 逐条实测，缺一个都读不了）：
		 *   ① package.json 的 `dsh.client.inject` 把提供该服务的包拉进客户端模块图
		 *      （@deepseek-ai/dsh-api-gateway + dsh-api-remotes + dsh-api-workspace-files + dsh-client-resources）；
		 *   ② 这里要声明 `remote`；
		 *   ③ **命名空间也要按点号全名声明**：`remote.workspaceFiles`。
		 *      少了 ③，访问时报的错是 `cannot get property "remote.workspaceFiles" without inject`
		 *      —— 界面上的自检行就是这么把它抓出来的。
		 */
		module.exports.inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'remote', 'remote.workspaceFiles']

		/** 自动打开用的一次性标记的版本号（改这个值 = 重置"已弹过"状态，方便再验证一次）。 */
		const AUTO_OPEN_STAMP = 'v10'

		/** 自动打开用的一次性标记（值 = 已自动打开过的标记版本，见 AUTO_OPEN_STAMP）。 */
		const AUTO_OPEN_KEY = PKG + ':auto-opened-3d:' + AUTO_OPEN_STAMP

		/**
		 * 从当前页面 URL 里认会话 id（DSH 会话 id 形如 session-xxxxxxxx-…）。
		 * 认不出来就返回空串 —— 自动打开只在认得出时做，绝不在错误会话里弹面板。
		 */
		function currentSessionIdFromLocation() {
		  try {
		    const found = /(session-[0-9a-f]{8}-[0-9a-f-]{20,})/.exec(String(window.location.href))
		    return found === null ? '' : found[1]
		  } catch { return '' }
		}

		/**
		 * 把自动打开的过程写到宿主 state（假会话 id `icv-diag`），便于 Agent 从宿主机侧读回。
		 * 只用于诊断，失败静默。
		 */
		function reportAutoOpenDiag(steps) {
		  if (diagEnabled() !== true) return
		  try {
		    void fetch(ROUTE + '/state?sessionId=' + encodeURIComponent('icv-diag'), {
		      method: 'PUT',
		      headers: { 'content-type': 'application/json' },
		      body: JSON.stringify({ doc: { at: new Date().toISOString(), href: String(window.location.href), steps } }),
		    }).catch(() => { /* 诊断写不进去不影响功能 */ })
		  } catch { /* 同上 */ }
		}

		/**
		 * 画布里已经有 3D 节点时，把右侧栏的无限画布**自己弹出来一次**（2026-10-28 用户反馈：
		 * "你这个是两张图片啊" —— 他以为 3D 只能靠 Agent 贴静态截图看，因为他从没打开过画布）。
		 *
		 * 口径：只弹一次（localStorage 记着；AUTO_OPEN_STAMP 换个值等于重置）；
		 * 任何异常都静默 —— 自动打开失败绝不能影响其它功能。
		 *
		 * 实测结论（2026-10-28，靠把过程写回宿主 state 才看清）：
		 *   - `layout.openRightbar` 在原型上，调用不报错但界面不动；真正生效的是 `layout.panels.openRightbar`；
		 *   - `sidebarRight.openTab(kind)` 在没有会话上下文时是空操作，`openTabIn(sessionId, kind)` 才可靠；
		 *   - 桌面版 URL 是 `dsh-app://app/`，不带会话 id，所以会话 id 得靠 URL 正则碰运气 —— 拿不到就用 openTab。
		 */
		function maybeAutoOpenFor3d(rightSidebar, layout) {
		  const steps = []
		  const note = (label, value) => { steps.push(label + '=' + String(value)) }
		  const sessionId = currentSessionIdFromLocation()
		  try {
		    if (window.localStorage.getItem(AUTO_OPEN_KEY) === '1') return
		  } catch { /* localStorage 用不了就每次页面加载弹一次 */ }

		  const open = () => {
		    // ① 展开右侧栏
		    try {
		      const panels = layout !== undefined && layout !== null ? layout.panels : undefined
		      if (panels !== undefined && panels !== null && typeof panels.openRightbar === 'function') {
		        panels.openRightbar(true, false)
		        note('rightbar', 'panels.openRightbar')
		      } else if (layout !== undefined && layout !== null && typeof layout.openRightbar === 'function') {
		        layout.openRightbar(true, false)
		        note('rightbar', 'layout.openRightbar')
		      } else {
		        note('rightbar', 'no-service')
		      }
		    } catch (error) {
		      note('rightbar', String(error && error.message ? error.message : error))
		    }
		    // ② 切到无限画布 tab（等侧栏布局落定再切，否则 tab 切了也看不见）
		    window.setTimeout(() => {
		      try {
		        if (rightSidebar === undefined || rightSidebar === null) note('tab', 'no-service')
		        else if (sessionId !== '' && typeof rightSidebar.openTabIn === 'function') { rightSidebar.openTabIn(sessionId, PAGE_KIND); note('tab', 'openTabIn') }
		        else if (typeof rightSidebar.openTab === 'function') { rightSidebar.openTab(PAGE_KIND); note('tab', 'openTab') }
		        else note('tab', 'none')
		      } catch (error) {
		        note('tab', String(error && error.message ? error.message : error))
		      }
		      try { window.localStorage.setItem(AUTO_OPEN_KEY, '1') } catch { /* 记不住就下次再弹 */ }
		      reportAutoOpenDiag(steps.concat(['sessionId=' + (sessionId === '' ? '(none)' : sessionId)]))
		    }, 450)
		  }

		  // 认得出会话 id 就要求"文档里真有 3D 节点"才弹；认不出就弹一次（用户随时能关掉）
		  if (sessionId === '') { open(); return }
		  void (async () => {
		    try {
		      const response = await fetch(ROUTE + '/state?sessionId=' + encodeURIComponent(sessionId))
		      if (!response.ok) return
		      const body = await response.json()
		      const nodes = body !== null && typeof body === 'object' && body.doc !== null && body.doc !== undefined && Array.isArray(body.doc.nodes)
		        ? body.doc.nodes
		        : []
		      if (!nodes.some((node) => node !== null && typeof node === 'object' && node.kind === 'model')) return
		      open()
		    } catch { /* 读不到就放弃（宿主路由没挂上时就是这样） */ }
		  })()
		}


		/**
		 * 注册两个 tab 类型与其正文。
		 * @param ctx - 浏览器侧插件上下文。
		 */
		module.exports.apply = function apply(ctx) {
		  ensureStyle()
		  // 面板外「右键图片 → 放入无限画布」：不依赖 slots，先挂上（HMR 会先撤再挂）
		  installExtMenu()
		  const slots = ctx.get('slots')
		  const tabs = ctx.get('sidebarRightTabs')
		  // 3D 节点已落地 → 右侧栏自己弹一次（见 maybeAutoOpenFor3d 的注释）
		  const rightSidebar = ctx.get('sidebarRight')
		  const layout = ctx.get('layout')
		  try { window.setTimeout(() => { maybeAutoOpenFor3d(rightSidebar, layout) }, 1400) } catch { /* 定时器失败无所谓 */ }

		  if (slots === undefined || tabs === undefined) {
		    // 宿主没有这两项服务时不注册任何东西，也不影响其它插件。
		    return
		  }

		  /**
		   * 读一个工作区文件的字节。
		   * 官方姿势（照 DSH 自带 dsh-client-ui-sidebar-documentpreview 的写法）：
		   *   ctx.remote.workspaceFiles.readBytes(sessionId, path, options, signal) → { value: { data: Uint8Array } }
		   * 注意：**没有 readAll 这个方法**；服务要从 ctx.remote 上取，不是 ctx.get('remote')。
		   *
		   * options 支持 `{}`（整文件，宿主上限 32 MiB）和 `{ range: { offset, length } }`
		   * （分块读，超过 32 MiB 的大图靠它拼回来；length 不能超过宿主 maxBytes，默认 2 MiB）。
		   * 第三个参数兼容旧调用（老代码传 AbortSignal），新代码推荐 loadImage(sessionId, path, options, signal)。
		   */
		  const loadImage = async (sessionId, path, options, signal) => {
		    // 兼容旧签名：loadImage(sessionId, path, signal)
		    let readOptions = options
		    let callerSignal = signal
		    if (options !== null && options !== undefined && typeof options === 'object'
		      && typeof options.aborted === 'boolean' && typeof options.addEventListener === 'function') {
		      callerSignal = options
		      readOptions = {}
		    }
		    if (readOptions === null || readOptions === undefined || typeof readOptions !== 'object') readOptions = {}
		    let remote
		    try {
		      remote = ctx.remote
		    } catch (error) {
		      return { ok: false, error: { code: 'no-remote', message: String(error && error.message ? error.message : error) } }
		    }
		    if (remote === undefined || remote === null) {
		      return { ok: false, error: { code: 'no-remote', message: '宿主未提供 remote 服务' } }
		    }
		    let files
		    try {
		      files = remote.workspaceFiles
		    } catch (error) {
		      return { ok: false, error: { code: 'no-workspace-files', message: String(error && error.message ? error.message : error) } }
		    }
		    if (files === undefined || files === null || typeof files.readBytes !== 'function') {
		      return { ok: false, error: { code: 'no-readBytes', message: 'remote 上没有 workspaceFiles.readBytes' } }
		    }
		    // 官方调用总是带 signal（readBytes(sessionId, path, options, signal)）；不给 signal 会一直挂着不返回。
		    // 再叠一层超时，保证界面上永远不会停在"载入中…"。
		    const timeoutMs = 20000
		    const controller = typeof AbortController === 'function' ? new AbortController() : undefined
		    const timer = window.setTimeout(() => { if (controller !== undefined) controller.abort() }, timeoutMs)
		    const timeout = new Promise((resolve) => window.setTimeout(
		      () => resolve({ ok: false, error: { code: 'timeout', message: '读取超时（' + String(timeoutMs / 1000) + 's）' } }),
		      timeoutMs + 500,
		    ))
		    try {
		      return await Promise.race([files.readBytes(sessionId, path, readOptions, callerSignal ?? controller?.signal), timeout])
		    } catch (error) {
		      return { ok: false, error: { code: 'read-failed', message: String(error && error.message ? error.message : error) } }
		    } finally {
		      window.clearTimeout(timer)
		    }
		  }

		  /**
		   * 列一个目录下的文件（官方同一个 API：remote.workspaceFiles.list → { ok, value: { entries, truncated } }）。
		   * 路径可以是绝对的，也可以是相对会话工作目录的。
		   */
		  const listDir = async (sessionId, dir, signal) => {
		    let files
		    try {
		      files = ctx.remote.workspaceFiles
		    } catch (error) {
		      return { ok: false, error: { code: 'no-workspace-files', message: String(error && error.message ? error.message : error) } }
		    }
		    if (files === undefined || files === null || typeof files.list !== 'function') {
		      return { ok: false, error: { code: 'no-list', message: 'remote 上没有 workspaceFiles.list' } }
		    }
		    try {
		      const result = await files.list(sessionId, dir, signal)
		      if (result === undefined || result === null || result.ok !== true) {
		        return { ok: false, error: (result && result.error) ?? { code: 'list-failed', message: '列目录失败' } }
		      }
		      const entries = Array.isArray(result.value?.entries) ? result.value.entries : []
		      return { ok: true, value: { entries } }
		    } catch (error) {
		      return { ok: false, error: { code: 'list-failed', message: String(error && error.message ? error.message : error) } }
		    }
		  }

		  // 阶段一：类型声明
		  ctx.effect(() => tabs.register({
		    id: PAGE_ID,
		    kind: PAGE_KIND,
		    title: () => '无限画布',
		    guide: [{ order: 30, title: () => '无限画布', description: () => '把打开的图片收进同一张可平移缩放的画布', icon: CanvasGuideIcon }],
		  }), 'image-canvas: page type')

		  ctx.effect(() => tabs.register({
		    id: IMAGE_ID,
		    kind: IMAGE_KIND,
		    patterns: ['dsh-resource://file/**'],
		    canOpen: (address) => {
		      const parsed = parseFileAddress(address)
		      return parsed !== undefined && isImagePath(parsed.path)
		    },
		    title: (address) => basenameOf(address),
		  }), 'image-canvas: image type')

		  // 3D 模型类型：和图片共用同一条资源 pattern，靠 canOpen 各认各的扩展名。
		  // 效果：对话里点开一个 .glb/.fbx/.obj… 会进画布（而不是弹一个"不支持预览"）。
		  ctx.effect(() => tabs.register({
		    id: MODEL_ID,
		    kind: MODEL_KIND,
		    patterns: ['dsh-resource://file/**'],
		    canOpen: (address) => {
		      const parsed = parseFileAddress(address)
		      return parsed !== undefined && isModelPath(parsed.path)
		    },
		    title: (address) => basenameOf(address),
		  }), 'image-canvas: model type')

		  // 阶段二：正文（key = 类型的 id）
		  const diagnostics = describeContext(ctx)
		  const serviceOk = diagnostics.includes('readBytes=function')
		  ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register(
		    { name: 'sidebar.right.pane.tab', key: PAGE_ID, inject: (sessionId) => ({ sessionId, loadImage, listDir, diagnostics, serviceOk }) },
		    CanvasBoard,
		  )), 'image-canvas: board body')

		  ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register(
		    { name: 'sidebar.right.pane.tab', key: IMAGE_ID, inject: (sessionId) => ({ sessionId, loadImage }) },
		    ImageIntake,
		  )), 'image-canvas: intake body')

		  // 3D 接引页：画布页正文还是 CanvasBoard（模型就画在画布节点里）
		  ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register(
		    { name: 'sidebar.right.pane.tab', key: MODEL_ID, inject: (sessionId) => ({ sessionId, loadImage }) },
		    ModelIntake,
		  )), 'image-canvas: model intake body')
		}

		// 纯函数自检钩子：tools/selftest-helpers.mjs 用（不进 UI、不影响运行时）。
		// 这些函数本身是模块私有的，但测试需要直接验它们（尤其是 magic-byte 嗅探/路径自愈/分块读）。
		module.exports.__test = {
		  sniffImageFormat,
		  repairPathCandidates,
		  readImageBytes,
		  readImage,
		  bytesToImageUrl,
		  describeReadError,
		  sessionFileAddress,
		}

		return module.exports;
	},
});
