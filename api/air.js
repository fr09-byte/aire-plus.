import { buildAirUrl, parseOpenMeteo, isFreshAir } from "../shared/air-core.js";
import { HttpError, fetchJson, checkOrigin, reply, fail } from "../server/http.js";
export * from "../shared/air-core.js";
export * from "../server/http.js";
export * from "../server/storage.js";

let cachedAir = null,
  airPromise = null;
export function clearAirCache() {
  cachedAir = null;
  airPromise = null;
}
export async function getAirData() {
  if (
    isFreshAir(cachedAir) &&
    Date.now() - Date.parse(cachedAir.fetchedAt) < 300000
  )
    return cachedAir;
  if (airPromise) return airPromise;
  airPromise = (async () => {
    const { response, data } = await fetchJson(buildAirUrl(), {
      headers: { Accept: "application/json" },
    });
    if (!response.ok)
      throw new HttpError(
        response.status === 429
          ? "Open-Meteo limitó temporalmente las consultas. Espera unos minutos."
          : "Open-Meteo no pudo entregar los datos actuales.",
        503,
      );
    try {
      cachedAir = parseOpenMeteo(data);
    } catch (error) {
      throw new HttpError(error.message, 503);
    }
    return cachedAir;
  })();
  try {
    return await airPromise;
  } finally {
    airPromise = null;
  }
}
export default async function handler(req, res) {
  try {
    checkOrigin(req, res, "GET, OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") throw new HttpError("Utiliza GET.", 405);
    const data = await getAirData();
    res.setHeader(
      "Cache-Control",
      "public, max-age=0, s-maxage=300, stale-while-revalidate=60",
    );
    return reply(res, 200, data);
  } catch (error) {
    return fail(res, error);
  }
}
