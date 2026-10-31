import { createHash } from 'node:crypto';
import { HttpError, fetchJson } from './http.js';

function setting(name) { return (process.env[name] || '').trim(); }

export const CHANNELS = Object.freeze(['telegram', 'sms', 'whatsapp', 'email']);
export const CHANNEL_NAMES = Object.freeze({
  telegram: 'Telegram', sms: 'SMS', whatsapp: 'WhatsApp', email: 'Correo',
});
const phone = /^\+[1-9]\d{7,14}$/;
const email = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function normalizeContact(channel, value) {
  if (!CHANNELS.includes(channel)) throw new HttpError('Selecciona un canal válido.');
  if (typeof value !== 'string' || value.length > 254)
    throw new HttpError('El contacto debe ser un texto válido.');
  const contact = value.trim();
  if (channel === 'telegram' && /^-?\d{5,20}$/.test(contact)) return contact;
  if (channel === 'email' && email.test(contact)) return contact.toLowerCase();
  if (channel === 'sms' && phone.test(contact)) return contact;
  if (channel === 'whatsapp' && phone.test(contact.replace(/^whatsapp:/, '')))
    return 'whatsapp:' + contact.replace(/^whatsapp:/, '');
  throw new HttpError(channel === 'telegram'
    ? 'Introduce tu ID numérico de Telegram; el nombre de usuario no es un chat ID.'
    : channel === 'email' ? 'Introduce un correo electrónico válido.'
      : 'Usa el formato internacional, por ejemplo +525512345678, sin espacios.');
}

export function maskContact(contact) {
  if (contact.includes('@')) {
    const [name, domain] = contact.split('@');
    return name.slice(0, 2) + '•••@' + domain;
  }
  return '••••' + contact.slice(-4);
}

export function providerStatus() {
  const twilio = /^AC[0-9a-f]{32}$/i.test(setting('TWILIO_ACCOUNT_SID')) &&
    !!setting('TWILIO_AUTH_TOKEN');
  return {
    telegram: /^\d+:[A-Za-z0-9_-]+$/.test(setting('TELEGRAM_BOT_TOKEN')),
    sms: twilio && phone.test(setting('TWILIO_SMS_FROM')),
    whatsapp: twilio && /^whatsapp:\+[1-9]\d{7,14}$/.test(setting('TWILIO_WHATSAPP_FROM')),
    email: !!setting('SENDGRID_API_KEY') && email.test(setting('EMAIL_FROM')),
  };
}

export function providerDetails() {
  const ready = providerStatus();
  return Object.fromEntries(CHANNELS.map(channel => [channel, {
    configured: ready[channel],
    message: ready[channel]
      ? 'Remitente configurado. Confirma tu contacto con un código.'
      : ({
        telegram: 'Falta TELEGRAM_BOT_TOKEN.',
        sms: 'Revisa TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN y TWILIO_SMS_FROM.',
        whatsapp: 'Revisa las credenciales Twilio y TWILIO_WHATSAPP_FROM.',
        email: 'Falta SENDGRID_API_KEY o EMAIL_FROM con un remitente verificado.',
      })[channel],
  }]));
}

function twilioAuthorization() {
  return 'Basic ' + Buffer.from(setting('TWILIO_ACCOUNT_SID') + ':' +
    setting('TWILIO_AUTH_TOKEN')).toString('base64');
}

const connections = new Map();
const connectionKeys = {
  telegram: () => [setting('TELEGRAM_BOT_TOKEN')],
  twilio: () => [setting('TWILIO_ACCOUNT_SID'), setting('TWILIO_AUTH_TOKEN')],
};

function connectionKey(service) {
  return service + ':' + createHash('sha256').update(JSON.stringify(connectionKeys[service]())).digest('hex');
}

function savedConnection(service) {
  const entry = connections.get(connectionKey(service));
  return entry?.until > Date.now() ? entry.value : null;
}

async function connectionCheck(service, work) {
  const key = connectionKey(service), existing = connections.get(key);
  if (existing?.until > Date.now()) return existing.value;
  if (existing?.promise) return existing.promise;
  const entry = {};
  entry.promise = (async () => {
    let value;
    try { value = await work(); }
    catch (error) {
      value = { state: 'error', message: error instanceof HttpError
        ? error.message : 'El proveedor no respondió. Intenta comprobar la conexión más tarde.' };
    }
    entry.value = { ...value, checkedAt: new Date().toISOString() };
    entry.until = Date.now() + (value.state === 'ready' ? 300000 : 30000);
    entry.promise = null;
    return entry.value;
  })();
  connections.set(key, entry);
  return entry.promise;
}

function rememberTwilioError(code) {
  connections.set(connectionKey('twilio'), {
    until: Date.now() + 30000,
    value: { state: 'error', code, checkedAt: new Date().toISOString(), message: twilioError(code) },
  });
}

export function clearProviderConnections() { connections.clear(); }

