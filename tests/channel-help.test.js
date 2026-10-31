import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setup, browserClient, preferences } from './helpers.js';
import { providerStatus, providerConnections } from '../server/notifications.js';

test('Telegram help explains the numeric ID, links the external lookup bot and includes the service bot link', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const help = html.slice(html.indexOf('<details id="telegramHelp"'), html.indexOf('<div class="verification-actions"'));
  assert.ok(help.includes('https://t.me/userinfobot'));
  assert.ok(help.includes('bot externo'));
  assert.ok(help.includes('id="telegramBotLink"'));
  assert.ok(help.includes('/start'));
  assert.ok(help.includes('Enviar código'));
});

test('Telegram help discovers the public service bot without Redis or sending a message', async t => {
  const state = await setup(t), browser = browserClient();
  delete process.env.UPSTASH_REDIS_REST_URL;
  const result = await browser.request({ action: 'telegram_info' });
  assert.equal(result.code, 200);
  assert.equal(result.body.botUrl, 'https://t.me/AirePlusUnitTestBot');
  assert.equal(result.body.username, 'AirePlusUnitTestBot');
  assert.equal(state.telegramInfoRequests, 1);
  await browser.request({ action: 'telegram_info' });
  assert.equal(state.telegramInfoRequests, 1);
  assert.equal(state.telegram.length, 0);
  assert.equal(JSON.stringify(result.body).includes(process.env.TELEGRAM_BOT_TOKEN), false);
});

test('A missing or rejected Telegram token never creates a broken service link', async t => {
  const state = await setup(t), browser = browserClient();
  state.telegramInfoError = 401;
  let result = await browser.request({ action: 'telegram_info' });
  assert.equal(result.code, 200);
  assert.equal(result.body.state, 'error');
  assert.equal(result.body.botUrl, undefined);
  delete process.env.TELEGRAM_BOT_TOKEN;
  result = await browser.request({ action: 'telegram_info' });
  assert.equal(result.code, 503);
});

test('Configured channels remain unverified until their authentication has been checked', async t => {
  await setup(t);
  assert.equal(providerStatus().sms, true);
  assert.equal(providerConnections().sms.state, 'configured');
  assert.equal(providerConnections().whatsapp.state, 'configured');
});

test('Diagnostics validate Telegram and Twilio without sending messages or exposing account secrets', async t => {
  const state = await setup(t), browser = browserClient();
  const result = await browser.request({ action: 'diagnostics' });
  assert.equal(result.code, 200, JSON.stringify(result.body));
  assert.equal(result.body.providerConnections.telegram.state, 'ready');
  assert.equal(result.body.providerConnections.sms.state, 'ready');
  assert.equal(result.body.providerConnections.whatsapp.state, 'ready');
  assert.equal(result.body.providerConnections.email.state, 'configured');
  const text = JSON.stringify(result.body);
  for (const secret of [process.env.TWILIO_AUTH_TOKEN, process.env.TWILIO_ACCOUNT_SID,
    process.env.TELEGRAM_BOT_TOKEN, 'never-disclose-this-account-token', 'private@example.com'])
    assert.equal(text.includes(secret), false);
  assert.equal(state.telegram.length + state.twilio.length + state.emails.length, 0);
  assert.equal(state.twilioAccountRequests, 1);
  await browser.request({ action: 'diagnostics' });
  assert.equal(state.twilioAccountRequests, 1);
});

test('Twilio 20003 marks SMS and WhatsApp rejected even though configuration variables exist', async t => {
  const state = await setup(t), browser = browserClient();
  state.twilioAuthError = 20003;
  const result = await browser.request({ action: 'diagnostics' });
  assert.equal(result.code, 200);
  assert.equal(result.body.channels.sms, true);
  assert.equal(result.body.providerConnections.sms.state, 'error');
  assert.equal(result.body.providerConnections.whatsapp.state, 'error');
  assert.equal(result.body.providerConnections.sms.code, 20003);
  assert.match(result.body.providerConnections.sms.message, /Auth Token reales/);
  assert.equal(state.twilio.length, 0);
});

test('Changing the credentials invalidates a cached rejection and outer whitespace is trimmed', async t => {
  const state = await setup(t), browser = browserClient();
  state.twilioAuthError = 20003;
  await browser.request({ action: 'diagnostics' });
  state.twilioAuthError = null;
  process.env.TWILIO_ACCOUNT_SID = ' ' + process.env.TWILIO_ACCOUNT_SID + ' ';
  process.env.TWILIO_AUTH_TOKEN = ' corrected-auth-token ';
  const result = await browser.request({ action: 'diagnostics' });
  assert.equal(result.body.providerConnections.sms.state, 'ready');
  assert.equal(state.twilioAccountRequests, 2);
  assert.equal(state.lastTwilioAuthorization, 'Basic ' + Buffer.from(
    process.env.TWILIO_ACCOUNT_SID.trim() + ':corrected-auth-token').toString('base64'));
});

test('A rejected send is reflected in connection status and its numeric code is retained in history', async t => {
  const state = await setup(t), browser = browserClient();
  state.twilioAuthError = 20003;
  const result = await browser.request({ action: 'request_verification',
    channel: 'sms', contact: '+525500000001', consent: true });
  assert.equal(result.code, 502);
  assert.match(result.body.error, /20003/);
  const status = await browser.request(undefined, { method: 'GET' });
  assert.equal(status.body.providerConnections.sms.state, 'error');
  assert.equal(status.body.deliveries[0].errorCode, 20003);
});
