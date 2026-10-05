// Inventory: the editable rentals catalog and date-based availability.
// Pure functions (no storage, no network) so they can be tested anywhere.

const ID_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const str = (v, n) => (v == null ? '' : String(v)).trim().slice(0, n);
export const MAX_RANGE_DAYS = 62;

// Statuses that keep rentals out of the warehouse on their dates
const HOLDING = ['booked', 'delivered', 'completed'];

export function addDay(ymd, n = 1) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
}

// Groups saved from the admin replace the ones in data/catalog.json; settings always come from the file.
export function liveCatalog(base, savedGroups) {
  const groups = Array.isArray(savedGroups) ? savedGroups : (base.groups || []).map(g => ({
    ...g, items: g.items.map(it => ({ qty: null, hidden: false, ...it }))
  }));
  return { settings: base.settings || {}, groups };
}

// What customers see: hidden items and empty groups removed, owned counts not exposed.
export function publicGroups(groups, avail) {
  return groups.map(g => ({
    cat: g.cat, name: g.name, sub: g.sub,
    items: g.items.filter(it => !it.hidden).map(it => {
      const out = { id: it.id, name: it.name, desc: it.desc, price: it.price };
      if (avail && avail[it.id] && avail[it.id].available !== null) out.available = Math.max(0, avail[it.id].available);
      return out;
    })
  })).filter(g => g.items.length);
}

export function indexGroups(groups) {
  const byId = {}, byName = {};
  for (const g of groups || []) for (const it of g.items) { byId[it.id] = it; byName[it.name.toLowerCase()] = it; }
  return { byId, byName };
}

// Validates a catalog sent from the admin page. Throws with a readable message on bad input.
export function cleanGroups(input) {
  if (!Array.isArray(input)) throw new Error('Catalog must be a list of groups.');
  const seen = new Set();
  const groups = input.slice(0, 100).map((g, gi) => {
    const name = str(g && g.name, 120);
    if (!name) throw new Error(`Group ${gi + 1} needs a name.`);
    const items = (Array.isArray(g.items) ? g.items : []).slice(0, 300).map(it => {
      const id = str(it.id, 60).toLowerCase();
      const iname = str(it.name, 200);
      if (!iname) throw new Error(`An item in "${name}" is missing its name.`);
      if (!ID_RE.test(id)) throw new Error(`"${iname}" has an invalid id.`);
      if (seen.has(id)) throw new Error(`Two items share the id "${id}".`);
      seen.add(id);
      const price = Math.round(Number(it.price) * 100) / 100;
      if (!Number.isFinite(price) || price < 0) throw new Error(`"${iname}" needs a price of $0 or more.`);
      const q = it.qty === null || it.qty === '' || it.qty === undefined ? null : Number(it.qty);
      if (q !== null && (!Number.isInteger(q) || q < 0 || q > 100000)) throw new Error(`"${iname}": quantity owned must be a whole number (or blank for not tracked).`);
      return { id, name: iname, desc: str(it.desc, 300), price, qty: q, hidden: !!it.hidden };
    });
    return { cat: str(g.cat, 60) || 'Other', name, sub: str(g.sub, 300), items };
  });
  return groups;
}

// The date span an order keeps its rentals out: delivery day through pickup day.
export function orderSpan(o) {
  const ev = o.event || {}, del = o.delivery || {}, pick = o.pickup || {};
  const from = isDate(del.date) ? del.date : ev.date;
  if (!isDate(from)) return null;
  let to = isDate(pick.date) ? pick.date : (isDate(ev.endDate) ? ev.endDate : ev.date);
  if (!isDate(to) || to < from) to = from;
  if (daysBetween(from, to) > MAX_RANGE_DAYS) to = addDay(from, MAX_RANGE_DAYS);
  return { from, to };
}

/**
 * How many of each tracked item are free across [from, to].
 * orders: stored orders; holds: pending online checkouts { id, from, to, items:[{id,qty}], expires }.
 * Returns { [itemId]: { owned, booked, available, holders:[{ orderId, number, name, qty, from, to, pending }] } }
 * where booked is the busiest single day in the range.
 */
export function availability(groups, orders, holds, from, to, { excludeId = '', nowMs = Date.now() } = {}) {
  // Usage is counted for every item; owned/available are null for items whose quantity isn't tracked
  const tracked = {};
  for (const g of groups) for (const it of g.items) tracked[it.id] = it.qty === undefined ? null : it.qty;
  const perDay = {}; // itemId -> { date: qty }
  const holders = {};
  const add = (id, qty, span, who) => {
    if (!(id in tracked) || !qty) return;
    const s = span.from > from ? span.from : from, e = span.to < to ? span.to : to;
    if (s > e) return;
    const days = perDay[id] = perDay[id] || {};
    for (let d = s; d <= e; d = addDay(d)) days[d] = (days[d] || 0) + qty;
    (holders[id] = holders[id] || []).push({ ...who, qty, from: span.from, to: span.to });
  };
  for (const o of orders) {
    if (o.id === excludeId || !HOLDING.includes(o.status)) continue;
    const span = orderSpan(o);
    if (!span) continue;
    const qtyById = {};
    for (const it of o.items || []) if (it.id) qtyById[it.id] = (qtyById[it.id] || 0) + (it.qty || 0);
    for (const id in qtyById) add(id, qtyById[id], span, { orderId: o.id, number: o.number, name: (o.customer || {}).name || '', status: o.status });
  }
  for (const h of holds || []) {
    if (!h || h.expires <= nowMs || h.id === excludeId) continue;
    for (const it of h.items || []) add(it.id, it.qty, { from: h.from, to: h.to }, { orderId: h.id, number: 'Checkout in progress', name: '', pending: true });
  }
  const out = {};
  for (const id in tracked) {
    const booked = Math.max(0, ...Object.values(perDay[id] || {}));
    out[id] = { owned: tracked[id], booked, available: tracked[id] === null ? null : tracked[id] - booked, holders: holders[id] || [] };
  }
  return out;
}

// Validates a cart from the browser against the live catalog and returns priced lines.
// Prices always come from the catalog, never from the browser.
export function priceCart(items, index) {
  if (!Array.isArray(items) || !items.length) throw new Error('Your cart is empty.');
  return items.map(({ id, qty }) => {
    const it = index.byId[id];
    const q = Number(qty);
    if (!it || it.hidden) throw new Error('An item in your cart is no longer available. Please refresh the page.');
    if (!Number.isInteger(q) || q < 1 || q > 1000) throw new Error('Invalid quantity for ' + it.name + '.');
    return { id, name: it.name, price: it.price, qty: q, total: Math.round(it.price * q * 100) / 100 };
  });
}

// Checks a cart [{id, qty}] against availability; returns readable problems (empty when everything fits).
export function shortages(lines, avail, index) {
  const want = {};
  for (const l of lines) want[l.id] = (want[l.id] || 0) + l.qty;
  const problems = [];
  for (const id in want) {
    const a = avail[id];
    if (a && a.available !== null && want[id] > a.available) {
      const name = (index.byId[id] || {}).name || id;
      problems.push(a.available > 0 ? `Only ${a.available} × ${name} available on that date.` : `${name} is booked on that date.`);
    }
  }
  return problems;
}
