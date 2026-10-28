// Build vendor/: copy three r169 build + addon files, flatten all import specifiers.
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const PKG = 'C:\\Users\\Administrator\\Documents\\deepseek-harness\\默认工作区\\dsh-image-canvas\\vendor\\_work\\package';
const OUT = 'C:\\Users\\Administrator\\Documents\\deepseek-harness\\默认工作区\\dsh-image-canvas\\vendor';
mkdirSync(OUT, { recursive: true });

// [source path under package/, output name]
const FILES = [
  ['build/three.module.min.js',           'three.module.js'],
  ['examples/jsm/loaders/GLTFLoader.js',  'GLTFLoader.js'],
  ['examples/jsm/loaders/DRACOLoader.js', 'DRACOLoader.js'],
  ['examples/jsm/loaders/KTX2Loader.js',  'KTX2Loader.js'],
  ['examples/jsm/loaders/FBXLoader.js',   'FBXLoader.js'],
  ['examples/jsm/loaders/OBJLoader.js',   'OBJLoader.js'],
  ['examples/jsm/loaders/MTLLoader.js',   'MTLLoader.js'],
  ['examples/jsm/loaders/STLLoader.js',   'STLLoader.js'],
  ['examples/jsm/loaders/PLYLoader.js',   'PLYLoader.js'],
  ['examples/jsm/controls/OrbitControls.js', 'OrbitControls.js'],
  ['examples/jsm/utils/BufferGeometryUtils.js', 'BufferGeometryUtils.js'],
  ['examples/jsm/utils/WorkerPool.js',    'WorkerPool.js'],
  ['examples/jsm/libs/fflate.module.js',  'fflate.module.js'],
  ['examples/jsm/libs/zstddec.module.js', 'zstddec.module.js'],
  ['examples/jsm/libs/ktx-parse.module.js', 'ktx-parse.module.js'],
  ['examples/jsm/curves/NURBSCurve.js',   'NURBSCurve.js'],
  ['examples/jsm/curves/NURBSUtils.js',   'NURBSUtils.js'],
  ['examples/jsm/environments/RoomEnvironment.js', 'RoomEnvironment.js'],
];

const report = [];
for (const [src, name] of FILES) {
  const from = PKG + '\\' + src.replaceAll('/', '\\');
  if (!existsSync(from)) { report.push(`MISSING ${src}`); continue; }
  let code = readFileSync(from, 'utf8');
  const orig = code;
  const rewrites = [];

  // 1) bare package specifier -> local file
  code = code.replace(/(\bfrom\s*)(['"])three\2/g, (m, a, q) => { rewrites.push("three -> ./three.module.js"); return `${a}'./three.module.js'`; });

  // 2) any relative specifier ending in .js (../x/Y.js, ../../x/Y.js, ./Y.js) -> ./Y.js
  code = code.replace(/(\bfrom\s*)(['"])(\.{1,2}\/[^'"]+\.js)\2/g, (m, a, q, spec) => {
    const flat = './' + spec.split('/').pop();
    if (flat !== spec) rewrites.push(`${spec} -> ${flat}`);
    return `${a}'${flat}'`;
  });

  // 3) side-effect imports: import 'three' / import './x.js'  (rare here but be thorough)
  code = code.replace(/(\bimport\s*)(['"])three\2/g, (m, a, q) => { rewrites.push("import three -> ./three.module.js"); return `${a}'./three.module.js'`; });
  code = code.replace(/(\bimport\s*)(['"])(\.{1,2}\/[^'"]+\.js)\2/g, (m, a, q, spec) => {
    const flat = './' + spec.split('/').pop();
    if (flat !== spec) rewrites.push(`side: ${spec} -> ${flat}`);
    return `${a}'${flat}'`;
  });

  const to = OUT + '\\' + name;
  if (to.endsWith('three.module.js')) copyFileSync(from, to); // verbatim big bundle
  else writeFileSync(to, code, 'utf8');

  const changed = code !== orig;
  report.push(`${name}  ${statSync(to).size}B  from ${src}${changed ? '  REWRITTEN: ' + [...new Set(rewrites)].join(' | ') : '  (no rewrite needed)'}`);
}

console.log(report.join('\n'));
console.log('\n--- files in vendor ---');
for (const [src, name] of FILES) {
  const p = OUT + '\\' + name;
  if (existsSync(p)) console.log(name.padEnd(28), statSync(p).size);
}
