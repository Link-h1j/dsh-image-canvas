// Test A: dynamically import every vendor/*.js over file:// — proves syntax + all relative
// specifiers resolve, and reports the exported names.
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

for (const k of ['HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','https_proxy','http_proxy','all_proxy']) delete process.env[k];

const V = 'C:\\Users\\Administrator\\Documents\\deepseek-harness\\默认工作区\\dsh-image-canvas\\vendor';
const files = readdirSync(V).filter(f => f.endsWith('.js')).sort();

let fail = 0;
for (const f of files) {
  const url = pathToFileURL(V + '\\' + f).href;
  const t0 = Date.now();
  try {
    const m = await import(url);
    const names = Object.keys(m);
    const shown = names.slice(0, 6).join(',') + (names.length > 6 ? `, …(+${names.length - 6})` : '');
    console.log(`OK   ${f.padEnd(26)} ${String(Date.now() - t0).padStart(5)}ms  exports: ${shown || '(none)'}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${f.padEnd(26)} ${e.code || ''} ${String(e.message).split('\n')[0]}`);
  }
}
console.log(`\n${files.length - fail}/${files.length} imported OK, ${fail} failed`);
process.exit(fail ? 1 : 0);
