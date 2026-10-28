// Download three@0.169.0 tarball without any proxy (env-cleared) and extract.
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

for (const k of ['HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','https_proxy','http_proxy','all_proxy','NODE_OPTIONS']) delete process.env[k];
// also clear npm proxy config influence (we don't use npm)

const OUT = 'C:\\Users\\Administrator\\Documents\\deepseek-harness\\默认工作区\\dsh-image-canvas\\vendor\\_work';
mkdirSync(OUT, { recursive: true });
const tgz = OUT + '\\three-0.169.0.tgz';

const sources = [
  'https://registry.npmmirror.com/three/-/three-0.169.0.tgz',
  'https://registry.npmjs.org/three/-/three-0.169.0.tgz',
  'https://cdn.jsdelivr.net/npm/three@0.169.0/package.json' // sanity only
];

async function tryDownload(url, isTarball = true) {
  const t0 = Date.now();
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`OK ${url} ${buf.length} bytes in ${Date.now()-t0}ms`);
  return buf;
}

let ok = false;
for (const url of sources.slice(0, 2)) {
  try {
    const buf = await tryDownload(url);
    if (buf.length < 100000) throw new Error('too small: ' + buf.length);
    writeFileSync(tgz, buf);
    console.log('saved', tgz, statSync(tgz).size);
    ok = true;
    break;
  } catch (e) {
    console.log('FAIL', url, e.message);
  }
}
if (!ok) { console.log('ALL_SOURCES_FAILED'); process.exit(2); }

// extract with tar (bundled with Windows 10+ / git)
try {
  execFileSync('tar', ['-xzf', tgz, '-C', OUT], { stdio: 'inherit' });
  console.log('extracted to', OUT + '\\package');
} catch (e) {
  console.log('TAR_FAILED', e.message);
  process.exit(3);
}
console.log('DONE');
