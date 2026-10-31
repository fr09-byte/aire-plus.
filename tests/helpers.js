import assert from 'node:assert/strict';
import Redis from 'ioredis-mock';
import { randomUUID } from 'node:crypto';
import alerts from '../api/alerts.js';
import { zones } from '../shared/air-core.js';
import { clearAirCache } from '../api/air.js';
import { clearProviderConnections } from '../server/notifications.js';

export function fixture(aqi = 125, now = Date.now()) {
  const hour = Math.floor(now / 3600000) * 3600000;
  return zones.map(zone => ({
    latitude: zone.lat, longitude: zone.lon,
    current: {
      time: hour / 1000, us_aqi: aqi,
      pm2_5: 31.5, pm10: 85, ozone: 110, nitrogen_dioxide: 58.6,
      us_aqi_pm2_5: aqi, us_aqi_pm10: 40, us_aqi_ozone: 50, us_aqi_nitrogen_dioxide: 45,
    },
    current_units: {
      time: 'unixtime', us_aqi: 'USAQI', pm2_5: 'μg/m³', pm10: 'μg/m³',
      ozone: 'μg/m³', nitrogen_dioxide: 'μg/m³',
      us_aqi_pm2_5: 'USAQI', us_aqi_pm10: 'USAQI', us_aqi_ozone: 'USAQI',
      us_aqi_nitrogen_dioxide: 'USAQI',
    },
    hourly_units: { time: 'unixtime', us_aqi: 'USAQI' },
    hourly: {
      time: Array.from({ length: 25 }, (_, i) => (hour + i * 3600000) / 1000),
      us_aqi: Array.from({ length: 25 }, (_, i) => aqi + i),
    },
  }));
}

