import test from 'node:test';
import assert from 'node:assert/strict';
import alerts from '../api/alerts.js';
import subscribe from '../api/subscribe.js';
import cron from '../api/cron.js';
import assistant from '../api/assistant.js';
import { checkAllSubscriptions, buildMessage, validatePreferences } from '../server/subscriptions.js';
import { normalizeContact, smsText } from '../server/notifications.js';
import { storageKey } from '../server/storage.js';
import { parseOpenMeteo, zones } from '../shared/air-core.js';
import { fixture, setup, browserClient, preferences, call } from './helpers.js';

test('Registration → verification → saved subscription → cron sends to the registered person', async t => {
  const state = await setup(t), browser = browserClient();
  await state.verify(browser, 'telegram', '987654321');
  let result = await browser.request({ action: 'subscribe', ...preferences('987654321') });
  assert.equal(result.code, 200, JSON.stringify(result.body));
  assert.equal(result.body.subscription.active, true);
  assert.equal(await state.redis.zcard(storageKey('subscriptions')), 1);
  assert.equal(await state.redis.exists('subscribers:telegram'), 0);
  const run = await checkAllSubscriptions();
  assert.equal(run.checked, 1);
  assert.equal(run.failures, 0, JSON.stringify(state.redisErrors));
  assert.equal(state.telegram.length, 2);
  assert.equal(state.telegram[1].chat_id, '987654321');
  assert.notEqual(state.telegram[1].chat_id, process.env.TELEGRAM_CHAT_ID);
  assert.match(state.telegram[1].text, /US AQI 125/);
  result = await browser.request(undefined, { method: 'GET' });
  assert.equal(result.body.deliveries[0].kind, 'auto');
  assert.equal(JSON.stringify(result.body).includes(process.env.TELEGRAM_BOT_TOKEN), false);
});

test('Unverified destinations and freely supplied message text cannot cause sends', async t => {
  const state = await setup(t), browser = browserClient();
  for (const action of ['subscribe', 'test']) {
    const result = await browser.request({ action, ...preferences('987654321'),
      chat_id: '111111111', text: 'Injected free text' });
    assert.equal(result.code, 409);
  }
  assert.equal(state.telegram.length, 0);
  assert.equal(await state.redis.zcard(storageKey('subscriptions')), 0);
});

test('The compatibility endpoint writes the same subscription consumed by the scheduler', async t => {
  const state = await setup(t), browser = browserClient();
  await state.verify(browser, 'telegram', '987654321');
  const result = await browser.request({
    canal: 'telegram', contacto: '987654321', alcaldia: 'Iztapalapa', consent: true,
  }, { handler: subscribe });
  assert.equal(result.code, 200, JSON.stringify(result.body));
  const run = await checkAllSubscriptions();
  assert.equal(run.checked, 1);
  assert.equal(state.telegram.at(-1).chat_id, '987654321');
});

test('Registration rejects malformed bodies, unknown channels and non-string contacts', async t => {
  await setup(t);
  for (const body of [undefined, null, [], { channels: ['unknown'], contacts: {}, zones: ['iztapalapa'] },
    { ...preferences(), contacts: { telegram: { value: '987654321' } } }]) {
    const result = await call(subscribe, body);
    assert.equal(result.code, 400, JSON.stringify(result.body));
  }
  assert.throws(() => normalizeContact('sms', '5512345678'), /formato internacional/);
  assert.throws(() => normalizeContact('email', 'broken'), /correo/);
  assert.throws(() => validatePreferences({ ...preferences(), content: [] }), /contenido/);
});

test('A confirmation code belongs to one browser and one exact contact', async t => {
  const state = await setup(t), first = browserClient(), second = browserClient();
  await first.request({ action: 'request_verification', channel: 'telegram', contact: '987654321', consent: true });
  const code = state.codeFor('telegram', '987654321');
  for (const [browser, contact] of [[second, '987654321'], [first, '987654322']]) {
    const result = await browser.request({ action: 'verify_contact', channel: 'telegram', contact, code });
    assert.equal(result.code, 400);
  }
  const result = await first.request({ action: 'verify_contact', channel: 'telegram', contact: '987654321', code });
  assert.equal(result.code, 200);
  const replay = await first.request({ action: 'verify_contact', channel: 'telegram', contact: '987654321', code });
  assert.equal(replay.code, 400);
});

