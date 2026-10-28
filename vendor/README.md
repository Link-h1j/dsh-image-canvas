# dsh-image-canvas · vendor（3D 预览运行时）

「无限画布」右侧栏插件的 3D 预览运行时：一份**零构建、零 npm 依赖**的 three.js
运行时 + 一个统一的 `viewer.js` 门面。整包可以被浏览器直接 `import()`，不需要
importmap、不需要 bundler、不需要 `<script>` 标签。

```
vendor/
├── viewer.js              ← 唯一对外入口（export createViewer）
├── three.module.js        ← three.js r169 ESM（min 版）
├── <loaders/controls…>    ← examples/jsm 扁平化副本，全部改成相对导入
├── test.html              ← 单模型冒烟页（?model=whale|knight&theme=dark|light）
├── selftest.html          ← 64 项契约自测页（浏览器打开即跑）
├── _verify/               ← 测试模型与截图（可整目录删除，不影响运行）
└── _work/                 ← 维护脚本：下载/构建/静态服务/headless 截图/校验
```

---

## 1. 版本与来源

| 项 | 值 |
|---|---|
| three.js 版本 | **r169 / 0.169.0** |
| 主源（实测可用） | `https://registry.npmmirror.com/three/-/three-0.169.0.tgz`（7,103,891 B，11.7 s） |
| 备用源 | `https://registry.npmjs.org/three/-/three-0.169.0.tgz` |
| 下载方式 | node 原生 `fetch`（脚本 `_work/fetch-three.mjs`，先清空 `*_PROXY` 环境变量），`tar -xzf` 解包 |
| 主包指纹 | `three.module.js` md5 `3eb31ec476700d53a41d4d0bcd98b366` = npm 包内 `build/three.module.min.js` 原字节（未做任何改动） |
| 许可 | MIT（three.js authors） |

> 本机坑：PowerShell 的 `curl` / `Invoke-WebRequest` 会因 schannel + 系统代理失败，
> 所以下载一律走 node。`HTTPS_PROXY` 等环境变量指向 Astrill（127.0.0.1:3213），
> 未开时会让 fetch 失败，脚本里第一步就 `delete process.env[...]`。

## 2. 文件清单（字节数 + md5 + 来源）

| vendor 内文件 | 字节 | md5 | 来源（npm 包内路径） |
|---|---:|---|---|
| `three.module.js` | 687,458 | `3eb31ec476700d53a41d4d0bcd98b366` | `build/three.module.min.js`（原字节，仅改名） |
| `GLTFLoader.js` | 110,034 | `76c2bf8774fc0c345c9d1b7fe94c9667` | `examples/jsm/loaders/GLTFLoader.js` |
| `DRACOLoader.js` | 13,711 | `416b6ddf9d1a254a797d238ac0c27cf5` | `examples/jsm/loaders/DRACOLoader.js` |
| `KTX2Loader.js` | 23,620 | `86ec4f61b3a9aabaf9c71faacb88bb2a` | `examples/jsm/loaders/KTX2Loader.js` |
| `FBXLoader.js` | 102,422 | `f363d003a4e6b97d3479f4c53cee4eba` | `examples/jsm/loaders/FBXLoader.js` |
| `OBJLoader.js` | 21,206 | `4121d964e9300cc46b68a2ef024bcff0` | `examples/jsm/loaders/OBJLoader.js` |
| `MTLLoader.js` | 10,709 | `b28bc16706bb18a52262d6aed73b8a3d` | `examples/jsm/loaders/MTLLoader.js` |
| `STLLoader.js` | 10,055 | `5420e6b70ea29e040c7e8499b42b66bb` | `examples/jsm/loaders/STLLoader.js` |
| `PLYLoader.js` | 16,651 | `e6e748a6bf6f29d26680f0b5e5308f5d` | `examples/jsm/loaders/PLYLoader.js` |
| `OrbitControls.js` | 32,146 | `a406f06436c4d36237263d8df155e641` | `examples/jsm/controls/OrbitControls.js` |
| `BufferGeometryUtils.js` | 31,780 | `053f54a584a942899c292c6c51d8f9af` | `examples/jsm/utils/BufferGeometryUtils.js` |
| `WorkerPool.js` | 1,712 | `e628c1c3e90d51611e16899e46d5b57a` | `examples/jsm/utils/WorkerPool.js` |
| `fflate.module.js` | 89,384 | `d731a3c949ef32c7290e0079204fbd48` | `examples/jsm/libs/fflate.module.js` |
| `zstddec.module.js` | 39,754 | `e6c6038dae265493cb67cacbed8ee8d8` | `examples/jsm/libs/zstddec.module.js` |
| `ktx-parse.module.js` | 19,440 | `ca5b0cff0f672a2e135569b8cb04bbbb` | `examples/jsm/libs/ktx-parse.module.js` |
| `NURBSCurve.js` | 1,882 | `664924996a76a78b1332c2f20e30e36c` | `examples/jsm/curves/NURBSCurve.js` |
| `NURBSUtils.js` | 9,162 | `12994fbdba65483e6ca3ba45ece703e3` | `examples/jsm/curves/NURBSUtils.js` |
| `RoomEnvironment.js` | 3,618 | `a0917fd46c1225db23edf09b2275020e` | `examples/jsm/environments/RoomEnvironment.js` |
| `viewer.js` | 34,307 | `6a62f3111faa06ebfe630bb416c2a754` | **本项目自写** |

