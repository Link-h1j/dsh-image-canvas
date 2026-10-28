/**
 * dsh-image-canvas · 3D 预览运行时  —  viewer.js
 * ---------------------------------------------------------------------------
 * 纯 ESM，无构建、无 importmap、无 <script>。依赖只有同目录的 three.module.js
 * 与 ./ 下的 loader/controls 文件（three.js r169 = 0.169.0）。
 *
 * 唯一对外导出：
 *   export async function createViewer(canvas, options) -> viewer
 *
 * viewer 契约：
 *   viewer.ready                       // boolean，初始化完成
 *   await viewer.load({ bytes, name, ext })  -> { meshes, triangles, bbox }
 *   viewer.resize()                    // 按 canvas.clientWidth/Height + dpr(<=2)
 *   viewer.frame()                     // 重新居中 + 按包围盒适配相机
 *   viewer.setBackground(color|null)
 *   viewer.setTheme('dark'|'light')
 *   viewer.dispose()
 *
 * 附加（契约外、可选、只增不改）：
 *   viewer.info / viewer.scene / viewer.camera / viewer.controls / viewer.renderer
 *   viewer.render()
 *   options.basePath / options.baseUrl / options.mtlUrl      —— OBJ 外挂 MTL 用
 *   options.dracoDecoderPath / options.ktx2TranscoderPath    —— 需要时外挂解码器
 *   options.loseContext = true                              —— dispose 时彻底丢 GPU 上下文
 *                                                              （之后同一 canvas 不能再建 viewer）
 *   options.showGrid = false
 * ---------------------------------------------------------------------------
 */

import * as THREE from './three.module.js';
import { OrbitControls } from './OrbitControls.js';
import { RoomEnvironment } from './RoomEnvironment.js';

/* ============================ 常量 / 主题 ============================ */

const SUPPORTED = Object.freeze(['glb', 'gltf', 'obj', 'fbx', 'stl', 'ply']);

const EXT_ALIASES = Object.freeze({
  glb: 'glb', gltf: 'gltf', gltf2: 'gltf',
  obj: 'obj', fbx: 'fbx', fbx7: 'fbx', stl: 'stl', stl2: 'stl', ply: 'ply',
});

const THEMES = Object.freeze({
  dark: {
    background: 0x14161a,
    gridMain: 0x4a5568,
    gridSub: 0x2b3140,
    gridOpacity: 0.55,
    hemiSky: 0xcfe0ff,
    hemiGround: 0x1b1e25,
    hemiIntensity: 0.6,
    keyIntensity: 1.95,
    fillIntensity: 0.5,
    exposure: 1.14,
    envIntensity: 1.0,
  },
  light: {
    background: 0xeef1f5,
    gridMain: 0x9aa4b2,
    gridSub: 0xc9d0da,
    gridOpacity: 0.75,
    hemiSky: 0xffffff,
    hemiGround: 0xb6bcc6,
    hemiIntensity: 0.7,
    keyIntensity: 1.6,
    fillIntensity: 0.55,
    exposure: 1.0,
    envIntensity: 0.95,
  },
});

/* ============================ 小工具 ============================ */

/** 把一个“可能不是 ArrayBuffer”的输入规整成 ArrayBuffer。 */
function toArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes;
  if (ArrayBuffer.isView(bytes)) {
    // 复制一份，避免 byteOffset 陷阱与外部释放
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  throw new TypeError('load() 的 bytes 必须是 Uint8Array 或 ArrayBuffer（也接受 Blob/File）');
}

