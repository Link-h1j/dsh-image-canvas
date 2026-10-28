// 用 module.register 的 resolve 钩子记录整条 ESM 依赖图里每一个 import specifier，
// 图级别证明 vendor/*.js 里不存在裸包名（只有相对路径）。
// 钩子跑在 loader 线程，统计经 stderr 输出；这里只看能否全部 import 成功。
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

for (const k of ['HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','https_proxy','http_proxy','all_proxy']) delete process.env[k];

const V = 'C:\\Users\\Administrator\\Documents\\deepseek-harness\\默认工作区\\dsh-image-canvas\\vendor';
const HOOK = 'file:///C:/Users/Administrator/Documents/deepseek-harness/%E9%BB%98%E8%AE%A4%E5%B7%A5%E4%BD%9C%E5%8C%BA/dsh-image-canvas/vendor/_work/hook.mjs';
register(HOOK);

const entries = ['viewer.js', 'GLTFLoader.js', 'FBXLoader.js', 'OBJLoader.js', 'MTLLoader.js',
  'STLLoader.js', 'PLYLoader.js', 'DRACOLoader.js', 'KTX2Loader.js', 'OrbitControls.js',
  'RoomEnvironment.js', 'BufferGeometryUtils.js', 'NURBSCurve.js', 'NURBSUtils.js'];

let ok = 0;
for (const f of entries) {
  try {
    await import(pathToFileURL(V + '\\' + f).href);
    ok++;
  } catch (e) {
    console.log('IMPORT_FAILED ' + f + ' :: ' + e.message.split('\n')[0]);
  }
}
console.log('GRAPH_WALK_OK ' + ok + '/' + entries.length +
  '  (每个 REL/BARE 解析行都是钩子从 stderr 打出来的，见上方输出)');
if (ok !== entries.length) process.exitCode = 1;
