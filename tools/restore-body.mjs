/**
 * 从已构建的 lib/client.js 反解出 lib/client.body.js（用于从 PowerShell 误改中恢复）。
 * 生成的产物结构是固定的：banner + load({ id, factory }) + 正文整体前置两个 tab + 收尾。
 * 用法：node tools/restore-body.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = path.join(ROOT, 'lib', 'client.js')
const BODY = path.join(ROOT, 'lib', 'client.body.js')

const lines = fs.readFileSync(CLIENT, 'utf8').split('\n')
const start = lines.findIndex((line) => line.includes('var exports = module.exports;'))
const end = lines.findIndex((line) => line.trim() === 'return module.exports;')
if (start === -1 || end === -1 || end <= start) {
  console.error('产物结构不符合预期，找不到正文边界')
  process.exit(1)
}
const body = lines.slice(start + 1, end).map((line) => (line.startsWith('\t\t') ? line.slice(2) : line)).join('\n')

const hasChinese = /无限画布|画布还是空的|批注/.test(body)
const badBytes = /\uFFFD/.test(body)
console.log(`正文 ${body.split('\n').length} 行，${body.length} 字符`)
console.log(`中文完好: ${hasChinese}，含替换字符: ${badBytes}`)
if (!hasChinese || badBytes) {
  console.error('反解出来的正文不可信，拒绝写盘')
  process.exit(1)
}
fs.writeFileSync(BODY, body)
console.log('已恢复 lib/client.body.js')