**依赖为什么是这几个**
- `GLTFLoader` → `BufferGeometryUtils`（`toTrianglesDrawMode`）
- `FBXLoader` → `fflate.module.js` (inflate) + `NURBSCurve` → `NURBSUtils`
- `KTX2Loader` → `WorkerPool` + `zstddec.module.js` + `ktx-parse.module.js`
- `DRACOLoader` / `OBJLoader` / `MTLLoader` / `STLLoader` / `PLYLoader` /
  `OrbitControls` / `RoomEnvironment` → 只依赖 `three`

> 任务书里提到的 `NURBSFrustum.js` 在 r169 里**不存在**（那是 `examples/jsm/csm/`
> 里的 `CSMFrustum.js`，与 FBX 无关）。FBX 真实需要的是 `NURBSCurve.js` +
> `NURBSUtils.js`，已补齐。
>
> Draco / KTX2 的 **wasm / decoder 二进制没有随包**（按任务书要求）。基础
> glb/gltf/obj/fbx/stl/ply 完全可用；模型若真的用了 Draco 压缩或 KTX2 贴图，
> 需要宿主再补 decoder 目录并通过 `options.dracoDecoderPath` /
> `options.ktx2TranscoderPath` 指过去。

## 3. 导入改写规则（脚本 `_work/build-vendor.mjs` 自动执行）

所有 `examples/jsm` 文件一律扁平放进 `vendor/`，因此**任何层级前缀都拍平**：

| 原文 | 改写为 |
|---|---|
| `from 'three'` | `from './three.module.js'` |
| `from '../utils/BufferGeometryUtils.js'` | `from './BufferGeometryUtils.js'` |
| `from '../../utils/BufferGeometryUtils.js'` | `from './BufferGeometryUtils.js'` |
| `from '../libs/fflate.module.js'` | `from './fflate.module.js'` |
| `from '../curves/NURBSCurve.js'` | `from './NURBSCurve.js'` |
| `from '../utils/WorkerPool.js'` | `from './WorkerPool.js'` |

规则就一条：**取 specifier 的 basename 前面加 `./`**。因为是扁平目录，basename
不会撞名（已核对全部 17 个 addon 文件）。`three.module.js` 本身是自包含 bundle，
一个 import 都没有，原字节拷贝。

### 无裸导入的证明（图级别，不是肉眼 grep）

`_work/hook.mjs` 用 `module.register()` 的 `resolve` 钩子记录**整条 ESM 依赖图**
里每一个 specifier，再对 14 个入口模块各跑一次 `import()`：

