import { HttpError, reply, fail, checkOrigin, readJson } from '../server/http.js';
import { session, touchSession, requireSessionSecret, clientFingerprint } from '../server/session.js';
import { requireStorage, rateLimit } from '../server/storage.js';
import { telegramBotInfo, diagnoseProviders } from '../server/notifications.js';
import {
  validatePreferences, legacyInput, assertVerified, requestVerification, verifyContact,
  getSubscription, saveSubscription, dispatch, subscriptionStatus, deliveryHistory,
} from '../server/subscriptions.js';
export { providerStatus, sendChannel } from '../server/notifications.js';
export { validatePreferences, dispatch, checkAllSubscriptions } from '../server/subscriptions.js';

export default async function handler(req, res) {
  try {
    checkOrigin(req, res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (!['GET', 'POST'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST, OPTIONS');
      throw new HttpError('Utiliza GET o POST.', 405);
    }
    const id = session(req, res);
    if (req.method === 'GET') return reply(res, 200, await subscriptionStatus(id));
    const input = legacyInput(await readJson(req));
    if (input.action === 'telegram_info') return reply(res, 200, await telegramBotInfo());
    if (input.action === 'diagnostics') {
      await diagnoseProviders();
      return reply(res, 200, await subscriptionStatus(id));
    }
    requireStorage();
    requireSessionSecret();
    if (input.action === 'request_verification')
      return reply(res, 200, await requestVerification(req, id, input));
    if (input.action === 'verify_contact')
      return reply(res, 200, await verifyContact(req, id, input));
    await rateLimit('actions:' + id, 30, 60);
    if (input.action === 'subscribe') {
      if (input.consent !== true) throw new HttpError('Confirma que deseas recibir estos avisos.');
      const preferences = validatePreferences(input);
      await assertVerified(id, preferences);
      await saveSubscription(id, preferences);
      touchSession(req, res, id);
      return reply(res, 200, await subscriptionStatus(id));
    }
    if (input.action === 'unsubscribe') {
      await saveSubscription(id, null);
      return reply(res, 200, await subscriptionStatus(id));
    }
    if (input.action === 'test') {
      await rateLimit('tests:' + clientFingerprint(req), 6, 3600);
      const preferences = validatePreferences(input);
      await assertVerified(id, preferences);
      return reply(res, 200, await dispatch(preferences, { test: true, id }));
    }
    if (input.action === 'check') {
      const subscription = await getSubscription(id);
      if (!subscription?.active) return reply(res, 200, { state: 'inactive', results: [] });
      if (subscription.schemaVersion !== 4)
        throw new HttpError('Actualiza tus alertas y confirma tus contactos para continuar.', 409);
      return reply(res, 200, await dispatch(validatePreferences(subscription), { id }));
    }
    if (input.action === 'delivery_status') {
      await rateLimit('delivery:' + id, 10, 60);
      return reply(res, 200, { deliveries: await deliveryHistory(id, true) });
    }
    throw new HttpError('Acción no válida.');
  } catch (error) {
    return fail(res, error);
  }
}
