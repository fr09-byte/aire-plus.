import { randomInt, randomUUID } from 'node:crypto';
import { zones, analyzeAirData, circulation, cdmxParts, isFreshAir } from '../shared/air-core.js';
import { getAirData } from '../api/air.js';
import { HttpError } from './http.js';
import {
  redisAvailable, requireStorage, redisCommand, storageKey, readRecord, writeRecord, rateLimit,
} from './storage.js';
import { digest, requireSessionSecret, sessionConfigured, clientFingerprint } from './session.js';
import {
  CHANNELS, CHANNEL_NAMES, normalizeContact, maskContact, providerStatus, providerDetails,
  sendChannel, pollDelivery, smsText, providerConnections,
} from './notifications.js';

const lifetime = 2592000;
const CONTENTS = ['aqi', 'pollutants', 'recommendations', 'circulation'];
const profiles = ['general', 'sensible', 'deportista', 'infancia'];

function ready() {
  requireStorage();
  requireSessionSecret();
}

function integerSetting(name, fallback, maximum) {
  const value = Number(process.env[name] || fallback);
  return Number.isInteger(value) ? Math.max(1, Math.min(maximum, value)) : fallback;
}

export function messageLimits() {
  return {
    auto: integerSetting('MAX_MESSAGES_PER_DAY', 6, 1000),
    test: integerSetting('MAX_TEST_MESSAGES_PER_DAY', 3, 100),
    verification: integerSetting('MAX_VERIFICATIONS_PER_DAY', 12, 200),
  };
}

export function validatePreferences(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new HttpError('Datos de suscripción inválidos.');
  if (!Array.isArray(input.channels) || !input.channels.length || input.channels.length > 4 ||
      input.channels.some(c => !CHANNELS.includes(c)) ||
      new Set(input.channels).size !== input.channels.length)
    throw new HttpError('Selecciona al menos un canal válido, sin repeticiones.');
  if (!input.contacts || typeof input.contacts !== 'object' || Array.isArray(input.contacts))
    throw new HttpError('Introduce el contacto de cada canal seleccionado.');
  const contacts = {};
  for (const channel of input.channels) {
    contacts[channel] = normalizeContact(channel, input.contacts[channel]);
    if (!providerStatus()[channel]) throw new HttpError(providerDetails()[channel].message, 503);
  }
  if (!Array.isArray(input.zones) || !input.zones.length || input.zones.length > 16 ||
      new Set(input.zones).size !== input.zones.length ||
      input.zones.some(z => !zones.some(zone => zone.id === z)))
    throw new HttpError('Selecciona alcaldías válidas.');
  if (![51, 101, 151, 201, 301].includes(input.threshold))
    throw new HttpError('El umbral US AQI no es válido.');
  if (![60, 180, 360, 1440].includes(input.intervalMinutes))
    throw new HttpError('El intervalo de avisos no es válido.');
  const content = input.content ?? ['aqi', 'recommendations'];
  if (!Array.isArray(content) || !content.length || content.length > CONTENTS.length ||
      content.some(c => !CONTENTS.includes(c)) || new Set(content).size !== content.length)
    throw new HttpError('Selecciona el contenido que quieres recibir.');
  const profile = input.profile ?? 'general';
  if (!profiles.includes(profile)) throw new HttpError('Selecciona un perfil válido.');
  let vehicle = null;
  if (content.includes('circulation')) {
    vehicle = input.vehicle;
    if (!vehicle || !Number.isInteger(vehicle.plate) || vehicle.plate < 0 || vehicle.plate > 9 ||
        !['00', '0', '1', '2', 'E'].includes(vehicle.hologram))
      throw new HttpError('Para Hoy No Circula elige terminación de placa y holograma.');
    vehicle = { plate: vehicle.plate, hologram: vehicle.hologram };
  }
  return {
    schemaVersion: 4, channels: [...input.channels], contacts, zones: [...input.zones],
    threshold: input.threshold, intervalMinutes: input.intervalMinutes,
    content: [...content], profile, vehicle, indexSystem: 'US_AQI',
  };
}