```
$ node _work/graph-check.mjs
... (钩子逐条打 REL) ...
GRAPH_WALK_OK 14/14
真实裸导入条数: 0
相对解析条数: 37
```

37 次解析全部是相对路径：`./three.module.js`、`./BufferGeometryUtils.js`、
`./fflate.module.js`、`./NURBSCurve.js`、`./NURBSUtils.js`、`./WorkerPool.js`、
`./zstddec.module.js`、`./ktx-parse.module.js`、`./OrbitControls.js`、
`./RoomEnvironment.js`。

> 顺带说明：对 `vendor/*.js` 直接跑 `grep "from '"` 会命中 **4 处假阳性**，全部不
> 是导入语句 —— `GLTFLoader.js:201/202`（JSDoc 注释里的示例 URL）、
> `GLTFLoader.js:4707`（`console.warn` 模板字符串）、`three.module.js:6`（min 化
> 后某行字符串里恰好含 `from '`）。真实导入语句为 0 条裸包名。

## 4. viewer.js API 契约

```js
import { createViewer } from './vendor/viewer.js';

const viewer = await createViewer(canvas, options);
```

### 4.1 `createViewer(canvas, options)` → `Promise<viewer>`

`async`，但在**模型加载之前**就 resolve（只做渲染器/场景/环境初始化，实测 ~0.5 s
首帧含 RoomEnvironment PMREM）。`options` 全部可选：

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `onInfo(info)` | function | — | 每次 `load()` 成功后回调 |
| `onError(error)` | function | — | 加载/初始化失败时回调（Error 实例）。`load()` 同时也会 throw，二者都有 |
| `background` | string \| number | 跟随主题 | 初始背景色，如 `'#101216'`、`0x101216` |
| `dark` | boolean | `true` | 深色场景（决定了背景/网格/光照/曝光整套配色） |
| `showGrid` | boolean | `true` | 是否显示自适应地面网格 |
| `basePath` / `baseUrl` | string | `''` | glTF 外部资源 / OBJ·MTL 的相对基路径 |
| `mtlUrl` | string | — | 额外的 MTL 地址（见 4.6） |
| `dracoDecoderPath` | string | — | 给了才挂 DRACOLoader（本包不带 wasm） |
| `ktx2TranscoderPath` | string | — | 给了才挂 KTX2Loader（本包不带 wasm） |
| `loseContext` | boolean | `false` | `dispose()` 时调用 `forceContextLoss()`。**开了之后这个 canvas 就永久废了**，只适合永久卸载 |

`info` 结构（`onInfo` 的参数，也是 `load()` 的返回值、`viewer.info` 的值）：

```ts
{
  meshes: number,        // 可渲染对象数（Mesh/SkinnedMesh/InstancedMesh/Points/Line）
  triangles: number,     // 三角面总数（InstancedMesh 已乘实例数）
  bbox: [number, number, number],   // 模型原始包围盒 [宽, 高, 深]（未缩放，单位=文件单位），保留 4 位小数
  loadMs: number,        // 解析+建场景耗时（ms），不含网络
  name: string,          // 原样回传的 name
  ext: string            // 归一化后的格式 key
}
```

### 4.2 `await viewer.load({ bytes, name, ext })` → `info`

| 参数 | 类型 | 说明 |
|---|---|---|
| `bytes` | `Uint8Array` \| `ArrayBuffer` | 文件内容。**额外接受 `Blob`/`File`**（拖拽进来的 File 可直接传） |
| `name` | string | 文件名，用于报错文案，也用于在 `ext` 缺省时推断格式 |
| `ext` | `'glb'\|'gltf'\|'obj'\|'fbx'\|'stl'\|'ply'` | 可省略，省略时从 `name` 推断 |

- 成功返回 `info`（见上），并调用 `options.onInfo`。
- 失败 throw `Error`，**同时**调用 `options.onError`。文案只有两类前缀：
  - `格式不支持：无法预览 .xyz 文件，目前只支持 glb / gltf / obj / fbx / stl / ply`
  - `文件损坏：xxx.glb 无法作为 GLB 解析（<底层原因>）` / `文件损坏：… 里没有可显示的网格（包围盒为空）`
  - 另有两个可预判的前置错误：`加载失败：没有收到文件内容（bytes 为空）`、
    `viewer 已 dispose，不能再 load`、`上一次加载还没结束...`
