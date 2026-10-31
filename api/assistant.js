import { zones, analyzeAirData } from "../shared/air-core.js";
import { getAirData } from "./air.js";
import { HttpError, reply, fail, checkOrigin, readJson } from "../server/http.js";
export { analyzeAirData } from "../shared/air-core.js";

export default async function handler(req, res) {
  try {
    checkOrigin(req, res, "POST, OPTIONS");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") throw new HttpError("Utiliza POST.", 405);
    const input = await readJson(req);
    if (!zones.some((z) => z.id === input.zone))
      throw new HttpError("Selecciona una alcaldía válida.");
    if (
      !["general", "sensible", "deportista", "infancia"].includes(
        input.profile || "general",
      )
    )
      throw new HttpError("Selecciona un perfil válido.");
    if (
      input.question !== undefined &&
      (typeof input.question !== "string" || input.question.length > 500)
    )
      throw new HttpError("La pregunta es demasiado larga.");
    const data = await getAirData();
    return reply(res, 200, {
      analysis: analyzeAirData(
        data,
        input.zone,
        input.profile || "general",
        input.question || "",
      ),
    });
  } catch (error) {
    return fail(res, error);
  }
}
