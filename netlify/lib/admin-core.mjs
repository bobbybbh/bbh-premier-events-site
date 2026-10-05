// Back-office API: orders, payments, delivery schedule, inventory and crew access,
// plus the public catalog and online checkout (which both need live inventory).
// Uses only Web APIs (Request, Response, fetch, crypto.subtle) so the same code runs in a
// Netlify Function and can be tested in a browser. Storage is passed in as a small key/value store.
import { liveCatalog, publicGroups, indexGroups, cleanGroups, availability, shortages, priceCart, daysBetween, MAX_RANGE_DAYS } from './inventory.mjs';

const COOKIE = 'bbh_admin';
const SESSION_MS = { admin: 7 * 864e5, crew: 30 * 864e5 };
export const STATUSES = ['quote', 'booked', 'delivered', 'completed', 'canceled'];
const SYNC_EVERY_MS = 60 * 1000;

const enc = new TextEncoder();
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => atob(s.replace(/-/g, '+').replace(/_/g, '/'));

const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const str = (v, n = 200) => (v == null ? '' : String(v)).trim().slice(0, n);
const num = v => {
  const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
const round2 = n => Math.round(n * 100) / 100;
// Calendar dates in the business's time zone (Netlify servers run on UTC)
const ymdLocal = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
}

// ---------- Order shape ----------
// Every write goes through cleanOrder so stored records always have the same shape,
// whatever the browser sent.
function cleanStop(s = {}) {
  return {
    date: isDate(s.date) ? s.date : '',
    window: str(s.window, 80),
    crew: str(s.crew, 120),
    truck: str(s.truck, 60),
    notes: str(s.notes, 1000),
    done: s.done ? str(s.done, 40) : null,
    doneBy: str(s.doneBy, 60)
  };
}

export function cleanOrder(input = {}, existing = null) {
  const o = input || {};
  const c = o.customer || {}, e = o.event || {}, m = o.money || {}, su = o.setup || {};
  const items = (Array.isArray(o.items) ? o.items : []).slice(0, 200)
    .map(it => ({
      id: str(it.id, 60),
      name: str(it.name, 200),
      qty: Math.max(0, Math.min(100000, parseInt(it.qty, 10) || 0)),
      price: it.price === null || it.price === '' || it.price === undefined ? null : num(it.price)
    }))
    .filter(it => it.name && it.qty > 0);
  const payments = (Array.isArray(o.payments) ? o.payments : []).slice(0, 100)
    .map(p => ({
      id: str(p.id, 40) || Math.random().toString(36).slice(2, 10),
      date: isDate(p.date) ? p.date : '',
      amount: num(p.amount),
      method: str(p.method, 60),
      note: str(p.note, 200),
      ref: str(p.ref, 120)
    }))
    .filter(p => p.amount !== 0);
  return {
    id: existing ? existing.id : str(o.id, 120),
    number: existing ? existing.number : str(o.number, 40),
    source: existing ? existing.source : (o.source === 'online' ? 'online' : 'manual'),
    createdAt: existing ? existing.createdAt : (str(o.createdAt, 40) || new Date().toISOString()),
    updatedAt: new Date().toISOString(),
    status: STATUSES.includes(o.status) ? o.status : 'booked',
    customer: { name: str(c.name), email: str(c.email), phone: str(c.phone, 40), company: str(c.company) },
    event: {
      date: isDate(e.date) ? e.date : '',
      endDate: isDate(e.endDate) ? e.endDate : '',
      address: str(e.address, 300),
      type: str(e.type, 80),
      guests: str(e.guests, 40),
      miles: num(e.miles)
    },
    items,
    money: { subtotal: num(m.subtotal), discount: num(m.discount), delivery: num(m.delivery), tax: num(m.tax), total: num(m.total) },
    payMode: str(o.payMode, 40),
    payments,
    delivery: cleanStop(o.delivery),
    pickup: cleanStop(o.pickup),
    setup: { surface: str(su.surface, 120), power: str(su.power, 120) },
    customerNotes: str(o.customerNotes, 2000),
    adminNotes: str(o.adminNotes, 5000),
    history: (existing ? existing.history : Array.isArray(o.history) ? o.history : []).slice(-100)
  };
}