export function legacyInput(input) {
  if (!Object.hasOwn(input, 'canal')) return input;
  const zone = zones.find(z => z.id === input.alcaldia || z.name === input.alcaldia);
  return {
    ...input, channels: [input.canal], contacts: { [input.canal]: input.contacto },
    zones: input.alcaldia === 'Todas' ? zones.map(z => z.id) : zone ? [zone.id] : input.zones,
    threshold: input.threshold ?? 101, intervalMinutes: input.intervalMinutes ?? 1440,
  };
}

async function proofFor(id, channel, contact) {
  const proof = await readRecord('proof:' + id + ':' + channel);
  return proof?.contact === contact && proof.expiresAt > Date.now() ? proof : null;
}

export async function assertVerified(id, preferences) {
  for (const channel of preferences.channels)
    if (!await proofFor(id, channel, preferences.contacts[channel]))
      throw new HttpError('Confirma tu contacto de ' + CHANNEL_NAMES[channel] + ' con el código recibido antes de continuar.', 409);
}

const RESERVE_SCRIPT = [
  '-- aire:reserve',
  "if redis.call('EXISTS',KEYS[1]) == 1 then return 'cooldown' end",
  "if tonumber(redis.call('GET',KEYS[2]) or '0') >= tonumber(ARGV[1]) then return 'quota' end",
  "if tonumber(redis.call('GET',KEYS[3]) or '0') >= tonumber(ARGV[2]) then return 'recipient_quota' end",
  "redis.call('INCR',KEYS[2]); redis.call('EXPIRE',KEYS[2],172800)",
  "redis.call('INCR',KEYS[3]); redis.call('EXPIRE',KEYS[3],172800)",
  "redis.call('SET',KEYS[1],ARGV[4],'EX',ARGV[3]); return 'ok'",
].join('\n');

async function reserve(channel, contact, kind, seconds) {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  const target = digest(channel + ':' + contact).slice(0, 40);
  const limit = messageLimits()[kind];
  const result = await redisCommand('EVAL', RESERVE_SCRIPT, 3,
    storageKey('cooldown:' + kind + ':' + target),
    storageKey('quota:' + kind + ':' + day),
    storageKey('recipient-quota:' + kind + ':' + target + ':' + day),
    limit, kind === 'verification' ? 3 : limit, seconds, randomUUID());
  if (result === 'cooldown') return false;
  if (result === 'quota' || result === 'recipient_quota')
    throw new HttpError(result === 'quota'
      ? 'Se alcanzó la cuota diaria de ' + ({ auto: 'avisos', test: 'pruebas', verification: 'códigos' })[kind] + ' del servicio.'
      : 'Este contacto alcanzó su límite diario de códigos.', 429);
  if (result !== 'ok') throw new HttpError('No se pudo reservar la cuota de envío.', 503);
  return true;
}

async function attempt(id, channel, contact, kind, work) {
  const record = {
    id: randomUUID(), channel, kind, contact: maskContact(contact), status: 'sending',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    providerId: null, message: 'Envío iniciado.',
  };
  const key = 'delivery:' + id + ':' + record.id;
  await writeRecord(key, record);
  await redisCommand('ZADD', storageKey('history:' + id), Date.now(), record.id);
  await redisCommand('EXPIRE', storageKey('history:' + id), lifetime);
  await redisCommand('ZREMRANGEBYRANK', storageKey('history:' + id), 0, -21);
  let result;
  try {
    result = await work();
    Object.assign(record, { status: result.status, providerId: result.id,
      message: result.message, errorCode: result.errorCode || null });
  } catch (error) {
    result = { channel, ok: false, status: 'failed', errorCode: error.providerCode || null,
      message: error instanceof HttpError
      ? error.message : 'No se pudo completar el envío. Consulta el historial antes de repetir.' };
    Object.assign(record, result);
  }
  record.updatedAt = new Date().toISOString();
  await writeRecord(key, record);
  return { ...result, recordId: record.id, contact: record.contact };
}