- **失败不破坏现状**：先解析成功才替换旧模型，所以坏的第二次加载不影响当前画面。
- 加载成功后会：自动摆正（水平居中 + 脚底贴到 y=0）、按包围盒自适应相机与网格、
  立刻渲染一帧。

### 4.3 其余方法

| 方法 | 行为 |
|---|---|
| `viewer.resize()` | 按 `canvas.clientWidth/clientHeight` 重设绘制缓冲，`setPixelRatio(min(devicePixelRatio, 2))`。**只改绘制缓冲，不改 canvas 的 CSS** |
| `viewer.frame()` | 保持“脚底贴地 + 水平居中”的摆位，重算相机距离/近远裁剪面把模型重新框满 |
| `viewer.setBackground(color)` | `color` 为 string/number 时设显式背景（之后 `setTheme` 不再覆盖它）；传 `null` 恢复跟随主题 |
| `viewer.setTheme('dark'\|'light')` | 整套换肤：背景、网格配色、半球光/主光/补光强度、`toneMappingExposure` |
| `viewer.dispose()` | 停 rAF、摘事件（visibility/resize/ResizeObserver）、`controls.dispose()`、逐个 dispose geometry/material/texture、env 渲染目标、`renderer.dispose()`。幂等 |
| `viewer.ready` | boolean，初始化完成且未 dispose |
| `viewer.info` | 最近一次成功加载的 info，未加载为 `null` |

**契约外、只增不改的暴露**：`viewer.scene` / `viewer.camera` / `viewer.controls` /
`viewer.renderer` / `viewer.canvas` / `viewer.render()`（外部改过场景后强制出一帧）。

### 4.4 调用示例

```js
const canvas = document.getElementById('view');
// ⚠ 宿主必须给 canvas 一个 CSS 尺寸，viewer 只负责绘制缓冲
canvas.style.cssText = 'display:block;width:100%;height:100%;';

const viewer = await createViewer(canvas, {
  dark: true,
  onInfo: (i) => console.log('meshes', i.meshes, 'tris', i.triangles, 'bbox', i.bbox, i.loadMs + 'ms'),
  onError: (e) => console.warn('预览失败', e.message),
});

const bytes = new Uint8Array(await (await fetch('/models/whale.glb')).arrayBuffer());
try {
  const info = await viewer.load({ bytes, name: 'whale.glb', ext: 'glb' });
} catch (err) {
  // err.message 已是中文可直显文案
}

new ResizeObserver(() => viewer.resize()).observe(canvas.parentElement);

// 卸载
viewer.dispose();
```

> 面板反复挂载/卸载时，**可以**在同一个 canvas 上重新 `createViewer`（已验证）。
> 前提是**不要**传 `loseContext: true`。

### 4.5 渲染约定（已实现，供验收）

- `WebGLRenderer({ antialias: true })`，`outputColorSpace = SRGBColorSpace`，
  `toneMapping = ACESFilmicToneMapping`，`toneMappingExposure = 1.14`（浅色 1.0）。
- 光照：`HemisphereLight` + 主 `DirectionalLight`(3.2,5,4) + 补 `DirectionalLight`(-4,2.2,-3.2)；
  **不启用 shadowMap**（`shadowMap.enabled = false`，所谓“简单点不要阴影”）。
- 环境：`RoomEnvironment` + `PMREMGenerator.fromScene(room, 0.04)` →
  `scene.environment`，`scene.environmentIntensity` 深色 1.0 / 浅色 0.95。PBR 材质
  不会黑。若 PMREM 抛错，自动退化为手写 equirect 渐变 `DataTexture`
  （`EquirectangularReflectionMapping`，three 内部会转 cubeUV），再不行就只靠灯光。