// Paid / balance are always computed, never stored.
export function withTotals(o) {
  const paid = round2(o.payments.reduce((a, p) => a + p.amount, 0));
  return { ...o, paid, balance: round2(o.money.total - paid) };
}

// ---------- Stripe -> orders ----------
function itemsFromMetadata(m, catalogIndex) {
  // New checkouts store exact item ids in cart_1, cart_2, ... ("id:qty,id:qty")
  const cart = Object.keys(m).filter(k => /^cart_\d+$/.test(k)).sort((a, b) => a.slice(5) - b.slice(5)).map(k => m[k]).join(',');
  if (cart) {
    return cart.split(',').filter(Boolean).map(pair => {
      const [id, q] = pair.split(':');
      const it = catalogIndex.byId[id];
      return { id, name: it ? it.name : id, qty: parseInt(q, 10) || 1, price: it ? it.price : null };
    });
  }
  // Older checkouts only have the readable list ("2x Name; 1x Name")
  return String(m.items || '').split(';').map(s => s.trim()).filter(Boolean).map(s => {
    const mm = s.match(/^(\d+)x\s+(.+)$/);
    const name = mm ? mm[2] : s, qty = mm ? parseInt(mm[1], 10) : 1;
    const it = catalogIndex.byName[name.toLowerCase()];
    return { id: it ? it.id : '', name, qty, price: it ? it.price : null };
  });
}

export function orderFromSession(s, catalogIndex) {
  const m = s.metadata || {};
  const cd = s.customer_details || {};
  const created = new Date((s.created || 0) * 1000);
  const ymd = ymdLocal(created.getTime());
  return cleanOrder({
    id: s.id,
    number: 'W' + ymd.slice(2).replace(/-/g, '') + '-' + s.id.slice(-4).toUpperCase(),
    source: 'online',
    createdAt: created.toISOString(),
    status: 'booked',
    customer: { name: m.customer_name || cd.name, email: cd.email || s.customer_email, phone: m.phone || cd.phone },
    event: { date: m.event_date, address: m.event_address, type: m.event_type, guests: m.guests, miles: m.miles },
    items: itemsFromMetadata(m, catalogIndex),
    money: { subtotal: m.items_subtotal, delivery: m.delivery_fee, tax: m.sales_tax, total: m.order_total },
    payMode: m.pay_mode === 'full' ? 'Paid in full' : 'Deposit',
    payments: [{ id: 'stripe', date: ymd, amount: (s.amount_total || 0) / 100, method: 'Card (online)', ref: typeof s.payment_intent === 'string' ? s.payment_intent : '' }],
    delivery: { date: m.event_date, window: m.delivery_window },
    pickup: { date: m.event_date, window: m.pickup_window },
    setup: { surface: m.surface, power: m.power },
    customerNotes: m.notes,
    history: [{ at: created.toISOString(), by: 'website', what: 'Booked online' }]
  });
}

