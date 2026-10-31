import { HttpError, fetchJson } from "./http.js";

export function redisAvailable() {
  return (
    !!process.env.UPSTASH_REDIS_REST_URL &&
    !!process.env.UPSTASH_REDIS_REST_TOKEN
  );
}
export function storageKey(key) {
  return (
    "aire-v3:" +
    String(process.env.AIRE_NAMESPACE || "cdmx")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 50) +
    ":" +
    key
  );
}
export async function redisCommand(...command) {
  if (!redisAvailable())
    throw new HttpError(
      "Configura el almacenamiento Redis para esta función.",
      503,
    );
  let url;
  try {
    url = new URL(process.env.UPSTASH_REDIS_REST_URL);
  } catch {
    throw new HttpError("La URL del almacenamiento no es válida.", 503);
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new HttpError("El almacenamiento debe utilizar HTTPS.", 503);
  const { response, data } = await fetchJson(url.href, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + process.env.UPSTASH_REDIS_REST_TOKEN,
    },
    body: JSON.stringify(command),
  });
  if (!response.ok || data.error)
    throw new HttpError(
      "El almacenamiento no está disponible. No se enviaron mensajes sin aplicar sus límites.",
      503,
    );
  return data.result;
}

export function requireStorage() {
  if (!redisAvailable()) throw new HttpError(
    "Configura UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN para guardar y verificar tus alertas.", 503);
}

export async function readRecord(key) {
  const raw = await redisCommand("GET", storageKey(key));
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { throw new HttpError("El registro guardado no es válido. Vuelve a configurar tus alertas.", 503); }
}

export async function writeRecord(key, value, seconds = 2592000) {
  await redisCommand("SET", storageKey(key), JSON.stringify(value), "EX", seconds);
}

const RATE_SCRIPT = `-- aire:rate
local n=redis.call('INCR',KEYS[1])
if n == 1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end
return n`;

export async function rateLimit(key, limit, seconds) {
  const n = await redisCommand("EVAL", RATE_SCRIPT, 1, storageKey("rate:" + key), seconds);
  if (Number(n) > limit) throw new HttpError("Se alcanzó el límite de solicitudes. Espera antes de volver a intentar.", 429);
}
