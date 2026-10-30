import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { ZONES, parseOpenMeteo, clearAirCache } from "../api/air.js";
import alerts, { sendChannel, clearMemoryReservations } from "../api/alerts.js";
import assistant, { analyzeAirData } from "../api/assistant.js";
import cron from "../api/cron.js";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const core = html.match(/<script id="aire-core">([\s\S]*?)<\/script>/)[1];
const context = vm.createContext({
  Intl,
  Date,
  URL,
  Set,
  Map,
  Number,
  Object,
  Math,
  Error,
});
vm.runInContext(core, context);
function fixture(aqi = 84, now = Date.now()) {
  const hour = Math.floor(now / 3600000) * 3600000;
  return ZONES.map((z) => ({
    latitude: z.lat,
    longitude: z.lon,
    current: {
      time: hour / 1000,
      us_aqi: aqi,
      pm2_5: 31.5,
      pm10: 85,
      ozone: 110,
      nitrogen_dioxide: 58.6,
      us_aqi_pm2_5: 90,
      us_aqi_pm10: 40,
      us_aqi_ozone: 50,
      us_aqi_nitrogen_dioxide: 45,
    },
    current_units: {
      time: "unixtime",
      us_aqi: "USAQI",
      pm2_5: "μg/m³",
      pm10: "μg/m³",
      ozone: "μg/m³",
      nitrogen_dioxide: "μg/m³",
      us_aqi_pm2_5: "USAQI",
      us_aqi_pm10: "USAQI",
      us_aqi_ozone: "USAQI",
      us_aqi_nitrogen_dioxide: "USAQI",
    },
    hourly_units: { time: "unixtime", us_aqi: "USAQI" },
    hourly: {
      time: Array.from({ length: 25 }, (_, i) => (hour + i * 3600000) / 1000),
      us_aqi: Array.from({ length: 25 }, (_, i) => aqi + i),
    },
  }));
}
function env() {
  process.env.TELEGRAM_BOT_TOKEN = "123456:fake_unit_test_token";
  process.env.TELEGRAM_CHAT_ID = "12345";
  process.env.SESSION_SECRET = "s".repeat(64);
  process.env.MAX_MESSAGES_PER_DAY = "6";
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  clearMemoryReservations();
  clearAirCache();
}
function req(body, cookie = "", method = "POST") {
  return {
    method,
    headers: {
      host: "aire.test",
      origin: "https://aire.test",
      "content-type": "application/json",
      cookie,
    },
    body,
  };
}
function res() {
  return {
    code: 0,
    body: null,
    headers: {},
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return this.headers[k.toLowerCase()];
    },
    status(v) {
      this.code = v;
      return this;
    },
    json(v) {
      this.body = v;
      return this;
    },
    end() {
      return this;
    },
  };
}
function cookieOf(response) {
  return (response.headers["set-cookie"] || [])
    .map((v) => v.split(";")[0])
    .join("; ");
}
function providerResponse(data, ok = true, status = 200) {
  return { ok, status, text: async () => JSON.stringify(data) };
}
const preferences = {
  channels: ["telegram"],
  zones: ["iztapalapa"],
  threshold: 101,
  intervalMinutes: 60,
};

test("The final HTML parses and contains no retired source links or password control", () => {
  for (const [, script] of html.matchAll(
    /<script id="[^"]+">([\s\S]*?)<\/script>/g,
  ))
    assert.doesNotThrow(() => new vm.Script(script));
  for (const word of [
    "SIM" + "AT",
    "SINA" + "ICA",
    "APP_" + "ACCESS_KEY",
    "accessKey",
    "apiBase",
    'type="password"',
  ])
    assert.equal(html.toLowerCase().includes(word.toLowerCase()), false);
  assert.ok(html.includes('role="switch"'));
  assert.ok(html.includes("brand-logo"));
  assert.ok(html.includes("/api/alerts"));
  assert.ok(html.includes("/api/assistant"));
  assert.equal(html.includes("Authorization:"), false);
});

