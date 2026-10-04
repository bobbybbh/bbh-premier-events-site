// GET /.netlify/functions/delivery-quote?address=...  -> { ok, miles, fee }
const { json, quoteDelivery, S } = require('../lib/shared.js');

exports.handler = async (event) => {
  const address = ((event.queryStringParameters || {}).address || '').trim();
  if (address.length < 8) return json(400, { ok: false, error: 'Enter the full event address.' });
  try {
    const q = await quoteDelivery(address);
    return json(q.ok ? 200 : 422, { ...q, enabled: S.delivery.confirmed });
  } catch (e) {
    return json(502, { ok: false, error: 'Delivery calculator is temporarily unavailable. Please try again or call (228) 243-7493.' });
  }
};