- 地面：`GridHelper`，尺寸 `niceCeil(maxDim*3)`（1/2/5×10ⁿ），20 等分，半透明、
  `depthWrite=false`、`toneMapped=false`，贴 y≈0（下移 `maxDim*1e-4` 防 z-fighting）。
- 自适应：`Box3.setFromObject` → 平移 pivot 使 **脚底 y=0 + x/z 居中**；
  相机距离取垂直/水平 FOV 两者较大者 ×1.18，`near/far` 按半径推导；
  `controls.target = (0, h/2, 0)`（即包围盒中心），`minDistance = dist*0.02`，
  `maxDistance = dist*12`。
- 交互：`OrbitControls`，`enableDamping = true`（dampingFactor 0.08），左键旋转 /
  右键平移 / 滚轮缩放，`screenSpacePanning = true`。
- **省电**：不常驻 rAF。`controls` 的 `change`/`start`/`end` 触发 `invalidate()`
  排一帧；`tick` 里 `controls.update()` 返回 `true`（阻尼未收敛）才续帧，收敛后
  循环自然停住。`document.visibilityState === 'hidden'` 时立刻取消 rAF，恢复可见
  时补一帧。（实测：空闲 800 ms 内渲染次数不再增加；hidden 期间不出帧。）
- 材质兜底：无材质 → 共享一个 `MeshStandardMaterial(color 0xc9ccd1, metalness 0.05,
  roughness 0.6)`。**OBJ 无 MTL 时 OBJLoader 会塞 `MeshPhongMaterial` 占位**，已专门
  转成同参数的 `MeshStandardMaterial`（保留顶点色/平滑度），使 obj/stl/ply 观感一致。
  几何缺 `normal` 属性时自动 `computeVertexNormals()`。
- 其他兜底：模型自带 Light/Camera 会被 `visible = false`（有的 FBX 带灯会把画面打爆）。

### 4.6 OBJ + MTL 的边界

`load()` 只收 `bytes`，拿不到同目录的 `.mtl` URL，所以默认走灰模兜底。
要上贴图，给 `options.mtlUrl`（以及必要时 `options.basePath`）：

```js
const viewer = await createViewer(canvas, { basePath: '/models/', mtlUrl: 'chair.mtl' });
await viewer.load({ bytes, name: 'chair.obj', ext: 'obj' });
```

MTL 加载失败**一律静默降级**为灰模，不抛错（契约要求）。

## 5. 验证记录

### A. Node 端逐文件动态 import（`_work/test-import.mjs`）

```
19/19 imported OK, 0 failed
```

对 `vendor/*.js` 全部 18 个文件 + `viewer.js` 逐个 `import('file:///…/vendor/x.js')`。
`three.module.js` 在 node 里**可以**直接 import（导出 413+ 符号，含 `WebGLRenderer`），
不需要 DOM shim。

### B. headless Chrome 真渲染（`_work/cdp-shot.mjs`，Chrome 155 + CDP + SwiftShader）

本地静态服务器 `_work/serve.mjs`（端口 7401）→ `Page.navigate` → 轮询页面状态机 →
`Page.captureScreenshot` → 同时用 `gl.readPixels` 做像素统计（避开
`preserveDrawingBuffer:false` 读空问题）。

| 截图 | 内容 |
|---|---|
| `_verify/shot-glb-whale-dark.png` | `tripo-out/whale_maid_joined.glb`，深色主题 |
| `_verify/shot-glb-whale-light.png` | 同上，浅色主题 |
| `_verify/shot-knight-fbx.png` | `tripo-out/verify-decimate/knight_lowpoly.fbx` |
| `_verify/selftest.png` | 64 项契约自测全绿 |

实测数据：

| 模型 | 格式 | meshes | triangles | bbox (w,h,d) | loadMs | 脚底贴地 | 水平居中 |
|---|---|---:|---:|---|---:|---|---|
| whale_maid_joined | glb | 15 | 32,545 | 0.7072, 1.6489, 0.8012 | 10 | ✅ min.y=0 | ✅ |
| knight_lowpoly | fbx | 1 | 17,156 | 0.5879, 0.9980, 0.5840 | 53 | ✅ min.y=0 | ✅ |