test('Five wrong guesses invalidate the code without storing the plain code in Redis', async t => {
  const state = await setup(t), browser = browserClient();
  await browser.request({ action: 'request_verification', channel: 'telegram', contact: '987654321', consent: true });
  const code = state.codeFor('telegram', '987654321');
  const keys = await state.redis.keys(storageKey('verify:*'));
  assert.equal(keys.length, 1);
  assert.ok(await state.redis.ttl(keys[0]) > 590);
  const hash = await state.redis.hgetall(keys[0]);
  assert.notEqual(hash.digest, code);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    const result = await browser.request({ action: 'verify_contact', channel: 'telegram', contact: '987654321', code: wrong });
    assert.equal(result.code, 400);
  }
  const result = await browser.request({ action: 'verify_contact', channel: 'telegram', contact: '987654321', code });
  assert.equal(result.code, 400);
  assert.equal(await state.redis.exists(keys[0]), 0);
});

test('Saving repeatedly updates one record; confirmed duplicate contacts cannot create another', async t => {
  const state = await setup(t), browser = browserClient(), other = browserClient();
  await state.verify(browser, 'telegram', '987654321');
  for (const threshold of [101, 151]) {
    const result = await browser.request({ action: 'subscribe', ...preferences('987654321'), threshold });
    assert.equal(result.code, 200);
  }
  assert.equal(await state.redis.zcard(storageKey('subscriptions')), 1);
  // Prove ownership from the other browser without waiting through a resend cooldown.
  const challenge = await state.redis.keys(storageKey('cooldown:verification:*'));
  await state.redis.del(...challenge);
  await state.verify(other, 'telegram', '987654321');
  const duplicate = await other.request({ action: 'subscribe', ...preferences('987654321') });
  assert.equal(duplicate.code, 409);
  assert.equal(await state.redis.zcard(storageKey('subscriptions')), 1);
  await browser.request({ action: 'unsubscribe' });
  const restored = await other.request({ action: 'subscribe', ...preferences('987654321') });
  assert.equal(restored.code, 200);
  assert.equal(await state.redis.zcard(storageKey('subscriptions')), 1);
});

test('One browser cannot read or disable another browser subscription', async t => {
  const state = await setup(t), first = browserClient(), second = browserClient();
  await state.verify(first, 'telegram', '987654321');
  await first.request({ action: 'subscribe', ...preferences('987654321') });
  const empty = await second.request(undefined, { method: 'GET' });
  assert.equal(empty.body.subscription, null);
  assert.equal(empty.body.verifiedContacts.length, 0);
  await second.request({ action: 'unsubscribe' });
  const original = await first.request(undefined, { method: 'GET' });
  assert.equal(original.body.subscription.active, true);
});

test('Cooldowns are per recipient and browser checks do not duplicate cron sends', async t => {
  const state = await setup(t), first = browserClient(), second = browserClient();
  for (const [browser, contact] of [[first, '987654321'], [second, '987654322']]) {
    await state.verify(browser, 'telegram', contact);
    await browser.request({ action: 'subscribe', ...preferences(contact) });
  }
  await checkAllSubscriptions();
  assert.equal(state.telegram.filter(m => !m.text.includes('Tu codigo')).length, 2);
  const result = await first.request({ action: 'check' });
  assert.equal(result.body.results[0].skipped, true);
  assert.equal(state.telegram.length, 4);
});

test('Tests and confirmation codes do not consume the automatic alert quota', async t => {
  const state = await setup(t), browser = browserClient();
  process.env.MAX_MESSAGES_PER_DAY = '1';
  process.env.MAX_TEST_MESSAGES_PER_DAY = '1';
  await state.verify(browser, 'telegram', '987654321');
  await browser.request({ action: 'subscribe', ...preferences('987654321') });
  const tested = await browser.request({ action: 'test', ...preferences('987654321') });
  assert.equal(tested.body.results[0].ok, true);
  const run = await checkAllSubscriptions();
  assert.equal(run.failures, 0);
  assert.equal(state.telegram.length, 3);
});

test('Parallel reservations respect the shared daily automatic budget', async t => {
  const state = await setup(t), first = browserClient(), second = browserClient();
  process.env.MAX_MESSAGES_PER_DAY = '1';
  for (const [browser, contact] of [[first, '987654321'], [second, '987654322']]) {
    await state.verify(browser, 'telegram', contact);
    await browser.request({ action: 'subscribe', ...preferences(contact) });
  }
  const results = await Promise.all([first.request({ action: 'check' }), second.request({ action: 'check' })]);
  assert.equal(results.filter(r => r.body.results?.[0]?.ok && !r.body.results[0].skipped).length, 1);
  assert.equal(state.telegram.filter(m => !m.text.includes('Tu codigo')).length, 1);
});

test('The scheduler does not send below the threshold and a subscription can be disabled', async t => {
  const state = await setup(t), browser = browserClient();
  state.airValue = 80;
  await state.verify(browser, 'telegram', '987654321');
  await browser.request({ action: 'subscribe', ...preferences('987654321') });
  const run = await checkAllSubscriptions();
  assert.equal(run.checked, 1);
  assert.equal(state.telegram.length, 1);
  await browser.request({ action: 'unsubscribe' });
  assert.equal((await checkAllSubscriptions()).state, 'inactive');
});