test("Every statically referenced DOM control exists and IDs are unique", () => {
  const markup = html.slice(0, html.indexOf('<script id="aire-core">'));
  const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, id] of html.matchAll(/\$\("([^"\n]+)"\)/g)) {
    assert.ok(ids.includes(id), `Missing DOM control: ${id}`);
  }
});
test("The shared analysis uses actual values, selects a subindex and personalizes recommendations", () => {
  const now = Date.now(),
    data = parseOpenMeteo(fixture(125, now), now);
  const general = analyzeAirData(data, "iztapalapa", "general", "", now);
  const athlete = analyzeAirData(
    data,
    "iztapalapa",
    "deportista",
    "¿Puedo entrenar?",
    now,
  );
  assert.equal(general.dominant, "pm25"); // Ozone concentration is larger, but its AQI subindex is lower.
  assert.equal(general.details.find((d) => d.key === "o3").value, 110);
  assert.match(general.answer, /31\.5 µg\/m³/);
  assert.match(general.answer, /125/);
  assert.notEqual(general.recommendations[0], athlete.recommendations[0]);
  assert.equal(athlete.engine, "rules");
  assert.equal(athlete.profileName, "Deportista");
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        context.AireCore.analyzeAirData(
          data,
          "iztapalapa",
          "deportista",
          "¿Puedo entrenar?",
          now,
        ),
      ),
    ),
    athlete,
  );
});
test("Missing and stale data cannot produce a reassuring assessment", () => {
  const now = Date.now(),
    data = parseOpenMeteo(fixture(), now);
  data.stations[4].value = null;
  data.stations[4].components.pm25 = null;
  const missing = analyzeAirData(data, "iztapalapa", "sensible", "", now);
  assert.equal(missing.status, "missing");
  assert.equal(missing.details[0].value, null);
  assert.match(missing.summary, /No hay un índice actual/);
  const expired = analyzeAirData(
    { ...data, observedAt: "2020-01-01T00:00:00Z" },
    "iztapalapa",
    "general",
    "",
    now,
  );
  assert.equal(expired.status, "missing");
  assert.ok(expired.details.every((d) => d.value === null));
});
test("The public status endpoint works without a panel key and never discloses provider credentials", async () => {
  env();
  const response = res();
  await alerts(req(undefined, "", "GET"), response);
  assert.equal(response.code, 200);
  assert.equal(response.body.channels.telegram, true);
  assert.equal(response.body.storageMode, "session");
  assert.ok(cookieOf(response).includes("aire_session="));
  assert.equal(
    JSON.stringify(response.body).includes(process.env.TELEGRAM_BOT_TOKEN),
    false,
  );
});
test("A public test sends to the server-configured Telegram recipient and ignores injected destinations/text", async () => {
  env();
  const previous = global.fetch;
  let telegramBody = null;
  global.fetch = async (url, options) => {
    if (String(url).startsWith("https://air-quality-api.open-meteo.com/"))
      return providerResponse(fixture());
    if (String(url).startsWith("https://api.telegram.org/")) {
      telegramBody = JSON.parse(options.body);
      return providerResponse({ ok: true, result: { message_id: 77 } });
    }
    throw new Error("Unexpected external request");
  };
  try {
    const response = res();
    await alerts(
      req({
        action: "test",
        ...preferences,
        chat_id: "attacker",
        text: "arbitrary text",
        To: "+15550000000",
      }),
      response,
    );
    assert.equal(response.code, 200);
    assert.equal(response.body.results[0].ok, true);
    assert.equal(telegramBody.chat_id, "12345");
    assert.match(telegramBody.text, /\[PRUEBA\]/);
    assert.equal(telegramBody.text.includes("arbitrary text"), false);
  } finally {
    global.fetch = previous;
  }
});
test("Activation uses signed browser preferences; checks respect US AQI and the interval", async () => {
  env();
  const previous = global.fetch;
  let value = 80,
    sends = 0;
  global.fetch = async (url) => {
    if (String(url).includes("air-quality-api.open-meteo.com"))
      return providerResponse(fixture(value));
    if (String(url).includes("api.telegram.org")) {
      sends++;
      return providerResponse({ ok: true, result: { message_id: sends } });
    }
    throw new Error("Unexpected request");
  };
  try {
    const status = res();
    await alerts(req(undefined, "", "GET"), status);
    let cookie = cookieOf(status);
    const activated = res();
    await alerts(
      req({ action: "subscribe", ...preferences }, cookie),
      activated,
    );
    assert.equal(activated.code, 200);
    assert.equal(activated.body.subscription.active, true);
    assert.equal(activated.body.subscription.indexSystem, "US_AQI");
    cookie += "; " + cookieOf(activated);
    let result = res();
    await alerts(req({ action: "check" }, cookie), result);
    assert.equal(result.body.state, "below_threshold");
    assert.equal(sends, 0);
    value = 120;
    clearAirCache();
    result = res();
    await alerts(req({ action: "check" }, cookie), result);
    assert.equal(result.body.results[0].ok, true);
    assert.equal(sends, 1);
    result = res();
    await alerts(req({ action: "check" }, cookie), result);
    assert.equal(result.body.results[0].skipped, true);
    assert.equal(sends, 1);
    const disabled = res();
    await alerts(req({ action: "unsubscribe" }, cookie), disabled);
    assert.equal(disabled.body.subscription, null);
  } finally {
    global.fetch = previous;
  }
});
test("Cross-site requests are rejected and paid channels fail closed without a durable limiter", async () => {
  env();
  const foreign = req({ action: "test", ...preferences });
  foreign.headers.origin = "https://other.test";
  let result = res();
  await alerts(foreign, result);
  assert.equal(result.code, 403);
  process.env.TWILIO_ACCOUNT_SID = "AC" + "a".repeat(32);
  process.env.TWILIO_AUTH_TOKEN = "fake_unit_token";
  process.env.TWILIO_SMS_FROM = "+17372508034";
  process.env.TWILIO_SMS_TO = "+525500000001";
  result = res();
  await alerts(
    req({ action: "test", ...preferences, channels: ["sms"] }),
    result,
  );
  assert.equal(result.code, 503);
  assert.match(result.body.error, /Redis/);
});
test("Twilio form encoding and WhatsApp prefixes stay on the server; queued is not delivered", async () => {
  env();
  process.env.TWILIO_ACCOUNT_SID = "AC" + "a".repeat(32);
  process.env.TWILIO_AUTH_TOKEN = "fake_unit_token";
  process.env.TWILIO_WHATSAPP_FROM = "whatsapp:+17372508034";
  process.env.TWILIO_WHATSAPP_TO = "whatsapp:+525500000001";
  delete process.env.TWILIO_WHATSAPP_CONTENT_SID;
  const previous = global.fetch;
  let params;
  global.fetch = async (url, options) => {
    assert.ok(String(url).startsWith("https://api.twilio.com/"));
    assert.ok(options.headers.Authorization.startsWith("Basic "));
    params = new URLSearchParams(options.body);
    return providerResponse({ sid: "SM-unit-test", status: "queued" });
  };
  try {
    const result = await sendChannel("whatsapp", "Aviso & prueba");
    assert.equal(params.get("From"), "whatsapp:+17372508034");
    assert.equal(params.get("To"), "whatsapp:+525500000001");
    assert.equal(params.get("Body"), "Aviso & prueba");
    assert.match(result.message, /pendiente/);
  } finally {
    global.fetch = previous;
  }
});
test("A durable, shared daily quota stops paid sends after the configured budget", async () => {
  env();
  process.env.MAX_MESSAGES_PER_DAY = "1";
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.unit-test.invalid";
  process.env.UPSTASH_REDIS_REST_TOKEN = "unit-token";
  process.env.TWILIO_ACCOUNT_SID = "AC" + "a".repeat(32);
  process.env.TWILIO_AUTH_TOKEN = "fake";
  process.env.TWILIO_SMS_FROM = "+17372508034";
  process.env.TWILIO_SMS_TO = "+525500000001";
  const previous = global.fetch,
    store = new Map();
  let telegramSends = 0,
    twilioSends = 0;
  global.fetch = async (url, options) => {
    if (String(url).includes("air-quality-api.open-meteo.com"))
      return providerResponse(fixture());
    if (String(url).includes("redis.unit-test.invalid")) {
      const [cmd, script, n, key, quota, limit, seconds, token] = JSON.parse(
        options.body,
      );
      assert.equal(cmd, "EVAL");
      assert.equal(n, 2);
      let result;
      if (store.has(key)) result = "cooldown";
      else if ((store.get(quota) || 0) >= Number(limit)) result = "quota";
      else {
        store.set(quota, (store.get(quota) || 0) + 1);
        store.set(key, token);
        result = "ok";
      }
      return providerResponse({ result });
    }
    if (String(url).includes("api.telegram.org")) {
      telegramSends++;
      return providerResponse({ ok: true, result: { message_id: 1 } });
    }
    if (String(url).includes("api.twilio.com")) {
      twilioSends++;
      return providerResponse({ sid: "SM-test", status: "queued" });
    }
    throw new Error("Unexpected request");
  };
  try {
    let result = res();
    await alerts(req({ action: "test", ...preferences }), result);
    assert.equal(result.body.results[0].ok, true);
    clearMemoryReservations();
    result = res();
    await alerts(
      req({ action: "test", ...preferences, channels: ["sms"] }),
      result,
    );
    assert.equal(result.body.results[0].ok, false);
    assert.match(result.body.results[0].message, /límite diario/);
    assert.equal(telegramSends, 1);
    assert.equal(twilioSends, 0);
  } finally {
    global.fetch = previous;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  }
});
test("The assistant API ignores client-provided readings and evaluates provider data", async () => {
  env();
  const previous = global.fetch;
  global.fetch = async (url) => {
    assert.ok(String(url).includes("air-quality-api.open-meteo.com"));
    return providerResponse(fixture(125));
  };
  try {
    const result = res();
    await assistant(
      req({
        zone: "iztapalapa",
        profile: "sensible",
        question: "¿Qué pasa con PM2.5?",
        value: 1,
        components: { pm25: 0 },
      }),
      result,
    );
    assert.equal(result.code, 200);
    assert.match(result.body.analysis.summary, /125/);
    assert.equal(result.body.analysis.details[0].value, 31.5);
  } finally {
    global.fetch = previous;
  }
});
test("The private scheduler requires its own server credential", async () => {
  process.env.CRON_SECRET = "c".repeat(64);
  const result = res();
  await cron(req(undefined, "", "GET"), result);
  assert.equal(result.code, 401);
});
