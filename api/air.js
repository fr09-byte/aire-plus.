// AIRE+ · Open-Meteo Air Quality. Node.js 22 / Vercel.
const zones = [
  {
    id: "cuauhtemoc",
    name: "Cuauhtémoc",
    lat: 19.4326,
    lon: -99.1469,
  },
  {
    id: "miguel-hidalgo",
    name: "Miguel Hidalgo",
    lat: 19.434,
    lon: -99.2005,
  },
  {
    id: "benito-juarez",
    name: "Benito Juárez",
    lat: 19.3794,
    lon: -99.1593,
  },
  {
    id: "coyoacan",
    name: "Coyoacán",
    lat: 19.3467,
    lon: -99.1617,
  },
  {
    id: "iztapalapa",
    name: "Iztapalapa",
    lat: 19.3574,
    lon: -99.0926,
  },
  {
    id: "gustavo-a-madero",
    name: "Gustavo A. Madero",
    lat: 19.482,
    lon: -99.1138,
  },
  {
    id: "azcapotzalco",
    name: "Azcapotzalco",
    lat: 19.4849,
    lon: -99.1858,
  },
  {
    id: "alvaro-obregon",
    name: "Álvaro Obregón",
    lat: 19.3599,
    lon: -99.2254,
  },
  {
    id: "cuajimalpa",
    name: "Cuajimalpa",
    lat: 19.3598,
    lon: -99.2919,
  },
  {
    id: "iztacalco",
    name: "Iztacalco",
    lat: 19.3955,
    lon: -99.0974,
  },
  {
    id: "magdalena-contreras",
    name: "La Magdalena Contreras",
    lat: 19.3051,
    lon: -99.2414,
  },
  {
    id: "milpa-alta",
    name: "Milpa Alta",
    lat: 19.1922,
    lon: -99.0232,
  },
  {
    id: "tlahuac",
    name: "Tláhuac",
    lat: 19.2868,
    lon: -99.0051,
  },
  {
    id: "tlalpan",
    name: "Tlalpan",
    lat: 19.2897,
    lon: -99.1678,
  },
  {
    id: "venustiano-carranza",
    name: "Venustiano Carranza",
    lat: 19.4303,
    lon: -99.0992,
  },
  {
    id: "xochimilco",
    name: "Xochimilco",
    lat: 19.2583,
    lon: -99.1048,
  },
];
function category(value) {
  if (!Number.isFinite(value) || value < 0)
    return { name: "Sin dato", color: "#94a7bc", level: -1 };
  if (value <= 50) return { name: "Bueno", color: "#42dca6", level: 0 };
  if (value <= 100) return { name: "Moderado", color: "#f3cb64", level: 1 };
  if (value <= 150)
    return {
      name: "Dañino para sensibles",
      color: "#f59b59",
      level: 2,
    };
  if (value <= 200) return { name: "Dañino", color: "#fa7885", level: 3 };
  if (value <= 300) return { name: "Muy dañino", color: "#bd91f5", level: 4 };
  return { name: "Peligroso", color: "#ba5570", level: 5 };
}
const AIR_REFRESH_MS = 15 * 60 * 1000;
const AIR_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const pollutantFields = Object.freeze({
  pm25: ["pm2_5", "us_aqi_pm2_5"],
  pm10: ["pm10", "us_aqi_pm10"],
  o3: ["ozone", "us_aqi_ozone"],
  no2: ["nitrogen_dioxide", "us_aqi_nitrogen_dioxide"],
});
function buildAirUrl() {
  const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
  url.searchParams.set("latitude", zones.map((z) => z.lat).join(","));
  url.searchParams.set("longitude", zones.map((z) => z.lon).join(","));
  url.searchParams.set(
    "current",
    ["us_aqi", ...Object.values(pollutantFields).flat()].join(","),
  );
  url.searchParams.set("hourly", "us_aqi");
  url.searchParams.set("forecast_hours", "25");
  url.searchParams.set("timeformat", "unixtime");
  url.searchParams.set("timezone", "GMT");
  url.searchParams.set("domains", "cams_global");
  return url.toString();
}
function parseOpenMeteo(payload, now = Date.now()) {
  if (payload?.error)
    throw new Error(
      "Open-Meteo: " +
        String(payload.reason || "consulta rechazada").slice(0, 180),
    );
  if (!Array.isArray(payload) || payload.length !== zones.length)
    throw new Error("La API no devolvió las 16 ubicaciones solicitadas.");
  const readValue = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : null;
  const points = [],
    validTimes = [];
  const stations = payload.map((item, index) => {
    const zone = zones[index];
    if (!item || item.error)
      throw new Error(
        "Open-Meteo no pudo resolver la consulta de " + zone.name + ".",
      );
    const current = item.current || {},
      units = item.current_units || {};
    const timestamp =
      typeof current.time === "number" && Number.isFinite(current.time)
        ? current.time * 1000
        : NaN;
    const fresh =
      Number.isFinite(timestamp) &&
      timestamp <= now + 300000 &&
      now - timestamp <= AIR_MAX_AGE_MS;
    const components = {},
      subindices = {};
    for (const [key, [field, aqiField]] of Object.entries(pollutantFields)) {
      const value = readValue(current[field]);
      if (
        value !== null &&
        String(units[field] || "").replace(/μ/g, "µ") !== "µg/m³"
      )
        throw new Error(
          "Unidad inesperada para " + field + "; se esperaba µg/m³.",
        );
      components[key] = fresh ? value : null;
      const subindex = readValue(current[aqiField]);
      if (subindex !== null && units[aqiField] !== "USAQI")
        throw new Error("Subíndice de contaminante con una escala inesperada.");
      subindices[key] =
        fresh && subindex !== null ? Math.round(subindex) : null;
    }
    const aqi = readValue(current.us_aqi);
    if (aqi !== null && units.us_aqi !== "USAQI")
      throw new Error("La API no identificó su escala como US AQI.");
    if (fresh) validTimes.push(timestamp);
    const hourly = item.hourly,
      hourlyUnits = item.hourly_units;
    if (
      hourlyUnits?.time === "unixtime" &&
      hourlyUnits.us_aqi === "USAQI" &&
      Array.isArray(hourly?.time) &&
      Array.isArray(hourly.us_aqi)
    ) {
      hourly.time.forEach((seconds, i) => {
        const value = readValue(hourly.us_aqi[i]);
        const time = typeof seconds === "number" ? seconds * 1000 : NaN;
        if (
          value !== null &&
          Number.isFinite(time) &&
          time > now &&
          time <= now + 25 * 3600000
        )
          points.push({
            zone: zone.id,
            time: new Date(time).toISOString(),
            value: Math.round(value),
          });
      });
    }
    return {
      zone: zone.id,
      name: zone.name,
      lat: zone.lat,
      lon: zone.lon,
      gridLat: Number.isFinite(item.latitude) ? item.latitude : null,
      gridLon: Number.isFinite(item.longitude) ? item.longitude : null,
      value: fresh && aqi !== null ? Math.round(aqi) : null,
      observedAt: fresh ? new Date(timestamp).toISOString() : null,
      components,
      subindices,
    };
  });
  if (!validTimes.length)
    throw new Error(
      "Open-Meteo no devolvió datos actuales válidos de las últimas dos horas.",
    );
  return {
    provider: "open-meteo",
    demo: false,
    indexSystem: "US_AQI",
    source: "Open-Meteo / CAMS Global",
    observedAt: new Date(Math.min(...validTimes)).toISOString(),
    fetchedAt: new Date(now).toISOString(),
    stations,
    forecast: { method: "cams", model: "CAMS Global", points },
  };
}
function isFreshAir(data, now = Date.now()) {
  if (
    !data ||
    data.provider !== "open-meteo" ||
    data.indexSystem !== "US_AQI" ||
    !Array.isArray(data.stations) ||
    data.stations.length !== zones.length
  )
    return false;
  const time = Date.parse(data.observedAt);
  return (
    Number.isFinite(time) &&
    time <= now + 300000 &&
    now - time <= AIR_MAX_AGE_MS &&
    data.stations.every((station, i) => station.zone === zones[i].id)
  );
}

