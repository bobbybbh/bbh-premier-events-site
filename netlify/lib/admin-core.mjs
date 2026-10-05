// Back-office API: orders, payments, delivery schedule and crew access.
// Uses only Web APIs (Request, Response, fetch, crypto.subtle) so the same code runs in a
// Netlify Function and can be tested in a browser. Storage is passed in as a small key/value store.

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

function indexCatalog(catalog) {
  const byId = {}, byName = {};
  for (const g of (catalog && catalog.groups) || []) for (const it of g.items) { byId[it.id] = it; byName[it.name.toLowerCase()] = it; }
  return { byId, byName };
}

// ---------- API ----------
export function createApi({ store, env, catalog, fetchImpl = (...a) => fetch(...a), now = () => Date.now() }) {
  const catalogIndex = indexCatalog(catalog);
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

  // Pull paid website checkouts from Stripe into the order list (new ones only; admin edits are never overwritten).
  async function syncStripe(force) {
    if (!env.STRIPE_SECRET_KEY) return { skipped: 'no Stripe key' };
    const meta = (await store.get('meta/sync')) || {};
    if (!force && meta.at && now() - meta.at < SYNC_EVERY_MS) return { skipped: 'recent' };
    const since = meta.since ? meta.since - 86400 : 0; // 1-day overlap is harmless: existing orders are skipped
    let after = '', added = 0, newest = meta.since || 0;
    for (let page = 0; page < 20; page++) {
      const url = `https://api.stripe.com/v1/checkout/sessions?limit=100&status=complete&created[gte]=${since}` + (after ? `&starting_after=${after}` : '');
      const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
      const data = await r.json();
      if (!r.ok) throw new Error('Stripe: ' + ((data.error && data.error.message) || r.status));
      for (const s of data.data || []) {
        newest = Math.max(newest, s.created || 0);
        if (!s.metadata || !s.metadata.event_date) continue; // not a website booking
        if (s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') continue;
        if (await store.get(orderKey(s.id))) continue;
        await saveOrder(orderFromSession(s, catalogIndex));
        added++;
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

  return async function handle(req) {
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
  };
}
