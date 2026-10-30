import {
  ZONES as zones,
  category,
  isFreshAir,
  getAirData,
  HttpError,
  reply,
  fail,
  checkOrigin,
  readJson,
} from "./air.js";
function analyzeAirData(
  data,
  zoneId,
  profile = "general",
  question = "",
  now = Date.now(),
) {
  const profiles = {
    general: "Población general",
    sensible: "Persona sensible",
    deportista: "Deportista",
    infancia: "Infancia y embarazo",
  };
  if (!Object.hasOwn(profiles, profile)) profile = "general";
  const zone = zones.find((z) => z.id === zoneId);
  if (!zone) throw new Error("Selecciona una alcaldía válida.");
  const station = isFreshAir(data, now)
    ? data.stations.find((s) => s.zone === zoneId)
    : null;
  const labels = { pm25: "PM2.5", pm10: "PM10", o3: "O₃", no2: "NO₂" };
  const detailKeys = ["pm25", "pm10", "o3", "no2"];
  const details = detailKeys.map((key) => {
    const value = station?.components?.[key],
      subindex = station?.subindices?.[key];
    return {
      key,
      name: labels[key],
      value: Number.isFinite(value) ? value : null,
      unit: "µg/m³",
      subindex: Number.isFinite(subindex) ? subindex : null,
      category: category(subindex).name,
    };
  });
  const ready = Number.isFinite(station?.value);
  const c = category(station?.value);
  const date = station?.observedAt
    ? new Intl.DateTimeFormat("es-MX", {
        timeZone: "America/Mexico_City",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(station.observedAt))
    : null;
  const guidance = {
    general: [
      "Puedes realizar tus actividades habituales al aire libre.",
      "La mayoría de las personas puede mantener sus actividades. Si notas molestias, reduce el esfuerzo prolongado.",
      "Si notas molestias respiratorias, reduce la intensidad y toma descansos; las personas sensibles necesitan mayor precaución.",
      "Reduce las actividades intensas y prolongadas al aire libre y aumenta los descansos.",
      "Evita el esfuerzo intenso al aire libre y reduce el tiempo de exposición.",
      "Evita las actividades al aire libre y permanece en espacios interiores libres de humo.",
    ],
    sensible: [
      "Puedes mantener tu actividad habitual siguiendo las indicaciones de tu profesional de salud.",
      "Si eres especialmente sensible, acorta el esfuerzo prolongado y presta atención a tus síntomas.",
      "Reduce el esfuerzo intenso y prolongado al aire libre. Prefiere actividades suaves y más descansos.",
      "Evita el esfuerzo intenso o prolongado al aire libre; considera realizar la actividad en interiores libres de humo.",
      "Evita la actividad física al aire libre y permanece en interiores libres de humo.",
      "Permanece en interiores y evita la exposición exterior; sigue tus indicaciones médicas.",
    ],
    deportista: [
      "Puedes realizar tu entrenamiento habitual. Elige rutas lejos del tráfico y revisa la evolución del aire.",
      "Puedes entrenar si te encuentras bien. Vigila tus síntomas y acorta la sesión si eres especialmente sensible.",
      "Considera reducir la duración o intensidad del entrenamiento exterior, especialmente si eres sensible o aparecen molestias.",
      "Reduce el entrenamiento intenso o prolongado; una sesión en interiores libres de humo es una alternativa.",
      "Reprograma el entrenamiento exterior y realiza una sesión suave en un espacio interior libre de humo.",
      "Cancela o reprograma la sesión exterior. Evita el esfuerzo en zonas expuestas a la contaminación.",
    ],
    infancia: [
      "Las actividades habituales son posibles; observa cualquier molestia y sigue las indicaciones médicas individuales.",
      "Vigila las molestias durante la actividad física; las personas especialmente sensibles pueden necesitar reducir el esfuerzo.",
      "Reduce las actividades intensas y prolongadas al aire libre, y aumenta los descansos.",
      "Prefiere actividades en interiores libres de humo y evita esfuerzos intensos al aire libre.",
      "Evita la actividad al aire libre y utiliza espacios interiores libres de humo.",
      "Permanece en interiores libres de humo y evita la exposición exterior.",
    ],
  };
  const ranked = details
    .filter((d) => Number.isFinite(d.subindex))
    .sort((a, b) => b.subindex - a.subindex);
  const dominant = ranked[0] || null;
  const summary = ready
    ? `En ${zone.name}, Open-Meteo estima un US AQI de ${station.value}: ${c.name.toLowerCase()}. El dato corresponde al modelo para ${date} (CDMX).`
    : `No hay un índice actual válido para ${zone.name}. No puedo asignar un nivel de riesgo sin datos vigentes.`;
  const recommendations = ready
    ? [
        guidance[profile][c.level],
        dominant
          ? `${dominant.name} presenta el mayor subíndice entre los contaminantes consultados (${dominant.subindex} US AQI). No compares directamente las concentraciones de sustancias distintas.`
          : "La fuente no entregó subíndices suficientes para identificar cuál pesa más entre los contaminantes consultados.",
      ]
    : [
        "Pulsa Actualizar y verifica la hora de los datos antes de decidir sobre una actividad exterior.",
        "No se sustituyen datos ausentes por números de ejemplo.",
      ];
  const future = (data?.forecast?.points || [])
    .filter(
      (p) =>
        p.zone === zoneId &&
        Number.isFinite(p.value) &&
        Date.parse(p.time) > now &&
        Date.parse(p.time) <= now + 6 * 3600000,
    )
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  let outlook = "No hay un pronóstico vigente para las próximas horas.";
  if (ready && future.length) {
    const low = future.reduce((a, b) => (a.value < b.value ? a : b)),
      high = future.reduce((a, b) => (a.value > b.value ? a : b));
    const hour = new Intl.DateTimeFormat("es-MX", {
      timeZone: "America/Mexico_City",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(low.time));
    outlook = `En las próximas ${future.length} horas, el modelo estima un rango de ${low.value} a ${high.value} US AQI. El menor valor de ese intervalo aparece a las ${hour} (CDMX).`;
  }
  const readings =
    details
      .map(
        (d) =>
          `${d.name}: ${d.value === null ? "sin dato" : Number(d.value.toFixed(1)) + " " + d.unit}${d.subindex === null ? "" : " (subíndice " + d.subindex + " US AQI)"}`,
      )
      .join("; ") + ".";
  const q = String(question)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  let introduction = "";
  if (/pm2|pm 2/.test(q))
    introduction =
      "PM2.5 son partículas finas. Su concentración actual y su subíndice se muestran a continuación.";
  else if (/ozono|o3/.test(q))
    introduction =
      "El O₃ es ozono a nivel del suelo. Para evaluar su aporte uso el subíndice publicado por Open-Meteo, sin convertir una concentración instantánea en un índice por mi cuenta.";
  else if (/pm10|pm 10/.test(q))
    introduction =
      "PM10 son partículas de hasta 10 micrómetros. Interpreto su subíndice junto con el índice general.";
  else if (/ia|modelo|como funciona/.test(q))
    introduction =
      "Este asistente es un sistema experto con reglas interpretables. Evalúa datos actuales y adapta la explicación a tu perfil; no utiliza un modelo generativo ni realiza diagnósticos médicos.";
  const answer = [
    introduction,
    summary,
    readings,
    `Para tu perfil (${profiles[profile].toLowerCase()}): ${recommendations[0]}`,
    recommendations[1],
    outlook,
    "Orientación ambiental basada en estimaciones; si presentas síntomas importantes, busca atención médica.",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    engine: "rules",
    status: ready ? "ready" : "missing",
    source: "Open-Meteo Air Quality / CAMS",
    indexSystem: "US_AQI",
    zone: zoneId,
    zoneName: zone.name,
    profile,
    profileName: profiles[profile],
    observedAt: station?.observedAt || null,
    summary,
    details,
    dominant: dominant?.key || null,
    recommendations,
    outlook,
    answer,
  };
}

export { analyzeAirData };
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
