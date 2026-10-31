import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setup, browserClient } from './helpers.js';
import { providerStatus, providerConnections, sendChannel } from '../server/notifications.js';

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

test('Valid trial credentials show the recipient and content restrictions without sending messages', async t => {
  const state = await setup(t), browser = browserClient();
  state.twilioAccountType = 'Trial';
  const result = await browser.request({ action: 'diagnostics' });
  const sms = result.body.providerConnections.sms;
  assert.equal(sms.state, 'ready');
  assert.equal(sms.trial, true);
  assert.match(sms.message, /Cuenta de prueba \(Trial\)/);
  assert.match(sms.message, /destinatario.*plantillas/);
  assert.match(sms.message, /impedir códigos y avisos personalizados/);
  assert.equal(state.twilio.length, 0);
  assert.equal(JSON.stringify(result.body).includes('never-disclose-this-account-token'), false);
});

test('A trial sender mismatch identifies SMS and keeps successful authentication separate from delivery', async t => {
  const state = await setup(t), browser = browserClient();
  await browser.request({ action: 'diagnostics' });
  state.twilioSendError = 572002;
  const result = await browser.request({ action: 'request_verification',
    channel: 'sms', contact: '+525500000001', consent: true });
  assert.equal(result.code, 502);
  assert.match(result.body.error, /^SMS:/);
  assert.match(result.body.error, /572002/);
  assert.match(result.body.error, /From de Messaging para ese receptor/);
  const status = await browser.request(undefined, { method: 'GET' });
  assert.equal(status.body.providerConnections.sms.state, 'ready');
  assert.equal(status.body.deliveries[0].channel, 'sms');
  assert.equal(status.body.deliveries[0].status, 'failed');
  assert.equal(status.body.deliveries[0].errorCode, 572002);
  assert.equal(status.body.verifiedContacts.some(contact => contact.channel === 'sms'), false);
});

test('A ContentSid rejection identifies WhatsApp and explains the required template', async t => {
  const state = await setup(t), browser = browserClient();
  state.twilioSendError = 21654;
  const result = await browser.request({ action: 'request_verification',
    channel: 'whatsapp', contact: '+525500000001', consent: true });
  assert.equal(result.code, 502);
  assert.match(result.body.error, /^WhatsApp:/);
  assert.match(result.body.error, /21654/);
  assert.match(result.body.error, /ContentSid.*plantilla/);
  const status = await browser.request(undefined, { method: 'GET' });
  assert.equal(status.body.deliveries[0].errorCode, 21654);
  assert.equal(status.body.verifiedContacts.some(contact => contact.channel === 'whatsapp'), false);
});

test('WhatsApp codes and alerts include their ContentSid with substitution values and omit Body', async t => {
  const state = await setup(t);
  process.env.TWILIO_WHATSAPP_CONTENT_SID = 'HX' + '1'.repeat(32);
  process.env.TWILIO_WHATSAPP_VERIFY_CONTENT_SID = 'HX' + '2'.repeat(32);
  const recipient = '+525500000001';
  await sendChannel('whatsapp', 'Tu codigo es 123456.', { recipient, verification: true, code: '123456' });
  await sendChannel('whatsapp', 'AIRE+: US AQI 125.', { recipient });
  assert.deepEqual(state.twilio.map(request => ({
    sid: request.ContentSid, values: JSON.parse(request.ContentVariables), body: request.Body,
  })), [
    { sid: process.env.TWILIO_WHATSAPP_VERIFY_CONTENT_SID, values: { 1: '123456' }, body: undefined },
    { sid: process.env.TWILIO_WHATSAPP_CONTENT_SID, values: { 1: 'AIRE+: US AQI 125.' }, body: undefined },
  ]);
});
