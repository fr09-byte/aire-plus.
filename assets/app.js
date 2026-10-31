import { zones, category, cdmxParts, circulation, buildAirUrl, parseOpenMeteo, isFreshAir, AIR_REFRESH_MS, analyzeAirData } from "../shared/air-core.js";

"use strict";
window.addEventListener("DOMContentLoaded", () => {
  const $ = (id) => document.getElementById(id);

  const tz = "America/Mexico_City";
  const timeLabel = (d) =>
    new Intl.DateTimeFormat("es-MX", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(d));
  const dateLabel = (d) =>
    new Intl.DateTimeFormat("es-MX", {
      timeZone: tz,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(d));
  const memory = new Map();
  let persistent = true;
  try {
    localStorage.setItem("aire:storage-test", "1");
    localStorage.removeItem("aire:storage-test");
  } catch {
    persistent = false;
  }
  function readStore(key, fallback) {
    try {
      const raw = persistent
        ? localStorage.getItem(key)
        : memory.get(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }
  function saveStore(key, value) {
    const raw = JSON.stringify(value);
    memory.set(key, raw);
    if (persistent) {
      try {
        localStorage.setItem(key, raw);
      } catch {
        persistent = false;
        $("storageWarning").hidden = false;
      }
    }
  }
  const saved = readStore("aire:settings", {});
  let selected = zones.some((z) => z.id === saved.zone)
    ? saved.zone
    : "cuauhtemoc";
  const cachedAir = readStore("aire:open-meteo:v1", null);
  let liveData = isFreshAir(cachedAir) ? cachedAir : null,
    sourceFailed = !!liveData,
    loadingAir = false,
    airError = "",
    chart = null,
    map = null,
    boundaryLayer = null,
    markers = new Map(),
    forecastHours = 24,
    forecastRows = [],
    busy = false,
    toastTimer = null;
  let backendConnected = false,
    serverSubscription = null;
  let latestStatus = null, statusLoaded = false;
  const verifiedContacts = new Map();
  const channelNames = { telegram: "Telegram", sms: "SMS", whatsapp: "WhatsApp", email: "Correo" };
  let reports = readStore("aire:reports", []);
  if (!Array.isArray(reports)) reports = [];
  reports = reports
    .filter(
      (r) =>
        r &&
        typeof r.description === "string" &&
        typeof r.location === "string",
    )
    .slice(0, 100);
  $("storageWarning").hidden = persistent;
  function toast(message) {
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").hidden = false;
    toastTimer = setTimeout(() => ($("toast").hidden = true), 5000);
  }
  function options(select, includeAll = false) {
    select.replaceChildren();
    if (includeAll) select.add(new Option("Todas las alcaldías", "all"));
    for (const z of zones) select.add(new Option(z.name, z.id));
  }
  options($("zoneSelect"));
  options($("alertZone"), true);
  options($("reportZone"));
  $("zoneSelect").value = selected;
  $("alertZone").value = saved.alertZone || selected;
  $("reportZone").value = selected;
  if ([51, 101, 151, 201, 301].includes(saved.threshold))
    $("alertThreshold").value = String(saved.threshold);
  if ([60, 180, 360, 1440].includes(saved.intervalMinutes))
    $("alertInterval").value = String(saved.intervalMinutes);
  if (Array.isArray(saved.channels))
    for (const el of document.querySelectorAll("[name=channel]"))
      el.checked = saved.channels.includes(el.value);
  if (Array.isArray(saved.content))
    for (const el of document.querySelectorAll("[name=alertContent]"))
      el.checked = saved.content.includes(el.value);
  if (["general", "sensible", "deportista", "infancia"].includes(saved.profile))
    $("alertProfile").value = saved.profile;
  if (saved.vehicle && Number.isInteger(saved.vehicle.plate) && saved.vehicle.plate >= 0 && saved.vehicle.plate <= 9)
    $("alertPlate").value = String(saved.vehicle.plate);
  if (["00", "0", "1", "2", "E"].includes(saved.vehicle?.hologram))
    $("alertHologram").value = saved.vehicle.hologram;
  function saveSettings() {
    saveStore("aire:settings", {
      zone: selected,
      ...preferences(),
    });
  }
  function preferences() {
    return {
      alertZone: $("alertZone").value,
      threshold: Number($("alertThreshold").value),
      intervalMinutes: Number($("alertInterval").value),
      channels: [
        ...document.querySelectorAll("[name=channel]:checked"),
      ].map((el) => el.value),
      content: [...document.querySelectorAll("[name=alertContent]:checked")].map(el => el.value),
      profile: $("alertProfile").value,
      vehicle: { plate: Number($("alertPlate").value), hologram: $("alertHologram").value },
    };
  }
  function stations() {
    return liveData
      ? liveData.stations
      : zones.map((z) => ({
          ...z,
          zone: z.id,
          value: null,
          components: {},
          subindices: {},
          observedAt: null,
        }));
  }
  function zoneStation() {
    return (
      stations().find((station) => station.zone === selected) || null
    );
  }
  function currentValue() {
    return zoneStation()?.value ?? null;
  }
  function updateClock() {
    const now = new Date();
    $("clock").textContent = timeLabel(now) + " · CDMX";
    $("clock").dateTime = now.toISOString();
    const key =
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        dateStyle: "short",
      }).format(now) + cdmxParts(now).hour;
    if (updateClock.previous !== key) {
      updateClock.previous = key;
      renderHnc();
    }
  }
  function renderHnc() {
    const parts = cdmxParts(),
      holo = document.querySelector("[name=hologram]:checked").value,
      result = circulation(Number($("plateSelect").value), holo, parts);
    $("hncDate").textContent = new Intl.DateTimeFormat("es-MX", {
      timeZone: tz,
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(new Date());
    const el = $("hncResult");
    el.className =
      "result" +
      (result.unknown
        ? " warn"
        : result.restrictedToday
          ? " danger"
          : "");
    const title = document.createElement("strong"),
      text = document.createElement("p");
    title.textContent = result.unknown
      ? "Confirma el aviso del quinto sábado"
      : result.restrictedNow
        ? "No circulas ahora · 05:00–22:00 h"
        : result.restrictedToday
          ? "Hoy descansas de 05:00 a 22:00 h"
          : "Circulas hoy · calendario base";
    text.textContent =
      result.reason +
      (result.restrictedToday && !result.restrictedNow
        ? " En este momento estás fuera del horario de restricción."
        : "");
    el.replaceChildren(title, text);
  }
  const advice = [
    [
      "La calidad estimada es satisfactoria. Puedes realizar tus actividades habituales.",
      "Sigue tus indicaciones médicas y consulta los avisos oficiales.",
      "Puedes entrenar al aire libre; revisa el estado del aire antes y durante la sesión.",
    ],
    [
      "La calidad estimada es aceptable para la mayoría de las personas.",
      "Si eres especialmente sensible y notas molestias, reduce el esfuerzo prolongado al aire libre.",
      "Vigila tus síntomas. Si eres sensible a la contaminación, reduce el esfuerzo prolongado o intenso.",
    ],
    [
      "Las personas sin condiciones de riesgo suelen verse menos afectadas. Mantente informado.",
      "Reduce el esfuerzo prolongado o intenso al aire libre y sigue tus indicaciones médicas.",
      "Si eres sensible, reduce el entrenamiento exterior. Ante molestias, baja la intensidad o entra a un espacio sin humo.",
    ],
    [
      "Reduce el esfuerzo intenso y prolongado al aire libre; aumenta los descansos.",
      "Evita el esfuerzo prolongado o intenso al aire libre y sigue tus indicaciones médicas.",
      "Reduce la duración e intensidad; considera entrenar en interiores libres de humo.",
    ],
    [
      "Evita el esfuerzo intenso al aire libre y reduce el tiempo de exposición.",
      "Evita la actividad física al aire libre y permanece en interiores libres de humo.",
      "Realiza la sesión en interiores libres de humo o reprograma el entrenamiento exterior.",
    ],
    [
      "Evita la actividad al aire libre y sigue las recomendaciones oficiales.",
      "Permanece en interiores libres de humo y busca atención médica ante síntomas importantes.",
      "Reprograma el entrenamiento exterior y evita la exposición a la contaminación.",
    ],
  ];
  function renderOverview() {
    const value = currentValue(),
      c = category(value),
      zone = zones.find((z) => z.id === selected),
      station = zoneStation();
    $("airCard").style.setProperty("--accent", c.color);
    $("icaValue").textContent = value ?? "—";
    $("airStatus").textContent =
      value === null && loadingAir ? "Cargando…" : c.name;
    $("airStatus").dataset.long = String(c.name.length > 13);
    $("currentZone").textContent = zone.name + ", CDMX";
    $("gauge").setAttribute(
      "aria-label",
      `US AQI ${value ?? "sin dato"}, ${c.name}. Estimación CAMS.`,
    );
    $("gaugeFill").setAttribute(
      "stroke-dasharray",
      `${value === null ? 0 : Math.min(100, value / 5)} 100`,
    );
    $("airDescription").textContent =
      value === null
        ? loadingAir
          ? "Consultando la API pública de Open-Meteo…"
          : "No hay un dato vigente disponible para esta alcaldía."
        : "Estimación actual de CAMS · índice US AQI.";
    $("observationLabel").textContent = station?.observedAt
      ? "Modelo para: " + dateLabel(station.observedAt) + " · CDMX"
      : "Sin estimación actual disponible.";
    const guidance =
      value === null
        ? [
            "Consulta el dato oficial vigente antes de decidir.",
            "Consulta el dato oficial y tus indicaciones médicas.",
            "Consulta el dato oficial antes de entrenar.",
          ]
        : advice[c.level];
    ["adviceGeneral", "adviceSensitive", "adviceAthletes"].forEach(
      (id, i) => ($(id).textContent = guidance[i]),
    );
    for (const key of ["pm25", "pm10", "o3", "no2"]) {
      const concentration = station?.components?.[key],
        subindex = station?.subindices?.[key];
      $(key).textContent = Number.isFinite(concentration)
        ? Number(concentration.toFixed(1))
        : "—";
      $(key + "bar").style.width = Number.isFinite(subindex)
        ? Math.min(100, subindex / 5) + "%"
        : "0%";
      $(key + "bar").style.background = category(subindex).color;
      $(key + "bar").parentElement.title = Number.isFinite(subindex)
        ? "Subíndice US AQI: " + subindex + " (escala visual 0–500)"
        : "Subíndice no disponible";
    }
    renderForecast();
    renderAnalysis();
  }
  function renderBadge() {
    $("dataBadge").className =
      "pill" + (!liveData || sourceFailed || loadingAir ? " amber" : "");
    const label = loadingAir
      ? "Consultando Open-Meteo…"
      : !liveData
        ? "Datos no disponibles"
        : sourceFailed
          ? "Último dato guardado"
          : "Open-Meteo conectado";
    $("dataBadge").replaceChildren(
      Object.assign(document.createElement("span"), { className: "dot" }),
      document.createTextNode(label),
    );
    $("dataNoticeText").textContent = liveData
      ? `${liveData.source}. Estimación para ${dateLabel(liveData.observedAt)}; consultada ${dateLabel(liveData.fetchedAt)} (CDMX). ${sourceFailed ? "Falló la actualización; se conserva el último dato vigente." : "Consulta automática cada 15 minutos."}`
      : loadingAir
        ? "Consultando datos de la API pública. No se muestran valores inventados mientras carga."
        : "No fue posible obtener datos actuales. " +
          (airError || "Pulsa Actualizar para reintentar.");
    $("mapDescription").textContent =
      "Puntos de consulta por alcaldía · US AQI de Open-Meteo / CAMS.";
  }
  function chooseZone(id, pan = true) {
    selected = id;
    $("zoneSelect").value = id;
    saveSettings();
    renderOverview();
    renderStations();
    boundaryLayer?.setStyle(boundaryStyle);
    if (pan && map) {
      const s = zoneStation();
      if (s) map.flyTo([s.lat, s.lon], 12, { duration: 0.5 });
    }
  }
  function renderStations() {
    const list = $("stationList"),
      head = document.createElement("div");
    head.className = "station-head";
    const l = document.createElement("span"),
      r = document.createElement("span");
    l.textContent = "PUNTOS DE CONSULTA";
    r.textContent = "US AQI";
    head.append(l, r);
    list.replaceChildren(head);
    const ss = stations();
    $("stationCount").textContent = ss.length + " alcaldías";
    ss.forEach((s, i) => {
      const c = category(s.value),
        button = document.createElement("button");
      button.type = "button";
      button.className =
        "station" + (s.zone === selected ? " selected" : "");
      button.setAttribute(
        "aria-label",
        `${s.name || s.zone}, US AQI ${s.value ?? "sin dato"}, ${c.name}`,
      );
      button.setAttribute("aria-pressed", String(s.zone === selected));
      const name = document.createElement("span");
      name.className = "station-name";
      const dot = document.createElement("i");
      dot.className = "dot";
      dot.style.color = c.color;
      name.append(
        dot,
        document.createTextNode(
          s.name || zones.find((z) => z.id === s.zone).name,
        ),
      );
      const value = document.createElement("span");
      value.className = "station-value";
      value.style.color = c.color;
      value.textContent = s.value ?? "—";
      button.append(name, value);
      button.addEventListener("click", () => {
        chooseZone(s.zone);
        markers.get(i)?.openPopup();
      });
      list.append(button);
    });
  }
  function isLight() {
    return document.documentElement.dataset.theme === "light";
  }
  function boundaryStyle(feature) {
    const active = feature.properties.zone === selected;
    return {
      color: active
        ? isLight()
          ? "#168568"
          : "#48dfad"
        : isLight()
          ? "#86a6b8"
          : "#355464",
      weight: active ? 1.8 : 1,
      fillColor: isLight() ? "#bfd6df" : "#193440",
      fillOpacity: isLight() ? 0.58 : 0.7,
    };
  }
  function updateChartTheme() {
    if (!chart) return;
    const css = getComputedStyle(document.documentElement),
      muted = css.getPropertyValue("--muted").trim();
    chart.data.datasets[0].borderColor = css
      .getPropertyValue("--green")
      .trim();
    chart.data.datasets[0].backgroundColor = css
      .getPropertyValue("--chart-fill")
      .trim();
    chart.options.scales.x.ticks.color = muted;
    chart.options.scales.y.ticks.color = muted;
    chart.options.scales.y.grid.color = css
      .getPropertyValue("--chart-grid")
      .trim();
    chart.options.plugins.tooltip.backgroundColor = css
      .getPropertyValue("--panel2")
      .trim();
    chart.options.plugins.tooltip.titleColor = css
      .getPropertyValue("--ink")
      .trim();
    chart.options.plugins.tooltip.bodyColor = css
      .getPropertyValue("--ink")
      .trim();
    chart.options.plugins.tooltip.borderColor = css
      .getPropertyValue("--border")
      .trim();
  }
  function applyTheme(theme, persist = true) {
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
    $("themeSwitch").setAttribute(
      "aria-checked",
      String(theme === "dark"),
    );
    $("themeLabel").textContent = theme === "dark" ? "Oscuro" : "Claro";
    $("themeIcon").setAttribute(
      "href",
      theme === "dark" ? "#i-moon" : "#i-sun",
    );
    document.querySelector('meta[name="theme-color"]').content =
      theme === "dark" ? "#08141d" : "#f4f7fa";
    if (persist) saveStore("aire:theme", theme);
    boundaryLayer?.setStyle(boundaryStyle);
    updateChartTheme();
    chart?.update("none");
  }
  $("themeSwitch").addEventListener("click", () =>
    applyTheme(isLight() ? "dark" : "light"),
  );
  function renderMarkers() {
    if (!map) return;
    for (const marker of markers.values()) marker.remove();
    markers.clear();
    stations().forEach((s, i) => {
      const color = category(s.value).color;
      const el = document.createElement("div");
      el.className = "map-marker";
      el.style.setProperty("--c", color);
      el.textContent = s.value ?? "—";
      const icon = L.divIcon({
        html: el,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
        className: "",
      });
      const popup = document.createElement("div"),
        strong = document.createElement("strong"),
        p = document.createElement("p");
      strong.textContent =
        s.name || zones.find((z) => z.id === s.zone).name;
      p.textContent = `US AQI ${s.value ?? "sin dato"} · ${category(s.value).name}. ${s.observedAt ? "CAMS para " + dateLabel(s.observedAt) + " (CDMX)." : "Sin datos actuales."} Punto de consulta, no estación física.`;
      popup.append(strong, p);
      const marker = L.marker([s.lat, s.lon], {
        icon,
        keyboard: true,
        title: `${s.name || s.zone}: US AQI ${s.value ?? "sin dato"}`,
      })
        .addTo(map)
        .bindPopup(popup);
      marker.on("click", () => chooseZone(s.zone, false));
      markers.set(i, marker);
    });
  }
  function initMap() {
    if (!window.L) {
      $("map").className = "map-fallback";
      const a = document.createElement("a");
      a.href = "https://www.openstreetmap.org/#map=11/19.39/-99.13";
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.className = "link";
      a.textContent = "Abrir mapa de CDMX ↗";
      $("map").replaceChildren(
        document.createTextNode(
          "El mapa requiere que Leaflet se descargue una vez desde su CDN. La lista de zonas sigue disponible.",
        ),
        a,
      );
      return;
    }
    map = L.map("map", {
      scrollWheelZoom: false,
      zoomControl: true,
    }).setView([19.365, -99.135], 10.6);
    boundaryLayer = L.geoJSON(
      JSON.parse($("aire-boundaries").textContent),
      {
        style: boundaryStyle,
        onEachFeature: (feature, layer) => {
          const label = document.createElement("span");
          label.textContent = feature.properties.name;
          layer.bindTooltip(label, { sticky: true });
          layer.on("click", () => chooseZone(feature.properties.zone));
        },
      },
    ).addTo(map);
    map.fitBounds(boundaryLayer.getBounds(), { padding: [15, 15] });
    map.attributionControl.addAttribution(
      '<a href="https://serviciosatlas.sgirpc.cdmx.gob.mx/arcgis/rest/services/AtlasCapasPublicas/Limites/FeatureServer/2" target="_blank" rel="noopener noreferrer">SGIRPC CDMX</a> · geometría simplificada',
    );
    renderMarkers();
  }
  function svgForecast(rows) {
    const wrap = document.createElement("div");
    wrap.className = "chart-fallback";
    const ns = "http://www.w3.org/2000/svg",
      svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 600 200");
    svg.setAttribute("role", "img");
    svg.setAttribute(
      "aria-label",
      "Curva de pronóstico. Valores accesibles en la tabla.",
    );
    const max = Math.max(130, ...rows.map((r) => r.value)) + 15;
    for (let y = 0; y <= 3; y++) {
      const line = document.createElementNS(ns, "line");
      line.setAttribute("x1", "30");
      line.setAttribute("x2", "580");
      line.setAttribute("y1", String(15 + y * 50));
      line.setAttribute("y2", String(15 + y * 50));
      line.setAttribute("stroke", "#253546");
      svg.append(line);
    }
    const poly = document.createElementNS(ns, "polyline");
    poly.setAttribute(
      "points",
      rows
        .map(
          (r, i) =>
            `${30 + (i * 550) / Math.max(1, rows.length - 1)},${175 - (r.value / max) * 155}`,
        )
        .join(" "),
    );
    poly.setAttribute("fill", "none");
    poly.setAttribute("stroke", "#42dca6");
    poly.setAttribute("stroke-width", "3");
    svg.append(poly);
    const label = document.createElementNS(ns, "text");
    label.setAttribute("x", "30");
    label.setAttribute("y", "198");
    label.setAttribute("fill", "#94a7bc");
    label.setAttribute("font-size", "11");
    label.textContent = `${timeLabel(rows[0].time)} — ${timeLabel(rows.at(-1).time)} · Hora CDMX`;
    svg.append(label);
    wrap.append(svg);
    $("chartWrap").replaceChildren(wrap);
  }
  function renderForecast() {
    const rows = (liveData?.forecast?.points || [])
      .filter(
        (point) =>
          point.zone === selected &&
          Number.isFinite(point.value) &&
          point.value >= 0 &&
          Date.parse(point.time) > Date.now(),
      )
      .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
      .slice(0, forecastHours);
    $("forecastMethod").textContent =
      loadingAir && !liveData
        ? "Consultando el pronóstico…"
        : "Open-Meteo / CAMS Global · US AQI";
    $("forecastCaveat").textContent =
      "Pronóstico numérico de CAMS proporcionado por Open-Meteo. No es un modelo de IA propio ni un aviso oficial; varias alcaldías pueden compartir celda de cálculo.";
    forecastRows = rows;
    $("forecastSummary").hidden = !rows.length;
    const tbody = $("forecastTable").querySelector("tbody");
    tbody.replaceChildren();
    if (!rows.length) {
      chart?.destroy();
      chart = null;
      const p = document.createElement("p");
      p.className = "muted small";
      p.style.padding = "40px 10px";
      p.textContent =
        "El pronóstico se mostrará cuando Open-Meteo entregue datos vigentes para esta alcaldía.";
      $("chartWrap").replaceChildren(p);
      return;
    }
    for (const point of rows) {
      const tr = document.createElement("tr"),
        td1 = document.createElement("td"),
        td2 = document.createElement("td");
      td1.textContent = dateLabel(point.time);
      td2.textContent = point.value;
      tr.append(td1, td2);
      tbody.append(tr);
    }
    const peak = rows.reduce((a, b) => (a.value > b.value ? a : b)),
      best = rows.reduce((a, b) => (a.value < b.value ? a : b));
    $("forecastAverage").textContent =
      Math.round(
        rows.reduce((sum, r) => sum + r.value, 0) / rows.length,
      ) + " US AQI";
    $("forecastBest").textContent = timeLabel(best.time);
    $("forecastPeak").textContent =
      `Pico: ${peak.value} a las ${timeLabel(peak.time)}`;
    if (!window.Chart) {
      svgForecast(rows);
      return;
    }
    if (!chart) {
      const canvas = document.createElement("canvas");
      canvas.id = "forecastChart";
      canvas.setAttribute("role", "img");
      canvas.setAttribute(
        "aria-label",
        "Pronóstico " + "de CAMS" + " a " + forecastHours + " horas",
      );
      $("chartWrap").replaceChildren(canvas);
      chart = new Chart(canvas, {
        type: "line",
        data: {
          labels: [],
          datasets: [
            {
              label: "US AQI",
              data: [],
              borderColor: "#42dca6",
              backgroundColor: "#42dca617",
              fill: true,
              borderWidth: 2.5,
              pointRadius: 0,
              pointHoverRadius: 5,
              tension: 0.36,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: "#1a2c3c",
              borderColor: "#3c5365",
              borderWidth: 1,
              displayColors: false,
              callbacks: {
                title: (items) =>
                  dateLabel(forecastRows[items[0].dataIndex].time),
                label: (item) => "US AQI " + item.raw,
              },
            },
          },
          scales: {
            x: {
              grid: { display: false },
              border: { display: false },
              ticks: {
                color: "#829ab1",
                maxTicksLimit: 6,
                font: { size: 10 },
              },
            },
            y: {
              beginAtZero: true,
              suggestedMax: 130,
              grid: { color: "#23334277" },
              border: { display: false },
              ticks: {
                color: "#7d94ac",
                stepSize: 50,
                font: { size: 10 },
              },
            },
          },
        },
      });
    }
    chart.data.labels = rows.map((r) => timeLabel(r.time));
    chart.data.datasets[0].data = rows.map((r) => r.value);
    chart.data.datasets[0].label = "US AQI";
    chart.canvas.setAttribute(
      "aria-label",
      "Pronóstico " + "de CAMS" + " a " + forecastHours + " horas",
    );
    updateChartTheme();
    chart.update();
  }
  async function backendRequest(path, payload, timeoutMs = 50000) {
    if (location.protocol === "file:")
      throw new Error(
        "Abre la página desplegada en Vercel para utilizar el backend /api.",
      );
    let response;
    try {
      response = await fetch(path, {
        method: payload === undefined ? "GET" : "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          ...(payload === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        ...(payload === undefined
          ? {}
          : { body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(
        error.name === "TimeoutError"
          ? "El servidor tardó demasiado. Revisa el proveedor antes de repetir un envío."
          : "No fue posible contactar al backend de AIRE+.",
      );
    }
    const data = await response.json().catch(() => null);
    if (!data)
      throw new Error(
        response.status === 404
          ? "No se encontró /api. Actualiza la carpeta api de tu despliegue en Vercel."
          : "El servidor devolvió una respuesta inválida.",
      );
    if (!response.ok)
      throw new Error(
        data.error || "El servidor no pudo completar la petición.",
      );
    return data;
  }
  function requestApi(action, extra = {}) {
    return backendRequest("/api/alerts", { action, ...extra });
  }
  async function loadAir(quiet = false) {
    if (loadingAir) return false;
    if (liveData && !isFreshAir(liveData)) liveData = null;
    loadingAir = true;
    $("refreshButton").disabled = true;
    renderBadge();
    renderOverview();
    try {
      let provided = null;
      if (location.protocol !== "file:") {
        try {
          const response = await fetch("/api/air", {
            headers: { Accept: "application/json" },
            credentials: "omit",
            signal: AbortSignal.timeout(15000),
          });
          if (response.ok) {
            const value = await response.json();
            if (isFreshAir(value)) provided = value;
          }
        } catch {}
      }
      const response = provided
        ? null
        : await fetch(buildAirUrl(), {
            method: "GET",
            mode: "cors",
            credentials: "omit",
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(25000),
          });
      if (response && !response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(
          response.status === 429
            ? "Open-Meteo limitó temporalmente las consultas. Espera unos minutos antes de reintentar."
            : "Open-Meteo respondió HTTP " +
              response.status +
              (payload?.reason
                ? ": " + String(payload.reason).slice(0, 150)
                : "."),
        );
      }
      liveData = provided || parseOpenMeteo(await response.json());
      saveStore("aire:open-meteo:v1", liveData);
      sourceFailed = false;
      airError = "";
      if (!quiet)
        toast("Panel y mapa actualizados desde Open-Meteo / CAMS.");
      return true;
    } catch (error) {
      const cached = liveData || readStore("aire:open-meteo:v1", null);
      liveData = isFreshAir(cached) ? cached : null;
      sourceFailed = !!liveData;
      airError =
        error.name === "TimeoutError"
          ? "La API tardó demasiado. Revisa tu conexión y reintenta."
          : error instanceof TypeError
            ? "No se pudo contactar a Open-Meteo. Revisa tu conexión a internet."
            : error.message;
      if (!quiet)
        toast(
          liveData
            ? "No se pudo actualizar; se conserva el último dato, con su hora."
            : airError,
        );
      return false;
    } finally {
      loadingAir = false;
      $("refreshButton").disabled = false;
      renderBadge();
      renderOverview();
      renderStations();
      renderMarkers();
      if (serverSubscription?.active) checkAlerts();
    }
  }
  let checkingAlerts = false;
  function canonicalContact(channel) {
    const raw = $("contact-" + channel).value.trim();
    return channel === "whatsapp" && raw ? "whatsapp:" + raw.replace(/^whatsapp:/, "")
      : channel === "email" ? raw.toLowerCase() : raw;
  }
  function contactVerified(channel) {
    return verifiedContacts.get(channel) === canonicalContact(channel);
  }
  function renderContactForms() {
    const selected = new Set(preferences().channels);
    for (const [channel] of Object.entries(channelNames)) {
      document.querySelector('[data-contact-channel="' + channel + '"]').hidden = !selected.has(channel);
      const connection = latestStatus?.providerConnections?.[channel];
      const verified = contactVerified(channel), ready = latestStatus?.channels?.[channel] && connection?.state !== "error";
      const status = $("status-" + channel);
      document.querySelector('[data-verify-send="' + channel + '"]').disabled = busy || verified || !ready;
      document.querySelector('[data-verify-confirm="' + channel + '"]').disabled = busy || verified || !ready;
      $("code-" + channel).disabled = busy || verified;
      if (verified) {
        status.className = "contact-status tiny verified";
        status.textContent = "✓ Contacto confirmado en este navegador.";
      } else if (connection?.state === "error") {
        status.className = "contact-status tiny error";
        status.textContent = connection.message;
      } else if (!ready && latestStatus) {
        status.className = "contact-status tiny";
        status.textContent = channelNames[channel] + " todavía no está habilitado en este servicio.";
      } else if (status.classList.contains("verified")) {
        status.className = "contact-status tiny";
        status.textContent = "El contacto cambió. Solicita y confirma un código nuevo.";
      }
    }
    $("alertVehicle").hidden = !preferences().content.includes("circulation");
  }
  function renderHistory(records = []) {
    const list = $("deliveryList");
    list.replaceChildren();
    if (!records.length) {
      const li = document.createElement("li");
      li.textContent = "Todavía no hay envíos en este navegador.";
      li.className = "tiny muted";
      list.append(li);
      return;
    }
    for (const record of records) {
      const li = document.createElement("li"), title = document.createElement("strong"),
        detail = document.createElement("div"), time = document.createElement("time");
      title.textContent = (channelNames[record.channel] || record.channel) + " · " + record.contact +
        " · " + ({ verification: "Código", test: "Prueba", auto: "Aviso" })[record.kind];
      detail.textContent = record.message + (record.errorCode ? " · Código " + record.errorCode : "") +
        (record.refreshError ? " · " + record.refreshError : "");
      if (["failed", "undelivered", "canceled"].includes(record.status)) li.className = "contact-status error";
      time.textContent = dateLabel(record.updatedAt || record.createdAt) + " · CDMX";
      time.dateTime = record.updatedAt || record.createdAt;
      li.append(title, detail, time);
      list.append(li);
    }
  }
  function applyServerStatus(data, syncForm = false) {
    backendConnected = true;
    latestStatus = data;
    serverSubscription = data.subscription || null;
    verifiedContacts.clear();
    for (const proof of data.verifiedContacts || []) {
      verifiedContacts.set(proof.channel, proof.contact);
      if ((!statusLoaded || syncForm) && !$("contact-" + proof.channel).value)
        $("contact-" + proof.channel).value = proof.contact.replace(/^whatsapp:/, "");
    }
    if (serverSubscription && (!statusLoaded || syncForm)) {
      const sub = serverSubscription;
      $("alertZone").value = sub.zones.length === 16 ? "all" : sub.zones[0];
      $("alertThreshold").value = String(sub.threshold);
      $("alertInterval").value = String(sub.intervalMinutes);
      $("alertProfile").value = sub.profile;
      $("alertConsent").checked = true;
      for (const el of document.querySelectorAll("[name=channel]")) el.checked = sub.channels.includes(el.value);
      for (const el of document.querySelectorAll("[name=alertContent]")) el.checked = sub.content.includes(el.value);
      for (const channel of sub.channels) $("contact-" + channel).value = sub.contacts[channel].replace(/^whatsapp:/, "");
      if (sub.vehicle) {
        $("alertPlate").value = String(sub.vehicle.plate);
        $("alertHologram").value = sub.vehicle.hologram;
      }
    }
    statusLoaded = true;
    $("deactivateAlerts").hidden = !serverSubscription?.active;
    $("alertState").textContent = data.configurationError ||
      (data.needsUpdate ? "Actualiza tus alertas: confirma tus contactos para recibir avisos personales."
        : serverSubscription?.active
          ? "Alertas activas desde US AQI " + serverSubscription.threshold + ". Los avisos se envían a tus contactos confirmados."
          : "Selecciona tus canales, confirma cada contacto y activa tus avisos.");
    const cadence = data.scheduleMinutes >= 1440 ? "diaria" : "cada " + data.scheduleMinutes + " minutos";
    $("scheduleState").textContent = data.backgroundReady
      ? "Revisión con la página cerrada: " + cadence + " configurada. " +
        (data.lastRun?.at ? "Última comprobación: " + dateLabel(data.lastRun.at) + " (CDMX)." : "Todavía no hay una ejecución registrada del programador.")
      : "Con la página abierta se revisa cada 15 minutos. La revisión con la página cerrada todavía no está preparada.";
    const status = $("channelStatus");
    status.replaceChildren();
    for (const channel of Object.keys(channelNames)) {
      const el = document.createElement("span");
      const connection = data.providerConnections?.[channel];
      const state = connection?.state || (data.channels?.[channel] ? "configured" : "unconfigured");
      el.className = state === "ready" ? "ready" : state === "error" ? "error" : "";
      el.textContent = (state === "ready" ? "✓ " : state === "error" ? "✕ " : "○ ") +
        channelNames[channel] + ({
          ready: " · credenciales comprobadas", error: " · conexión rechazada",
          configured: " · configurado, sin comprobar", unconfigured: " · por configurar",
        })[state];
      el.title = connection?.message || data.channelDetails?.[channel]?.message || "";
      status.append(el);
    }
    const diagnosticList = $("providerDiagnosticsList");
    diagnosticList.replaceChildren();
    for (const [channel, connection] of Object.entries(data.providerConnections || {})) {
      const li = document.createElement("li");
      li.textContent = channelNames[channel] + ": " + connection.message;
      if (connection.state === "error") li.className = "contact-status error";
      diagnosticList.append(li);
    }
    if (Object.values(data.providerConnections || {}).some(c => c.state === "error"))
      $("providerDiagnostics").hidden = false;
    $("quotaInfo").textContent = "Cuotas diarias compartidas del servicio: " + data.limits.auto +
      " avisos, " + data.limits.test + " pruebas y " + data.limits.verification +
      " códigos. Los intentos fallidos también cuentan.";
    renderHistory(data.deliveries);
    renderContactForms();
  }
  async function loadBackendStatus(quiet = true) {
    try {
      applyServerStatus(await backendRequest("/api/alerts"));
      if (!quiet) toast("Configuración del servicio actualizada.");
    } catch (error) {
      backendConnected = false;
      $("alertState").textContent = error.message;
      if (!quiet) {
        $("alertLog").className = "alert-log error";
        $("alertLog").textContent = error.message;
      }
    }
  }
  function showDeliveryResults(data) {
    const results = data.results || [];
    $("alertLog").className = "alert-log" + (results.some(r => !r.ok) ? " error" : "");
    $("alertLog").textContent = results.length
      ? results.map(r => (r.skipped ? "↷" : r.ok ? "✓" : "✕") + " " +
        (channelNames[r.channel] || r.channel) + ": " + r.message).join("\n")
      : data.state === "below_threshold"
        ? "Alertas activas. Las zonas seleccionadas están por debajo del umbral."
        : "No hay mensajes pendientes.";
  }
  async function checkAlerts(force = false) {
    if (checkingAlerts || !serverSubscription?.active || (busy && !force)) return;
    checkingAlerts = true;
    try {
      showDeliveryResults(await requestApi("check"));
    } catch (error) {
      $("alertLog").className = "alert-log error";
      $("alertLog").textContent = error.message;
    } finally { checkingAlerts = false; }
  }
  async function alertOperation(button, work) {
    if (busy) return;
    busy = true;
    const children = [...button.childNodes];
    const controls = [...document.querySelectorAll("#alertsForm button,#alertsForm input,#alertsForm select,#checkChannels,#refreshDeliveries")];
    for (const control of controls) control.disabled = true;
    button.textContent = "Procesando…";
    $("alertLog").textContent = "";
    $("alertLog").className = "alert-log";
    try { await work(); }
    catch (error) {
      $("alertLog").className = "alert-log error";
      $("alertLog").textContent = error.message;
      await loadBackendStatus(true);
    } finally {
      busy = false;
      button.replaceChildren(...children);
      for (const control of controls) control.disabled = false;
      renderContactForms();
    }
  }
  function alertPayload() {
    const prefs = preferences();
    if (!prefs.channels.length) throw new Error("Selecciona al menos un canal.");
    if (!prefs.content.length) throw new Error("Selecciona el contenido que quieres recibir.");
    if (!$("alertConsent").checked) throw new Error("Marca la autorización para recibir tus avisos.");
    const contacts = {};
    for (const channel of prefs.channels) {
      if (!canonicalContact(channel)) throw new Error("Introduce tu contacto de " + channelNames[channel] + ".");
      if (!contactVerified(channel)) throw new Error("Confirma tu contacto de " + channelNames[channel] + " con el código recibido.");
      contacts[channel] = canonicalContact(channel);
    }
    return {
      channels: prefs.channels, contacts,
      zones: prefs.alertZone === "all" ? zones.map(z => z.id) : [prefs.alertZone],
      threshold: prefs.threshold, intervalMinutes: prefs.intervalMinutes,
      content: prefs.content, profile: prefs.profile, vehicle: prefs.vehicle,
      indexSystem: "US_AQI", consent: true,
    };
  }
  for (const [channel] of Object.entries(channelNames)) {
    const contact = $("contact-" + channel);
    contact.addEventListener("input", () => {
      const status = $("status-" + channel);
      status.className = "contact-status tiny";
      status.textContent = "Confirma este contacto para activar sus avisos.";
      renderContactForms();
    });
    const send = document.querySelector('[data-verify-send="' + channel + '"]');
    send.addEventListener("click", () => alertOperation(send, async () => {
      if (!$("alertConsent").checked) throw new Error("Marca la autorización para recibir el código en tu contacto.");
      if (!contact.reportValidity() || !contact.value.trim()) throw new Error("Introduce tu contacto de " + channelNames[channel] + ".");
      const result = await requestApi("request_verification", {
        channel, contact: canonicalContact(channel), consent: true,
      });
      if (result.verified) verifiedContacts.set(channel, result.contact);
      $("status-" + channel).textContent = result.message;
      $("status-" + channel).className = "contact-status tiny";
      $("code-" + channel).value = "";
      if (!result.verified) $("code-" + channel).focus();
      await loadBackendStatus(true);
    }));
    const confirm = document.querySelector('[data-verify-confirm="' + channel + '"]');
    confirm.addEventListener("click", () => alertOperation(confirm, async () => {
      const result = await requestApi("verify_contact", {
        channel, contact: canonicalContact(channel), code: $("code-" + channel).value.trim(),
      });
      verifiedContacts.set(channel, result.contact);
      $("code-" + channel).value = "";
      $("status-" + channel).textContent = result.message;
      await loadBackendStatus(true);
    }));
  }
  let telegramHelpLoaded = false, telegramHelpLoading = false;
  $("telegramHelp").addEventListener("toggle", async () => {
    if (!$("telegramHelp").open || telegramHelpLoaded || telegramHelpLoading) return;
    telegramHelpLoading = true;
    $("telegramBotHelpStatus").textContent = "Buscando el bot de AIRE+…";
    try {
      const info = await requestApi("telegram_info");
      if (!info.botUrl) throw new Error(info.message || "El bot de AIRE+ no está disponible.");
      $("telegramBotLink").href = info.botUrl;
      $("telegramBotLink").hidden = false;
      $("telegramBotHelpStatus").textContent = "@" + info.username;
      telegramHelpLoaded = true;
    } catch (error) {
      $("telegramBotHelpStatus").textContent = error.message;
    } finally { telegramHelpLoading = false; }
  });
  $("checkChannels").addEventListener("click", () =>
    alertOperation($("checkChannels"), async () => {
      applyServerStatus(await requestApi("diagnostics"));
      $("providerDiagnostics").hidden = false;
      $("alertLog").textContent = "Comprobación terminada. Revisa el resultado de cada canal.";
    }));
  $("alertsForm").addEventListener("submit", event => {
    event.preventDefault();
    alertOperation($("activateAlerts"), async () => {
      const result = await requestApi("subscribe", alertPayload());
      applyServerStatus(result, true);
      saveSettings();
      await checkAlerts(true);
      await loadBackendStatus(true);
    });
  });
  $("testAlert").addEventListener("click", () =>
    alertOperation($("testAlert"), async () => {
      showDeliveryResults(await requestApi("test", alertPayload()));
      saveSettings();
      await loadBackendStatus(true);
    }));
  $("deactivateAlerts").addEventListener("click", () =>
    alertOperation($("deactivateAlerts"), async () => {
      applyServerStatus(await requestApi("unsubscribe"));
      $("alertLog").textContent = "Alertas desactivadas para tus contactos en este navegador.";
    }));
  $("refreshDeliveries").addEventListener("click", () =>
    alertOperation($("refreshDeliveries"), async () => {
      const result = await requestApi("delivery_status");
      renderHistory(result.deliveries);
      $("alertLog").textContent = "Historial actualizado. Aceptado y entregado son estados diferentes.";
    }));
  function renderReports() {
    const list = $("reportsList");
    list.replaceChildren();
    $("reportCount").textContent =
      `${reports.length} reporte${reports.length === 1 ? "" : "s"} en este dispositivo`;
    $("exportReports").disabled = !reports.length;
    $("clearReports").hidden = !reports.length;
    for (const r of reports.slice(0, 5)) {
      const el = document.createElement("article");
      el.className = "report-item";
      const title = document.createElement("strong"),
        p = document.createElement("p"),
        location = document.createElement("p"),
        meta = document.createElement("div");
      title.textContent = r.type || "Reporte";
      p.textContent = r.description;
      location.textContent = r.location;
      meta.className = "between";
      const zone = document.createElement("span"),
        date = document.createElement("span");
      zone.textContent =
        zones.find((z) => z.id === r.zone)?.name || "CDMX";
      date.textContent = Number.isFinite(Date.parse(r.createdAt))
        ? dateLabel(r.createdAt)
        : "Sin fecha";
      meta.append(zone, date);
      el.append(title, p, location, meta);
      list.append(el);
    }
  }
  $("reportForm").addEventListener("submit", (event) => {
    event.preventDefault();
    if (reports.length >= 100) {
      toast(
        "Alcanzaste 100 reportes. Descárgalos y borra el registro para continuar.",
      );
      return;
    }
    const description = $("reportDescription").value.trim(),
      locationText = $("reportLocation").value.trim();
    if (description.length < 10 || !locationText) {
      toast(
        "Completa una ubicación y una descripción de al menos 10 caracteres.",
      );
      return;
    }
    const report = {
      id: globalThis.crypto?.randomUUID?.() || "R-" + Date.now(),
      createdAt: new Date().toISOString(),
      type: $("reportType").value,
      zone: $("reportZone").value,
      location: locationText,
      description,
    };
    reports.unshift(report);
    saveStore("aire:reports", reports);
    renderReports();
    $("reportForm").reset();
    $("reportZone").value = selected;
    toast(
      persistent
        ? "Reporte guardado en este navegador."
        : "Reporte guardado solo durante esta sesión.",
    );
  });
  $("exportReports").addEventListener("click", () => {
    if (!reports.length) return;
    const blob = new Blob(
      [
        JSON.stringify(
          {
            project: "AIRE+",
            exportedAt: new Date().toISOString(),
            reports,
          },
          null,
          2,
        ),
      ],
      { type: "application/json;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "AIRE_PLUS_reportes.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $("clearReports").addEventListener("click", () => {
    if (
      !reports.length ||
      !confirm(
        "¿Borrar los reportes guardados en este navegador? Puedes descargarlos antes.",
      )
    )
      return;
    reports = [];
    saveStore("aire:reports", reports);
    renderReports();
    toast("Registro local borrado.");
  });
  function addBubble(message, user = false) {
    const bubble = document.createElement("div");
    bubble.className = "bubble" + (user ? " user" : "");
    bubble.textContent = message;
    $("chatMessages").append(bubble);
    while ($("chatMessages").children.length > 60)
      $("chatMessages").firstElementChild.remove();
    $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
  }
  let chatBusy = false;
  const savedProfile = readStore("aire:profile", "general");
  if (
    ["general", "sensible", "deportista", "infancia"].includes(
      savedProfile,
    )
  ) {
    $("analysisProfile").value = savedProfile;
    $("chatProfile").value = savedProfile;
  }
  function currentAnalysis(question = "") {
    return analyzeAirData(
      liveData,
      selected,
      $("analysisProfile").value,
      question,
    );
  }
  function renderAnalysis(analysis = currentAnalysis()) {
    $("analysisSummary").textContent = analysis.summary;
    $("analysisRecommendations").replaceChildren(
      ...analysis.recommendations.map((text) => {
        const li = document.createElement("li");
        li.textContent = text;
        return li;
      }),
    );
    $("analysisMetrics").replaceChildren(
      ...analysis.details.map((detail) => {
        const box = document.createElement("div");
        box.className = "analysis-metric";
        const label = document.createElement("small"),
          value = document.createElement("strong"),
          foot = document.createElement("small");
        label.textContent = detail.name;
        value.textContent =
          detail.value === null
            ? "—"
            : Number(detail.value.toFixed(1)) + " " + detail.unit;
        foot.textContent =
          detail.subindex === null
            ? "Subíndice no disponible"
            : "US AQI " + detail.subindex + " · " + detail.category;
        box.append(label, value, foot);
        return box;
      }),
    );
    $("analysisOutlook").textContent = analysis.outlook;
  }
  async function getAnalysis(question = "") {
    try {
      const result = await backendRequest(
        "/api/assistant",
        {
          zone: selected,
          profile: $("analysisProfile").value,
          question,
        },
        8000,
      );
      $("analysisEngine").textContent = "Sistema experto · servidor";
      $("analysisEngine").title =
        "Análisis actualizado desde /api/assistant";
      return result.analysis;
    } catch (error) {
      $("analysisEngine").title = error.message;
      $("analysisEngine").textContent = "Sistema experto · local";
      return currentAnalysis(question);
    }
  }
  async function runAnalysis() {
    const button = $("analyzeButton"),
      children = [...button.childNodes];
    button.disabled = true;
    button.textContent = "Analizando…";
    try {
      renderAnalysis(await getAnalysis());
    } finally {
      button.disabled = false;
      button.replaceChildren(...children);
    }
  }
  $("analyzeButton").addEventListener("click", runAnalysis);
  for (const id of ["analysisProfile", "chatProfile"])
    $(id).addEventListener("change", () => {
      const value = $(id).value;
      $("analysisProfile").value = value;
      $("chatProfile").value = value;
      saveStore("aire:profile", value);
      renderAnalysis();
    });
  async function ask(text) {
    text = text.trim();
    if (!text || chatBusy) return;
    chatBusy = true;
    addBubble(text, true);
    $("chatInput").value = "";
    $("chatInput").disabled = true;
    const pending = document.createElement("div");
    pending.className = "bubble pending";
    pending.textContent = "Consultando los contaminantes de tu zona…";
    $("chatMessages").append(pending);
    try {
      const q = text
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
      let answer;
      if (/no puedo respirar|dolor (en el )?pecho/.test(q))
        answer =
          "Ante dificultad importante para respirar o dolor en el pecho, busca atención médica urgente. La evaluación ambiental no determina la causa de esos síntomas.";
      else if (/alert|telegram|twilio|whatsapp/.test(q))
        answer =
          "Selecciona tu zona, umbral US AQI y canales. Activar alertas guarda tu configuración; Probar alerta solicita un mensaje real a /api. Confirma tu contacto con el código recibido. El historial muestra la aceptación y, para SMS o WhatsApp, permite consultar la entrega.";
      else if (/circula|holograma|placa/.test(q))
        answer =
          "Consulta el módulo Hoy No Circula con el último dígito y tu holograma vigente. El resultado usa el calendario ordinario y puede cambiar por disposiciones extraordinarias.";
      else if (/reporte|tiradero|basura/.test(q))
        answer =
          "El formulario registra tus reportes en este navegador y permite descargarlos como JSON. No publica tus observaciones ni las envía a una autoridad.";
      else {
        const analysis = await getAnalysis(text);
        renderAnalysis(analysis);
        answer = analysis.answer;
      }
      pending.remove();
      addBubble(answer);
    } finally {
      pending.remove();
      chatBusy = false;
      $("chatInput").disabled = false;
      $("chatInput").focus();
    }
  }
  function setChat(open) {
    $("chatPanel").hidden = !open;
    $("chatLauncher").setAttribute("aria-expanded", String(open));
    if (open) $("chatInput").focus();
    else $("chatLauncher").focus();
  }
  $("chatLauncher").addEventListener("click", () =>
    setChat($("chatPanel").hidden),
  );
  $("closeChat").addEventListener("click", () => setChat(false));
  $("chatForm").addEventListener("submit", (event) => {
    event.preventDefault();
    ask($("chatInput").value);
  });
  document
    .querySelectorAll("[data-question]")
    .forEach((b) =>
      b.addEventListener("click", () => ask(b.dataset.question)),
    );
  function closeMenu() {
    $("sidebar").classList.remove("open");
    $("menuOverlay").classList.remove("visible");
    $("menuButton").setAttribute("aria-expanded", "false");
  }
  $("menuButton").addEventListener("click", () => {
    const open = !$("sidebar").classList.contains("open");
    $("sidebar").classList.toggle("open", open);
    $("menuOverlay").classList.toggle("visible", open);
    $("menuButton").setAttribute("aria-expanded", String(open));
  });
  $("menuOverlay").addEventListener("click", closeMenu);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeMenu();
      if (!$("chatPanel").hidden) setChat(false);
    }
  });
  document.querySelectorAll(".nav a").forEach((a) =>
    a.addEventListener("click", () => {
      closeMenu();
      document
        .querySelectorAll(".nav a")
        .forEach((b) => b.classList.toggle("active", a === b));
    }),
  );
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible[0])
          document
            .querySelectorAll(".nav a")
            .forEach((a) =>
              a.classList.toggle(
                "active",
                a.hash === "#" + visible[0].target.id,
              ),
            );
      },
      { rootMargin: "-90px 0px -45% 0px", threshold: [0, 0.2, 0.5] },
    );
    document.querySelectorAll("section[id]").forEach((el) => {
      if (el.id !== "chatPanel") observer.observe(el);
    });
  }
  $("zoneSelect").addEventListener("change", () =>
    chooseZone($("zoneSelect").value),
  );

  $("centerMap").addEventListener("click", () => {
    if (map && boundaryLayer)
      map.fitBounds(boundaryLayer.getBounds(), { padding: [15, 15] });
    else toast("El mapa requiere conexión. Consulta la lista de zonas.");
  });
  $("hncForm").addEventListener("submit", (e) => {
    e.preventDefault();
    renderHnc();
  });
  $("hncForm").addEventListener("change", renderHnc);
  document.querySelectorAll("[data-hours]").forEach((b) =>
    b.addEventListener("click", () => {
      forecastHours = Number(b.dataset.hours);
      document
        .querySelectorAll("[data-hours]")
        .forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      renderForecast();
    }),
  );
  $("refreshButton").addEventListener("click", () => loadAir(false));
  for (const el of document.querySelectorAll(
    "#alertsForm select,#alertsForm input",
  ))
    el.addEventListener("change", () => { saveSettings(); renderContactForms(); });
  renderContactForms();
  applyTheme(document.documentElement.dataset.theme || "dark", false);
  renderBadge();
  renderOverview();
  renderStations();
  renderReports();
  initMap();
  updateClock();
  setInterval(updateClock, 1000);
  setInterval(() => {
    if (!document.hidden) loadAir(true);
  }, AIR_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (
      !document.hidden &&
      (!liveData ||
        Date.now() - Date.parse(liveData.fetchedAt) >= AIR_REFRESH_MS)
    )
      loadAir(true);
  });
  window.addEventListener("online", () => loadAir(true));
  addBubble(
    "Hola. Selecciona tu perfil y pregúntame por tu zona. Evaluaré PM2.5, PM10, O₃ y NO₂ de Open-Meteo para explicarte la situación actual y cómo adaptar tus actividades.",
  );
  loadAir(true);
  loadBackendStatus(true);
});