test('Missing storage or a stable session secret blocks sends with an explicit error', async t => {
  const state = await setup(t), browser = browserClient();
  delete process.env.UPSTASH_REDIS_REST_URL;
  let result = await browser.request({ action: 'request_verification', channel: 'sms', contact: '+525500000001', consent: true });
  assert.equal(result.code, 503);
  assert.match(result.body.error, /UPSTASH/);
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.unit-test.invalid';
  delete process.env.SESSION_SECRET;
  result = await browser.request({ action: 'request_verification', channel: 'sms', contact: '+525500000001', consent: true });
  assert.equal(result.code, 503);
  assert.equal(state.twilio.length, 0);
});

test('Redis failures block sends and an invalid JSON request is handled', async t => {
  const state = await setup(t), browser = browserClient();
  let result = await browser.request('{bad json');
  assert.equal(result.code, 400);
  state.failRedis = true;
  result = await browser.request({ action: 'request_verification', channel: 'telegram', contact: '987654321', consent: true });
  assert.equal(result.code, 503);
  assert.equal(state.telegram.length, 0);
});

test('SendGrid 202 with an empty response is accepted and emails use the visitor contact', async t => {
  const state = await setup(t), browser = browserClient();
  await state.verify(browser, 'email', 'person@example.com');
  await browser.request({ action: 'subscribe', ...preferences('person@example.com', 'email') });
  await checkAllSubscriptions();
  assert.equal(state.emails.length, 2);
  assert.equal(state.emails[1].personalizations[0].to[0].email, 'person@example.com');
  const status = await browser.request(undefined, { method: 'GET' });
  assert.equal(status.body.deliveries[0].status, 'accepted');
  assert.match(status.body.deliveries[0].message, /sin confirmar/);
});

test('Twilio queued is distinct from delivered and delivery polling updates the history', async t => {
  const state = await setup(t), browser = browserClient();
  await state.verify(browser, 'sms', '+525500000001');
  const tested = await browser.request({ action: 'test', ...preferences('+525500000001', 'sms') });
  assert.equal(tested.body.results[0].status, 'queued');
  assert.equal(state.twilio[1].To, '+525500000001');
  assert.notEqual(state.twilio[1].To, process.env.TWILIO_SMS_TO);
  assert.ok(state.twilio[1].Body.length <= 160);
  state.deliveryStatus = 'delivered';
  const refreshed = await browser.request({ action: 'delivery_status' });
  assert.equal(refreshed.body.deliveries[0].status, 'delivered');
});

test('WhatsApp prefixes are normalized once and a failed delivery is not marked successful', async t => {
  const state = await setup(t), browser = browserClient();
  await state.verify(browser, 'whatsapp', '+525500000001');
  await browser.request({ action: 'test', ...preferences('+525500000001', 'whatsapp') });
  assert.equal(state.twilio[1].To, 'whatsapp:+525500000001');
  state.deliveryStatus = 'undelivered';
  const result = await browser.request({ action: 'delivery_status' });
  assert.equal(result.body.deliveries[0].status, 'undelivered');
  assert.match(result.body.deliveries[0].message, /plantilla/);
});

test('Messages obey selected content and explain the ordinary circulation calendar', async t => {
  await setup(t);
  const air = parseOpenMeteo(fixture(125)), worst = air.stations.find(s => s.zone === 'iztapalapa');
  const sub = validatePreferences({ ...preferences(), content: ['circulation'], vehicle: { plate: 0, hologram: '1' } });
  const message = buildMessage(sub, air, worst);
  assert.match(message, /Hoy No Circula/);
  assert.match(message, /contingencias/);
  assert.equal(message.includes('PM2.5'), false);
  assert.equal(message.includes('Para tu perfil:'), false);
  assert.ok(smsText('á'.repeat(200)).length <= 160);
});

test('The scheduler requires a server secret and does not disclose subscription contacts', async t => {
  await setup(t);
  let result = await call(cron, undefined, '', 'GET');
  assert.equal(result.code, 401);
  result = await call(cron, undefined, '', 'GET', { authorization: 'Bearer ' + process.env.CRON_SECRET });
  assert.equal(result.code, 200);
  assert.equal(result.body.state, 'inactive');
  assert.equal(JSON.stringify(result.body).includes('contacts'), false);
});

