/**
 * 对着真实 ComfyUI 核对接口与节点（只读探测）。
 * 用法：node tools/probe-comfy.mjs [http://127.0.0.1:8189]
 */
const BASE = (process.argv[2] ?? 'http://127.0.0.1:8189').replace(/\/+$/, '')

const NEEDED = [
  'CheckpointLoaderSimple', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler',
  'VAEDecode', 'SaveImage', 'LoadImage', 'VAEEncode', 'ImageToMask', 'SetLatentNoiseMask',
]

const stats = await fetch(BASE + '/system_stats', { signal: AbortSignal.timeout(8000) })
console.log(`/system_stats -> HTTP ${stats.status}`)
const statsBody = await stats.json()
const device = statsBody?.devices?.[0]
console.log(`  版本: ${statsBody?.system?.comfyui_version ?? '?'}  python: ${statsBody?.system?.python_version?.split(' ')[0] ?? '?'}`)
console.log(`  设备: ${device?.name ?? '?'}  VRAM: ${device ? Math.round(device.vram_total / 1024 / 1024) + ' MB' : '?'}`)

const info = await (await fetch(BASE + '/object_info', { signal: AbortSignal.timeout(120000) })).json()
const names = Object.keys(info)
console.log(`\n节点总数: ${names.length}`)
for (const node of NEEDED) {
  const present = names.includes(node)
  let detail = ''
  if (present && node === 'KSampler') {
    const sampler = info.KSampler?.input?.required?.sampler_name?.[0]
    const scheduler = info.KSampler?.input?.required?.scheduler?.[0]
    detail = ` samplers=${Array.isArray(sampler) ? sampler.length : '?'}(含dpmpp_2m=${Array.isArray(sampler) && sampler.includes('dpmpp_2m')}) schedulers=${Array.isArray(scheduler) ? scheduler.length : '?'}(含karras=${Array.isArray(scheduler) && scheduler.includes('karras')})`
  }
  console.log(`  ${present ? '✅' : '❌'} ${node}${detail}`)
}

const checkpoints = info.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] ?? []
console.log(`\n可用 checkpoint: ${checkpoints.length} 个`)
for (const name of checkpoints.slice(0, 25)) console.log('  - ' + name)

const SD15 = checkpoints.filter((n) => /v1-5|sd15|anything|dreamshaper|majicmix|realistic/i.test(n))
const SDXL = checkpoints.filter((n) => /xl|sdxl|juggernaut|dreamshaper_?xl/i.test(n))
console.log(`\n候选（自动挑默认用）: SD1.5 系 ${SD15.length} 个, SDXL 系 ${SDXL.length} 个`)
console.log('  SD1.5 例子: ' + (SD15.slice(0, 3).join(' | ') || '（无）'))
console.log('  SDXL  例子: ' + (SDXL.slice(0, 3).join(' | ') || '（无）'))