// ---------- API ----------
// pricing: { quoteDelivery, totals, cents } from shared.js (only needed for checkout)
export function createBackOffice({ store, env, catalog: baseCatalog, pricing = {}, fetchImpl = (...a) => fetch(...a), now = () => Date.now() }) {
  const S = baseCatalog.settings || {};
  const secret = env.SESSION_SECRET || `${env.ADMIN_PASSWORD}|${env.CREW_PASSWORD || ''}|bbh-admin`;
  let keyPromise;
  const hmac = async data => {
    keyPromise = keyPromise || crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await keyPromise, enc.encode(data))));
  };

  async function makeToken(role) {
    const payload = b64url(enc.encode(JSON.stringify({ r: role, e: now() + SESSION_MS[role] })));
    return payload + '.' + await hmac(payload);
  }
  async function readToken(req) {
    const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
    if (!m) return null;
    const [payload, sig] = m[1].split('.');
    if (!payload || !sig || sig !== await hmac(payload)) return null;
    try {
      const t = JSON.parse(fromB64url(payload));
      return t.e > now() && SESSION_MS[t.r] ? t.r : null;
    } catch (e) { return null; }
  }
  const cookie = (token, maxAgeSec) => `${COOKIE}=${token}; Path=/api/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;

  // --- storage helpers ---
  const orderKey = id => 'orders/' + id.replace(/[^A-Za-z0-9_-]/g, '');
  async function allOrders() {
    const keys = await store.list('orders/');
    const rows = await Promise.all(keys.map(k => store.get(k)));
    return rows.filter(Boolean);
  }
  async function saveOrder(o) { await store.set(orderKey(o.id), o); return o; }

  async function getCatalog() {
    const saved = await store.get('catalog');
    return liveCatalog(baseCatalog, saved && saved.groups);
  }
  // Pending online checkouts hold their rentals until paid (then they become orders) or expired.
  const holdKey = id => 'holds/' + id.replace(/[^A-Za-z0-9_-]/g, '');
  async function activeHolds() {
    const keys = await store.list('holds/');
    const rows = await Promise.all(keys.map(k => store.get(k)));
    const live = [];
    await Promise.all(rows.map((h, i) => {
      if (h && h.expires > now()) { live.push(h); return null; }
      return store.delete(keys[i]); // tidy up expired holds
    }));
    return live;
  }
  async function availabilityFor(from, to, excludeId) {
    const [cat, orders, holds] = await Promise.all([getCatalog(), allOrders(), activeHolds()]);
    return availability(cat.groups, orders, holds, from, to, { excludeId, nowMs: now() });
  }

  // Pull paid website checkouts from Stripe into the order list (new ones only; admin edits are never overwritten).
  async function syncStripe(force) {
    if (!env.STRIPE_SECRET_KEY) return { skipped: 'no Stripe key' };
    const meta = (await store.get('meta/sync')) || {};
    if (!force && meta.at && now() - meta.at < SYNC_EVERY_MS) return { skipped: 'recent' };
    const since = meta.since ? meta.since - 86400 : 0; // 1-day overlap is harmless: existing orders are skipped
    let after = '', added = 0, newest = meta.since || 0;
    const catalogIndex = indexGroups((await getCatalog()).groups);
    for (let page = 0; page < 20; page++) {
      const url = `https://api.stripe.com/v1/checkout/sessions?limit=100&status=complete&created[gte]=${since}` + (after ? `&starting_after=${after}` : '');
      const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
      const data = await r.json();
      if (!r.ok) throw new Error('Stripe: ' + ((data.error && data.error.message) || r.status));
      for (const s of data.data || []) {
        newest = Math.max(newest, s.created || 0);
        if (!s.metadata || !s.metadata.event_date) continue; // not a website booking
        if (s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') continue;
        if (!(await store.get(orderKey(s.id)))) {
          await saveOrder(orderFromSession(s, catalogIndex));
          added++;
        }
        await store.delete(holdKey(s.id)); // the order now holds the rentals
      }
      if (!data.has_more || !data.data.length) break;
      after = data.data[data.data.length - 1].id;
    }
    await store.set('meta/sync', { at: now(), since: newest });
    return { added };
  }
  async function trySync(force) {
    try { return await syncStripe(force); } catch (e) { console.error(e); return { error: e.message }; }
  }

  // Crew see what they need on site, nothing about money.
  function stopFor(o, type, role) {
    const s = o[type];
    const stop = {
      type, orderId: o.id, number: o.number, status: o.status,
      date: s.date, window: s.window, crew: s.crew, truck: s.truck, notes: s.notes, done: s.done, doneBy: s.doneBy,
      customer: { name: o.customer.name, phone: o.customer.phone, company: o.customer.company },
      address: o.event.address, eventDate: o.event.date, eventType: o.event.type, guests: o.event.guests,
      items: o.items.map(i => ({ name: i.name, qty: i.qty })),
      setup: o.setup, customerNotes: o.customerNotes
    };
    if (role === 'admin') stop.balance = withTotals(o).balance;
    return stop;
  }

  function newManualId() {
    const d = ymdLocal(now()).slice(2).replace(/-/g, '');
    const r = Math.random().toString(36).slice(2, 6).toUpperCase();
    return { id: 'm_' + d + '_' + r, number: 'P' + d + '-' + r };
  }

  async function handle(req) {
    try {
      if (!env.ADMIN_PASSWORD) return json(503, { error: 'The admin area is not set up yet. Add ADMIN_PASSWORD in Netlify → Site configuration → Environment variables, then redeploy.' });
      const url = new URL(req.url);
      const parts = url.pathname.replace(/^\/api\/admin\/?/, '').split('/').filter(Boolean);
      const method = req.method;
      const body = async () => { try { return await req.json(); } catch (e) { return {}; } };

      // Changes must come from the admin page (blocks cross-site form posts).
      if (method !== 'GET' && req.headers.get('x-bbh-admin') !== '1') return json(403, { error: 'Forbidden' });

      if (parts[0] === 'login' && method === 'POST') {
        const { password } = await body();
        const given = await hmac('pw:' + String(password || ''));
        let role = null;
        if (given === await hmac('pw:' + env.ADMIN_PASSWORD)) role = 'admin';
        else if (env.CREW_PASSWORD && given === await hmac('pw:' + env.CREW_PASSWORD)) role = 'crew';
        if (!role) {
          await new Promise(r => setTimeout(r, 700)); // slow down guessing
          return json(401, { error: 'Wrong password.' });
        }
        return json(200, { role }, { 'Set-Cookie': cookie(await makeToken(role), SESSION_MS[role] / 1000) });
      }
      if (parts[0] === 'logout') return json(200, { ok: true }, { 'Set-Cookie': cookie('', 0) });

      const role = await readToken(req);
      if (!role) return json(401, { error: 'Please log in.' });
      if (parts[0] === 'me') return json(200, { role });

      // ----- Schedule (crew + admin) -----
      if (parts[0] === 'schedule' && method === 'GET') {
        const from = url.searchParams.get('from'), to = url.searchParams.get('to');
        if (!isDate(from) || !isDate(to) || to < from) return json(400, { error: 'Bad date range' });
        const sync = await trySync(false);
        const stops = [];
        for (const o of await allOrders()) {
          if (o.status === 'canceled' || o.status === 'quote') continue;
          for (const type of ['delivery', 'pickup']) {
            const d = o[type].date;
            if (d && d >= from && d <= to) stops.push(stopFor(o, type, role));
          }
        }
        stops.sort((a, b) => (a.date + a.window).localeCompare(b.date + b.window));
        return json(200, { stops, sync });
      }
      if (parts[0] === 'schedule' && parts[1] && parts[2] === 'done' && method === 'POST') {
        const { stop, done, by } = await body();
        if (stop !== 'delivery' && stop !== 'pickup') return json(400, { error: 'Bad stop' });
        const o = await store.get(orderKey(parts[1]));
        if (!o) return json(404, { error: 'Order not found' });
        o[stop].done = done ? new Date(now()).toISOString() : null;
        o[stop].doneBy = done ? str(by, 60) || role : '';
        if (o.status !== 'canceled') {
          if (stop === 'delivery') {
            if (done && o.status === 'booked') o.status = 'delivered';
            if (!done && o.status === 'delivered') o.status = 'booked';
          } else {
            if (done) o.status = 'completed';
            else if (o.status === 'completed') o.status = o.delivery.done ? 'delivered' : 'booked';
          }
        }
        o.updatedAt = new Date(now()).toISOString();
        o.history = (o.history || []).concat({ at: o.updatedAt, by: o[stop].doneBy || role, what: `${stop === 'delivery' ? 'Delivery' : 'Pickup'} ${done ? 'marked done' : 'un-marked'}` }).slice(-100);
        await saveOrder(o);
        return json(200, { ok: true, status: o.status });
      }

      // ----- Everything below is admin only -----
      if (role !== 'admin') return json(403, { error: 'Crew logins can only see the schedule.' });

      // ----- Inventory -----
      if (parts[0] === 'catalog' && method === 'GET') {
        const cat = await getCatalog();
        return json(200, { settings: cat.settings, groups: cat.groups });
      }
      if (parts[0] === 'catalog' && method === 'PUT') {
        let groups;
        try { groups = cleanGroups((await body()).groups); } catch (e) { return json(400, { error: e.message }); }
        await store.set('catalog', { groups, updatedAt: new Date(now()).toISOString() });
        return json(200, { settings: S, groups });
      }
      if (parts[0] === 'availability' && method === 'GET') {
        const from = url.searchParams.get('from'), to = url.searchParams.get('to') || from;
        if (!isDate(from) || !isDate(to) || to < from || daysBetween(from, to) > MAX_RANGE_DAYS) return json(400, { error: 'Bad date range' });
        return json(200, { from, to, items: await availabilityFor(from, to, url.searchParams.get('exclude') || '') });
      }

      if (parts[0] === 'orders') {
        if (!parts[1] && method === 'GET') {
          const sync = await trySync(url.searchParams.get('sync') === '1');
          const orders = (await allOrders()).map(withTotals).sort((a, b) => (b.event.date || '').localeCompare(a.event.date || ''));
          return json(200, { orders, sync });
        }
        if (!parts[1] && method === 'POST') {
          const ids = newManualId();
          const o = cleanOrder({ ...(await body()), ...ids, source: 'manual' });
          o.history = [{ at: o.createdAt, by: 'admin', what: 'Created' }];
          await saveOrder(o);
          return json(201, { order: withTotals(o) });
        }
        if (parts[1] && method === 'PUT') {
          const existing = await store.get(orderKey(parts[1]));
          if (!existing) return json(404, { error: 'Order not found' });
          const o = cleanOrder(await body(), existing);
          const what = [];
          if (o.status !== existing.status) what.push(`Status ${existing.status} → ${o.status}`);
          const paidBefore = existing.payments.reduce((a, p) => a + p.amount, 0), paidNow = o.payments.reduce((a, p) => a + p.amount, 0);
          if (round2(paidNow) !== round2(paidBefore)) what.push(`Payments ${round2(paidBefore).toFixed(2)} → ${round2(paidNow).toFixed(2)}`);
          o.history = o.history.concat({ at: o.updatedAt, by: 'admin', what: what.join('; ') || 'Edited' }).slice(-100);
          await saveOrder(o);
          return json(200, { order: withTotals(o) });
        }
        if (parts[1] && method === 'DELETE') {
          const existing = await store.get(orderKey(parts[1]));
          if (!existing) return json(404, { error: 'Order not found' });
          if (existing.source === 'online') return json(400, { error: 'Online bookings can\'t be deleted (they would come back from Stripe). Set the status to Canceled instead.' });
          await store.delete(orderKey(parts[1]));
          return json(200, { ok: true });
        }
      }
      return json(404, { error: 'Not found' });
    } catch (e) {
      console.error(e);
      return json(500, { error: 'Something went wrong: ' + e.message });
    }
  }

  // ---------- Public: rentals for the booking page (with what's left on a date) ----------
  async function publicCatalog(req) {
    try {
      const date = new URL(req.url).searchParams.get('date');
      const cat = await getCatalog();
      let avail = null;
      if (isDate(date)) {
        await trySync(false); // so very recent online bookings count
        avail = await availabilityFor(date, date);
      }
      return json(200, { settings: cat.settings, groups: publicGroups(cat.groups, avail), date: isDate(date) ? date : null });
    } catch (e) {
      console.error(e);
      return json(500, { error: 'Rentals could not be loaded.' });
    }
  }

  // ---------- Public: online checkout -> Stripe ----------
  async function checkout(req) {
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const key = env.STRIPE_SECRET_KEY;
    if (!key || !S.delivery || !S.delivery.confirmed) {
      return json(503, { error: 'Online checkout is being set up. Please call (228) 243-7493 or request a quote to book.' });
    }
    let b;
    try { b = await req.json(); } catch (e) { return json(400, { error: 'Bad request' }); }
    b = b || {};
    const c = b.customer || {}, a = b.address || {}, d = b.details || {};

    // Basic validation
    if (!c.name || !c.email || !c.phone) return json(400, { error: 'Name, email and phone are required.' });
    if (!/^\S+@\S+\.\S+$/.test(c.email)) return json(400, { error: 'Please enter a valid email address.' });
    if (!a.street || !a.city || !a.state || !a.zip) return json(400, { error: 'Please enter the full event address.' });
    if (!b.agree) return json(400, { error: 'Please agree to the rental terms.' });
    if (!isDate(b.eventDate)) return json(400, { error: 'Please choose your event date.' });
    const earliest = new Date(now()); earliest.setHours(0, 0, 0, 0); earliest.setDate(earliest.getDate() + S.minLeadDays);
    if (new Date(b.eventDate + 'T12:00:00') < earliest) return json(400, { error: `Online bookings need at least ${S.minLeadDays} days' notice. Please call us for sooner dates.` });
    const payMode = b.payMode === 'full' ? 'full' : 'deposit';

    try {
      const cat = await getCatalog();
      const index = indexGroups(cat.groups);
      let lines;
      try { lines = priceCart(b.items, index); } catch (e) { return json(400, { error: e.message }); }

      // Availability: count bookings paid moments ago and other checkouts in progress
      await trySync(true);
      const avail = await availabilityFor(b.eventDate, b.eventDate);
      const problems = shortages(lines, avail, index);
      if (problems.length) {
        const left = {};
        for (const id in avail) if (avail[id].available !== null) left[id] = Math.max(0, avail[id].available);
        return json(409, { error: problems.join(' ') + ' Please update your cart.', available: left });
      }

      const fullAddress = `${a.street}, ${a.city}, ${a.state} ${a.zip}`;
      const quote = await pricing.quoteDelivery(fullAddress);
      if (!quote.ok) return json(422, { error: quote.error });
      const t = pricing.totals(lines, quote.fee);
      const cents = pricing.cents;
      const money = n => '$' + n.toFixed(2);
      const clip = (s, n = 490) => String(s == null ? '' : s).slice(0, n);
      const dateLabel = new Date(b.eventDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

      // Stripe Checkout Session (form-encoded REST call, no SDK needed)
      const p = new URLSearchParams();
      const site = env.URL || 'https://bbhpremierevents.com';
      const expiresAt = Math.floor(now() / 1000) + 31 * 60; // Stripe minimum is 30 minutes; the hold lasts as long
      p.append('mode', 'payment');
      p.append('success_url', `${site}/deposit-thanks.html?session_id={CHECKOUT_SESSION_ID}`);
      p.append('cancel_url', `${site}/book.html?canceled=1`);
      p.append('customer_email', c.email);
      p.append('billing_address_collection', 'required');
      p.append('expires_at', String(expiresAt));

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
        event_address: fullAddress, miles: String(quote.miles),
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

      const r = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: p.toString()
      });
      const session = await r.json();
      if (!r.ok) {
        console.error('Stripe error', session && session.error && session.error.message);
        return json(502, { error: 'Payment page could not be opened. Please try again or call (228) 243-7493.' });
      }
      // Hold the rentals while the customer pays
      await store.set(holdKey(session.id), {
        id: session.id, from: b.eventDate, to: b.eventDate, expires: expiresAt * 1000,
        items: lines.map(l => ({ id: l.id, qty: l.qty }))
      });
      return json(200, { url: session.url, totals: t });
    } catch (e) {
      console.error(e);
      return json(500, { error: 'Something went wrong opening checkout. Please try again or call (228) 243-7493.' });
    }
  }

  return { handle, publicCatalog, checkout, getCatalog, syncStripe: trySync };
}

// Kept for the admin function and the local test bench
export const createApi = opts => createBackOffice(opts).handle;