test('Foreign origins are rejected and the assistant ignores forged browser readings', async t => {
  const state = await setup(t);
  let result = await call(alerts, { action: 'test', ...preferences() }, '', 'POST', { origin: 'https://foreign.test' });
  assert.equal(result.code, 403);
  result = await call(assistant, { zone: 'iztapalapa', profile: 'sensible', value: 1, components: { pm25: 0 } });
  assert.equal(result.code, 200);
  assert.match(result.body.analysis.summary, /125/);
  assert.equal(result.body.analysis.details[0].value, 31.5);
  assert.equal(state.telegram.length, 0);
});

test('Activation capacity is enforced atomically and expired entries do not block new users', async t => {
  const state = await setup(t), first = browserClient(), second = browserClient();
  process.env.MAX_SUBSCRIPTIONS = '1';
  await state.verify(first, 'telegram', '987654321');
  await state.verify(second, 'telegram', '987654322');
  const replies = await Promise.all([
    first.request({ action: 'subscribe', ...preferences('987654321') }),
    second.request({ action: 'subscribe', ...preferences('987654322') }),
  ]);
  assert.deepEqual(replies.map(r => r.code).sort(), [200, 429]);
  assert.equal(await state.redis.zcard(storageKey('subscriptions')), 1);
  const id = (await state.redis.zrange(storageKey('subscriptions'), 0, 0))[0];
  await state.redis.del(storageKey('sub:' + id));
  await state.redis.zadd(storageKey('subscriptions'), Date.now() - 1, id);
  const winner = replies[0].code === 200 ? first : second;
  const target = replies[0].code === 200 ? '987654321' : '987654322';
  // The original contact owner expires with the old subscription as in real Redis.
  for (const key of await state.redis.keys(storageKey('owner:*'))) await state.redis.del(key);
  const result = await winner.request({ action: 'subscribe', ...preferences(target) });
  assert.equal(result.code, 200);
});

test('Provider failures are recorded without revealing codes or pretending to confirm a contact', async t => {
  const state = await setup(t), browser = browserClient();
  state.telegramError = 403;
  const result = await browser.request({ action: 'request_verification', channel: 'telegram', contact: '987654321', consent: true });
  assert.equal(result.code, 502);
  assert.match(result.body.error, /bloqueado/);
  const status = await browser.request(undefined, { method: 'GET' });
  assert.equal(status.body.verifiedContacts.length, 0);
  assert.equal(status.body.deliveries[0].status, 'failed');
  const code = state.codeFor('telegram', '987654321');
  assert.equal(JSON.stringify(status.body.deliveries).includes(code), false);
});

test('A missing or expired verification challenge requires a new code', async t => {
  const state = await setup(t), browser = browserClient();
  await browser.request({ action: 'request_verification', channel: 'telegram', contact: '987654321', consent: true });
  const code = state.codeFor('telegram', '987654321');
  const keys = await state.redis.keys(storageKey('verify:*'));
  await state.redis.del(keys[0]);
  const result = await browser.request({ action: 'verify_contact', channel: 'telegram', contact: '987654321', code });
  assert.equal(result.code, 400);
  assert.match(result.body.error, /caducó/);
});

test('SMS extension characters count as two septets', async t => {
  await setup(t);
  assert.equal(smsText('['.repeat(100)).length, 80);
  assert.equal(smsText('á'.repeat(200)).length, 160);
});

test('Concurrent edits from the same browser do not leave orphan contact ownership', async t => {
  const state = await setup(t), browser = browserClient();
  await state.verify(browser, 'telegram', '987654321');
  const results = await Promise.all([
    browser.request({ action: 'subscribe', ...preferences('987654321'), threshold: 101 }),
    browser.request({ action: 'subscribe', ...preferences('987654321'), threshold: 151 }),
  ]);
  assert.ok(results.some(r => r.code === 200));
  assert.ok(results.every(r => [200, 409].includes(r.code)));
  assert.equal(await state.redis.zcard(storageKey('subscriptions')), 1);
  assert.equal((await state.redis.keys(storageKey('owner:*'))).length, 1);
  await browser.request({ action: 'unsubscribe' });
  assert.equal((await state.redis.keys(storageKey('owner:*'))).length, 0);
});

test('Codes require explicit consent and a repeat request is throttled', async t => {
  const state = await setup(t), browser = browserClient();
  let result = await browser.request({ action: 'request_verification', channel: 'telegram', contact: '987654321' });
  assert.equal(result.code, 400);
  assert.equal(state.telegram.length, 0);
  result = await browser.request({ action: 'request_verification', channel: 'telegram', contact: '987654321', consent: true });
  assert.equal(result.code, 200);
  result = await browser.request({ action: 'request_verification', channel: 'telegram', contact: '987654321', consent: true });
  assert.equal(result.code, 429);
  assert.equal(state.telegram.length, 1);
});
