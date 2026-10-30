import {
  createHmac,
  randomBytes,
  timingSafeEqual,
  randomUUID,
} from "node:crypto";
import {
  HttpError,
  reply,
  fail,
  checkOrigin,
  readJson,
  fetchJson,
  getAirData,
  ZONES,
  redisAvailable,
  redisCommand,
  storageKey,
} from "./air.js";

const CHANNELS = ["telegram", "sms", "whatsapp"];
const memoryReservations = new Map();
const fallbackSecret = randomBytes(32).toString("hex");
export function providerStatus() {
  const e = process.env,
    number = (v) => /^\+[1-9]\d{7,14}$/.test(v || "");
  const twilio =
    /^AC[0-9a-f]{32}$/i.test(e.TWILIO_ACCOUNT_SID || "") &&
    !!e.TWILIO_AUTH_TOKEN;
  return {
    telegram:
      /^\d+:[A-Za-z0-9_-]+$/.test(e.TELEGRAM_BOT_TOKEN || "") &&
      /^-?\d+$/.test(e.TELEGRAM_CHAT_ID || ""),
    sms: twilio && number(e.TWILIO_SMS_FROM) && number(e.TWILIO_SMS_TO),
    whatsapp:
      twilio &&
      /^whatsapp:\+[1-9]\d{7,14}$/.test(e.TWILIO_WHATSAPP_FROM || "") &&
      /^whatsapp:\+[1-9]\d{7,14}$/.test(e.TWILIO_WHATSAPP_TO || ""),
  };
}
function signature(value) {
  const key =
    process.env.SESSION_SECRET ||
    [process.env.TELEGRAM_BOT_TOKEN, process.env.TWILIO_AUTH_TOKEN]
      .filter(Boolean)
      .join(":") ||
    fallbackSecret;
  return createHmac("sha256", key).update(value).digest("base64url");
}
function sign(value) {
  const raw = Buffer.from(JSON.stringify(value)).toString("base64url");
  return raw + "." + signature(raw);
}
function unsign(raw) {
  if (typeof raw !== "string" || raw.length > 6000) return null;
  const [value, mac] = raw.split(".");
  if (!value || !mac) return null;
  const expected = signature(value),
    a = Buffer.from(mac),
    b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString());
  } catch {
    return null;
  }
}
function cookies(req) {
  const result = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0) result[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return result;
}
function putCookie(req, res, name, value, maxAge = 2592000) {
  const secure =
    req.headers["x-forwarded-proto"] === "https" ||
    (req.headers.host &&
      !/^(localhost|127\.0\.0\.1|terminal\.local)(:|$)/.test(req.headers.host));
  const cookie = `${name}=${value}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  const old = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", [
    ...(Array.isArray(old) ? old : old ? [old] : []),
    cookie,
  ]);
}
function session(req, res) {
  const parsed = unsign(cookies(req).aire_session);
  if (
    parsed &&
    /^[a-f0-9]{32}$/.test(parsed.id) &&
    Number.isFinite(parsed.createdAt) &&
    Date.now() - parsed.createdAt < 2592000000
  )
    return parsed.id;
  const value = { id: randomBytes(16).toString("hex"), createdAt: Date.now() };
  putCookie(req, res, "aire_session", sign(value));
  return value.id;
}
async function getSubscription(req, id) {
  if (redisAvailable()) {
    const raw = await redisCommand("GET", storageKey("sub:" + id));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const value = unsign(cookies(req).aire_preferences);
  return value && value.session === id ? value.subscription : null;
}
async function storeSubscription(req, res, id, value) {
  if (redisAvailable()) {
    if (value?.active) {
      const active = await redisCommand("ZCARD", storageKey("subscriptions"));
      const existing = await redisCommand("GET", storageKey("sub:" + id));
      if (!existing && Number(active) >= 64)
        throw new HttpError(
          "Se alcanzó el máximo de configuraciones activas de este despliegue.",
          429,
        );
      await redisCommand(
        "SET",
        storageKey("sub:" + id),
        JSON.stringify(value),
        "EX",
        2592000,
      );
      await redisCommand("ZADD", storageKey("subscriptions"), Date.now(), id);
    } else {
      await redisCommand("DEL", storageKey("sub:" + id));
      await redisCommand("ZREM", storageKey("subscriptions"), id);
    }
  } else
    putCookie(
      req,
      res,
      "aire_preferences",
      value?.active ? sign({ session: id, subscription: value }) : "",
      value?.active ? 2592000 : 0,
    );
  return value;
}
export function validatePreferences(input) {
  if (
    !Array.isArray(input.channels) ||
    !input.channels.length ||
    input.channels.length > 3 ||
    input.channels.some((c) => !CHANNELS.includes(c)) ||
    new Set(input.channels).size !== input.channels.length
  )
    throw new HttpError("Selecciona al menos un canal válido.");
  const ready = providerStatus();
  for (const channel of input.channels)
    if (!ready[channel])
      throw new HttpError(
        `Configura las variables de entorno y el destinatario de ${channel} en Vercel.`,
        503,
      );
  const ids = new Set(ZONES.map((z) => z.id));
  if (
    !Array.isArray(input.zones) ||
    !input.zones.length ||
    input.zones.length > 16 ||
    input.zones.some((z) => !ids.has(z)) ||
    new Set(input.zones).size !== input.zones.length
  )
    throw new HttpError("Selecciona alcaldías válidas.");
  if (![51, 101, 151, 201, 301].includes(input.threshold))
    throw new HttpError("El umbral US AQI no es válido.");
  if (![60, 180, 360, 1440].includes(input.intervalMinutes))
    throw new HttpError("El intervalo no es válido.");
  if (input.channels.some((c) => c !== "telegram") && !redisAvailable())
    throw new HttpError(
      "Para SMS y WhatsApp configura Redis: permite aplicar el límite diario de mensajes de forma persistente.",
      503,
    );
  return {
    channels: [...input.channels],
    zones: [...input.zones],
    threshold: input.threshold,
    intervalMinutes: input.intervalMinutes,
    indexSystem: "US_AQI",
  };
}
const RESERVE_SCRIPT = `
if redis.call('EXISTS',KEYS[1]) == 1 then return 'cooldown' end
local count=tonumber(redis.call('GET',KEYS[2]) or '0')
if count>=tonumber(ARGV[1]) then return 'quota' end
redis.call('INCR',KEYS[2]); redis.call('EXPIRE',KEYS[2],172800)
redis.call('SET',KEYS[1],ARGV[3],'EX',ARGV[2])
return 'ok'`;
function dailyLimit() {
  const n = Number(process.env.MAX_MESSAGES_PER_DAY || 6);
  return Number.isInteger(n) ? Math.max(1, Math.min(100, n)) : 6;
}
async function reserve(channel, kind, seconds) {
  const day = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/Mexico_City",
    }),
    token = randomUUID(),
    key = storageKey(`cooldown:${kind}:${channel}`),
    quota = storageKey("quota:" + day);
  if (redisAvailable()) {
    const result = await redisCommand(
      "EVAL",
      RESERVE_SCRIPT,
      2,
      key,
      quota,
      dailyLimit(),
      seconds,
      token,
    );
    if (result === "quota")
      throw new HttpError(
        "Se alcanzó el límite diario de mensajes de este despliegue.",
        429,
      );
    if (result === "cooldown") return null;
    return { key, token };
  }
  if (channel !== "telegram")
    throw new HttpError(
      "SMS y WhatsApp requieren un limitador persistente configurado.",
      503,
    );
  const now = Date.now(),
    current = memoryReservations.get(key);
  if (current && current.until > now) return null;
  const used = memoryReservations.get(quota) || 0;
  if (used >= dailyLimit())
    throw new HttpError(
      "Se alcanzó el límite diario de mensajes de esta instancia.",
      429,
    );
  memoryReservations.set(quota, used + 1);
  memoryReservations.set(key, { until: now + seconds * 1000, token });
  return { key, token };
}
export function clearMemoryReservations() {
  memoryReservations.clear();
}
export async function sendChannel(channel, message) {
  const e = process.env;
  if (!providerStatus()[channel])
    throw new HttpError(`Falta configurar ${channel} en Vercel.`, 503);
  if (channel === "telegram") {
    const { response, data } = await fetchJson(
      `https://api.telegram.org/bot${e.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: e.TELEGRAM_CHAT_ID,
          text: message,
          disable_web_page_preview: true,
        }),
      },
    );
    if (!response.ok || data.ok !== true) {
      const code = data.error_code || response.status;
      const hint = {
        401: "Telegram rechazó el token. Revisa TELEGRAM_BOT_TOKEN.",
        400: "Telegram rechazó el chat. Revisa TELEGRAM_CHAT_ID y envía /start a tu bot.",
        403: "El bot está bloqueado o no tiene permiso en este chat.",
        429: "Telegram limitó la frecuencia. Espera antes de repetir.",
      };
      throw new HttpError(
        hint[code] || `Telegram respondió con el código ${code}.`,
        502,
      );
    }
    if (!data.result?.message_id)
      throw new HttpError(
        "Telegram no confirmó un identificador de mensaje.",
        502,
      );
    return {
      channel,
      ok: true,
      id: String(data.result.message_id),
      message: "Mensaje aceptado por Telegram.",
    };
  }
  const whatsapp = channel === "whatsapp";
  const params = new URLSearchParams({
    From: e[whatsapp ? "TWILIO_WHATSAPP_FROM" : "TWILIO_SMS_FROM"],
    To: e[whatsapp ? "TWILIO_WHATSAPP_TO" : "TWILIO_SMS_TO"],
  });
  if (whatsapp && e.TWILIO_WHATSAPP_CONTENT_SID) {
    params.set("ContentSid", e.TWILIO_WHATSAPP_CONTENT_SID);
    params.set("ContentVariables", JSON.stringify({ 1: message }));
  } else params.set("Body", message);
  const { response, data } = await fetchJson(
    `https://api.twilio.com/2010-04-01/Accounts/${e.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization:
          "Basic " +
          Buffer.from(
            `${e.TWILIO_ACCOUNT_SID}:${e.TWILIO_AUTH_TOKEN}`,
          ).toString("base64"),
      },
      body: params.toString(),
    },
  );
  if (!response.ok) {
    const code = Number(data.code),
      hint = {
        20003: "Twilio rechazó Account SID o Auth Token.",
        21608: "Verifica el destinatario de tu cuenta de prueba de Twilio.",
        21606: "El remitente no está habilitado para SMS.",
        21408: "Habilita el destino geográfico en Twilio.",
        63007: "Revisa el remitente WhatsApp o el número del Sandbox.",
        63015: "El destinatario debe unirse al Sandbox de WhatsApp.",
        63016:
          "WhatsApp requiere una plantilla aprobada fuera de la ventana de atención.",
      };
    throw new HttpError(
      hint[code] ||
        `Twilio rechazó el mensaje (código ${Number.isFinite(code) ? code : response.status}).`,
      502,
    );
  }
  if (!data.sid)
    throw new HttpError("Twilio no confirmó un SID de mensaje.", 502);
  return {
    channel,
    ok: true,
    id: data.sid,
    message: `Aceptado por Twilio (${String(data.status || "aceptado").slice(0, 20)}); entrega pendiente de confirmar.`,
  };
}
export async function dispatch(subscription, { test = false } = {}) {
  const air = await getAirData();
  const relevant = air.stations.filter(
    (s) => subscription.zones.includes(s.zone) && Number.isFinite(s.value),
  );
  if (!relevant.length)
    throw new HttpError(
      "Open-Meteo no tiene un índice vigente para la alcaldía elegida.",
      503,
    );
  const exceeded = relevant.filter((s) => s.value >= subscription.threshold);
  if (!test && !exceeded.length)
    return {
      state: "below_threshold",
      results: [],
      observedAt: air.observedAt,
    };
  const worst = (test ? relevant : exceeded).reduce((a, b) =>
    a.value > b.value ? a : b,
  );
  const date = new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mexico_City",
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(worst.observedAt || air.observedAt));
  const text = test
    ? `[PRUEBA] AIRE+ · Canal conectado. Consulta Open-Meteo: ${worst.name}, US AQI ${worst.value}, modelo para ${date} (CDMX). Esta es una prueba, no un aviso de emergencia.`
    : `AIRE+ · ${worst.name}: US AQI ${worst.value}, umbral ${subscription.threshold}+. Modelo Open-Meteo / CAMS para ${date} (CDMX). Reduce tu exposición según tu sensibilidad y consulta el panel.`;
  const results = [];
  for (const channel of subscription.channels) {
    try {
      const reservation = await reserve(
        channel,
        test ? "test" : "auto",
        test ? 60 : subscription.intervalMinutes * 60,
      );
      if (!reservation) {
        results.push({
          channel,
          ok: true,
          skipped: true,
          message: test
            ? "Espera 60 segundos antes de repetir este canal."
            : "Aún no se cumple el intervalo mínimo de avisos.",
        });
        continue;
      }
      results.push(await sendChannel(channel, text));
    } catch (error) {
      results.push({
        channel,
        ok: false,
        message:
          error instanceof HttpError
            ? error.message
            : "No se pudo completar el envío.",
      });
    }
  }
  return {
    state: test ? "tested" : "checked",
    observedAt: air.observedAt,
    results,
  };
}
export async function checkAllSubscriptions() {
  if (!redisAvailable())
    throw new HttpError(
      "Las comprobaciones con el sitio cerrado requieren Redis.",
      503,
    );
  const lock = storageKey("cron-lock"),
    token = randomUUID();
  if (!(await redisCommand("SET", lock, token, "EX", 120, "NX")))
    return { state: "busy", results: [] };
  try {
    const ids = await redisCommand(
        "ZRANGE",
        storageKey("subscriptions"),
        0,
        63,
      ),
      results = [];
    if (!ids?.length) return { state: "inactive", results };
    await getAirData();
    for (const id of ids) {
      const raw = await redisCommand("GET", storageKey("sub:" + id));
      if (!raw) {
        await redisCommand("ZREM", storageKey("subscriptions"), id);
        continue;
      }
      try {
        const sub = JSON.parse(raw);
        if (sub.active) results.push(await dispatch(validatePreferences(sub)));
      } catch (error) {
        results.push({
          state: "error",
          message:
            error instanceof HttpError
              ? error.message
              : "Configuración no válida.",
        });
      }
    }
    return { state: "checked", results };
  } finally {
    await redisCommand(
      "EVAL",
      'if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end',
      1,
      lock,
      token,
    );
  }
}
export default async function handler(req, res) {
  try {
    checkOrigin(req, res);
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["GET", "POST"].includes(req.method))
      throw new HttpError("Utiliza GET o POST.", 405);
    const id = session(req, res);
    if (req.method === "GET")
      return reply(res, 200, {
        channels: providerStatus(),
        storageMode: redisAvailable() ? "server" : "session",
        dailyLimit: dailyLimit(),
        backgroundReady:
          redisAvailable() && (process.env.CRON_SECRET || "").length >= 32,
        subscription: await getSubscription(req, id),
      });
    const input = await readJson(req);
    if (input.action === "test") {
      const preferences = validatePreferences({
        ...input,
        intervalMinutes: input.intervalMinutes || 1440,
      });
      return reply(res, 200, await dispatch(preferences, { test: true }));
    }
    if (input.action === "subscribe") {
      const preferences = validatePreferences(input),
        air = await getAirData();
      if (
        !air.stations.some(
          (s) => preferences.zones.includes(s.zone) && Number.isFinite(s.value),
        )
      )
        throw new HttpError("No hay datos actuales para la zona elegida.", 503);
      const subscription = {
        ...preferences,
        active: true,
        updatedAt: new Date().toISOString(),
      };
      await storeSubscription(req, res, id, subscription);
      return reply(res, 200, {
        subscription,
        storageMode: redisAvailable() ? "server" : "session",
        channels: providerStatus(),
        backgroundReady:
          redisAvailable() && (process.env.CRON_SECRET || "").length >= 32,
      });
    }
    if (input.action === "unsubscribe") {
      await storeSubscription(req, res, id, null);
      return reply(res, 200, {
        subscription: null,
        storageMode: redisAvailable() ? "server" : "session",
        channels: providerStatus(),
        backgroundReady:
          redisAvailable() && (process.env.CRON_SECRET || "").length >= 32,
      });
    }
    if (input.action === "check") {
      const subscription = await getSubscription(req, id);
      if (!subscription?.active)
        return reply(res, 200, { state: "inactive", results: [] });
      return reply(res, 200, await dispatch(validatePreferences(subscription)));
    }
    throw new HttpError("Acción no válida.");
  } catch (error) {
    return fail(res, error);
  }
}
