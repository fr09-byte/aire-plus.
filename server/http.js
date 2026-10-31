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
  const { allowEmpty = false, ...requestOptions } = options;
  let response;
  try {
    response = await fetch(url, {
      ...requestOptions,
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
  if (!raw && allowEmpty) return { response, data: {} };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new HttpError("El proveedor devolvió una respuesta inválida.", 502);
  }
  return { response, data };
}
