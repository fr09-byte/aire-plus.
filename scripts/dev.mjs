import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import air from '../api/air.js';
import alerts from '../api/alerts.js';
import assistant from '../api/assistant.js';
import cron from '../api/cron.js';
import subscribe from '../api/subscribe.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const routes = {
  '/api/air': air, '/api/alerts': alerts, '/api/assistant': assistant,
  '/api/cron': cron, '/api/subscribe': subscribe,
};
const types = { '.html': 'text/html', '.js': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

export function createDevServer() {
  return http.createServer(async (req, res) => {
    res.status = code => { res.statusCode = code; return res; };
    res.json = data => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(data)); return res;
    };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { return res.status(400).json({ error: 'Ruta inválida.' }); }
    if (routes[path]) {
      try { return await routes[path](req, res); }
      catch {
        if (!res.headersSent) res.status(500).json({ error: 'Error del servidor local.' });
        else res.end();
        return;
      }
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD');
      return res.status(405).json({ error: 'Método no permitido.' });
    }
    const file = path === '/' || path === '/index.html' ? 'index.html'
      : /^\/(assets|shared)\/[a-zA-Z0-9_./-]+$/.test(path) ? path.slice(1) : null;
    if (!file) return res.status(404).json({ error: 'No se encontró la ruta.' });
    try {
      const full = await realpath(resolve(root, file));
      if (!full.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error('Outside root');
      const body = await readFile(full);
      res.setHeader('Content-Type', (types[extname(full)] || 'application/octet-stream') + '; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.status(404).json({ error: 'No se encontró el archivo.' }); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createDevServer();
  const port = Number(process.env.PORT || 4173);
  server.listen(port, '0.0.0.0', () => console.log('AIRE+ development server listening on ' + port));
}