export async function deliveryHistory(id, refresh = false) {
  if (!redisAvailable()) return [];
  const ids = await redisCommand('ZREVRANGE', storageKey('history:' + id), 0, 9);
  const records = (await Promise.all((ids || []).map(key => readRecord('delivery:' + id + ':' + key)))).filter(Boolean);
  if (refresh) {
    const pending = records.filter(r => ['sms', 'whatsapp'].includes(r.channel) &&
      ['accepted', 'queued', 'sending', 'sent'].includes(r.status)).slice(0, 3);
    await Promise.all(pending.map(async record => {
      try {
        Object.assign(record, await pollDelivery(record));
        await writeRecord('delivery:' + id + ':' + record.id, record);
      } catch (error) {
        record.refreshError = error instanceof HttpError ? error.message : 'No se pudo actualizar este envío.';
      }
    }));
  }
  return records;
}

export async function requestVerification(req, id, input) {
  ready();
  if (input.consent !== true)
    throw new HttpError('Autoriza el envío del código a tu propio contacto.');
  const contact = normalizeContact(input.channel, input.contact);
  if (!providerStatus()[input.channel])
    throw new HttpError(providerDetails()[input.channel].message, 503);
  if (await proofFor(id, input.channel, contact))
    return { verified: true, channel: input.channel, contact, message: 'Este contacto ya está confirmado en este navegador.' };
  await rateLimit('verification-ip:' + clientFingerprint(req), 6, 3600);
  await rateLimit('verification-session:' + id, 6, 3600);
  if (!await reserve(input.channel, contact, 'verification', 60))
    throw new HttpError('Espera 60 segundos antes de solicitar otro código para este contacto.', 429);
  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  const challengeKey = 'verify:' + id + ':' + input.channel;
  await redisCommand('EVAL', [
    '-- aire:challenge',
    "redis.call('DEL',KEYS[1])",
    "redis.call('HSET',KEYS[1],'contact',ARGV[1],'digest',ARGV[2],'attempts',0)",
    "redis.call('EXPIRE',KEYS[1],600); return 'ok'",
  ].join('\n'), 1, storageKey(challengeKey),
  contact, digest(id + ':' + input.channel + ':' + contact + ':' + code));
  const result = await attempt(id, input.channel, contact, 'verification', () =>
    sendChannel(input.channel,
      'AIRE+ · Tu codigo es ' + code + '. Caduca en 10 minutos. No lo compartas. Si no lo solicitaste, ignora este mensaje.',
      { recipient: contact, verification: true, code }));
  if (!result.ok) {
    await redisCommand('DEL', storageKey(challengeKey));
    const error = new HttpError(result.message, 502);
    error.providerCode = result.errorCode || null;
    throw error;
  }
  return { channel: input.channel, verified: false, expiresIn: 600,
    message: 'Código solicitado. Revisa tu canal e introdúcelo aquí.', result };
}

const VERIFY_SCRIPT = [
  '-- aire:verify',
  "if redis.call('EXISTS',KEYS[1]) == 0 then return 'missing' end",
  "if redis.call('HGET',KEYS[1],'contact') ~= ARGV[1] then return 'mismatch' end",
  "if tonumber(redis.call('HGET',KEYS[1],'attempts') or '0') >= 5 then redis.call('DEL',KEYS[1]); return 'locked' end",
  "if redis.call('HGET',KEYS[1],'digest') ~= ARGV[2] then",
  "  local attempts=redis.call('HINCRBY',KEYS[1],'attempts',1)",
  "  if attempts >= 5 then redis.call('DEL',KEYS[1]); return 'locked' end",
  "  return 'wrong'",
  'end',
  "redis.call('SET',KEYS[2],ARGV[3],'EX',ARGV[4]); redis.call('DEL',KEYS[1]); return 'ok'",
].join('\n');

