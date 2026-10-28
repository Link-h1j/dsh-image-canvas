// 极简静态服务器：root = vendor/，另外把 /whale.glb /knight.fbx 别名到 _verify/。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

for (const k of ['HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','https_proxy','http_proxy','all_proxy']) delete process.env[k];

const VENDOR = 'C:\\Users\\Administrator\\Documents\\deepseek-harness\\默认工作区\\dsh-image-canvas\\vendor';
const PORT = Number(process.argv[2] || 7401);

const ALIASES = {
  '/whale.glb': join(VENDOR, '_verify', 'whale.glb'),
  '/knight.fbx': join(VENDOR, '_verify', 'knight.fbx'),
  '/cube.obj': join(VENDOR, '_verify', 'cube.obj'),
  '/cube.stl': join(VENDOR, '_verify', 'cube.stl'),
  '/cube.ply': join(VENDOR, '_verify', 'cube.ply'),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.fbx': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    let pathName = decodeURIComponent(url.pathname);
    if (pathName === '/') pathName = '/test.html';

    let file = ALIASES[pathName];
    if (!file) {
      const rel = normalize(pathName).replace(/^([/\\])+/, '');
      file = join(VENDOR, rel);
      if (!file.startsWith(VENDOR)) { res.writeHead(403).end('forbidden'); return; }
    }

    const s = await stat(file);
    if (!s.isFile()) { res.writeHead(404).end('not a file'); return; }

    const buf = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 ' + (e && e.message));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('SERVER_READY http://127.0.0.1:' + PORT + '/test.html  root=' + VENDOR);
});
