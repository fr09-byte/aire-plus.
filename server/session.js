import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpError } from "./http.js";

const lifetime = 30 * 24 * 3600;
const temporarySecret = randomBytes(32).toString("hex");

export function sessionConfigured() {
  return (process.env.SESSION_SECRET || "").length >= 32;
}

export function requireSessionSecret() {
  if (!sessionConfigured())
    throw new HttpError("Configura SESSION_SECRET con al menos 32 caracteres en el servidor.", 503);
}

export function digest(value) {
  return createHmac("sha256", process.env.SESSION_SECRET || temporarySecret)
    .update(value).digest("hex");
}

function sign(value) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return payload + "." + digest(payload);
}

export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function unsign(raw) {
  if (!raw || raw.length > 1024) return null;
  const parts = raw.split(".");
  if (parts.length !== 2 || !safeEqual(parts[1], digest(parts[0]))) return null;
  try { return JSON.parse(Buffer.from(parts[0], "base64url").toString()); }
  catch { return null; }
}

export function touchSession(req, res, id) {
  const secure = req.headers["x-forwarded-proto"] === "https" ||
    !/^(localhost|127\.0\.0\.1|terminal\.local)(:|$)/.test(req.headers.host || "localhost");
  res.setHeader("Set-Cookie", `aire_session=${sign({ id, createdAt: Date.now() })}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${lifetime}${secure ? "; Secure" : ""}`);
}

export function session(req, res) {
  const raw = (req.headers.cookie || "").split(";")
    .map(v => v.trim()).find(v => v.startsWith("aire_session="))?.slice(13);
  const parsed = unsign(raw), now = Date.now();
  if (parsed && /^[a-f0-9]{32}$/.test(parsed.id) &&
      Number.isFinite(parsed.createdAt) && parsed.createdAt <= now + 300000 &&
      now - parsed.createdAt < lifetime * 1000) return parsed.id;
  const id = randomBytes(16).toString("hex");
  touchSession(req, res, id);
  return id;
}

export function clientFingerprint(req) {
  const ip = String(req.headers["x-real-ip"] || req.socket?.remoteAddress ||
    req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim().slice(0, 100);
  return digest("ip:" + ip).slice(0, 32);
}