export function providerConnections() {
  const configured = providerStatus();
  return Object.fromEntries(CHANNELS.map(channel => [channel,
    !configured[channel] ? { state: 'unconfigured', message: providerDetails()[channel].message }
      : channel === 'email' ? { state: 'configured',
        message: 'SendGrid configurado. El código de correo comprueba la clave, el remitente y la recepción.' }
        : savedConnection(channel === 'telegram' ? 'telegram' : 'twilio') ||
          { state: 'configured', message: 'Variables cargadas. Pulsa Comprobar conexión para validar las credenciales.' },
  ]));
}

export async function telegramBotInfo() {
  if (!providerStatus().telegram)
    throw new HttpError('El servicio todavía no tiene un bot de Telegram configurado.', 503);
  return connectionCheck('telegram', async () => {
    const { response, data } = await fetchJson(
      'https://api.telegram.org/bot' + setting('TELEGRAM_BOT_TOKEN') + '/getMe');
    if (!response.ok || !data.ok) return {
      state: 'error', message: 'No se pudo comprobar el bot de AIRE+. Su administrador debe revisar el token de Telegram.',
    };
    const username = data.result?.username;
    if (!data.result?.is_bot || typeof username !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username))
      return { state: 'error', message: 'Telegram no devolvió una dirección válida para el bot de AIRE+.' };
    return { state: 'ready', username, botUrl: 'https://t.me/' + username,
      message: 'Credenciales del bot comprobadas. Inicia el chat antes de pedir un código.' };
  });
}

export async function diagnoseProviders() {
  const configured = providerStatus(), checks = [];
  if (configured.telegram) checks.push(telegramBotInfo());
  if (configured.sms || configured.whatsapp) checks.push(connectionCheck('twilio', async () => {
    const { response, data } = await fetchJson(
      'https://api.twilio.com/2010-04-01/Accounts/' + setting('TWILIO_ACCOUNT_SID') + '.json', {
        headers: { Authorization: twilioAuthorization() },
      });
    if (!response.ok) {
      const code = Number(data.code || response.status);
      return { state: 'error', code, message: twilioError(code) };
    }
    if (data.sid !== setting('TWILIO_ACCOUNT_SID') || data.status !== 'active')
      return { state: 'error', message: 'La cuenta de Twilio no está activa o no corresponde a las credenciales configuradas.' };
    // Never forward the account response: it can include the account Auth Token.
    const trial = data.type === 'Trial';
    return { state: 'ready', trial,
      message: trial
        ? 'Credenciales de Twilio comprobadas. Cuenta de prueba (Trial): revisa el remitente asignado a cada destinatario y las plantillas permitidas. Las restricciones pueden impedir códigos y avisos personalizados de AIRE+.'
        : 'Credenciales de Twilio comprobadas. El envío todavía depende del remitente, el destinatario y las restricciones de la cuenta.' };
  }));
  await Promise.all(checks);
  return providerConnections();
}

export function deliveryLabel(status) {
  return ({
    sending: 'Enviando', accepted: 'Aceptado por el proveedor',
    queued: 'En cola', sending_provider: 'En proceso', sent: 'Enviado; entrega sin confirmar',
    delivered: 'Entregado', read: 'Leído', failed: 'Falló',
    undelivered: 'No entregado', canceled: 'Cancelado',
  })[status] || 'Pendiente de confirmar';
}

export function twilioError(code) {
  return ({
    20003: 'Twilio rechazó las credenciales (código 20003). El administrador debe revisar el Account SID y el Auth Token reales de la misma cuenta y volver a desplegar.',
    21608: 'La cuenta de prueba de Twilio requiere verificar este destinatario.',
    21606: 'El remitente de Twilio no está habilitado para SMS.',
    21654: 'Twilio requiere un ContentSid de plantilla (código 21654). El administrador debe revisar la plantilla HX y sus variables; en Trial solo se admiten las opciones de prueba habilitadas en la consola.',
    21408: 'El destino geográfico no está habilitado en Twilio.',
    572002: 'El remitente de prueba no está asignado a este destinatario (código 572002). El administrador debe copiar de Twilio el número From de Messaging para ese receptor y actualizar el remitente del canal en Vercel.',
    63007: 'El remitente de WhatsApp o el número del Sandbox no es válido.',
    63015: 'Envía join y el código de tu Sandbox al número indicado por Twilio.',
    63016: 'WhatsApp requiere una plantilla aprobada fuera de la ventana de atención.',
  })[Number(code)] || 'Twilio no completó el envío' + (code ? ' (código ' + code + ').' : '.');
}

export function smsText(message) {
  const plain = message.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e\n]/g, '').replace(/\x60/g, "'").replace(/\s+/g, ' ').trim();
  let text = '', septets = 0;
  for (const character of plain) {
    const cost = '^{}\\[~]|'.includes(character) ? 2 : 1;
    if (septets + cost > 160) break;
    text += character;
    septets += cost;
  }
  return text;
}

