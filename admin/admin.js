// BBH Premier Events — back office: orders, delivery schedule, reports. Talks to /api/admin/*.
(function () {
  'use strict';

  // ---------- Helpers ----------
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const round2 = n => Math.round(n * 100) / 100;
  const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? round2(n) : 0; };
  const money = n => (n < 0 ? '-' : '') + '$' + Math.abs(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money0 = n => (n < 0 ? '-' : '') + '$' + Math.round(Math.abs(n || 0)).toLocaleString('en-US');
  const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const today = () => iso(new Date());
  const parse = s => new Date(s + 'T12:00:00');
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
  const fmtDate = (s, o) => s ? parse(s).toLocaleDateString('en-US', o || { weekday: 'short', month: 'short', day: 'numeric' }) : '—';
  const fmtStamp = s => s ? new Date(s).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const clone = o => JSON.parse(JSON.stringify(o));
  const mapsLink = a => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(a);
  const getPath = (o, k) => k.split('.').reduce((a, p) => (a == null ? a : a[p]), o);
  const setPath = (o, k, v) => { const ps = k.split('.'); let t = o; ps.slice(0, -1).forEach(p => { t = t[p] = t[p] || {}; }); t[ps[ps.length - 1]] = v; };
  const store = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };

  const STATUS = { quote: 'Quote', booked: 'Booked', delivered: 'Out on site', completed: 'Completed', canceled: 'Canceled' };

  let role = null, orders = null, catalog = { groups: [], settings: {} }, S = {};
  let filter = 'upcoming', current = null, dirty = false;
  let schDate = today(), schMode = 'day', stops = [];
  let currentView = '', invGroups = null, invAvail = {}, invDirty = false, invDate = today(), invOpen = '';

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3200);
  }
  function notice(msg) { const n = $('#notice'); n.textContent = msg || ''; n.hidden = !msg; }

  async function api(path, opts = {}) {
    const r = await fetch('/api/admin/' + path, {
      method: opts.method || 'GET', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-BBH-Admin': '1' },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    let data = {};
    try { data = await r.json(); } catch (e) { /* empty body */ }
    if (r.status === 401 && path !== 'login') { showLogin(); throw new Error(data.error || 'Please log in.'); }
    if (!r.ok) throw new Error(data.error || 'Error ' + r.status + (r.status === 404 ? ' (is the site deployed with its functions?)' : ''));
    return data;
  }

  // ---------- Login ----------
  function showLogin() {
    role = null; orders = null;
    $('#app').hidden = true; $('#login').hidden = false; $('#editor').hidden = true;
    $('#loginPw').value = ''; $('#loginPw').focus();
  }
  function showApp() {
    $('#login').hidden = true; $('#app').hidden = false;
    $('#roleLabel').textContent = role === 'admin' ? 'Owner' : 'Crew';
    $$('[data-admin]').forEach(el => { el.hidden = role !== 'admin'; });
    if (role === 'admin') loadCatalog().catch(() => { /* falls back to the catalog file */ });
    route();
  }
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#loginErr'); err.hidden = true;
    const btn = $('#loginForm button'); btn.disabled = true;
    try {
      role = (await api('login', { method: 'POST', body: { password: $('#loginPw').value } })).role;
      showApp();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    btn.disabled = false;
  });
  $('#logoutBtn').addEventListener('click', async () => { try { await api('logout', { method: 'POST' }); } catch (e) { /* ignore */ } showLogin(); });

  // ---------- Routing ----------
  function route() {
    const views = role === 'admin' ? ['orders', 'schedule', 'inventory', 'reports'] : ['schedule'];
    let v = location.hash.slice(1);
    if (!views.includes(v)) v = views[0];
    if (v !== 'inventory' && invDirty && currentView === 'inventory') {
      if (!confirm('You have unsaved inventory changes. Leave without saving?')) { history.replaceState(null, '', '#inventory'); return; }
      invDirty = false; invGroups = null;
    }
    currentView = v;
    $$('.view').forEach(s => { s.hidden = s.id !== 'view-' + v; });
    $$('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.view === v));
    if (v === 'orders') ensureOrders().then(renderOrders);
    if (v === 'schedule') loadSchedule();
    if (v === 'reports') ensureOrders().then(renderReports);
    if (v === 'inventory') loadInventory();
  }
  window.addEventListener('hashchange', () => { if (role) route(); });

  // ---------- Orders ----------
  async function loadOrders(force) {
    try {
      const data = await api('orders' + (force ? '?sync=1' : ''));
      orders = data.orders;
      const s = data.sync || {};
      if (s.error) notice("Couldn't check Stripe for new online bookings: " + s.error);
      else if (force && s.skipped === 'no Stripe key') notice('Online bookings can\'t be pulled in yet: STRIPE_SECRET_KEY isn\'t set in Netlify.');
      else notice('');
      if (s.added) toast(s.added + ' new online booking' + (s.added > 1 ? 's' : '') + ' added');
      else if (force && !s.error) toast('Up to date — no new online bookings');
    } catch (e) {
      if (!role) return;
      notice(e.message);
      orders = orders || [];
    }
    return orders;
  }
  const ensureOrders = () => orders ? Promise.resolve(orders) : loadOrders(false);

  function payState(o) {
    if (o.status === 'canceled' || !(o.money.total > 0)) return null;
    if (o.balance <= 0.004) return { cls: 'b-paid', text: 'Paid in full' };
    if (o.status === 'quote') return { cls: 'b-due', text: o.paid > 0 ? 'Paid ' + money0(o.paid) : 'Not paid' };
    const due = o.event.date ? addDays(o.event.date, -(S.balanceDueDays || 7)) : '';
    const overdue = o.status === 'completed' || (!!due && today() > due);
    return { cls: overdue ? 'b-overdue' : 'b-due', text: (overdue ? 'Overdue ' : 'Owes ') + money0(o.balance), due };
  }
  const itemsSummary = o => o.items.map(i => i.qty + '× ' + i.name).join(', ') || '<span class="muted">No rentals listed</span>';
  const lastDay = o => o.event.endDate || o.event.date || '';

  function matches(o, q) {
    if (!q) return true;
    const digits = q.replace(/\D/g, '');
    const hay = [o.number, o.customer.name, o.customer.email, o.customer.company, o.event.address, o.event.type, o.items.map(i => i.name).join(' ')].join(' ').toLowerCase();
    return hay.includes(q.toLowerCase()) || (digits.length >= 3 && (o.customer.phone || '').replace(/\D/g, '').includes(digits));
  }

  function renderOrders() {
    if (!orders) return;
    const q = $('#orderSearch').value.trim(), t = today();
    const live = o => o.status !== 'canceled' && o.status !== 'quote';
    const tests = {
      upcoming: o => live(o) && (lastDay(o) >= t || !o.event.date || (o.status !== 'completed' && o.event.date >= addDays(t, -2))),
      quote: o => o.status === 'quote',
      balance: o => live(o) && o.balance > 0.004,
      past: o => live(o) && lastDay(o) && lastDay(o) < t,
      canceled: o => o.status === 'canceled',
      all: () => true
    };
    const asc = ['upcoming', 'quote', 'balance'].includes(filter);
    const list = orders.filter(tests[filter]).filter(o => matches(o, q))
      .sort((a, b) => (asc ? 1 : -1) * ((a.event.date || '9999') + a.number).localeCompare((b.event.date || '9999') + b.number));
    const sum = list.reduce((a, o) => a + (o.status === 'canceled' ? 0 : o.money.total), 0);
    $('#orderCount').textContent = list.length + ' order' + (list.length === 1 ? '' : 's') + (list.length ? ' · ' + money0(sum) + ' total' : '');
    $('#orderList').innerHTML = list.length ? list.map(o => {
      const p = payState(o);
      return `<button class="orow" type="button" data-id="${esc(o.id)}">
        <span class="date"><b>${esc(fmtDate(o.event.date))}</b><span class="muted small">${o.event.date ? parse(o.event.date).getFullYear() : 'No date'}</span></span>
        <span class="cust"><b>${esc(o.customer.name || '(no name)')}</b><span class="muted small">${esc(o.number)}${o.customer.company ? ' · ' + esc(o.customer.company) : ''}</span></span>
        <span class="items">${o.items.length ? esc(o.items.map(i => i.qty + '× ' + i.name).join(', ')) : itemsSummary(o)}</span>
        <span class="amt">${money(o.money.total)}</span>
        <span>${p ? `<span class="badge ${p.cls}">${esc(p.text)}</span>` : ''}</span>
        <span><span class="badge b-${o.status}">${STATUS[o.status]}</span>${o.source === 'online' ? ' <span class="badge b-online" title="Booked on the website">Web</span>' : ''}</span>
      </button>`;
    }).join('') : `<div class="empty">${orders.length ? 'No orders match.' : 'No orders yet. Online bookings show up here automatically, or click “+ New order” for phone and quote orders.'}</div>`;
  }
  $('#orderList').addEventListener('click', e => { const b = e.target.closest('.orow'); if (b) openEditor(orders.find(o => o.id === b.dataset.id)); });
  $('#orderSearch').addEventListener('input', renderOrders);
  $('#orderFilters').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    filter = b.dataset.f;
    $$('#orderFilters button').forEach(x => x.classList.toggle('on', x === b));
    renderOrders();
  });
  $('#syncBtn').addEventListener('click', async () => {
    const b = $('#syncBtn'); b.disabled = true;
    await loadOrders(true); renderOrders(); b.disabled = false;
  });
  $('#newOrderBtn').addEventListener('click', () => openEditor(null));

  // ---------- Order editor ----------
  const blankOrder = () => ({
    status: 'booked', customer: {}, event: {}, items: [],
    money: { subtotal: 0, discount: 0, delivery: 0, tax: 0, total: 0 },
    payments: [], delivery: {}, pickup: {}, setup: {}, customerNotes: '', adminNotes: '', history: []
  });

  function fillCatalogSelect() {
    $('#edAddItem').innerHTML = '<option value="">+ Add rental from catalog…</option>' + catalog.groups.map(g =>
      `<optgroup label="${esc(g.name)}">${g.items.map(it => `<option value="${esc(it.id)}">${esc(it.name)} — ${money(it.price)}${it.hidden ? ' (not on website)' : ''}</option>`).join('')}</optgroup>`).join('');
  }

  function openEditor(o) {
    current = o ? clone(o) : blankOrder();
    dirty = false;
    const isNew = !o;
    $('#edTitle').textContent = isNew ? 'New order' : (current.customer.name || 'Order');
    $('#edSub').textContent = isNew ? 'Phone, quote or purchase-order booking' :
      `${current.number} · ${current.source === 'online' ? 'Booked online' : 'Entered by hand'} ${fmtStamp(current.createdAt)}`;
    $('#edStatus').value = current.status;
    $$('#edForm [data-k]').forEach(inp => {
      const v = getPath(current, inp.dataset.k);
      inp.value = inp.hasAttribute('data-num') ? (v ? Number(v).toFixed(2) : '') : (v == null ? '' : v);
    });
    $('#edDelete').hidden = isNew || current.source === 'online';
    $('#edErr').hidden = true;
    $('#payDate').value = today(); $('#payAmount').value = ''; $('#payNote').value = '';
    $('#edAvail').hidden = true;
    renderItems(); renderPayments(); renderDone(); updateMap(); moneyNote();
    $('#edHistory').innerHTML = (current.history || []).slice().reverse().map(h => `<li>${esc(fmtStamp(h.at))} — ${esc(h.what)} <span class="muted">(${esc(h.by)})</span></li>`).join('');
    $('#edHistoryWrap').hidden = isNew;
    $('#editor').hidden = false;
    document.body.style.overflow = 'hidden';
    $('#editor').scrollTop = 0;
    if (isNew) $('[data-k="customer.name"]').focus();
  }
  function closeEditor(force) {
    if (!force && dirty && !confirm('Close without saving your changes?')) return;
    $('#editor').hidden = true; document.body.style.overflow = ''; current = null;
  }
  $$('#editor [data-close]').forEach(b => b.addEventListener('click', () => closeEditor(false)));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#editor').hidden) closeEditor(false); });

  function setField(k, v) {
    setPath(current, k, v);
    const inp = $(`#edForm [data-k="${k}"]`);
    if (inp) inp.value = inp.hasAttribute('data-num') ? Number(v || 0).toFixed(2) : v;
  }

  // Totals follow whatever was changed: rentals -> subtotal -> tax -> total.
  function recalc(from) {
    const m = current.money;
    if (from === 'items') m.subtotal = round2(current.items.reduce((a, i) => a + i.qty * (i.price || 0), 0));
    if (['items', 'subtotal', 'discount', 'delivery'].includes(from)) {
      const taxable = Math.max(0, m.subtotal - m.discount) + (S.taxDelivery ? m.delivery : 0);
      m.tax = round2(taxable * (S.taxRatePercent || 0) / 100);
    }
    if (from !== 'total') m.total = round2(m.subtotal - m.discount + m.delivery + m.tax);
    ['subtotal', 'tax', 'total'].forEach(k => setField('money.' + k, m[k]));
    renderPaySum(); moneyNote();
  }
  function moneyNote() {
    const t = current.money.total;
    const dep = round2(Math.min(t, Math.max(S.depositMinimum || 0, t * (S.depositPercent || 0) / 100)));
    const due = current.event.date ? fmtDate(addDays(current.event.date, -(S.balanceDueDays || 7)), { month: 'short', day: 'numeric' }) : '';
    $('#edMoneyNote').textContent = t > 0 ? `Standard deposit: ${money(dep)} (${S.depositPercent}%, minimum ${money0(S.depositMinimum)})` + (due ? ` · Balance due by ${due}` : '') + ` · Tax rate ${S.taxRatePercent}%${S.taxDelivery ? ' incl. delivery' : ''}` : '';
  }

  $('#edForm').addEventListener('input', e => {
    const inp = e.target.closest('[data-k]'); if (!inp) return;
    dirty = true;
    const k = inp.dataset.k;
    if (inp.hasAttribute('data-num')) {
      setPath(current, k, num(inp.value));
      recalc(k.split('.')[1]);
      return;
    }
    const before = getPath(current, k);
    setPath(current, k, inp.value);
    if (k === 'event.date') {
      // Delivery and pickup follow the event date unless they were set to something else
      ['delivery', 'pickup'].forEach(s => { if (!current[s].date || current[s].date === before) setField(s + '.date', inp.value); });
      moneyNote();
    }
    if (k === 'event.address') updateMap();
    if (/\.(date|endDate)$/.test(k)) checkAvail();
  });
  $('#edForm').addEventListener('change', e => {
    // Tidy money inputs once the user leaves them
    if (e.target.matches('[data-num]')) e.target.value = num(e.target.value).toFixed(2);
  });
  $('#edStatus').addEventListener('change', e => { current.status = e.target.value; dirty = true; checkAvail(); });
  function updateMap() { const a = current.event.address; $('#edMap').hidden = !a; if (a) $('#edMap').href = mapsLink(a); }

  // Rentals
  // Warn (don't block) when this order would use more of something than is free on its dates
  function checkAvail() {
    clearTimeout(checkAvail.t);
    checkAvail.t = setTimeout(async () => {
      const box = $('#edAvail');
      if (!current) return;
      const ev = current.event || {}, from = current.delivery.date || ev.date;
      let to = current.pickup.date || ev.endDate || ev.date;
      const need = {};
      current.items.forEach(i => { if (i.id) need[i.id] = (need[i.id] || 0) + i.qty; });
      if (!from || !Object.keys(need).length || current.status === 'canceled') { box.hidden = true; return; }
      if (!to || to < from) to = from;
      try {
        const res = await api(`availability?from=${from}&to=${to}&exclude=${encodeURIComponent(current.id || '')}`);
        const msgs = Object.keys(need).filter(id => res.items[id] && res.items[id].available !== null && need[id] > res.items[id].available).map(id => {
          const a = res.items[id], name = (current.items.find(i => i.id === id) || {}).name || id;
          const others = a.holders.filter(h => !h.pending).map(h => h.number).join(', ');
          return `<li><b>${esc(name)}</b>: this order needs ${need[id]}, only ${Math.max(0, a.available)} of ${a.owned} free${others ? ` (also on ${esc(others)})` : ''}</li>`;
        });
        const span = from === to ? fmtDate(from) : fmtDate(from) + ' – ' + fmtDate(to);
        box.innerHTML = msgs.length ? `<b>⚠ Not enough on hand ${esc(span)}${current.status === 'quote' ? ' (if this quote is booked)' : ''}:</b><ul>${msgs.join('')}</ul>` : '';
        box.hidden = !msgs.length;
      } catch (e) { box.hidden = true; }
    }, 350);
  }

  function renderItems() {
    checkAvail();
    $('#edItems').innerHTML = (current.items.length ? `<div class="irow ihead"><span>Rental</span><span>Qty</span><span>Price each</span><span class="lt">Line total</span><span></span></div>` : '') +
      current.items.map((it, i) => `<div class="irow" data-i="${i}">
        <input data-f="name" value="${esc(it.name)}" placeholder="Description" aria-label="Rental name">
        <input data-f="qty" value="${it.qty}" inputmode="numeric" aria-label="Quantity">
        <input data-f="price" value="${it.price == null ? '' : Number(it.price).toFixed(2)}" inputmode="decimal" placeholder="—" aria-label="Price each">
        <span class="lt">${it.price == null ? '—' : money(it.qty * it.price)}</span>
        <button type="button" class="rm" aria-label="Remove">×</button></div>`).join('');
  }
  $('#edItems').addEventListener('input', e => {
    const row = e.target.closest('.irow'); if (!row || !e.target.dataset.f) return;
    e.stopPropagation(); dirty = true;
    const it = current.items[row.dataset.i], f = e.target.dataset.f;
    if (f === 'name') { it.name = e.target.value; return; }
    if (f === 'qty') it.qty = Math.max(0, parseInt(e.target.value, 10) || 0);
    if (f === 'price') it.price = e.target.value.trim() === '' ? null : num(e.target.value);
    row.querySelector('.lt').textContent = it.price == null ? '—' : money(it.qty * it.price);
    recalc('items');
    if (f === 'qty') checkAvail();
  });
  $('#edItems').addEventListener('click', e => {
    const b = e.target.closest('.rm'); if (!b) return;
    current.items.splice(b.closest('.irow').dataset.i, 1); dirty = true;
    renderItems(); recalc('items');
  });
  $('#edAddItem').addEventListener('change', e => {
    const id = e.target.value; e.target.value = ''; if (!id) return;
    let it = null; catalog.groups.forEach(g => g.items.forEach(x => { if (x.id === id) it = x; }));
    const existing = current.items.find(x => x.id === id);
    if (existing) existing.qty += 1; else current.items.push({ id, name: it.name, qty: 1, price: it.price });
    dirty = true; renderItems(); recalc('items');
  });
  $('#edAddCustom').addEventListener('click', () => {
    current.items.push({ id: '', name: '', qty: 1, price: 0 }); dirty = true;
    renderItems(); $('#edItems .irow:last-child input').focus();
  });
  $('#edCalcDelivery').addEventListener('click', async () => {
    const a = (current.event.address || '').trim();
    if (a.length < 8) { toast('Enter the full event address first'); return; }
    const b = $('#edCalcDelivery'); b.textContent = 'calculating…';
    try {
      const r = await fetch('/.netlify/functions/delivery-quote?address=' + encodeURIComponent(a));
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || 'Could not price delivery');
      current.event.miles = d.miles; dirty = true;
      setField('money.delivery', d.fee); recalc('delivery');
      toast(`${Math.round(d.miles)} miles from the warehouse → ${money(d.fee)}`);
    } catch (ex) { toast(ex.message); }
    b.textContent = 'calculate';
  });

  // Payments
  function renderPayments() {
    $('#edPayments').innerHTML = current.payments.length ? current.payments.map((p, i) => `<div class="prow" data-i="${i}">
      <span>${esc(fmtDate(p.date, { month: 'short', day: 'numeric', year: 'numeric' }))}</span>
      <span class="n">${money(p.amount)}</span>
      <span>${esc(p.method)}</span>
      <span class="note muted">${esc(p.note || p.ref || '')}</span>
      <button type="button" class="rm link" aria-label="Remove payment">×</button></div>`).join('') : '<p class="muted small">No payments yet.</p>';
    renderPaySum();
  }
  function renderPaySum() {
    const paid = round2(current.payments.reduce((a, p) => a + p.amount, 0));
    const bal = round2(current.money.total - paid);
    $('#edPaySum').innerHTML = `Paid <b>${money(paid)}</b> of ${money(current.money.total)} · ` +
      (bal > 0.004 ? `<b class="collect">Balance ${money(bal)}</b>` : bal < -0.004 ? `<b class="collect">Overpaid ${money(-bal)}</b>` : '<b style="color:var(--ok)">Paid in full</b>');
    $('#payAmount').placeholder = bal > 0.004 ? bal.toFixed(2) : 'Amount';
  }
  $('#edPayments').addEventListener('click', e => {
    const b = e.target.closest('.rm'); if (!b) return;
    const p = current.payments[b.closest('.prow').dataset.i];
    if (p.method === 'Card (online)' && !confirm('This is the online card payment from Stripe. Remove it from this order anyway?')) return;
    current.payments.splice(b.closest('.prow').dataset.i, 1); dirty = true; renderPayments();
  });
  $('#payAdd').addEventListener('click', () => {
    const raw = $('#payAmount').value.trim() || $('#payAmount').placeholder;
    let amt = num(raw);
    if (!amt) { toast('Enter the payment amount'); $('#payAmount').focus(); return; }
    const method = $('#payMethod').value;
    if (method === 'Refund') amt = -Math.abs(amt);
    current.payments.push({ id: Math.random().toString(36).slice(2, 10), date: $('#payDate').value || today(), amount: amt, method, note: $('#payNote').value.trim() });
    dirty = true;
    $('#payAmount').value = ''; $('#payNote').value = '';
    renderPayments();
  });

  function renderDone() {
    const tag = s => s.done ? `✓ done ${fmtStamp(s.done)}${s.doneBy ? ' by ' + s.doneBy : ''}` : '';
    $('#edDelDone').textContent = tag(current.delivery);
    $('#edPickDone').textContent = tag(current.pickup);
  }

  $('#edForm').addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#edErr'); err.hidden = true;
    if (!(current.customer.name || '').trim()) { err.textContent = 'Add the customer’s name.'; err.hidden = false; return; }
    if (current.status !== 'quote' && !current.event.date) { err.textContent = 'Add the event date (or set the status to Quote).'; err.hidden = false; return; }
    const btn = $('#edSave'); btn.disabled = true;
    try {
      const isNew = !current.id;
      const res = isNew ? await api('orders', { method: 'POST', body: current }) : await api('orders/' + encodeURIComponent(current.id), { method: 'PUT', body: current });
      if (isNew) orders.push(res.order); else orders[orders.findIndex(o => o.id === res.order.id)] = res.order;
      closeEditor(true);
      toast(isNew ? 'Order ' + res.order.number + ' created' : 'Saved');
      route();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    btn.disabled = false;
  });
  $('#edDelete').addEventListener('click', async () => {
    if (!confirm('Delete this order for good? (To keep a record, set the status to Canceled instead.)')) return;
    try {
      await api('orders/' + encodeURIComponent(current.id), { method: 'DELETE' });
      orders = orders.filter(o => o.id !== current.id);
      closeEditor(true); toast('Order deleted'); route();
    } catch (ex) { $('#edErr').textContent = ex.message; $('#edErr').hidden = false; }
  });

  // ---------- Schedule ----------
  async function loadSchedule() {
    $('#schDate').value = schDate;
    const to = schMode === 'week' ? addDays(schDate, 6) : schDate;
    $('#schTitle').textContent = schMode === 'week'
      ? fmtDate(schDate, { month: 'short', day: 'numeric' }) + ' – ' + fmtDate(to, { month: 'short', day: 'numeric', year: 'numeric' })
      : fmtDate(schDate, { weekday: 'long', month: 'long', day: 'numeric' }) + (schDate === today() ? ' · Today' : '');
    $('#schList').innerHTML = '<p class="muted">Loading…</p>';
    try {
      const data = await api(`schedule?from=${schDate}&to=${to}`);
      stops = data.stops;
      if (data.sync && data.sync.added) { orders = null; toast(data.sync.added + ' new online booking' + (data.sync.added > 1 ? 's' : '') + ' added'); }
      renderSchedule(to);
    } catch (e) { $('#schList').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  }

  function stopCard(s) {
    const isDel = s.type === 'delivery';
    const doneLabel = isDel ? 'Delivered' : 'Picked up';
    const other = s.eventDate && s.eventDate !== s.date ? ` (event ${fmtDate(s.eventDate)})` : '';
    const meta = [
      s.eventType || s.guests ? `<b>Event:</b> ${esc([s.eventType, s.guests ? s.guests + ' guests' : ''].filter(Boolean).join(' · '))}${esc(other)}` : (other ? `<b>Event:</b>${esc(other)}` : ''),
      s.setup && s.setup.surface ? `<b>Surface:</b> ${esc(s.setup.surface)}` : '',
      s.setup && s.setup.power ? `<b>Power:</b> ${esc(s.setup.power)}` : '',
      s.crew || s.truck ? `<b>Crew:</b> ${esc([s.crew, s.truck].filter(Boolean).join(' · truck '))}` : '<b>Crew:</b> <span class="muted">not assigned</span>',
      s.notes ? `<b>Crew notes:</b> ${esc(s.notes)}` : '',
      s.customerNotes ? `<b>Customer notes:</b> ${esc(s.customerNotes)}` : ''
    ].filter(Boolean).map(x => `<div class="meta">${x}</div>`).join('');
    return `<article class="stop ${s.type}${s.done ? ' done' : ''}">
      <div class="stop-top">
        <div><div class="stop-type">${isDel ? 'Delivery & setup' : 'Pickup & teardown'}</div><div class="stop-when">${esc(s.window || 'Time not set')}</div></div>
        <span class="muted small">${esc(s.number)}</span>
      </div>
      <div class="stop-name">${esc(s.customer.name)}${s.customer.company ? ` <span class="muted small">${esc(s.customer.company)}</span>` : ''}</div>
      <div class="meta">${s.customer.phone ? `<a href="tel:${esc(s.customer.phone.replace(/[^\d+]/g, ''))}">${esc(s.customer.phone)}</a> · ` : ''}${s.address ? `<a href="${mapsLink(s.address)}" target="_blank" rel="noopener">${esc(s.address)}</a>` : '<span class="muted">No address</span>'}</div>
      <ul>${s.items.map(i => `<li>${i.qty}× ${esc(i.name)}</li>`).join('') || '<li class="muted">No rentals listed</li>'}</ul>
      ${meta}
      ${isDel && s.balance > 0.004 ? `<div class="meta collect">Balance owed: ${money(s.balance)}</div>` : ''}
      <div class="stop-actions">
        ${s.done ? `<span class="small" style="color:var(--ok)">✓ ${doneLabel} ${esc(fmtStamp(s.done))}${s.doneBy ? ' by ' + esc(s.doneBy) : ''}</span> <button class="link small" data-undo="${esc(s.orderId)}" data-stop="${s.type}">Undo</button>`
          : `<button class="btn btn-gold btn-sm" data-done="${esc(s.orderId)}" data-stop="${s.type}">Mark ${doneLabel.toLowerCase()}</button>`}
        ${role === 'admin' ? `<button class="btn btn-outline btn-sm" data-open="${esc(s.orderId)}">Open order</button>` : ''}
      </div>
    </article>`;
  }

  function renderSchedule(to) {
    const days = [];
    for (let d = schDate; d <= to; d = addDays(d, 1)) days.push(d);
    const html = days.map(d => {
      const ds = stops.filter(s => s.date === d);
      const nDel = ds.filter(s => s.type === 'delivery').length, nPick = ds.length - nDel;
      const head = schMode === 'week' ? `<div class="day-head"><h3>${esc(fmtDate(d, { weekday: 'long', month: 'short', day: 'numeric' }))}</h3><span class="muted small">${nDel} deliver${nDel === 1 ? 'y' : 'ies'} · ${nPick} pickup${nPick === 1 ? '' : 's'}</span></div>`
        : `<p class="muted small">${nDel} deliver${nDel === 1 ? 'y' : 'ies'} · ${nPick} pickup${nPick === 1 ? '' : 's'}</p>`;
      if (!ds.length) return schMode === 'week' ? head + '<p class="muted small">Nothing scheduled.</p>' : '<div class="empty">Nothing scheduled for this day.</div>';
      return head + `<div class="stops">${ds.map(stopCard).join('')}</div>`;
    }).join('');
    $('#schList').innerHTML = html;
    // Route through today's open stops, starting and ending at the warehouse (Google allows 9 stops per link)
    const open = schMode === 'day' ? stops.filter(s => !s.done && s.address) : [];
    const wh = (S.warehouse && S.warehouse.address) || '';
    $('#routeBtn').hidden = !open.length;
    if (open.length) {
      $('#routeBtn').href = 'https://www.google.com/maps/dir/?api=1&origin=' + encodeURIComponent(wh) + '&destination=' + encodeURIComponent(wh) +
        '&waypoints=' + encodeURIComponent(open.slice(0, 9).map(s => s.address).join('|')) + '&travelmode=driving';
      $('#routeBtn').title = open.length > 9 ? 'Google Maps links fit 9 stops — the first 9 are included' : '';
    }
  }

  $('#schList').addEventListener('click', async e => {
    const open = e.target.closest('[data-open]');
    if (open) { await ensureOrders(); const o = orders.find(x => x.id === open.dataset.open); if (o) openEditor(o); return; }
    const b = e.target.closest('[data-done],[data-undo]'); if (!b) return;
    const done = !!b.dataset.done;
    let by = store.get('bbh_crew_name') || '';
    if (done && !by && role === 'crew') { by = (prompt('Your name (shown on the order):') || '').trim(); if (by) store.set('bbh_crew_name', by); }
    if (role === 'admin') by = by || 'Owner';
    b.disabled = true;
    try {
      await api(`schedule/${encodeURIComponent(b.dataset.done || b.dataset.undo)}/done`, { method: 'POST', body: { stop: b.dataset.stop, done, by } });
      orders = null; // statuses changed
      loadSchedule();
    } catch (ex) { toast(ex.message); b.disabled = false; }
  });
  $('#schDate').addEventListener('change', e => { if (e.target.value) { schDate = e.target.value; loadSchedule(); } });
  $('#schPrev').addEventListener('click', () => { schDate = addDays(schDate, schMode === 'week' ? -7 : -1); loadSchedule(); });
  $('#schNext').addEventListener('click', () => { schDate = addDays(schDate, schMode === 'week' ? 7 : 1); loadSchedule(); });
  $('#schToday').addEventListener('click', () => { schDate = today(); loadSchedule(); });
  $('#schMode').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    schMode = b.dataset.m; $$('#schMode button').forEach(x => x.classList.toggle('on', x === b)); loadSchedule();
  });
  $('#printBtn').addEventListener('click', () => window.print());

  // ---------- Inventory ----------
  async function loadCatalog() {
    const data = await api('catalog');
    catalog = data; S = data.settings || S;
    fillCatalogSelect();
    return data;
  }
  async function loadInventory() {
    $('#invDate').value = invDate;
    try {
      if (!invGroups) invGroups = clone((await loadCatalog()).groups);
      renderInventory();
      await loadInvAvail();
    } catch (e) { $('#invList').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  }
  async function loadInvAvail() {
    try { invAvail = (await api(`availability?from=${invDate}&to=${invDate}`)).items; } catch (e) { invAvail = {}; toast(e.message); }
    $$('#invList tr[data-i]').forEach(tr => updateAvailCell(tr));
    renderHolders();
  }
  function setInvDirty(on) { invDirty = on; $('#invDirty').hidden = !on; }
  const itemAt = tr => invGroups[tr.closest('[data-g]').dataset.g].items[tr.dataset.i];

  function availBadge(it) {
    if (it.qty === null || it.qty === undefined || it.qty === '') return '<span class="muted small">not counted</span>';
    const a = invAvail[it.id];
    const booked = a ? a.booked : 0, free = it.qty - booked;
    const cls = free <= 0 ? 'b-overdue' : free <= Math.max(1, Math.round(it.qty * 0.2)) ? 'b-due' : 'b-paid';
    return `<button type="button" class="badge ${cls} avail-btn" data-holders="${esc(it.id)}" title="${booked} booked">${free < 0 ? 'Overbooked by ' + (-free) : free + ' of ' + it.qty + ' free'}</button>`;
  }
  function updateAvailCell(tr) { const it = itemAt(tr); if (it) tr.querySelector('.av').innerHTML = availBadge(it); }

  function renderInventory() {
    const q = $('#invSearch').value.trim().toLowerCase();
    const cats = [...new Set(invGroups.map(g => g.cat).filter(Boolean))];
    $('#invCats').innerHTML = cats.map(c => `<option value="${esc(c)}">`).join('');
    const dateLbl = fmtDate(invDate, { month: 'short', day: 'numeric' });
    $('#invList').innerHTML = invGroups.map((g, gi) => {
      const rows = g.items.map((it, i) => ({ it, i })).filter(({ it }) => !q || (g.name + ' ' + it.name + ' ' + (it.desc || '')).toLowerCase().includes(q));
      if (q && !rows.length) return '';
      return `<div class="panel inv-group" data-g="${gi}">
        <div class="row inv-ghead">
          <label class="field"><span>Group</span><input data-gf="name" value="${esc(g.name)}"></label>
          <label class="field sm2"><span>Category</span><input data-gf="cat" list="invCats" value="${esc(g.cat)}"></label>
          <label class="field grow2"><span>Shown under the group name</span><input data-gf="sub" value="${esc(g.sub || '')}"></label>
          <button type="button" class="btn btn-danger btn-sm" data-delgroup ${g.items.length ? 'hidden' : ''}>Delete group</button>
        </div>
        <div class="table-wrap"><table class="inv-table"><thead><tr><th>Rental</th><th>Description</th><th class="n">Price</th><th class="n">Owned</th><th>${esc(dateLbl)}</th><th>On website</th><th></th></tr></thead><tbody>
        ${rows.map(({ it, i }) => `<tr data-i="${i}"${it.hidden ? ' class="hid"' : ''}>
          <td><input data-f="name" value="${esc(it.name)}" aria-label="Rental name"></td>
          <td><input data-f="desc" value="${esc(it.desc || '')}" aria-label="Description"></td>
          <td class="n"><input data-f="price" class="num" value="${Number(it.price).toFixed(2)}" inputmode="decimal" aria-label="Price"></td>
          <td class="n"><input data-f="qty" class="num sm" value="${it.qty === null || it.qty === undefined ? '' : it.qty}" inputmode="numeric" placeholder="—" aria-label="Quantity owned"></td>
          <td class="av">${availBadge(it)}</td>
          <td><input type="checkbox" data-f="shown" ${it.hidden ? '' : 'checked'} aria-label="Show on website"></td>
          <td><button type="button" class="rm" data-delitem aria-label="Delete ${esc(it.name)}">×</button></td>
        </tr>`).join('')}
        </tbody></table></div>
        <button type="button" class="btn btn-outline btn-sm" data-additem>+ Add rental</button>
      </div>`;
    }).join('') || '<div class="empty">No rentals match.</div>';
    renderHolders();
  }

  // Expandable "who has it" list under an item
  function renderHolders() {
    $$('#invList tr.holders').forEach(r => r.remove());
    if (!invOpen) return;
    const tr = $$('#invList tr[data-i]').find(r => itemAt(r).id === invOpen);
    if (!tr) return;
    const h = (invAvail[invOpen] || {}).holders || [];
    const row = document.createElement('tr'); row.className = 'holders';
    row.innerHTML = `<td colspan="7">${h.length ? h.map(x => x.pending
      ? `<div class="muted">${x.qty} in an online checkout in progress</div>`
      : `<div><button type="button" class="link" data-openorder="${esc(x.orderId)}">${esc(x.number)}</button> · ${esc(x.name)} · ${x.qty} · ${esc(fmtDate(x.from, { month: 'short', day: 'numeric' }))}${x.to !== x.from ? '–' + esc(fmtDate(x.to, { month: 'short', day: 'numeric' })) : ''} <span class="muted">(${esc(STATUS[x.status] || x.status)})</span></div>`).join('')
      : '<span class="muted">Not on any orders this day.</span>'}</td>`;
    tr.after(row);
  }

  $('#invList').addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.gf) { invGroups[t.closest('[data-g]').dataset.g][t.dataset.gf] = t.value; setInvDirty(true); return; }
    const tr = t.closest('tr[data-i]'); if (!tr || !t.dataset.f) return;
    const it = itemAt(tr);
    if (t.dataset.f === 'shown') { it.hidden = !t.checked; tr.classList.toggle('hid', it.hidden); }
    else if (t.dataset.f === 'price') it.price = num(t.value);
    else if (t.dataset.f === 'qty') { const v = t.value.trim(); it.qty = v === '' ? null : Math.max(0, parseInt(v, 10) || 0); updateAvailCell(tr); }
    else it[t.dataset.f] = t.value;
    setInvDirty(true);
  });
  $('#invList').addEventListener('change', e => { if (e.target.dataset.f === 'price') e.target.value = num(e.target.value).toFixed(2); });
  $('#invList').addEventListener('click', async e => {
    const t = e.target;
    const g = t.closest('[data-g]') ? invGroups[t.closest('[data-g]').dataset.g] : null;
    if (t.closest('[data-additem]')) {
      g.items.push({ id: '', name: '', desc: '', price: 0, qty: null, hidden: false });
      setInvDirty(true); renderInventory();
      $(`#invList [data-g="${t.closest('[data-g]').dataset.g}"] tr[data-i]:last-child input`).focus();
    } else if (t.closest('[data-delitem]')) {
      const it = itemAt(t.closest('tr'));
      if (it.id && !confirm(`Delete "${it.name}"? Past orders keep their record. (To stop offering it for now, uncheck "On website" instead.)`)) return;
      g.items.splice(t.closest('tr').dataset.i, 1); setInvDirty(true); renderInventory();
    } else if (t.closest('[data-delgroup]')) {
      invGroups.splice(t.closest('[data-g]').dataset.g, 1); setInvDirty(true); renderInventory();
    } else if (t.closest('[data-holders]')) {
      const id = t.closest('[data-holders]').dataset.holders;
      invOpen = invOpen === id ? '' : id; renderHolders();
    } else if (t.closest('[data-openorder]')) {
      await ensureOrders();
      const o = orders.find(x => x.id === t.closest('[data-openorder]').dataset.openorder);
      if (o) openEditor(o);
    }
  });
  $('#invAddGroup').addEventListener('click', () => {
    invGroups.push({ cat: (invGroups[invGroups.length - 1] || {}).cat || 'Other', name: 'New group', sub: '', items: [{ id: '', name: '', desc: '', price: 0, qty: null, hidden: false }] });
    setInvDirty(true); renderInventory();
    const last = $$('#invList .inv-group').pop(); last.scrollIntoView({ behavior: 'smooth' }); $('input[data-gf="name"]', last).select();
  });
  $('#invSearch').addEventListener('input', renderInventory);
  $('#invDate').addEventListener('change', e => { if (e.target.value) { invDate = e.target.value; renderInventory(); loadInvAvail(); } });

  // New items get a permanent id from their name (ids link orders to rentals, so they never change)
  function assignIds() {
    const used = new Set();
    invGroups.forEach(g => g.items.forEach(it => { if (it.id) used.add(it.id); }));
    invGroups.forEach(g => g.items.forEach(it => {
      if (it.id) return;
      const base = (it.name || 'item').toLowerCase().replace(/×/g, 'x').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'item';
      let id = base, n = 2;
      while (used.has(id)) id = base + '-' + n++;
      used.add(id); it.id = id;
    }));
  }
  $('#invSave').addEventListener('click', async () => {
    const b = $('#invSave'); b.disabled = true;
    invGroups.forEach(g => { g.items = g.items.filter(it => it.id || (it.name || '').trim()); });
    assignIds();
    try {
      const res = await api('catalog', { method: 'PUT', body: { groups: invGroups } });
      catalog = res; S = res.settings || S; invGroups = clone(res.groups);
      fillCatalogSelect(); setInvDirty(false); renderInventory(); await loadInvAvail();
      toast('Inventory saved — the booking page is updated');
    } catch (ex) { toast(ex.message); }
    b.disabled = false;
  });
  window.addEventListener('beforeunload', e => { if (invDirty) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- Reports ----------
  function presetRange(p) {
    const d = new Date(), y = d.getFullYear(), m = d.getMonth();
    const r = {
      thisMonth: [iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0))],
      lastMonth: [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))],
      next30: [today(), addDays(today(), 30)],
      thisYear: [y + '-01-01', y + '-12-31'],
      lastYear: [(y - 1) + '-01-01', (y - 1) + '-12-31'],
      last12: [iso(new Date(y, m - 11, 1)), iso(new Date(y, m + 1, 0))]
    };
    return r[p];
  }
  function setPreset() {
    const r = presetRange($('#rpPreset').value);
    if (r) { $('#rpFrom').value = r[0]; $('#rpTo').value = r[1]; }
    renderReports();
  }
  $('#rpPreset').addEventListener('change', setPreset);
  ['#rpFrom', '#rpTo'].forEach(s => $(s).addEventListener('change', () => { $('#rpPreset').value = 'custom'; renderReports(); }));

  function reportOrders() {
    const from = $('#rpFrom').value, to = $('#rpTo').value;
    return (orders || []).filter(o => o.event.date && o.event.date >= from && o.event.date <= to);
  }
  const monthKey = d => d.slice(0, 7);
  const monthLabel = (k, withYear) => new Date(k + '-15T12:00:00').toLocaleDateString('en-US', withYear ? { month: 'short', year: '2-digit' } : { month: 'short' });

  function renderReports() {
    if (!orders) return;
    if (!$('#rpFrom').value) { const r = presetRange($('#rpPreset').value) || presetRange('thisYear'); $('#rpFrom').value = r[0]; $('#rpTo').value = r[1]; }
    const inRange = reportOrders();
    const R = inRange.filter(o => o.status !== 'canceled' && o.status !== 'quote');
    const quotes = inRange.filter(o => o.status === 'quote');
    const sum = (list, f) => round2(list.reduce((a, o) => a + f(o), 0));
    const booked = sum(R, o => o.money.total), collected = sum(R, o => o.paid), owed = sum(R, o => Math.max(0, o.balance));
    const overdue = sum(R.filter(o => (payState(o) || {}).cls === 'b-overdue'), o => o.balance);
    const online = R.filter(o => o.source === 'online');
    const kpi = (lbl, val, sub) => `<div class="kpi"><div class="lbl">${lbl}</div><div class="val">${val}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
    $('#kpis').innerHTML = [
      kpi('Booked revenue', money0(booked), `${R.length} order${R.length === 1 ? '' : 's'}${R.length ? ' · avg ' + money0(booked / R.length) : ''}`),
      kpi('Collected', money0(collected), booked ? Math.round(collected / booked * 100) + '% of booked' : ''),
      kpi('Still owed', money0(owed), overdue ? `<span style="color:var(--bad)">${money0(overdue)} overdue</span>` : 'none overdue'),
      kpi('Rentals', money0(sum(R, o => o.money.subtotal - o.money.discount)), ''),
      kpi('Delivery fees', money0(sum(R, o => o.money.delivery)), ''),
      kpi('Sales tax', money(sum(R, o => o.money.tax)), 'collected for the state'),
      kpi('Online vs. by hand', `${online.length} / ${R.length - online.length}`, `${money0(sum(online, o => o.money.total))} online`),
      kpi('Open quotes', String(quotes.length), quotes.length ? money0(sum(quotes, o => o.money.total)) + ' quoted' : '')
    ].join('');

    // Months in range
    const months = [];
    for (let k = monthKey($('#rpFrom').value); k <= monthKey($('#rpTo').value) && months.length < 60;) {
      months.push(k);
      const [yy, mm] = k.split('-').map(Number);
      k = mm === 12 ? (yy + 1) + '-01' : yy + '-' + String(mm + 1).padStart(2, '0');
    }
    const multiYear = months.length && months[0].slice(0, 4) !== months[months.length - 1].slice(0, 4);
    const byMonth = months.map(k => {
      const L = R.filter(o => monthKey(o.event.date) === k);
      return { k, n: L.length, rentals: sum(L, o => o.money.subtotal - o.money.discount), delivery: sum(L, o => o.money.delivery), tax: sum(L, o => o.money.tax), total: sum(L, o => o.money.total), paid: sum(L, o => o.paid) };
    });
    drawChart(byMonth.map(m => ({ label: monthLabel(m.k, multiYear), full: monthLabel(m.k, true), value: m.total, n: m.n })));

    const tot = f => byMonth.reduce((a, m) => a + m[f], 0);
    $('#monthTable').innerHTML = `<table><thead><tr><th>Month</th><th class="n">Orders</th><th class="n">Rentals</th><th class="n">Delivery</th><th class="n">Sales tax</th><th class="n">Total</th><th class="n">Collected</th></tr></thead><tbody>` +
      byMonth.map(m => `<tr><td>${monthLabel(m.k, true)}</td><td class="n">${m.n}</td><td class="n">${money(m.rentals)}</td><td class="n">${money(m.delivery)}</td><td class="n">${money(m.tax)}</td><td class="n">${money(m.total)}</td><td class="n">${money(m.paid)}</td></tr>`).join('') +
      `</tbody><tfoot><tr><td>Total</td><td class="n">${tot('n')}</td><td class="n">${money(tot('rentals'))}</td><td class="n">${money(tot('delivery'))}</td><td class="n">${money(tot('tax'))}</td><td class="n">${money(tot('total'))}</td><td class="n">${money(tot('paid'))}</td></tr></tfoot></table>`;

    const items = {};
    R.forEach(o => o.items.forEach(i => {
      const t = items[i.name] = items[i.name] || { name: i.name, qty: 0, rev: 0, orders: 0 };
      t.qty += i.qty; t.rev += i.qty * (i.price || 0); t.orders++;
    }));
    const top = Object.values(items).sort((a, b) => b.rev - a.rev || b.qty - a.qty).slice(0, 15);
    $('#itemTable').innerHTML = top.length ? `<table><thead><tr><th>Rental</th><th class="n">Orders</th><th class="n">Qty</th><th class="n">Revenue</th></tr></thead><tbody>` +
      top.map(t => `<tr><td>${esc(t.name)}</td><td class="n">${t.orders}</td><td class="n">${t.qty}</td><td class="n">${money0(t.rev)}</td></tr>`).join('') + '</tbody></table>'
      : '<p class="muted small">No rentals in this period.</p>';

    const owing = orders.filter(o => o.status !== 'canceled' && o.status !== 'quote' && o.balance > 0.004).sort((a, b) => (a.event.date || '').localeCompare(b.event.date || ''));
    $('#balanceTable').innerHTML = owing.length ? `<table><thead><tr><th>Event</th><th>Order</th><th>Customer</th><th>Phone</th><th class="n">Total</th><th class="n">Paid</th><th class="n">Owed</th><th>Due by</th></tr></thead><tbody>` +
      owing.map(o => { const p = payState(o); return `<tr class="click" data-id="${esc(o.id)}"><td>${esc(fmtDate(o.event.date))}</td><td>${esc(o.number)}</td><td>${esc(o.customer.name)}</td><td>${esc(o.customer.phone)}</td><td class="n">${money(o.money.total)}</td><td class="n">${money(o.paid)}</td><td class="n">${money(o.balance)}</td><td>${p && p.due ? `<span class="badge ${p.cls}">${esc(fmtDate(p.due, { month: 'short', day: 'numeric' }))}${p.cls === 'b-overdue' ? ' · overdue' : ''}</span>` : ''}</td></tr>`; }).join('') +
      `</tbody><tfoot><tr><td colspan="6">Total owed</td><td class="n">${money(owing.reduce((a, o) => a + o.balance, 0))}</td><td></td></tr></tfoot></table>`
      : '<p class="muted small">Nobody owes a balance. 🎉</p>';
  }
  $('#balanceTable').addEventListener('click', e => { const r = e.target.closest('tr[data-id]'); if (r) openEditor(orders.find(o => o.id === r.dataset.id)); });

  // Single-series bar chart (one hue, title names it, hover tooltip; the month table below is its table view)
  function drawChart(data) {
    const el = $('#chart');
    if (!data.length) { el.innerHTML = ''; return; }
    const W = Math.max(320, el.clientWidth || 800), H = 260, padL = 56, padB = 28, padT = 10;
    const max = Math.max(...data.map(d => d.value), 0);
    const step = niceStep(max / 4 || 250), top = Math.max(step, Math.ceil(max / step) * step);
    const y = v => padT + (H - padT - padB) * (1 - v / top);
    const slot = (W - padL) / data.length, bw = Math.max(4, Math.min(48, slot * 0.6));
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Revenue by month">`;
    for (let v = 0; v <= top + 0.001; v += step) svg += `<line class="grid" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${money0(v)}</text>`;
    const every = Math.ceil(data.length / Math.max(1, Math.floor((W - padL) / (multiLabelWidth(data) + 8))));
    data.forEach((d, i) => {
      const x = padL + slot * i + (slot - bw) / 2, yt = y(d.value), h = y(0) - yt, r = Math.min(4, h, bw / 2);
      const path = h > 0 ? `M${x},${y(0)} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + bw - r} Q${x + bw},${yt} ${x + bw},${yt + r} V${y(0)} Z` : '';
      svg += `<rect class="bar-hit" data-i="${i}" x="${padL + slot * i}" y="${padT}" width="${slot}" height="${H - padT - padB}" fill="transparent"/>`;
      if (path) svg += `<path class="bar" data-i="${i}" d="${path}"/>`;
      if (i % every === 0) svg += `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text>`;
    });
    el.innerHTML = svg + '</svg><div class="tip" hidden></div>';
    const tip = $('.tip', el);
    el.querySelectorAll('.bar-hit').forEach(hit => {
      hit.addEventListener('mouseenter', () => {
        const i = +hit.dataset.i, d = data[i];
        el.querySelectorAll('.bar').forEach(b => b.classList.toggle('hl', +b.dataset.i === i));
        const box = el.getBoundingClientRect(), hb = hit.getBoundingClientRect();
        tip.innerHTML = `<b>${esc(d.full)}</b> · ${money0(d.value)} · ${d.n} order${d.n === 1 ? '' : 's'}`;
        tip.hidden = false;
        const half = tip.offsetWidth / 2;
        tip.style.left = Math.min(box.width - half, Math.max(half, hb.left - box.left + hb.width / 2)) + 'px';
        tip.style.top = (y(d.value) / H * box.height) + 'px';
      });
      hit.addEventListener('mouseleave', () => { tip.hidden = true; el.querySelectorAll('.bar').forEach(b => b.classList.remove('hl')); });
    });
  }
  const multiLabelWidth = data => Math.max(...data.map(d => d.label.length)) * 7; // ~7px per character at 12px
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  window.addEventListener('resize', () => { if (!$('#view-reports').hidden && orders) renderReports(); });

  $('#csvBtn').addEventListener('click', () => {
    const rows = [['Order', 'Status', 'Source', 'Event date', 'Customer', 'Company', 'Phone', 'Email', 'Address', 'Rentals', 'Rentals subtotal', 'Discount', 'Delivery', 'Sales tax', 'Total', 'Paid', 'Balance', 'Created']];
    reportOrders().sort((a, b) => a.event.date.localeCompare(b.event.date)).forEach(o => rows.push([
      o.number, STATUS[o.status], o.source === 'online' ? 'Website' : 'By hand', o.event.date, o.customer.name, o.customer.company, o.customer.phone, o.customer.email, o.event.address,
      o.items.map(i => i.qty + 'x ' + i.name).join('; '), o.money.subtotal, o.money.discount, o.money.delivery, o.money.tax, o.money.total, o.paid, o.balance, (o.createdAt || '').slice(0, 10)
    ]));
    const csv = rows.map(r => r.map(v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `bbh-orders-${$('#rpFrom').value}-to-${$('#rpTo').value}.csv`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ---------- Start ----------
  (async function init() {
    try { catalog = await (await fetch('/data/catalog.json')).json(); S = catalog.settings || {}; } catch (e) { /* catalog optional */ }
    fillCatalogSelect();
    try { role = (await api('me')).role; showApp(); } catch (e) {
      showLogin();
      if (!/log in/i.test(e.message)) { $('#loginErr').textContent = e.message; $('#loginErr').hidden = false; }
    }
  })();
})();
