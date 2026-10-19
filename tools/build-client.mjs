/**
 * 把可读的 lib/client.body.js 包成 DSH 浏览器半边要求的 lib/client.js。
 *
 * 为什么必须包一层：浏览器侧加载器只认 `window.__ModuleLoader__.load({ id, factory })` 这种闭包工厂；
 * 直接写 `exports.apply = ...` 在页面里会 ReferenceError。
 *
 * 语法闸门：正文用 vm.Script 只编译不执行，SyntaxError 就**拒绝写盘**，磁盘上永远留上一个能跑的版本
 * （2026-10-02 有插件把坏包直接喂给 HMR，导致桌面版渲染进程崩溃过，所以这道闸门不能省）。
 *
 * 用法：node tools/build-client.mjs [--check]
 *   --check 只比对，不一致则 exit 1（CI/自检用）
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BODY = path.join(ROOT, 'lib', 'client.body.js')
const OUT = path.join(ROOT, 'lib', 'client.js')
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

const body = fs.readFileSync(BODY, 'utf8').replace(/^\uFEFF/, '')

// 闸门 1：语法
try {
  new vm.Script('(function (module, exports, require) {\n' + body + '\n})', { filename: 'client.body.js' })
} catch (error) {
  console.error('lib/client.body.js 语法不过，拒绝生成 lib/client.js：' + (error?.message ?? error))
  console.error('（磁盘上的 lib/client.js 保持原样，HMR 不会拿到坏包）')
  process.exit(1)
}

// 闸门 2：正文里不许残留 ESM import/export（工厂是 CJS 形态）
for (const [label, pattern] of [
  ['顶层 import 语句', /^\s*import\s+[^(]/m],
  ['顶层 export 语句', /^\s*export\s+(const|let|var|function|class|default|\{)/m],
]) {
  if (pattern.test(body)) {
    console.error(`lib/client.body.js 里有${label}，浏览器半边只支持 CJS 形态（require / module.exports）`)
    process.exit(1)
  }
}

const indented = body.split('\n').map((line) => (line.trim() === '' ? line : '\t\t' + line)).join('\n')

const generated = `/**
 * 生成物 —— 不要手改。源码在 lib/client.body.js，改完跑：node tools/build-client.mjs
 * 包名 ${PKG.name} 必须与 __ModuleLoader__.load({ id }) 以及 profile 里的 loader 行一致。
 */
window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PKG.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${indented}
\t\treturn module.exports;
\t},
});
`

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
  if (current !== generated) {
    console.error('lib/client.js 与 lib/client.body.js 不一致，请跑一次 node tools/build-client.mjs')
    process.exit(1)
  }
  console.log('lib/client.js 是最新的 ✅')
  process.exit(0)
}

fs.writeFileSync(OUT, generated)
console.log(`已生成 ${path.relative(ROOT, OUT)}（正文 ${body.split('\n').length} 行 → 产物 ${generated.length} 字节）`)
