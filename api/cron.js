import { timingSafeEqual } from "node:crypto";
import { HttpError, reply, fail } from "./air.js";
import { checkAllSubscriptions } from "./alerts.js";
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method !== "GET") throw new HttpError("Utiliza GET.", 405);
    const secret = process.env.CRON_SECRET;
    if (!secret || secret.length < 32)
      throw new HttpError(
        "Configura CRON_SECRET con al menos 32 caracteres para el programador del servidor.",
        503,
      );
    const value = Buffer.from(req.headers.authorization || ""),
      expected = Buffer.from("Bearer " + secret);
    if (value.length !== expected.length || !timingSafeEqual(value, expected))
      throw new HttpError("Comprobación programada no autorizada.", 401);
    return reply(res, 200, await checkAllSubscriptions());
  } catch (error) {
    return fail(res, error);
  }
}
