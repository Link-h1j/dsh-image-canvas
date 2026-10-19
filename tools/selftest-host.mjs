/**
 * 宿主半边自检：不启动 DSH，只把它当普通模块跑一遍。
 * 验证：注入契约、两条路由注册、探活响应、状态读写（含原子写与目录创建）。
 *
 * 用法：node tools/selftest-host.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-image-canvas-home-'))
process.env.DSH_HOME = TEMP_HOME

let passed = 0
const failures = []
const check = (label, ok, extra = '') => {
  if (ok) { passed++; console.log('  ✅ ' + label) }
  else { failures.push(label); console.log('  ❌ ' + label + (extra === '' ? '' : ' — ' + extra)) }
}

const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)

console.log('== 宿主半边 ==')
check('导出 name = dsh-image-canvas', mod.name === 'dsh-image-canvas')
check('声明注入 webServer', Array.isArray(mod.inject) && mod.inject.includes('webServer'))
check('导出 apply()', typeof mod.apply === 'function')

const routes = []
const effects = []
const webServer = { register: (route) => { routes.push(route); return () => {} } }
const ctx = {
  inject: (names, callback) => { callback({ webServer }) },
  effect: (fn) => { const dispose = fn(); effects.push(typeof dispose); return () => {} },
  reflect: { get: () => webServer },
}
mod.apply(ctx)

const EXPECTED_ROUTES = [
  '/plugins/dsh-image-canvas/probe',
  '/plugins/dsh-image-canvas/state',
  '/plugins/dsh-image-canvas/comfy/status',
  '/plugins/dsh-image-canvas/comfy/run',
  '/plugins/dsh-image-canvas/comfy/out',
]
check('注册的路由集合与预期完全一致', routes.length === EXPECTED_ROUTES.length
  && EXPECTED_ROUTES.every((expected) => routes.some((route) => route.kind === 'exact' && route.path === expected)),
  '实际: ' + routes.map((r) => r.kind + ' ' + r.path).join(', '))
check('探活路由存在', routes.some((r) => r.kind === 'exact' && r.path === '/plugins/dsh-image-canvas/probe'))
check('状态路由存在', routes.some((r) => r.kind === 'exact' && r.path === '/plugins/dsh-image-canvas/state'))
check('effect 返回了 disposer', effects.every((kind) => kind === 'function'))

/** 伪造一个响应对象。 */
function fakeRes() {
  return {
    statusCode: 0, headers: {}, body: '',
    setHeader(key, value) { this.headers[key] = value },
    end(value) { this.body = value ?? '' },
  }
}

const probe = routes.find((r) => r.path.endsWith('/probe')).handler
const res1 = fakeRes()
probe({}, res1)
const probeJson = JSON.parse(res1.body)
check('探活返回 ok 与身份', probeJson.ok === true && probeJson.plugin === 'dsh-image-canvas', res1.body)
check('探活报出存储目录', typeof probeJson.store === 'string' && probeJson.store.startsWith(TEMP_HOME), probeJson.store)

const state = routes.find((r) => r.path.endsWith('/state')).handler
const res2 = fakeRes()
state({ method: 'GET', url: '/plugins/dsh-image-canvas/state?sessionId=s1' }, res2)
check('无快照时返回 doc=null', JSON.parse(res2.body).doc === null, res2.body)

const res3 = fakeRes()
state({ method: 'GET', url: '/plugins/dsh-image-canvas/state' }, res3)
check('缺 sessionId 返回 400', res3.statusCode === 400 && JSON.parse(res3.body).ok === false, res3.body)

const putReq = new EventEmitter()
putReq.method = 'PUT'
putReq.url = '/plugins/dsh-image-canvas/state?sessionId=s%2F1'
const res4 = fakeRes()
state(putReq, res4)
putReq.emit('data', Buffer.from(JSON.stringify({ v: 1, nodes: [{ id: 'n1' }], annotations: [] })))
putReq.emit('end')
await new Promise((r) => setTimeout(r, 60))
check('写入返回 ok', JSON.parse(res4.body).ok === true, res4.body)

const stored = fs.readdirSync(path.join(TEMP_HOME, 'storages', 'dsh-image-canvas'))
check('会话 id 被安全化成文件名', stored.length === 1 && stored[0] === 's_1.json', JSON.stringify(stored))

const res5 = fakeRes()
state({ method: 'GET', url: '/plugins/dsh-image-canvas/state?sessionId=s%2F1' }, res5)
const roundTrip = JSON.parse(res5.body)
check('读回来与写入一致', roundTrip.ok === true && roundTrip.doc?.nodes?.[0]?.id === 'n1', res5.body)

const res6 = fakeRes()
const badReq = new EventEmitter()
badReq.method = 'PUT'
badReq.url = '/plugins/dsh-image-canvas/state?sessionId=s1'
state(badReq, res6)
badReq.emit('data', Buffer.from('{ not json'))
badReq.emit('end')
await new Promise((r) => setTimeout(r, 60))
check('坏 JSON 返回 400 而不是崩溃', res6.statusCode === 400, res6.body)

fs.rmSync(TEMP_HOME, { recursive: true, force: true })

console.log('')
if (failures.length === 0) { console.log(`全部通过：${passed} 项 ✅`); process.exit(0) }
console.log(`通过 ${passed} 项，失败 ${failures.length} 项 ❌`)
for (const failure of failures) console.log('  - ' + failure)
process.exit(1)
