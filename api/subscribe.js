import alerts from './alerts.js';
import { checkOrigin, readJson, fail, HttpError } from '../server/http.js';

// La ruta anterior comparte el almacenamiento y la validación del servicio principal.
export default async function handler(req, res) {
  try {
    checkOrigin(req, res, 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      throw new HttpError('Utiliza POST.', 405);
    }
    const body = await readJson(req);
    return alerts({ method: 'POST', headers: req.headers, socket: req.socket,
      body: { ...body, action: 'subscribe' } }, res);
  } catch (error) {
    return fail(res, error);
  }
}
