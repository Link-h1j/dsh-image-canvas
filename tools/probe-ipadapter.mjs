/**
 * 只读探测：IPAdapter / ControlNet 节点在**本机 ComfyUI 里**的真实入参名，以及适合出角色设定的动漫模型。
 * 用法：node tools/probe-ipadapter.mjs
 */
const BASE = (process.argv[2] ?? 'http://127.0.0.1:8189').replace(/\/+$/, '')

const info = await (await fetch(BASE + '/object_info', { signal: AbortSignal.timeout(180000) })).json()
const names = Object.keys(info)

const wanted = names.filter((n) => /ipadapter|IPAdapter/i.test(n)).sort()
console.log(`IPAdapter 相关节点（${wanted.length} 个）:`)
for (const name of wanted) console.log('  - ' + name)

for (const name of ['IPAdapterUnifiedLoader', 'IPAdapterAdvanced', 'IPAdapterModelLoader', 'CLIPVisionLoader', 'IPAdapter', 'IPAdapterApply']) {
  if (!names.includes(name)) continue
  const required = info[name]?.input?.required ?? {}
  const optional = info[name]?.input?.optional ?? {}
  console.log(`\n== ${name} ==`)
  for (const [key, spec] of Object.entries(required)) {
    const type = Array.isArray(spec) && Array.isArray(spec[0]) ? `枚举(${spec[0].length}: ${spec[0].slice(0, 6).join('/')}${spec[0].length > 6 ? '/…' : ''})` : String(spec?.[0] ?? spec)
    console.log(`   ${key}: ${type}`)
  }
  for (const [key, spec] of Object.entries(optional)) {
    const type = Array.isArray(spec) && Array.isArray(spec[0]) ? `枚举(${spec[0].length})` : String(spec?.[0] ?? spec)
    console.log(`   [可选] ${key}: ${type}`)
  }
}

// IPAdapter 的预置权重清单（UnifiedLoader 的 preset 枚举里能看到实际文件名）
const preset = info.IPAdapterUnifiedLoader?.input?.required?.preset?.[0]
if (Array.isArray(preset)) console.log('\nIPAdapterUnifiedLoader preset: ' + preset.join(' | '))

const ips = info.IPAdapterModelLoader?.input?.required?.ipadapter_file?.[0]
if (Array.isArray(ips)) console.log('\n可用 ipadapter 权重文件:\n  ' + ips.join('\n  '))

const ckpts = info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? []
const anime = ckpts.filter((n) => /illustrious|noob|animagine|pony|anime|awp|wai|sushi|revanim|meina|anything|mix|2\.5D|墨幽/i.test(n))
console.log(`\n可能适合动漫角色的 checkpoint（${anime.length}/${ckpts.length}）:\n  ` + anime.join('\n  '))

const has = (n) => names.includes(n)
console.log('\n其他关键节点: ' + ['ControlNetApplyAdvanced', 'ControlNetLoader', 'LoadImage', 'ImageScale', 'LatentUpscale', 'SaveImage'].map((n) => `${n}=${has(n) ? '✅' : '❌'}`).join('  '))