export async function verifyContact(req, id, input) {
  ready();
  const contact = normalizeContact(input.channel, input.contact);
  if (typeof input.code !== 'string' || !/^\d{6}$/.test(input.code))
    throw new HttpError('Introduce los seis dígitos del código.');
  await rateLimit('verify-attempts:' + id, 30, 600);
  const proof = { contact, verifiedAt: new Date().toISOString(), expiresAt: Date.now() + lifetime * 1000 };
  const state = await redisCommand('EVAL', VERIFY_SCRIPT, 2,
    storageKey('verify:' + id + ':' + input.channel),
    storageKey('proof:' + id + ':' + input.channel),
    contact, digest(id + ':' + input.channel + ':' + contact + ':' + input.code),
    JSON.stringify(proof), lifetime);
  if (state !== 'ok') throw new HttpError(state === 'locked'
    ? 'Se agotaron los cinco intentos. Solicita un código nuevo.'
    : state === 'missing' ? 'El código caducó o ya fue utilizado. Solicita otro.'
      : 'El código no coincide con este contacto.', 400);
  return { verified: true, channel: input.channel, contact, message: 'Contacto confirmado. Ya puedes activar tus avisos.' };
}


function ownerKeys(subscription) {
  return (subscription?.channels || []).filter(channel =>
    typeof subscription.contacts?.[channel] === 'string').map(channel =>
    storageKey('owner:' + digest(channel + ':' + subscription.contacts[channel]).slice(0, 40)));
}

const SAVE_SCRIPT = [
  '-- aire:save',
  "redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',ARGV[6])",
  "if ARGV[2] ~= '' and not redis.call('GET',KEYS[1]) and redis.call('ZCARD',KEYS[2]) >= tonumber(ARGV[4]) then return 'full' end",
  'local n=tonumber(ARGV[7])',
  'for i=3,2+n do',
  "  local owner=redis.call('GET',KEYS[i]); if owner and owner ~= ARGV[1] then return 'duplicate' end",
  'end',
  "for i=3+n,#KEYS do if redis.call('GET',KEYS[i]) == ARGV[1] then redis.call('DEL',KEYS[i]) end end",
  "if ARGV[2] == '' then redis.call('DEL',KEYS[1]); redis.call('ZREM',KEYS[2],ARGV[1]); return 'ok' end",
  "redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]); redis.call('ZADD',KEYS[2],ARGV[5],ARGV[1])",
  "for i=3,2+n do redis.call('SET',KEYS[i],ARGV[1],'EX',ARGV[3]) end",
  "return 'ok'",
].join('\n');

export async function getSubscription(id) {
  return redisAvailable() ? readRecord('sub:' + id) : null;
}

export async function saveSubscription(id, preferences) {
  ready();
  const lock = storageKey('sub-lock:' + id), token = randomUUID();
  if (!await redisCommand('SET', lock, token, 'EX', 30, 'NX'))
    throw new HttpError('Hay otra actualización de tus alertas en curso. Intenta de nuevo.', 409);
  try {
    const old = await getSubscription(id);
    const value = preferences ? {
      ...preferences, active: true,
      createdAt: old?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(), expiresAt: Date.now() + lifetime * 1000,
    } : null;
    const added = ownerKeys(value), removed = ownerKeys(old);
    const result = await redisCommand('EVAL', SAVE_SCRIPT, 2 + added.length + removed.length,
      storageKey('sub:' + id), storageKey('subscriptions'), ...added, ...removed,
      id, value ? JSON.stringify(value) : '', lifetime,
      integerSetting('MAX_SUBSCRIPTIONS', 64, 2000), value?.expiresAt || Date.now(),
      Date.now(), added.length);
    if (result === 'duplicate') throw new HttpError(
      'Uno de tus contactos ya tiene alertas activas en otro navegador. Desactívalas allí antes de registrarlo de nuevo.', 409);
    if (result === 'full') throw new HttpError(
      'El servicio alcanzó su capacidad de suscripciones. Intenta más tarde.', 429);
    if (result !== 'ok') throw new HttpError('No se pudo guardar la suscripción.', 503);
    return value;
  } finally {
    await redisCommand('EVAL', RELEASE_SCRIPT, 1, lock, token);
  }
}

function vehicleSummary(subscription) {
  const result = circulation(subscription.vehicle.plate, subscription.vehicle.hologram, cdmxParts());
  return (result.unknown ? 'Hoy No Circula: confirma el aviso oficial. '
    : result.restrictedNow ? 'Hoy No Circula: tienes restricción ahora. '
      : result.restrictedToday ? 'Hoy No Circula: descansas de 05:00 a 22:00. '
        : 'Hoy No Circula: sin restricción ordinaria hoy. ') + result.reason +
    ' Calendario ordinario; las contingencias pueden cambiarlo.';
}

