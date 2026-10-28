/**
 * 离线验证「blob 模块树」拼装算法：不启浏览器，只跑 client.body.js 里那段依赖多轮解析，
 * 确认 vendor 目录里的文件闭包能解完、viewer.js 最终能就绪。
 *
 * VENDOR_FILES 直接从 lib/client.body.js 里抽出来（不复制一份，避免两边漂移）。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'C:\\Users\\Administrator\\Documents\\deepseek-harness\\默认工作区\\dsh-image-canvas'
const VENDOR = path.join(ROOT, 'vendor')
const BODY = fs.readFileSync(path.join(ROOT, 'lib', 'client.body.js'), 'utf8')

const block = /const VENDOR_FILES = \[([\s\S]*?)\]/.exec(BODY)
if (block === null) { console.log('没在 client.body.js 里找到 VENDOR_FILES'); process.exit(1) }
const VENDOR_FILES = Array.from(block[1].matchAll(/'([A-Za-z0-9_.\-]+\.js)'/g)).map((m) => m[1])
console.log('VENDOR_FILES:', VENDOR_FILES.length, '个 →', VENDOR_FILES.join(', '))

const texts = new Map()
for (const name of VENDOR_FILES) {
  const file = path.join(VENDOR, name)
  if (!fs.existsSync(file)) { console.log('缺失文件:', name); process.exit(1) }
  texts.set(name, fs.readFileSync(file, 'utf8'))
}

const depPattern = /(?:from|import)\s*\(?\s*['"]\.\/([A-Za-z0-9_.\-]+\.js)['"]/g
const depsOf = (source) => {
  const out = new Set()
  let m
  depPattern.lastIndex = 0
  while ((m = depPattern.exec(source)) !== null) out.add(m[1])
  return out
}

// 1) 闭包里有没有指向列表之外的文件（列表漏了它，浏览器里就会 404）
const missing = new Set()
for (const [name, source] of texts) {
  for (const dep of depsOf(source)) {
    if (!texts.has(dep)) missing.add(name + ' → ' + dep)
  }
}
console.log('依赖闭包缺口:', missing.size === 0 ? '无 ✅' : Array.from(missing).join(', '))

// 2) 还原多轮解析（用 "就绪" 集合模拟 blob URL 表）
const ready = new Set()
const pending = new Set(VENDOR_FILES)
for (let round = 0; round < 8 && pending.size > 0; round++) {
  let progressed = false
  for (const name of Array.from(pending)) {
    const deps = depsOf(texts.get(name))
    let blocked = false
    for (const dep of deps) if (!ready.has(dep)) { blocked = true; break }
    if (blocked) continue
    ready.add(name)
    pending.delete(name)
    progressed = true
  }
  console.log('  第 ' + (round + 1) + ' 轮：就绪 ' + ready.size + ' / 未解 ' + pending.size)
  if (!progressed) break
}
console.log('viewer.js 就绪:', ready.has('viewer.js') ? '✅' : '❌ 未解：' + Array.from(pending).join(', '))

// 3) 逐文件 file:// 动态 import（语法 + 顶层可执行性）
let ok = 0
for (const name of VENDOR_FILES) {
  try {
    await import('file:///' + path.join(VENDOR, name).replace(/\\/g, '/'))
    ok++
  } catch (error) {
    console.log('  import 失败:', name, '→', String(error?.message ?? error).slice(0, 140))
  }
}
console.log('file:// 动态 import:', ok + '/' + VENDOR_FILES.length)

// 4) viewer 必须导出 createViewer
const viewer = await import('file:///' + path.join(VENDOR, 'viewer.js').replace(/\\/g, '/')).catch((e) => ({ __error: e }))
const hasCreate = typeof viewer.createViewer === 'function'
console.log('viewer.js 导出 createViewer:', hasCreate ? '✅' : '❌ ' + String(viewer.__error?.message ?? Object.keys(viewer).join(',')).slice(0, 160))

const pass = missing.size === 0 && ready.has('viewer.js') && ok === VENDOR_FILES.length && hasCreate
console.log(pass ? '\nBLOB_TREE_OK' : '\nBLOB_TREE_FAIL')
process.exit(pass ? 0 : 1)