export async function sendChannel(channel, message, options = {}) {
  if (!providerStatus()[channel])
    throw new HttpError(providerDetails()[channel]?.message || 'Canal no disponible.', 503);
  const contact = normalizeContact(channel, options.recipient);
  if (channel === 'telegram') {
    const { response, data } = await fetchJson(
      'https://api.telegram.org/bot' + setting('TELEGRAM_BOT_TOKEN') + '/sendMessage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: contact, text: message, disable_web_page_preview: true }),
      });
    if (!response.ok || !data.ok || !data.result?.message_id) {
      const code = Number(data.error_code || response.status);
      throw new HttpError(({
        401: 'El token del bot de Telegram no es válido.',
        400: 'Revisa tu ID de Telegram y envía /start al bot antes de pedir el código.',
        403: 'El bot está bloqueado o no tiene permiso para escribir en ese chat.',
        429: 'Telegram limitó los envíos; espera antes de repetir.',
      })[code] || 'Telegram no confirmó el mensaje.', 502);
    }
    return { channel, ok: true, id: String(data.result.message_id), status: 'accepted',
      message: 'Aceptado por Telegram. La API no confirma si fue leído.' };
  }
  if (channel === 'email') {
    const { response } = await fetchJson('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST', allowEmpty: true,
      headers: {
        'Content-Type': 'application/json', Authorization: 'Bearer ' + setting('SENDGRID_API_KEY'),
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: contact }] }],
        from: { email: setting('EMAIL_FROM'), name: 'AIRE+' },
        subject: options.verification ? 'Tu código de AIRE+' : 'AIRE+ · Aviso de calidad del aire',
        content: [{ type: 'text/plain', value: message }],
      }),
    });
    if (response.status !== 202) throw new HttpError(
      response.status === 401 || response.status === 403
        ? 'SendGrid rechazó la clave o el remitente. Verifica EMAIL_FROM en tu cuenta.'
        : 'SendGrid no aceptó el correo.', 502);
    return { channel, ok: true, id: response.headers?.get('x-message-id') || null,
      status: 'accepted', message: 'Aceptado por SendGrid; entrega al buzón sin confirmar.' };
  }
  const whatsapp = channel === 'whatsapp';
  const params = new URLSearchParams({
    From: setting(whatsapp ? 'TWILIO_WHATSAPP_FROM' : 'TWILIO_SMS_FROM'), To: contact,
  });
  const template = whatsapp && (options.verification
    ? setting('TWILIO_WHATSAPP_VERIFY_CONTENT_SID') || setting('TWILIO_WHATSAPP_CONTENT_SID')
    : setting('TWILIO_WHATSAPP_CONTENT_SID'));
  if (template) {
    if (!/^HX[0-9a-f]{32}$/i.test(template))
      throw new HttpError('El Content SID de WhatsApp debe comenzar con HX y ser válido.', 503);
    params.set('ContentSid', template);
    const value = options.verification && setting('TWILIO_WHATSAPP_VERIFY_CONTENT_SID')
      ? options.code : message;
    params.set('ContentVariables', JSON.stringify({ 1: value }));
  } else params.set('Body', channel === 'sms' ? smsText(message) : message);
  const { response, data } = await fetchJson(
    'https://api.twilio.com/2010-04-01/Accounts/' + setting('TWILIO_ACCOUNT_SID') + '/Messages.json', {
      method: 'POST', headers: {
        'Content-Type': 'application/x-www-form-urlencoded', Authorization: twilioAuthorization(),
      }, body: params.toString(),
    });
  if (!response.ok) {
    const code = Number(data.code || response.status);
    if (code === 20003 || response.status === 401) rememberTwilioError(code);
    const error = new HttpError(CHANNEL_NAMES[channel] + ': ' + twilioError(code), 502);
    error.provider = 'twilio';
    error.providerCode = code;
    throw error;
  }
  if (!/^SM[0-9a-f]{32}$/i.test(data.sid || ''))
    throw new HttpError('Twilio no devolvió un identificador de mensaje válido.', 502);
  return {
    channel, ok: !['failed', 'undelivered', 'canceled'].includes(data.status), id: data.sid,
    status: data.status || 'accepted', errorCode: data.error_code || null,
    message: ['failed', 'undelivered', 'canceled'].includes(data.status)
      ? twilioError(data.error_code)
      : 'Aceptado por Twilio (' + deliveryLabel(data.status) + '); consulta la entrega.',
  };
}

export async function pollDelivery(record) {
  if (!['sms', 'whatsapp'].includes(record.channel) ||
      !/^SM[0-9a-f]{32}$/i.test(record.providerId || '')) return record;
  const { response, data } = await fetchJson(
    'https://api.twilio.com/2010-04-01/Accounts/' + setting('TWILIO_ACCOUNT_SID') +
      '/Messages/' + record.providerId + '.json', {
        headers: { Authorization: twilioAuthorization() },
      });
  if (!response.ok) throw new HttpError('No se pudo consultar el estado de entrega en Twilio.', 502);
  const known = ['accepted', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'undelivered', 'canceled'];
  const status = known.includes(data.status) ? data.status : record.status;
  return { ...record, status, errorCode: data.error_code || null,
    message: ['failed', 'undelivered', 'canceled'].includes(status)
      ? twilioError(data.error_code) : deliveryLabel(status),
    updatedAt: new Date().toISOString() };
}