export function buildMessage(subscription, air, worst, { test = false, channel = 'telegram' } = {}) {
  const analysis = analyzeAirData(air, worst.zone, subscription.profile);
  const header = (test ? '[PRUEBA] ' : '') + 'AIRE+ · ' + worst.name;
  const date = new Intl.DateTimeFormat('es-MX', {
    timeZone: 'America/Mexico_City', dateStyle: 'short', timeStyle: 'short',
  }).format(new Date(worst.observedAt));
  const parts = [header];
  if (subscription.content.includes('aqi'))
    parts.push('US AQI ' + worst.value + '. ' + analysis.summary);
  if (subscription.content.includes('pollutants'))
    parts.push(analysis.details.map(d => d.name + ': ' +
      (d.value === null ? 'sin dato' : Number(d.value.toFixed(1)) + ' ' + d.unit)).join('; ') + '.');
  if (subscription.content.includes('circulation')) parts.push(vehicleSummary(subscription));
  if (subscription.content.includes('recommendations'))
    parts.push('Para tu perfil: ' + analysis.recommendations[0]);
  if (subscription.zones.length > 1)
    parts.push('Se muestra el mayor índice entre las alcaldías seleccionadas con datos vigentes.');
  parts.push('Estimación Open-Meteo / CAMS para ' + date + ' (CDMX).');
  if (test) parts.push('Mensaje de prueba, no aviso de emergencia.');
  if (channel === 'sms') {
    const short = [(test ? 'PRUEBA ' : '') + 'AIRE+ ' + worst.name];
    if (subscription.content.includes('aqi')) short.push('US AQI ' + worst.value);
    if (subscription.content.includes('pollutants'))
      short.push(analysis.details.map(d => d.name.replace('₂', '2').replace('₃', '3') + ':' +
        (d.value === null ? '?' : Number(d.value.toFixed(1)))).join(' '));
    if (subscription.content.includes('circulation')) {
      const c = circulation(subscription.vehicle.plate, subscription.vehicle.hologram);
      short.push('HNC:' + (c.unknown ? 'consulta aviso' : c.restrictedNow ? 'no circulas ahora'
        : c.restrictedToday ? 'descanso 5-22h' : 'sin restriccion ordinaria'));
    }
    if (subscription.content.includes('recommendations')) short.push(analysis.recommendations[0]);
    return smsText(short.join('. ') + '. CAMS');
  }
  return parts.join('\n\n');
}

export async function dispatch(subscription, { test = false, id, air: providedAir } = {}) {
  ready();
  if (!id || subscription.schemaVersion !== 4 || !subscription.contacts)
    throw new HttpError('Vuelve a configurar y confirmar tus contactos para actualizar las alertas.', 409);
  const air = providedAir || await getAirData();
  if (!isFreshAir(air)) throw new HttpError('No hay datos de calidad del aire vigentes.', 503);
  const relevant = air.stations.filter(s =>
    subscription.zones.includes(s.zone) && Number.isFinite(s.value) &&
    Number.isFinite(Date.parse(s.observedAt)) && Date.now() - Date.parse(s.observedAt) <= 7200000);
  if (!relevant.length) throw new HttpError('No hay un índice vigente para la zona elegida.', 503);
  const exceeded = relevant.filter(s => s.value >= subscription.threshold);
  if (!test && !exceeded.length)
    return { state: 'below_threshold', results: [], observedAt: air.observedAt };
  const worst = (test ? relevant : exceeded).reduce((a, b) => a.value >= b.value ? a : b);
  const kind = test ? 'test' : 'auto';
  const results = await Promise.all(subscription.channels.map(async channel => {
    try {
      const contact = normalizeContact(channel, subscription.contacts[channel]);
      if (!await reserve(channel, contact, kind, test ? 60 : subscription.intervalMinutes * 60))
        return { channel, ok: true, skipped: true, message: test
          ? 'Espera 60 segundos antes de repetir la prueba.'
          : 'Todavía no se cumple el intervalo mínimo para este contacto.' };
      return await attempt(id, channel, contact, kind, () =>
        sendChannel(channel, buildMessage(subscription, air, worst, { test, channel }), { recipient: contact }));
    } catch (error) {
      return { channel, ok: false, message: error instanceof HttpError
        ? error.message : 'No se pudo completar el envío. Revisa el historial antes de repetir.' };
    }
  }));
  return { state: test ? 'tested' : 'checked', results, observedAt: air.observedAt };
}