export { zones as ZONES, category, buildAirUrl, parseOpenMeteo, isFreshAir };

export class HttpError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export function reply(res, status, data) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(status).json(data);
}
export function fail(res, error) {
  return reply(res, error instanceof HttpError ? error.status : 500, {
    error:
      error instanceof HttpError
        ? error.message
        : "No fue posible completar la operación. Revisa la configuración del servidor.",
  });
}
export function checkOrigin(req, res, methods = "GET, POST, OPTIONS") {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  const origin = req.headers.origin;
  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  let same = false;
  if (origin) {
    try {
      const parsed = new URL(origin);
      same =
        parsed.host === req.headers.host &&
        ["http:", "https:"].includes(parsed.protocol);
    } catch {}
  }
  if (origin && !same && !allowed.includes(origin))
    throw new HttpError(
      "Esta petición debe realizarse desde el sitio AIRE+ desplegado.",
      403,
    );
  if (
    req.headers["sec-fetch-site"] === "cross-site" &&
    !allowed.includes(origin)
  )
    throw new HttpError("No se permiten peticiones de otros sitios.", 403);
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
}
export async function readJson(req) {
  if (Number(req.headers["content-length"] || 0) > 8192)
    throw new HttpError("Solicitud demasiado grande.", 413);
  if (
    !(req.headers["content-type"] || "")
      .toLowerCase()
      .includes("application/json")
  )
    throw new HttpError("Se requiere una solicitud JSON.", 415);
  let value = req.body;
  if (value === undefined) {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 8192)
        throw new HttpError("Solicitud demasiado grande.", 413);
    }
    value = raw;
  }
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new HttpError("JSON inválido.");
    }
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Buffer.byteLength(JSON.stringify(value)) > 8192
  )
    throw new HttpError("Datos de solicitud inválidos.");
  return value;
}
export async function fetchJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new HttpError(
      "El proveedor no respondió a tiempo. Revisa su registro antes de repetir un envío.",
      502,
    );
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 1048576)
    throw new HttpError("Respuesta demasiado grande del proveedor.", 502);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new HttpError("El proveedor devolvió una respuesta inválida.", 502);
  }
  return { response, data };
}
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