export function mockResponse() {
  return {
    code: 0, body: null, headers: {},
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    getHeader(key) { return this.headers[key.toLowerCase()]; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

export async function call(handler, body, cookie = '', method = 'POST', extraHeaders = {}) {
  const response = mockResponse();
  await handler({
    method, body,
    async *[Symbol.asyncIterator]() {},
    headers: {
      host: 'aire.test', origin: 'https://aire.test',
      'content-type': 'application/json', cookie, ...extraHeaders,
    },
  }, response);
  return response;
}

export function browserClient() {
  const cookies = new Map();
  return {
    get cookie() { return [...cookies].map(([key, value]) => key + '=' + value).join('; '); },
    async request(body, { handler = alerts, method = 'POST' } = {}) {
      const response = await call(handler, body, this.cookie, method);
      const entries = response.headers['set-cookie'];
      for (const item of entries ? Array.isArray(entries) ? entries : [entries] : []) {
        const pair = item.split(';')[0], at = pair.indexOf('=');
        cookies.set(pair.slice(0, at), pair.slice(at + 1));
      }
      return response;
    },
  };
}

export const preferences = (contact = '123456789', channel = 'telegram') => ({
  channels: [channel], contacts: { [channel]: contact }, zones: ['iztapalapa'],
  threshold: 101, intervalMinutes: 60, content: ['aqi', 'pollutants', 'recommendations'],
  profile: 'deportista', consent: true,
});

export async function setup(t) {
  const names = [
    'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN',
    'TWILIO_SMS_FROM', 'TWILIO_SMS_TO', 'TWILIO_WHATSAPP_FROM', 'TWILIO_WHATSAPP_TO',
    'TWILIO_WHATSAPP_CONTENT_SID', 'TWILIO_WHATSAPP_VERIFY_CONTENT_SID', 'SENDGRID_API_KEY',
    'EMAIL_FROM', 'SESSION_SECRET', 'CRON_SECRET', 'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN', 'MAX_MESSAGES_PER_DAY', 'MAX_TEST_MESSAGES_PER_DAY',
    'MAX_VERIFICATIONS_PER_DAY', 'MAX_SUBSCRIPTIONS', 'AIRE_NAMESPACE', 'ALERT_CHECK_MINUTES',
    'ALLOWED_ORIGINS', 'REDIS_URL',
  ];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, {
    TELEGRAM_BOT_TOKEN: '123456:fake_unit_test_token',
    TELEGRAM_CHAT_ID: '111111111',
    TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_AUTH_TOKEN: 'fake_unit_test_token',
    TWILIO_SMS_FROM: '+15550000001', TWILIO_SMS_TO: '+15559999999',
    TWILIO_WHATSAPP_FROM: 'whatsapp:+15550000001', TWILIO_WHATSAPP_TO: 'whatsapp:+15559999999',
    SENDGRID_API_KEY: 'SG.fake_unit_test_key', EMAIL_FROM: 'aire@example.com',
    SESSION_SECRET: 's'.repeat(64), CRON_SECRET: 'c'.repeat(64),
    UPSTASH_REDIS_REST_URL: 'https://redis.unit-test.invalid',
    UPSTASH_REDIS_REST_TOKEN: 'fake_redis_token', AIRE_NAMESPACE: randomUUID(),
    MAX_MESSAGES_PER_DAY: '6', MAX_TEST_MESSAGES_PER_DAY: '3', MAX_VERIFICATIONS_PER_DAY: '12',
  });
  clearAirCache();
  clearProviderConnections();
  const redis = new Redis({ host: randomUUID() });
  const state = {
    redis, telegram: [], twilio: [], emails: [], commands: [], airValue: 125,
    telegramError: null, telegramInfoError: null, telegramInfoRequests: 0,
    twilioAuthError: null, twilioAccountRequests: 0, lastTwilioAuthorization: null,
    deliveryStatus: 'queued', redisErrors: [], failRedis: false,
  };
  const originalFetch = global.fetch;
  const json = (data, status = 200, headers = {}) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.startsWith('https://redis.unit-test.invalid')) {
      const [command, ...args] = JSON.parse(options.body);
      state.commands.push([command, ...args]);
      if (state.failRedis) return json({ error: 'Redis unavailable' }, 503);
      try {
        // The actual Lua scripts run unchanged in the emulator.
        return json({ result: await redis[command.toLowerCase()](...args) });
      } catch (error) {
        state.redisErrors.push(error.message);
        return json({ error: error.message }, 500);
      }
    }
    if (value.startsWith('https://air-quality-api.open-meteo.com/'))
      return json(fixture(state.airValue));
    if (value.startsWith('https://api.telegram.org/') && value.endsWith('/getMe')) {
      state.telegramInfoRequests++;
      if (state.telegramInfoError) return json({ ok: false, error_code: state.telegramInfoError }, 401);
      return json({ ok: true, result: { id: 123456, is_bot: true, username: 'AirePlusUnitTestBot' } });
    }
    if (value.startsWith('https://api.telegram.org/')) {
      const body = JSON.parse(options.body);
      state.telegram.push(body);
      if (state.telegramError) return json({ ok: false, error_code: state.telegramError }, 400);
      return json({ ok: true, result: { message_id: state.telegram.length } });
    }
    if (value.startsWith('https://api.twilio.com/')) {
      state.lastTwilioAuthorization = options.headers?.Authorization;
      if (/\/Accounts\/AC[a-f0-9]{32}\.json$/i.test(value)) {
        state.twilioAccountRequests++;
        if (state.twilioAuthError) return json({ code: state.twilioAuthError }, 401);
        return json({ sid: process.env.TWILIO_ACCOUNT_SID.trim(), status: 'active',
          auth_token: 'never-disclose-this-account-token', friendly_name: 'private@example.com' });
      }
      if (state.twilioAuthError) return json({ code: state.twilioAuthError }, 401);
      if (options.method === 'POST') {
        const body = Object.fromEntries(new URLSearchParams(options.body));
        state.twilio.push(body);
        return json({ sid: 'SM' + state.twilio.length.toString(16).padStart(32, '0'), status: 'queued' }, 201);
      }
      return json({ status: state.deliveryStatus, error_code: state.deliveryStatus === 'undelivered' ? 63016 : null });
    }
    if (value === 'https://api.sendgrid.com/v3/mail/send') {
      state.emails.push(JSON.parse(options.body));
      return new Response(null, { status: 202, headers: { 'x-message-id': 'email-test-' + state.emails.length } });
    }
    if (/^http:\/\/127\.0\.0\.1:\d+\//.test(value)) return originalFetch(url, options);
    throw new Error('Unexpected network access: ' + value);
  };
  t.after(async () => {
    global.fetch = originalFetch;
    for (const name of names) previous[name] === undefined
      ? delete process.env[name] : process.env[name] = previous[name];
    await redis.flushall();
    redis.disconnect();
    clearAirCache();
    clearProviderConnections();
  });
  state.codeFor = (channel, contact) => {
    const message = channel === 'telegram'
      ? state.telegram.findLast(item => item.chat_id === contact)?.text
      : channel === 'email'
        ? state.emails.findLast(item => item.personalizations[0].to[0].email === contact)?.content[0].value
        : state.twilio.findLast(item => item.To === (channel === 'whatsapp' ? 'whatsapp:' + contact.replace(/^whatsapp:/, '') : contact))?.Body;
    return message?.match(/codigo es (\d{6})/i)?.[1];
  };
  state.verify = async (browser, channel, contact) => {
    let response = await browser.request({ action: 'request_verification', channel, contact, consent: true });
    assert.equal(response.code, 200, JSON.stringify({ body: response.body, redisErrors: state.redisErrors }));
    const code = state.codeFor(channel, contact);
    assert.match(code, /^\d{6}$/);
    response = await browser.request({ action: 'verify_contact', channel, contact, code });
    assert.equal(response.code, 200, JSON.stringify({ body: response.body, redisErrors: state.redisErrors }));
    return code;
  };
  return state;
}