export async function subscriptionStatus(id) {
  const channels = providerStatus();
  const configured = redisAvailable();
  const subscription = configured ? await getSubscription(id) : null;
  const needsUpdate = !!subscription && subscription.schemaVersion !== 4;
  const proofs = configured ? await Promise.all(CHANNELS.map(async channel => {
    const proof = await readRecord('proof:' + id + ':' + channel);
    return proof?.expiresAt > Date.now() ? { channel, contact: proof.contact, verified: true } : null;
  })) : [];
  const lastRun = configured ? await readRecord('last-cron') : null;
  return {
    channels, channelDetails: providerDetails(), providerConnections: providerConnections(),
    storageMode: configured ? 'server' : 'unconfigured',
    limits: messageLimits(), dailyLimit: messageLimits().auto,
    backgroundReady: configured && sessionConfigured() && (process.env.CRON_SECRET || '').length >= 32,
    configurationError: !configured ? 'El servicio de alertas todavía necesita configurar su almacenamiento.'
      : !sessionConfigured() ? 'El servicio de alertas todavía necesita configurar su sesión segura.' : null,
    scheduleMinutes: integerSetting('ALERT_CHECK_MINUTES', 1440, 1440), lastRun,
    subscription: needsUpdate ? null : subscription, needsUpdate,
    verifiedContacts: proofs.filter(Boolean), deliveries: configured ? await deliveryHistory(id) : [],
  };
}

const RELEASE_SCRIPT = [
  '-- aire:release',
  "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",
].join('\n');

export async function checkAllSubscriptions() {
  ready();
  const lock = storageKey('cron-lock'), token = randomUUID(), started = Date.now();
  if (!await redisCommand('SET', lock, token, 'EX', 55, 'NX'))
    return { state: 'busy', checked: 0 };
  try {
    await redisCommand('ZREMRANGEBYSCORE', storageKey('subscriptions'), '-inf', Date.now());
    let ids = await redisCommand('ZRANGE', storageKey('subscriptions'), 0, -1) || [];
    const cursor = await redisCommand('GET', storageKey('cron-cursor'));
    const position = ids.indexOf(cursor);
    if (position >= 0) ids = [...ids.slice(position + 1), ...ids.slice(0, position + 1)];
    const air = ids.length ? await getAirData() : null;
    const results = [];
    let processed = 0;
    for (const id of ids) {
      if (Date.now() - started > 30000) break;
      const sub = await getSubscription(id);
      if (!sub) {
        await redisCommand('ZREM', storageKey('subscriptions'), id);
      } else {
        try {
          if (sub.schemaVersion !== 4) throw new HttpError('Suscripción antigua pendiente de actualizar.', 409);
          if (sub.active) results.push(await dispatch(validatePreferences(sub), { id, air }));
        } catch (error) {
          results.push({ state: 'error', message: error instanceof HttpError
            ? error.message : 'No se pudo comprobar una suscripción.' });
        }
      }
      processed++;
      await redisCommand('SET', storageKey('cron-cursor'), id, 'EX', lifetime);
    }
    const run = {
      at: new Date().toISOString(), state: ids.length ? 'checked' : 'inactive',
      checked: processed, remaining: Math.max(0, ids.length - processed),
      failures: results.reduce((n, r) => n + (r.state === 'error' ? 1 : (r.results || []).filter(x => !x.ok).length), 0),
    };
    await writeRecord('last-cron', run);
    return run;
  } finally {
    await redisCommand('EVAL', RELEASE_SCRIPT, 1, lock, token);
  }
}
