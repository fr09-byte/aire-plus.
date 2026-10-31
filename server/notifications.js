import { HttpError, fetchJson } from './http.js';

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
  const e = process.env;
  const twilio = /^AC[0-9a-f]{32}$/i.test(e.TWILIO_ACCOUNT_SID || '') &&
    !!e.TWILIO_AUTH_TOKEN;
  return {
    telegram: /^\d+:[A-Za-z0-9_-]+$/.test(e.TELEGRAM_BOT_TOKEN || ''),
    sms: twilio && phone.test(e.TWILIO_SMS_FROM || ''),
    whatsapp: twilio && /^whatsapp:\+[1-9]\d{7,14}$/.test(e.TWILIO_WHATSAPP_FROM || ''),
    email: !!e.SENDGRID_API_KEY && email.test(e.EMAIL_FROM || ''),
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
  return 'Basic ' + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' +
    process.env.TWILIO_AUTH_TOKEN).toString('base64');
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
    20003: 'Twilio rechazó las credenciales del servidor.',
    21608: 'La cuenta de prueba de Twilio requiere verificar este destinatario.',
    21606: 'El remitente de Twilio no está habilitado para SMS.',
    21408: 'El destino geográfico no está habilitado en Twilio.',
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
      'https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
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
        'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.SENDGRID_API_KEY,
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: contact }] }],
        from: { email: process.env.EMAIL_FROM, name: 'AIRE+' },
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
    From: process.env[whatsapp ? 'TWILIO_WHATSAPP_FROM' : 'TWILIO_SMS_FROM'], To: contact,
  });
  const template = whatsapp && (options.verification
    ? process.env.TWILIO_WHATSAPP_VERIFY_CONTENT_SID || process.env.TWILIO_WHATSAPP_CONTENT_SID
    : process.env.TWILIO_WHATSAPP_CONTENT_SID);
  if (template) {
    if (!/^HX[0-9a-f]{32}$/i.test(template))
      throw new HttpError('El Content SID de WhatsApp debe comenzar con HX y ser válido.', 503);
    params.set('ContentSid', template);
    const value = options.verification && process.env.TWILIO_WHATSAPP_VERIFY_CONTENT_SID
      ? options.code : message;
    params.set('ContentVariables', JSON.stringify({ 1: value }));
  } else params.set('Body', channel === 'sms' ? smsText(message) : message);
  const { response, data } = await fetchJson(
    'https://api.twilio.com/2010-04-01/Accounts/' + process.env.TWILIO_ACCOUNT_SID + '/Messages.json', {
      method: 'POST', headers: {
        'Content-Type': 'application/x-www-form-urlencoded', Authorization: twilioAuthorization(),
      }, body: params.toString(),
    });
  if (!response.ok) throw new HttpError(twilioError(data.code || response.status), 502);
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
    'https://api.twilio.com/2010-04-01/Accounts/' + process.env.TWILIO_ACCOUNT_SID +
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
