// Shared pricing logic for the booking functions.
// Prices and settings live in data/catalog.json so the server never trusts prices sent by the browser.
const catalog = require('../../data/catalog.json');

const S = catalog.settings;
const ITEMS = {};
for (const g of catalog.groups) for (const it of g.items) ITEMS[it.id] = it;

const round2 = n => Math.round(n * 100) / 100;
const cents = n => Math.round(n * 100);

function json(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// Address -> coordinates (US Census geocoder: free, no key).
async function geocode(address) {
  const url = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=' + encodeURIComponent(address);
  const r = await fetch(url);
  if (!r.ok) throw new Error('geocoder unavailable');
  const data = await r.json();
  const m = data && data.result && data.result.addressMatches && data.result.addressMatches[0];
  if (!m) return null;
  return { lat: m.coordinates.y, lon: m.coordinates.x, matched: m.matchedAddress };
}

function straightLineMiles(a, b) {
  const R = 3958.8, rad = d => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Driving miles from the warehouse (OSRM routing; falls back to straight line x 1.3).
async function drivingMiles(to) {
  const from = S.warehouse;
  try {
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`);
    if (r.ok) {
      const d = await r.json();
      if (d.routes && d.routes[0]) return d.routes[0].distance / 1609.344;
    }
  } catch (e) { /* fall through */ }
  return straightLineMiles(from, to) * 1.3;
}

function deliveryFee(miles) {
  const d = S.delivery;
  const billable = Math.max(0, miles - d.freeMiles) * (d.roundTrip ? 2 : 1);
  return round2(Math.max(d.minimumFee, billable * d.ratePerMile));
}

async function quoteDelivery(address) {
  const geo = await geocode(address);
  if (!geo) return { ok: false, error: "We couldn't find that address. Check the street, city and ZIP, or call (228) 243-7493." };
  const miles = round2(await drivingMiles(geo));
  if (miles > S.delivery.maxMiles) return { ok: false, error: `That address is about ${Math.round(miles)} miles away. Please call (228) 243-7493 for a custom quote.` };
  return { ok: true, miles, fee: deliveryFee(miles), matched: geo.matched };
}

// Validates the cart against the catalog and returns priced lines.
function priceCart(items) {
  if (!Array.isArray(items) || !items.length) throw new Error('Your cart is empty.');
  const lines = [];
  for (const { id, qty } of items) {
    const it = ITEMS[id];
    const q = Number(qty);
    if (!it) throw new Error('An item in your cart is no longer available. Please refresh the page.');
    if (!Number.isInteger(q) || q < 1 || q > 1000) throw new Error('Invalid quantity for ' + it.name + '.');
    lines.push({ id, name: it.name, price: it.price, qty: q, total: round2(it.price * q) });
  }
  return lines;
}

function totals(lines, delivery) {
  const subtotal = round2(lines.reduce((a, l) => a + l.total, 0));
  const taxable = subtotal + (S.taxDelivery ? delivery : 0);
  const tax = round2(taxable * S.taxRatePercent / 100);
  const total = round2(subtotal + delivery + tax);
  const deposit = round2(Math.min(total, Math.max(S.depositMinimum, total * S.depositPercent / 100)));
  return { subtotal, delivery, tax, total, deposit, balance: round2(total - deposit) };
}

module.exports = { catalog, S, ITEMS, round2, cents, json, quoteDelivery, priceCart, totals };
