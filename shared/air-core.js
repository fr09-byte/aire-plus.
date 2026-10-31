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
  if (value <= 100)
    return { name: "Moderado", color: "#f3cb64", level: 1 };
  if (value <= 150)
    return {
      name: "Dañino para sensibles",
      color: "#f59b59",
      level: 2,
    };
  if (value <= 200)
    return { name: "Dañino", color: "#fa7885", level: 3 };
  if (value <= 300)
    return { name: "Muy dañino", color: "#bd91f5", level: 4 };
  return { name: "Peligroso", color: "#ba5570", level: 5 };
}
function cdmxParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const result = {};
  for (const p of parts)
    if (p.type !== "literal") result[p.type] = Number(p.value);
  return result;
}
function circulation(plate, hologram, parts = cdmxParts()) {
  if (
    !Number.isInteger(plate) ||
    plate < 0 ||
    plate > 9 ||
    !["00", "0", "1", "2", "E"].includes(hologram)
  )
    throw new Error("Selecciona una placa y un holograma válidos.");
  const weekday = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day),
  ).getUTCDay();
  const saturday = Math.ceil(parts.day / 7);
  let restrictedToday = false,
    unknown = false,
    reason = "Hoy no tienes restricción en el calendario base.";
  if (["00", "0", "E"].includes(hologram))
    reason =
      "Este holograma está exento en el calendario base, mientras sea vigente y reconocido.";
  else if (weekday === 6) {
    if (hologram === "2") {
      restrictedToday = true;
      reason = "Holograma 2: restricción todos los sábados.";
    } else if (saturday === 5) {
      unknown = true;
      reason =
        "Quinto sábado: para holograma 1, consulta el aviso vigente de SEDEMA o CAMe.";
    } else {
      restrictedToday =
        (plate % 2 === 1 && [1, 3].includes(saturday)) ||
        (plate % 2 === 0 && [2, 4].includes(saturday));
      reason = restrictedToday
        ? `Holograma 1: placas ${plate % 2 ? "impares" : "pares"}, ${saturday}.º sábado del mes.`
        : "Tu terminación no descansa este sábado en el calendario base.";
    }
  } else if (weekday !== 0) {
    const restricted = {
      1: [5, 6],
      2: [7, 8],
      3: [3, 4],
      4: [1, 2],
      5: [9, 0],
    };
    restrictedToday = restricted[weekday].includes(plate);
    if (restrictedToday)
      reason = `La terminación ${plate} descansa hoy con holograma ${hologram}.`;
  } else
    reason = "El domingo no hay restricción ordinaria del programa.";
  const restrictedNow =
    restrictedToday && parts.hour >= 5 && parts.hour < 22;
  return {
    restrictedToday,
    restrictedNow,
    unknown,
    reason,
    weekday,
    saturday,
  };
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
  const url = new URL(
    "https://air-quality-api.open-meteo.com/v1/air-quality",
  );
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
    throw new Error(
      "La API no devolvió las 16 ubicaciones solicitadas.",
    );
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
    for (const [key, [field, aqiField]] of Object.entries(
      pollutantFields,
    )) {
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
        throw new Error(
          "Subíndice de contaminante con una escala inesperada.",
        );
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

export { zones, zones as ZONES, category, cdmxParts, circulation, buildAirUrl, parseOpenMeteo, isFreshAir, AIR_REFRESH_MS, AIR_MAX_AGE_MS, analyzeAirData };