/** 从文件名里抽扩展名（小写、去 query）。 */
function extOf(name) {
  if (!name || typeof name !== 'string') return '';
  const clean = name.split(/[?#]/)[0];
  const i = clean.lastIndexOf('.');
  return i < 0 ? '' : clean.slice(i + 1).toLowerCase();
}

/** 归一化扩展名 -> 支持的 key，不支持返回 ''。 */
function normalizeExt(ext, name) {
  const raw = (ext || extOf(name) || '').toLowerCase().replace(/^\./, '');
  return EXT_ALIASES[raw] || '';
}

/** 1/2/5 × 10^n 向上取整，给 GridHelper 一个“好看的”尺寸。 */
function niceCeil(v) {
  if (!(v > 0) || !Number.isFinite(v)) return 10;
  const exp = Math.floor(Math.log10(v));
  const pow = Math.pow(10, exp);
  const f = v / pow;
  const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return m * pow;
}

function round(v, digits = 4) {
  const k = Math.pow(10, digits);
  return Math.round(v * k) / k;
}

/** 深色/浅色都看得清的兜底材质色 */
const FALLBACK_MAT = { color: 0xc9ccd1, metalness: 0.05, roughness: 0.6 };

/* ============================ 主入口 ============================ */

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{onInfo?:Function, onError?:Function, background?:string|number,
 *          dark?:boolean, showGrid?:boolean, basePath?:string, baseUrl?:string,
 *          mtlUrl?:string, name?:string}} [options]
 * @returns {Promise<object>} viewer
 */
export async function createViewer(canvas, options = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new TypeError('createViewer(canvas, options)：第一个参数必须是 <canvas> 元素');
  }

  const opts = options || {};
  const onInfo = typeof opts.onInfo === 'function' ? opts.onInfo : null;
  const onError = typeof opts.onError === 'function' ? opts.onError : null;

  let theme = opts.dark === false ? 'light' : 'dark';
  let palette = THEMES[theme];

  /* ---------- renderer ---------- */
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
  } catch (e) {
    const err = new Error('无法初始化 WebGL 渲染器（浏览器/显卡不支持或被禁用）：' + (e && e.message ? e.message : e));
    if (onError) { try { onError(err); } catch (_) { /* ignore */ } }
    throw err;
  }

  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = palette.exposure;
  renderer.shadowMap.enabled = false;

  /* ---------- scene / camera ---------- */
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(
    opts.background != null ? opts.background : palette.background
  );
  let explicitBg = opts.background != null;

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  camera.position.set(2.4, 1.8, 3.2);

  /* ---------- lights ---------- */
  const hemi = new THREE.HemisphereLight(palette.hemiSky, palette.hemiGround, palette.hemiIntensity);
  hemi.position.set(0, 1, 0);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, palette.keyIntensity);
  key.position.set(3.2, 5.0, 4.0);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xffffff, palette.fillIntensity);
  fill.position.set(-4.0, 2.2, -3.2);
  scene.add(fill);

  /* ---------- environment (PBR 不黑) ---------- */
  let envTarget = null;      // WebGLRenderTarget | null
  let envTexture = null;     // Texture (可直接 dispose)
  let roomEnv = null;

  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    roomEnv = new RoomEnvironment();
    envTarget = pmrem.fromScene(roomEnv, 0.04);
    envTexture = envTarget.texture;
    scene.environment = envTexture;
    scene.environmentIntensity = palette.envIntensity;
    if (typeof roomEnv.dispose === 'function') roomEnv.dispose();
    pmrem.dispose();
  } catch (e) {
    // 退化方案：手写 equirect 渐变（three 内部会自动做成 cubeUV，PBR 照样有环境光）
    try {
      envTexture = makeGradientEnvironment(theme);
      scene.environment = envTexture;
      scene.environmentIntensity = palette.envIntensity;
    } catch (_) {
      scene.environment = null; // 最后兜底：靠 hemi + 两盏方向光
    }
  }

  /* ---------- model pivot ---------- */
  const pivot = new THREE.Group();  // 模型挂这里；整体平移做“脚底 y=0 / 水平居中”
  pivot.name = 'dsh-canvas-model';
  scene.add(pivot);

  /* ---------- grid ---------- */
  let grid = null;
  let gridMaxDim = 10;      // 记住网格是按多大的包围盒生成的（换主题时重建要用）

  /* ---------- controls ---------- */
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.9;
  controls.panSpeed = 0.9;
  controls.zoomSpeed = 0.9;
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.minPolarAngle = 0.02;
  controls.maxPolarAngle = Math.PI - 0.02;
  controls.minDistance = 0.01;
  controls.maxDistance = 2000;
  controls.target.set(0, 0.5, 0);

  /* ---------- 渲染状态 ---------- */
  let disposed = false;
  let rafId = 0;
  let needsRender = true;
  let interacting = false;
  let cssW = 1;
  let cssH = 1;
  let fitDist = 5;
  let fitTarget = new THREE.Vector3(0, 0.5, 0);
  let lastInfo = null;
  let lastSize = null;                       // 模型的原始尺寸（Vector3），frame() 复用
  let lastOffset = new THREE.Vector3();      // pivot 的“摆正”位移（脚底 y=0 + 水平居中）
  let loading = false;

  // 复用一套待释放集合，避免共用材质重复 dispose
  const disposedGeometries = new Set();
  const disposedMaterials = new Set();
  const disposedTextures = new Set();
  const fallbackMaterials = new Set();

  /* ==================== 渲染循环（省电版） ==================== */

  function schedule() {
    if (disposed || rafId) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (typeof requestAnimationFrame !== 'function') return;
    rafId = requestAnimationFrame(tick);
  }

  function invalidate() {
    needsRender = true;
    schedule();
  }

  function tick() {
    rafId = 0;
    if (disposed) return;

    let moved = false;
    try {
      moved = controls.update() === true;
    } catch (_) {
      moved = false;
    }

    if (moved || needsRender) {
      needsRender = false;
      renderNow();
    }

    // 阻尼未收敛或正在交互时继续要帧；收敛后自然停住
    if (moved || interacting) schedule();
  }

  function renderNow() {
    if (disposed) return;
    try {
      renderer.render(scene, camera);
    } catch (_) { /* 上下文丢失等情况静默 */ }
  }

  // 相机一有变化就置脏 + 排一帧：交互/惯性期间靠这个自我续帧，收敛后自然停下
  controls.addEventListener('change', () => invalidate());
  controls.addEventListener('start', () => { interacting = true; invalidate(); });
  controls.addEventListener('end', () => { interacting = false; invalidate(); });

  /* ==================== 尺寸 ==================== */

  function readCssSize() {
    let w = canvas.clientWidth | 0;
    let h = canvas.clientHeight | 0;
    if ((!w || !h) && canvas.parentElement) {
      const p = canvas.parentElement;
      w = w || (p.clientWidth | 0);
      h = h || (p.clientHeight | 0);
    }
    if (!w || !h) {
      w = w || canvas.width | 0 || 1;
      h = h || canvas.height | 0 || 1;
    }
    return { w: Math.max(1, w), h: Math.max(1, h) };
  }

  function resize() {
    if (disposed) return;
    const { w, h } = readCssSize();
    cssW = w; cssH = h;
    const dpr = Math.min(
      (typeof window !== 'undefined' && window.devicePixelRatio) || 1,
      2
    );
    // 只改绘制缓冲，不碰 CSS（画布显示尺寸由宿主用 CSS 决定）
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    invalidate();
  }

  /* ==================== 网格 ==================== */

  function disposeGrid() {
    if (!grid) return;
    scene.remove(grid);
    if (grid.geometry && !disposedGeometries.has(grid.geometry)) {
      disposedGeometries.add(grid.geometry);
      grid.geometry.dispose();
    }
    const mats = Array.isArray(grid.material) ? grid.material : [grid.material];
    for (const m of mats) {
      if (m && !disposedMaterials.has(m)) { disposedMaterials.add(m); m.dispose(); }
    }
    grid = null;
  }

  function buildGrid(maxDim) {
    disposeGrid();
    gridMaxDim = maxDim;
    if (opts.showGrid === false) return;

    const size = niceCeil(Math.max(maxDim, 1e-3) * 3);
    const divisions = 20;
    grid = new THREE.GridHelper(size, divisions, palette.gridMain, palette.gridSub);
    grid.name = 'dsh-canvas-grid';
    const mats = Array.isArray(grid.material) ? grid.material : [grid.material];
    for (const m of mats) {
      if (!m) continue;
      m.transparent = true;
      m.opacity = palette.gridOpacity;
      m.depthWrite = false;
      m.toneMapped = false;
    }
    grid.position.y = -Math.max(maxDim, 1e-3) * 1e-4; // 贴地，避免与模型底面 z-fighting
    scene.add(grid);
    invalidate();
  }

  /* ==================== 模型清理 ==================== */

  function disposeMaterial(mat) {
    if (!mat || disposedMaterials.has(mat)) return;
    disposedMaterials.add(mat);
    if (fallbackMaterials.has(mat)) fallbackMaterials.delete(mat);
    for (const k of Object.keys(mat)) {
      const v = mat[k];
      if (v && v.isTexture && !disposedTextures.has(v) && v !== envTexture) {
        disposedTextures.add(v);
        try { v.dispose(); } catch (_) { /* ignore */ }
      }
    }
    try { mat.dispose(); } catch (_) { /* ignore */ }
  }

  function disconnectObject(root) {
    if (!root) return;
    root.traverse((o) => {
      if (o.geometry && !disposedGeometries.has(o.geometry)) {
        disposedGeometries.add(o.geometry);
        try { o.geometry.dispose(); } catch (_) { /* ignore */ }
      }
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) disposeMaterial(m);
      if (o.isSkinnedMesh) {
        try { o.skeleton && o.skeleton.dispose && o.skeleton.dispose(); } catch (_) { /* ignore */ }
      }
    });
  }

  function clearModel() {
    const kids = pivot.children.slice();
    for (const k of kids) {
      pivot.remove(k);
      disconnectObject(k);
    }
    pivot.position.set(0, 0, 0);
    pivot.scale.set(1, 1, 1);
    lastInfo = null;
  }

  /* ==================== 材质/几何兜底 ==================== */

  function fallbackMaterial() {
    const m = new THREE.MeshStandardMaterial({
      color: FALLBACK_MAT.color,
      metalness: FALLBACK_MAT.metalness,
      roughness: FALLBACK_MAT.roughness,
    });
    m.name = 'dsh-canvas-fallback';
    fallbackMaterials.add(m);
    return m;
  }

  function ensureGeometryNormals(geometry) {
    if (!geometry || !geometry.attributes || !geometry.attributes.position) return;
    if (geometry.attributes.normal) return;
    try {
      geometry.computeVertexNormals();
    } catch (_) { /* 某些非常规几何算不出来，忽略 */ }
  }

  function ensureMaterials(root) {
    let shared = null;  // 一次加载内复用同一个兜底材质
    root.traverse((o) => {
      if (o.isCamera) { o.visible = false; return; }
      if (o.isLight) { o.visible = false; return; }   // 模型自带的灯会把画面打爆
      if (!o.isMesh && !o.isPoints && !o.isLine && !o.isLineSegments) return;

      if (o.geometry) ensureGeometryNormals(o.geometry);

      const hasMat = Array.isArray(o.material)
        ? o.material.some((m) => !!m)
        : !!o.material;

      if (!hasMat) {
        if (!shared) shared = fallbackMaterial();
        o.material = shared;
      }
    });
  }

  /* ==================== 统计 / 取景 ==================== */

  function measure(root) {
    let meshes = 0;
    let triangles = 0;
    root.traverse((o) => {
      if (!o.isMesh && !o.isPoints && !o.isLine && !o.isLineSegments) return;
      const g = o.geometry;
      if (!g || !g.attributes || !g.attributes.position) return;
      meshes += 1;
      const count = g.index && g.index.count ? g.index.count : g.attributes.position.count;
      const tri = Math.floor(count / 3);
      const inst = o.isInstancedMesh && o.count ? o.count : 1;
      triangles += tri * inst;
    });
    return { meshes, triangles };
  }

  function fitCamera(sizeVec, targetPoint) {
    const sx = Math.max(sizeVec.x, 1e-4);
    const sy = Math.max(sizeVec.y, 1e-4);
    const sz = Math.max(sizeVec.z, 1e-4);
    const radius = 0.5 * Math.sqrt(sx * sx + sy * sy + sz * sz);

    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const aspect = camera.aspect > 0.01 ? camera.aspect : 1;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);

    const distV = radius / Math.max(Math.sin(vFov / 2), 1e-3);
    const distH = radius / Math.max(Math.sin(hFov / 2), 1e-3);
    let dist = Math.max(distV, distH) * 1.18;

    if (!Number.isFinite(dist) || dist <= 0) dist = Math.max(sx, sy, sz) * 3;

    const dir = new THREE.Vector3(0.72, 0.42, 1).normalize(); // 经典 3/4 视角
    camera.position.copy(targetPoint).addScaledVector(dir, dist);

    camera.near = Math.max(dist / 2000, radius / 2000, 1e-5);
    camera.far = Math.max(dist * 40, radius * 40, camera.near * 1000);
    camera.updateProjectionMatrix();

    controls.target.copy(targetPoint);
    controls.minDistance = Math.max(dist * 0.02, 1e-4);
    controls.maxDistance = Math.max(dist * 12, controls.minDistance * 10);
    controls.update();

    fitDist = dist;
    fitTarget = targetPoint.clone();
    invalidate();
  }

  /* ==================== 解析器 ==================== */

  const loaderCache = new Map();
  function getModule(key) {
    if (!loaderCache.has(key)) loaderCache.set(key, import(key));
    return loaderCache.get(key);
  }

  async function loadGLTF(buffer, name, ext) {
    const { GLTFLoader } = await getModule('./GLTFLoader.js');
    const loader = new GLTFLoader();

    // Draco / KTX2 为可选扩展；本目录不带 wasm/decoder 二进制，
    // 只有在宿主显式给了 decoder 路径时才挂上，避免加载报错。
    if (opts.dracoDecoderPath) {
      try {
        const { DRACOLoader } = await getModule('./DRACOLoader.js');
        const draco = new DRACOLoader();
        draco.setDecoderPath(opts.dracoDecoderPath);
        loader.setDRACOLoader(draco);
      } catch (_) { /* 可选 */ }
    }
    if (opts.ktx2TranscoderPath) {
      try {
        const { KTX2Loader } = await getModule('./KTX2Loader.js');
        const ktx2 = new KTX2Loader();
        ktx2.setTranscoderPath(opts.ktx2TranscoderPath);
        ktx2.detectSupport(renderer);
        loader.setKTX2Loader(ktx2);
      } catch (_) { /* 可选 */ }
    }

    const basePath = opts.basePath || opts.baseUrl || '';
    const payload = ext === 'gltf' && looksLikeText(buffer)
      ? new TextDecoder('utf-8').decode(buffer)
      : buffer;

    return await new Promise((resolve, reject) => {
      try {
        loader.parse(payload, basePath, resolve, reject);
      } catch (e) {
        reject(e);
      }
    });
  }

  /** 粗略判断一个 buffer 是不是 JSON 文本（.gltf 可能是 .glb 内容被误命名） */
  function looksLikeText(buffer) {
    if (!buffer || buffer.byteLength < 4) return false;
    const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
    // glTF 二进制魔数 'glTF'
    if (head[0] === 0x67 && head[1] === 0x6c && head[2] === 0x54 && head[3] === 0x46) return false;
    return true;
  }

  async function loadOBJ(buffer, name) {
    // 有 MTL 就尽量用（需要可访问的 URL，本契约只给了 bytes，所以靠 options 提供）
    const basePath = opts.basePath || opts.baseUrl || '';
    const mtlUrl = opts.mtlUrl || '';
    let materialsCreator = null;

    if (mtlUrl) {
      try {
        const { MTLLoader } = await getModule('./MTLLoader.js');
        const mtlLoader = new MTLLoader();
        if (basePath) mtlLoader.setPath(basePath);
        const mats = await new Promise((resolve, reject) => {
          mtlLoader.load(mtlUrl, resolve, undefined, reject);
        });
        try { mats.preload(); } catch (_) { /* ignore */ }
        materialsCreator = mats;
      } catch (_) {
        materialsCreator = null; // MTL 失败一律静默降级为兜底材质
      }
    }

    const { OBJLoader } = await getModule('./OBJLoader.js');
    const loader = new OBJLoader();
    if (materialsCreator) loader.setMaterials(materialsCreator);
    if (basePath) loader.setPath(basePath);
    const root = loader.parse(new TextDecoder('utf-8').decode(buffer));
    // 没有 MTL 时 OBJLoader 会塞 MeshPhongMaterial 占位；统一换成 PBR 兜底材质，
    // 保证 obj/stl/ply 三种“无材质”格式观感一致（浅灰、metalness .05、roughness .6）。
    if (!materialsCreator) convertObjPlaceholderMaterials(root);
    return root;
  }

  /** 把 OBJLoader 的 MeshPhongMaterial 占位材质换成 MeshStandardMaterial（保留顶点色/平滑度） */
  function convertObjPlaceholderMaterials(root) {
    const cache = new Map();
    const originals = new Set();
    root.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const src = o.material;
      if (!src.isMeshPhongMaterial) return;
      let dst = cache.get(src);
      if (!dst) {
        dst = new THREE.MeshStandardMaterial({
          // 有顶点色就让白色相乘，否则用浅灰
          color: src.vertexColors ? new THREE.Color(0xffffff) : new THREE.Color(FALLBACK_MAT.color),
          metalness: FALLBACK_MAT.metalness,
          roughness: FALLBACK_MAT.roughness,
          vertexColors: !!src.vertexColors,
          flatShading: !!src.flatShading,
          side: src.side,
          transparent: !!src.transparent,
          opacity: typeof src.opacity === 'number' ? src.opacity : 1,
        });
        dst.name = src.name || 'dsh-canvas-fallback';
        fallbackMaterials.add(dst);
        cache.set(src, dst);
        originals.add(src);
      }
      o.material = dst;
    });
    for (const src of originals) { try { src.dispose(); } catch (_) { /* ignore */ } }
  }

  async function loadFBX(buffer) {
    const { FBXLoader } = await getModule('./FBXLoader.js');
    const loader = new FBXLoader();
    return loader.parse(buffer, opts.basePath || opts.baseUrl || '');
  }

  async function loadSTL(buffer) {
    const { STLLoader } = await getModule('./STLLoader.js');
    const geometry = new STLLoader().parse(buffer);
    return new THREE.Mesh(geometry, fallbackMaterial());
  }

  async function loadPLY(buffer) {
    const { PLYLoader } = await getModule('./PLYLoader.js');
    const geometry = new PLYLoader().parse(buffer);
    return new THREE.Mesh(geometry, fallbackMaterial());
  }

  /* ==================== load() ==================== */

  async function load(input = {}) {
    if (disposed) throw new Error('viewer 已 dispose，不能再 load');
    if (loading) throw new Error('上一次加载还没结束，请等它完成后再调用 load');

    const { bytes, name = '' } = input || {};
    const extKey = normalizeExt(input && input.ext, name);

    if (!extKey) {
      const got = (input && input.ext) || extOf(name) || '(未知)';
      const err = new Error(
        `格式不支持：无法预览 .${String(got).replace(/^\./, '')} 文件，目前只支持 glb / gltf / obj / fbx / stl / ply`
      );
      if (onError) { try { onError(err); } catch (_) { /* ignore */ } }
      throw err;
    }

    if (bytes == null) {
      const err = new Error('加载失败：没有收到文件内容（bytes 为空）');
      if (onError) { try { onError(err); } catch (_) { /* ignore */ } }
      throw err;
    }

    loading = true;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    try {
      let buffer;
      if (typeof Blob !== 'undefined' && bytes instanceof Blob) {
        buffer = await bytes.arrayBuffer();
      } else {
        buffer = toArrayBuffer(bytes);
      }
      if (!buffer || buffer.byteLength === 0) {
        throw Object.assign(new Error('文件是空的（0 字节）'), { _kind: 'empty' });
      }

      let object = null;
      try {
        switch (extKey) {
          case 'glb':
          case 'gltf': {
            const gltf = await loadGLTF(buffer, name, extKey);
            object = gltf && gltf.scene ? gltf.scene : gltf;
            break;
          }
          case 'obj':  object = await loadOBJ(buffer, name); break;
          case 'fbx':  object = await loadFBX(buffer); break;
          case 'stl':  object = await loadSTL(buffer); break;
          case 'ply':  object = await loadPLY(buffer); break;
          default:     throw new Error('未实现的格式：' + extKey);
        }
      } catch (e) {
        const kind = e && e._kind === 'empty' ? 'empty' : 'corrupt';
        const detail = e && e.message ? String(e.message).split('\n')[0].slice(0, 200) : String(e);
        const err = new Error(
          kind === 'empty'
            ? `文件损坏：${name || '该文件'} 是空文件，无法解析`
            : `文件损坏：${name || '该文件'} 无法作为 ${extKey.toUpperCase()} 解析（${detail}）`
        );
        err.cause = e;
        if (onError) { try { onError(err); } catch (_) { /* ignore */ } }
        throw err;
      }

      if (!object || !object.isObject3D) {
        const err = new Error(`文件损坏：${name || '该文件'} 解析后没有产出 3D 对象`);
        if (onError) { try { onError(err); } catch (_) { /* ignore */ } }
        throw err;
      }

      ensureMaterials(object);

      // —— 换模型（先解析成功再替换，失败保留旧模型）——
      clearModel();
      pivot.position.set(0, 0, 0);
      pivot.scale.set(1, 1, 1);
      pivot.add(object);

      // 包围盒必须在 pivot 归零后算，得到的是模型自身（世界）尺寸
      pivot.updateWorldMatrix(true, true);
      const box = new THREE.Box3().setFromObject(pivot);
      if (box.isEmpty() || !isFinite(box.min.x) || !isFinite(box.max.x)) {
        const err = new Error(`文件损坏：${name || '该文件'} 里没有可显示的网格（包围盒为空）`);
        pivot.remove(object);
        disconnectObject(object);
        if (onError) { try { onError(err); } catch (_) { /* ignore */ } }
        throw err;
      }

      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);

      if (!(maxDim > 0) || !Number.isFinite(maxDim)) {
        const err = new Error(`文件损坏：${name || '该文件'} 的尺寸为 0，无法显示`);
        pivot.remove(object);
        disconnectObject(object);
        if (onError) { try { onError(err); } catch (_) { /* ignore */ } }
        throw err;
      }

      // 脚底贴地 + 水平居中
      pivot.position.set(-center.x, -box.min.y, -center.z);
      pivot.updateWorldMatrix(true, true);
      lastSize = size.clone();
      lastOffset.copy(pivot.position);

      const stats = measure(pivot);
      if (stats.meshes === 0) {
        clearModel();
        const err = new Error(`文件损坏：${name || '该文件'} 中没有可渲染的网格`);
        if (onError) { try { onError(err); } catch (_) { /* ignore */ } }
        throw err;
      }

      buildGrid(maxDim);

      // 取景：目标点 = 贴地后的模型几何中心
      const target = new THREE.Vector3(0, size.y / 2, 0);
      fitCamera(size, target);

      const loadMs = Math.round(
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0
      );

      const info = {
        meshes: stats.meshes,
        triangles: stats.triangles,
        bbox: [round(size.x), round(size.y), round(size.z)],
        loadMs,
        name: name || '',
        ext: extKey,
      };
      lastInfo = info;

      renderNow(); // 立刻出一帧，避免“加载完还是黑的”
      invalidate();

      if (onInfo) { try { onInfo(info); } catch (_) { /* ignore */ } }
      return info;
    } finally {
      loading = false;
    }
  }

  /* ==================== theme / background ==================== */

  function setBackground(color) {
    if (disposed) return;
    if (color == null) {
      explicitBg = false;
      scene.background = new THREE.Color(palette.background);
    } else {
      explicitBg = true;
      scene.background = new THREE.Color(color);
    }
    invalidate();
  }

  function applyPalette() {
    if (envTexture && scene.environment === envTexture) scene.environmentIntensity = palette.envIntensity;

    hemi.color.setHex(palette.hemiSky);
    hemi.groundColor.setHex(palette.hemiGround);
    hemi.intensity = palette.hemiIntensity;

    key.intensity = palette.keyIntensity;
    fill.intensity = palette.fillIntensity;

    renderer.toneMappingExposure = palette.exposure;

    if (!explicitBg) scene.background = new THREE.Color(palette.background);

    // 网格颜色是烘进顶点色的，换色只能重建；尺寸沿用上一次的
    if (grid) buildGrid(gridMaxDim);
    invalidate();
  }

  function setTheme(next) {
    if (disposed) return;
    const want = next === 'light' ? 'light' : next === 'dark' ? 'dark' : null;
    if (!want || want === theme) return;
    theme = want;
    palette = THEMES[theme];
    applyPalette();
  }

  /* ==================== frame / dispose ==================== */

  function frame() {
    if (disposed) return;
    if (!lastSize) {
      invalidate();
      return;
    }
    // 保持“脚底贴地 + 水平居中”的摆位，只重算相机距离/视角
    pivot.position.copy(lastOffset);
    pivot.updateWorldMatrix(true, true);
    const target = new THREE.Vector3(0, lastSize.y / 2, 0);
    fitCamera(lastSize, target);
    renderNow();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    ready = false;

    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }

    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', onWindowResize);
    }
    if (ro) { try { ro.disconnect(); } catch (_) { /* ignore */ } ro = null; }

    try { controls.dispose(); } catch (_) { /* ignore */ }

    clearModel();
    disposeGrid();

    if (envTexture && !disposedTextures.has(envTexture) && !envTexture.isRenderTargetTexture) {
      // 手写渐变环境
      disposedTextures.add(envTexture);
      try { envTexture.dispose(); } catch (_) { /* ignore */ }
    }
    if (envTarget) { try { envTarget.dispose(); } catch (_) { /* ignore */ } envTarget = null; }
    if (roomEnv && typeof roomEnv.dispose === 'function') { try { roomEnv.dispose(); } catch (_) { /* ignore */ } }
    scene.environment = null;

    for (const m of fallbackMaterials) {
      if (disposedMaterials.has(m)) continue;
      disposedMaterials.add(m);
      try { m.dispose(); } catch (_) { /* ignore */ }
    }
    fallbackMaterials.clear();

    try { scene.clear(); } catch (_) { /* ignore */ }
    try { renderer.dispose(); } catch (_) { /* ignore */ }
    // ⚠ 默认不调用 forceContextLoss()：一旦这么做，这个 canvas 的 WebGL 上下文
    // 会永久失效，之后在同一 canvas 上再 createViewer 会直接失败
    // （实测 "Cannot read properties of null (reading 'precision')"）。
    // 需要彻底释放 GPU 上下文（永久卸载）时传 options.loseContext = true。
    if (opts.loseContext === true) {
      try { renderer.forceContextLoss && renderer.forceContextLoss(); } catch (_) { /* ignore */ }
    }
  }

  /* ==================== 事件 ==================== */

  function onVisibility() {
    if (disposed) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    } else {
      invalidate();
    }
  }

  let roRaf = 0;
  function onWindowResize() {
    if (disposed || roRaf) return;
    roRaf = requestAnimationFrame(() => { roRaf = 0; resize(); });
  }

  let ro = null;

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  if (typeof window !== 'undefined') window.addEventListener('resize', onWindowResize);

  // 观察父容器尺寸（不观察 canvas 自身：canvas 的绘制缓冲变化会污染观察源）
  if (typeof ResizeObserver !== 'undefined' && canvas.parentElement) {
    try {
      ro = new ResizeObserver(() => onWindowResize());
      ro.observe(canvas.parentElement);
    } catch (_) { ro = null; }
  }

  /* ==================== 初始化收尾 ==================== */

  resize();
  buildGrid(10);   // 空场景先给一块 10 单位网格，看着不至于全黑
  fitCamera(new THREE.Vector3(1, 1, 1), new THREE.Vector3(0, 0.5, 0));
  renderNow();

  let ready = true;

  /* ==================== 对外对象 ==================== */

  const viewer = {
    get ready() { return ready && !disposed; },
    get info() { return lastInfo; },
    get disposed() { return disposed; },

    canvas,
    scene,
    camera,
    controls,
    renderer,

    load,
    resize,
    frame,
    setBackground,
    setTheme,
    dispose,

    /** 契约外的便捷方法：立刻渲染一帧（外部改过场景后想马上看到） */
    render() { renderNow(); },
  };

  return viewer;
}

/* ============================ 退化环境贴图 ============================ */

/**
 * 手写 equirect 渐变环境（天顶亮 → 地面暖灰），给 PBR 材质兜底环境光。
 * three 会自动把 EquirectangularReflectionMapping 的贴图转成 cubeUV。
 */
function makeGradientEnvironment(theme) {
  const W = 32;
  const H = 16;
  const data = new Uint8Array(W * H * 4);
  const top = theme === 'light' ? [250, 251, 253] : [78, 96, 130];
  const mid = theme === 'light' ? [214, 219, 227] : [38, 42, 52];
  const bot = theme === 'light' ? [176, 182, 190] : [16, 17, 21];

  for (let y = 0; y < H; y++) {
    const t = y / (H - 1);               // 0 = 天顶
    const c = t < 0.5
      ? mix(top, mid, t / 0.5)
      : mix(mid, bot, (t - 0.5) / 0.5);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;

  function mix(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ];
  }
}
