// POST /.netlify/functions/create-checkout -> { url } (Stripe Checkout)
// Requires the STRIPE_SECRET_KEY environment variable, set in Netlify (never in this code).
const { json, quoteDelivery, priceCart, totals, cents, S } = require('../lib/shared.js');

const clip = (s, n = 490) => String(s == null ? '' : s).slice(0, n);
const money = n => '$' + n.toFixed(2);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !S.delivery.confirmed) {
    return json(503, { error: 'Online checkout is being set up. Please call (228) 243-7493 or request a quote to book.' });
  }

  let b;
  try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Bad request' }); }
  const c = b.customer || {}, a = b.address || {}, d = b.details || {};

  // Basic validation
  if (!c.name || !c.email || !c.phone) return json(400, { error: 'Name, email and phone are required.' });
  if (!/^\S+@\S+\.\S+$/.test(c.email)) return json(400, { error: 'Please enter a valid email address.' });
  if (!a.street || !a.city || !a.state || !a.zip) return json(400, { error: 'Please enter the full event address.' });
  if (!b.agree) return json(400, { error: 'Please agree to the rental terms.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.eventDate || '')) return json(400, { error: 'Please choose your event date.' });
  const earliest = new Date(); earliest.setHours(0, 0, 0, 0); earliest.setDate(earliest.getDate() + S.minLeadDays);
  if (new Date(b.eventDate + 'T12:00:00') < earliest) return json(400, { error: `Online bookings need at least ${S.minLeadDays} days' notice. Please call us for sooner dates.` });
  const payMode = b.payMode === 'full' ? 'full' : 'deposit';

  let lines, quote;
  try {
    lines = priceCart(b.items);
    const fullAddress = `${a.street}, ${a.city}, ${a.state} ${a.zip}`;
    quote = await quoteDelivery(fullAddress);
    if (!quote.ok) return json(422, { error: quote.error });
  } catch (e) {
    return json(400, { error: e.message || 'Could not price your order.' });
  }
  const t = totals(lines, quote.fee);
  const dateLabel = new Date(b.eventDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

  // Stripe Checkout Session (form-encoded REST call, no SDK needed)
  const p = new URLSearchParams();
  const site = process.env.URL || 'https://bbhpremierevents.com';
  p.append('mode', 'payment');
  p.append('success_url', `${site}/deposit-thanks.html?session_id={CHECKOUT_SESSION_ID}`);
  p.append('cancel_url', `${site}/book.html?canceled=1`);
  p.append('customer_email', c.email);
  p.append('billing_address_collection', 'required');

  let i = 0;
  const addLine = (name, amount, qty = 1, description) => {
    p.append(`line_items[${i}][price_data][currency]`, 'usd');
    p.append(`line_items[${i}][price_data][product_data][name]`, name);
    if (description) p.append(`line_items[${i}][price_data][product_data][description]`, description);
    p.append(`line_items[${i}][price_data][unit_amount]`, String(cents(amount)));
    p.append(`line_items[${i}][quantity]`, String(qty));
    i++;
  };
  if (payMode === 'full') {
    for (const l of lines) addLine(l.name, l.price, l.qty);
    if (t.delivery > 0) addLine(`Delivery, setup & pickup (${Math.round(quote.miles)} mi)`, t.delivery);
    if (t.tax > 0) addLine(`Sales tax (${S.taxRatePercent}%)`, t.tax);
  } else {
    addLine(`Deposit — Rental order for ${dateLabel}`, t.deposit, 1,
      `Order total ${money(t.total)}. Remaining balance ${money(t.balance)} due ${S.balanceDueDays} days before your event. Deposits are non-refundable.`);
  }

  const itemsText = lines.map(l => `${l.qty}x ${l.name}`).join('; ');
  const meta = {
    event_date: b.eventDate, pay_mode: payMode, customer_name: c.name, phone: c.phone,
    event_address: `${a.street}, ${a.city}, ${a.state} ${a.zip}`, miles: String(quote.miles),
    items_subtotal: money(t.subtotal), delivery_fee: money(t.delivery), sales_tax: money(t.tax),
    order_total: money(t.total), paid_now: money(payMode === 'full' ? t.total : t.deposit),
    balance_due: money(payMode === 'full' ? 0 : t.balance),
    event_type: d.eventType, guests: d.guests, delivery_window: d.deliveryWindow, pickup_window: d.pickupWindow,
    surface: d.surface, power: d.power, items: itemsText, notes: d.notes
  };
  // Exact item ids for the admin order list, split so each value stays under Stripe's 500-character limit
  let chunk = '', n = 0;
  for (const pair of lines.map(l => `${l.id}:${l.qty}`)) {
    if (chunk && chunk.length + pair.length + 1 > 480) { meta['cart_' + (++n)] = chunk; chunk = ''; }
    if (n >= 8) break;
    chunk += (chunk ? ',' : '') + pair;
  }
  if (chunk) meta['cart_' + (++n)] = chunk;
  for (const [k, v] of Object.entries(meta)) {
    if (v == null || v === '') continue;
    p.append(`metadata[${k}]`, clip(v));
    p.append(`payment_intent_data[metadata][${k}]`, clip(v));
  }
  p.append('payment_intent_data[description]', clip(`BBH Premier — ${dateLabel} — ${c.name} — ${payMode === 'full' ? 'paid in full' : 'deposit'}`));

  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: p.toString()
  });
  const session = await r.json();
  if (!r.ok) {
    console.error('Stripe error', session && session.error && session.error.message);
    return json(502, { error: 'Payment page could not be opened. Please try again or call (228) 243-7493.' });
  }
  return json(200, { url: session.url, totals: t });
};