像素统计（`_work/analyze.py`，PIL，排除背景/HUD/网格）：

| 截图 | 模型区 mean | p50 | p99 | max | ≥250 占比 |
|---|---:|---:|---:|---:|---:|
| whale dark | 140.3 | 117.2 | 246.1 | 248.1 | **0.00 %** |
| knight dark | 69.6 | 48.4 | 232.0 | 239.1 | **0.00 %** |

→ 无过曝（`max < 250`）、无死黑（ACES 曲线下暗部有细节），模型不灰。

### C. 契约自测（`vendor/selftest.html` → headless 实测）

```
SELFTEST ALL PASS   pass=64 fail=0
```

覆盖：`createViewer` 返回即 ready / `ready` 是 boolean / 六个方法存在 / toneMapping /
outputColorSpace / antialias / environment 已设 / 自适应网格 / damping 开 /
6 种格式真实解析（triangle 数逐个核对：obj 6、stl 12、ply 8）/ 兜底材质是
`MeshStandardMaterial` 且 metalness .05 roughness .6 / 缺 normal 自动补 / ArrayBuffer
入参 / 省 ext 时按 name 推断 / 像素非空 / resize 的 dpr 夹取与 aspect / setTheme 双向 /
setBackground 显式背景不被 setTheme 覆盖 / frame 拉回相机且仍贴地 / 5 条错误路径文案 /
失败后旧模型仍在 / dispose 后 ready=false 且场景清空且再 load 抛错 / **dispose 后可在
同一 canvas 重建** / **空闲 800 ms 渲染次数不增长** / **change 事件后恢复渲染** /
**hidden 时 rAF 被取消、恢复 visible 后补帧**。

复跑：

```powershell
node vendor\_work\serve.mjs 7401                     # 起静态服务器
node vendor\_work\cdp-shot.mjs 7401 selftest dark <out.png> x http://127.0.0.1:7401/selftest.html
```

## 6. 怎么再升级（r169 → r17x）

```powershell
# 1) 改版本号：_work/fetch-three.mjs 里的 three-0.169.0.tgz -> three-0.17X.0.tgz
node vendor\_work\fetch-three.mjs           # 下载 + 解包到 _work/package
node vendor\_work\build-vendor.mjs          # 拷贝 + 自动改写相对导入，并打印每个文件的改写记录
node vendor\_work\test-import.mjs           # A：逐文件 import 必须 19/19
node vendor\_work\graph-check.mjs           # 裸导入必须是 0
```

`build-vendor.mjs` 的 `FILES` 表是唯一事实来源；如果新版 `examples/jsm` 多出新的
相对依赖，脚本会把它写成 `./<basename>.js` 但**不会自动带过来** —— 跑一次
`test-import.mjs` 会立刻以 `ERR_MODULE_NOT_FOUND` 指出来，照着报错往 `FILES` 里补
一行即可。

**升级后必须重跑**：`selftest.html`（B/C 两节），并肉眼核对
`_verify/shot-*.png` 三张不再黑模/不居中。

### 已知限制

1. 不带 Draco / KTX2 的 wasm 解码器（按需求刻意不带）。用到的话要么模型侧不压缩，
   要么宿主提供 decoder 目录并用 `options.dracoDecoderPath` / `options.ktx2TranscoderPath`。
2. `viewer.resize()` 依赖 canvas 有 CSS 尺寸；如果 canvas 既没 CSS 宽高又是默认
   `display:inline`，显示尺寸会等于绘制缓冲尺寸（高 dpr 下看起来偏大）。宿主给
   `display:block;width:100%;height:100%` 即可。
3. 不支持远程 URL 直接 `load`（契约是 bytes），需要宿主自己 fetch。
4. `_verify/` 里的两个模型共 2.8 MB，纯测试夹具，可整目录删除；`_work/` 是维护脚本，
   运行时不需要，也可删。
