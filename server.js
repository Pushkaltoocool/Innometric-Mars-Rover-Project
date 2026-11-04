// Zero-dependency static server for the demo: `npm start` → http://localhost:5173
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('./web/', import.meta.url)));
const port = Number(process.env.PORT) || 5173;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

http
  .createServer(async (req, res) => {
    try {
      const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = normalize(join(root, url));
      if (!file.startsWith(root)) throw Object.assign(new Error('forbidden'), { code: 'EACCES' });
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(body);
    } catch (e) {
      res.writeHead(e.code === 'EACCES' ? 403 : 404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  })
  .listen(port, () => console.log(`RoverOS demo → http://localhost:${port}`));
