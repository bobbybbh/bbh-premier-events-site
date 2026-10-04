// Online booking: catalog, cart and checkout (payments via Stripe through Netlify Functions)
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var money = function (n) { return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var round2 = function (n) { return Math.round(n * 100) / 100; };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  var S = null, GROUPS = [], ITEMS = {};
  var cart = {}, eventDate = '', qtyPick = {}, step = 1, delivery = null, quoting = null;

  function load(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(t._t); t._t = setTimeout(function () { t.hidden = true; }, 2200);
  }
  function showError(msg) { var e = $('#formError'); e.textContent = msg || ''; e.hidden = !msg; }

  // ---------- Catalog ----------
  function renderChips() {
    var cats = [];
    GROUPS.forEach(function (g) { if (cats.indexOf(g.cat) < 0) cats.push(g.cat); });
    $('#catChips').innerHTML = cats.map(function (c) {
      return '<a class="chip" href="#cat-' + c.replace(/\W+/g, '-').toLowerCase() + '">' + esc(c) + '</a>';
    }).join('');
  }

  function renderCatalog() {
    var html = '', lastCat = '';
    GROUPS.forEach(function (g) {
      if (g.cat !== lastCat) {
        html += '<h2 class="bk-cat" id="cat-' + g.cat.replace(/\W+/g, '-').toLowerCase() + '">' + esc(g.cat) + '</h2>';
        lastCat = g.cat;
      }
      html += '<div class="bk-group"><h3>' + esc(g.name) + '</h3>' + (g.sub ? '<p class="muted">' + esc(g.sub) + '</p>' : '') + '<div class="bk-grid">';
      g.items.forEach(function (it) {
        var q = qtyPick[it.id] || 1;
        html += '<div class="bk-item">' +
          '<div class="bk-name">' + esc(it.name) + '</div>' +
          '<div class="bk-desc">' + (it.desc ? esc(it.desc) : '&nbsp;') + '</div>' +
          '<div class="bk-row"><div class="bk-price">' + money(it.price) + '</div>' +
          '<div class="bk-add">' +
            '<div class="bk-qty"><button type="button" data-q="-1" data-id="' + it.id + '" aria-label="Decrease quantity">−</button>' +
            '<input type="number" min="1" value="' + q + '" data-qty="' + it.id + '" aria-label="Quantity for ' + esc(it.name) + '">' +
            '<button type="button" data-q="1" data-id="' + it.id + '" aria-label="Increase quantity">+</button></div>' +
            '<button type="button" class="btn btn-gold bk-addbtn" data-add="' + it.id + '">Add</button>' +
          '</div></div></div>';
      });
      html += '</div></div>';
    });
    $('#catalog').innerHTML = html;
  }

  $('#catalog').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.dataset.q) {
      var id = b.dataset.id, input = document.querySelector('[data-qty="' + id + '"]');
      var v = Math.max(1, (parseInt(input.value, 10) || 1) + Number(b.dataset.q));
      input.value = v; qtyPick[id] = v;
    } else if (b.dataset.add) {
      if (!eventDate) { toast('Choose your event date first'); $('#evDate').focus(); return; }
      var aid = b.dataset.add, inp = document.querySelector('[data-qty="' + aid + '"]');
      var n = Math.max(1, parseInt(inp.value, 10) || 1);
      cart[aid] = (cart[aid] || 0) + n; store('bbh_cart', cart);
      renderCart(); toast('Added ' + n + ' × ' + ITEMS[aid].name);
    }
  });
  $('#catalog').addEventListener('change', function (e) {
    if (e.target.dataset.qty) { var v = Math.max(1, parseInt(e.target.value, 10) || 1); e.target.value = v; qtyPick[e.target.dataset.qty] = v; }
  });

  // ---------- Date ----------
  function minDate() { var d = new Date(); d.setDate(d.getDate() + (S ? S.minLeadDays : 2)); return d.toISOString().slice(0, 10); }
  function dateLabel(iso) { return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); }
  function setDate(iso) {
    if (!iso || iso < minDate()) { eventDate = ''; $('#datebar').classList.remove('set'); return false; }
    eventDate = iso; store('bbh_date', iso);
    $('#datebar').classList.add('set');
    $('#dateNote').textContent = 'Booking for ' + dateLabel(iso) + '. Add what you need, then open your cart to check out.';
    return true;
  }
  $('#evDate').addEventListener('change', function () {
    if (!setDate(this.value)) toast('Online bookings need at least ' + S.minLeadDays + " days' notice");
  });

  // ---------- Totals ----------
  function calc() {
    var sub = 0;
    Object.keys(cart).forEach(function (id) { if (ITEMS[id]) sub += ITEMS[id].price * cart[id]; });
    sub = round2(sub);
    var del = delivery && delivery.ok ? delivery.fee : null;
    var taxable = sub + (S.taxDelivery && del ? del : 0);
    var tax = round2(taxable * S.taxRatePercent / 100);
    var total = round2(sub + (del || 0) + tax);
    var deposit = round2(Math.min(total, Math.max(S.depositMinimum, total * S.depositPercent / 100)));
    return { sub: sub, del: del, tax: tax, total: total, deposit: deposit, balance: round2(total - deposit) };
  }

  function renderTotals() {
    var t = calc();
    $('#tSub').textContent = money(t.sub);
    $('#tDel').textContent = t.del == null ? 'From address' : (t.del === 0 ? 'Included' : money(t.del));
    $('#tTaxLabel').textContent = 'Sales tax (' + S.taxRatePercent + '%)';
    $('#tTax').textContent = money(t.tax);
    $('#tTotal').textContent = money(t.total) + (t.del == null ? ' + delivery' : '');
    $('#payDepositAmt').textContent = money(t.deposit);
    $('#payDepositNote').textContent = 'Balance of ' + money(t.balance) + ' due ' + S.balanceDueDays + ' days before your event.';
    $('#payFullAmt').textContent = money(t.total);
  }

  // ---------- Cart ----------
  function renderCart() {
    var ids = Object.keys(cart).filter(function (id) { return ITEMS[id]; });
    $('#cartCount').textContent = ids.reduce(function (a, id) { return a + cart[id]; }, 0);
    $('#cartEmpty').hidden = ids.length > 0;
    $('#cartLines').innerHTML = ids.map(function (id) {
      var it = ITEMS[id];
      return '<div class="bk-line"><div><div>' + esc(it.name) + '</div><div class="muted bk-small">' + money(it.price) + ' each</div></div>' +
        '<div class="bk-qty sm"><button type="button" data-cq="-1" data-id="' + id + '" aria-label="Decrease">−</button><span>' + cart[id] + '</span><button type="button" data-cq="1" data-id="' + id + '" aria-label="Increase">+</button></div>' +
        '<div class="bk-linetotal">' + money(it.price * cart[id]) + '</div>' +
        '<button type="button" class="bk-remove" data-rm="' + id + '" aria-label="Remove ' + esc(it.name) + '">×</button></div>';
    }).join('');
    renderTotals();
  }
  $('#cartLines').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.dataset.rm) delete cart[b.dataset.rm];
    if (b.dataset.cq) { var id = b.dataset.id; cart[id] = (cart[id] || 0) + Number(b.dataset.cq); if (cart[id] < 1) delete cart[id]; }
    store('bbh_cart', cart); renderCart();
  });

  // ---------- Delivery quote ----------
  function addressString() {
    var st = $('#a_street').value.trim(), city = $('#a_city').value.trim(), zip = $('#a_zip').value.trim();
    if (!st || !city || zip.length < 5) return '';
    return st + ', ' + city + ', ' + $('#a_state').value + ' ' + zip;
  }
  function quoteDelivery() {
    var addr = addressString(), box = $('#deliveryBox');
    if (!addr) { delivery = null; box.textContent = 'Enter the address to calculate delivery.'; box.className = 'bk-delivery'; renderTotals(); return Promise.resolve(); }
    if (delivery && delivery.addr === addr) return Promise.resolve();
    box.textContent = 'Calculating delivery…'; box.className = 'bk-delivery';
    var p = fetch('/.netlify/functions/delivery-quote?address=' + encodeURIComponent(addr))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (quoting !== p) return;
        d.addr = addr; delivery = d;
        if (d.ok) {
          box.innerHTML = '<strong>' + Math.round(d.miles) + ' miles</strong> from our warehouse · Delivery, setup &amp; pickup: <strong>' + (d.fee === 0 ? 'Included' : money(d.fee)) + '</strong>';
          box.className = 'bk-delivery ok';
        } else { box.textContent = d.error; box.className = 'bk-delivery bad'; }
        renderTotals();
      })
      .catch(function () {
        if (quoting !== p) return;
        delivery = null; box.textContent = 'Could not calculate delivery right now. Please try again.'; box.className = 'bk-delivery bad'; renderTotals();
      });
    quoting = p;
    return p;
  }
  ['a_street', 'a_city', 'a_zip'].forEach(function (id) { $('#' + id).addEventListener('change', quoteDelivery); });
  $('#a_state').addEventListener('change', quoteDelivery);

  // ---------- Steps ----------
  function show(n) {
    step = n; showError('');
    [1, 2, 3].forEach(function (i) { $('#step' + i).classList.toggle('on', i === n); });
    document.querySelectorAll('.bk-steps li').forEach(function (li) { li.classList.toggle('on', Number(li.dataset.s) <= n); });
    $('#drawerTitle').textContent = ['Your cart', 'Event details', 'Review & pay'][n - 1];
    $('#backBtn').hidden = n === 1;
    $('#nextBtn').textContent = ['Checkout', 'Review order', 'Continue to payment'][n - 1];
    if (n === 3) renderReview();
    $('.bk-bd').scrollTop = 0;
  }

  function v(id) { return $('#' + id).value.trim(); }

  function renderReview() {
    var t = calc();
    var lines = Object.keys(cart).map(function (id) { return '<li><span>' + cart[id] + ' × ' + esc(ITEMS[id].name) + '</span><span>' + money(ITEMS[id].price * cart[id]) + '</span></li>'; }).join('');
    $('#reviewBox').innerHTML =
      '<div class="bk-rv-head"><div><div class="muted bk-small">EVENT DATE</div>' + esc(dateLabel(eventDate)) + '</div>' +
      '<div><div class="muted bk-small">DELIVER TO</div>' + esc(addressString()) + '</div></div>' +
      '<ul class="bk-rv-lines">' + lines +
      '<li><span>Delivery, setup &amp; pickup (' + Math.round(delivery.miles) + ' mi)</span><span>' + (t.del === 0 ? 'Included' : money(t.del)) + '</span></li>' +
      '<li><span>Sales tax (' + S.taxRatePercent + '%)</span><span>' + money(t.tax) + '</span></li>' +
      '<li class="tot"><span>Order total</span><span>' + money(t.total) + '</span></li></ul>';
    renderTotals();
  }

  function validateDetails() {
    if (!v('c_name') || !v('c_phone') || !v('c_email')) return 'Please enter your name, phone and email.';
    if (!/^\S+@\S+\.\S+$/.test(v('c_email'))) return 'Please enter a valid email address.';
    if (!addressString()) return 'Please enter the full event address, including ZIP.';
    if (!delivery || !delivery.ok) return delivery && delivery.error ? delivery.error : 'Please wait for delivery to be calculated.';
    return '';
  }

  $('#nextBtn').addEventListener('click', function () {
    if (step === 1) {
      if (!Object.keys(cart).length) { showError('Add something to your cart first.'); return; }
      if (!eventDate) { closeDrawer(); toast('Choose your event date first'); $('#evDate').focus(); return; }
      show(2);
    } else if (step === 2) {
      quoteDelivery().then(function () { var err = validateDetails(); if (err) showError(err); else show(3); });
    } else {
      pay();
    }
  });
  $('#backBtn').addEventListener('click', function () { show(step - 1); });

  // ---------- Payment ----------
  function payMode() { return document.querySelector('input[name="payMode"]:checked').value; }

  function recordOrder(t) {
    var mode = payMode();
    var data = {
      'form-name': 'booking', name: v('c_name'), email: v('c_email'), phone: v('c_phone'),
      'event-date': eventDate, 'event-address': addressString(), 'pay-mode': mode === 'full' ? 'Pay in full' : 'Deposit',
      items: Object.keys(cart).map(function (id) { return cart[id] + ' x ' + ITEMS[id].name; }).join('\n'),
      'rentals-subtotal': money(t.sub), delivery: money(t.del) + ' (' + Math.round(delivery.miles) + ' mi)', 'sales-tax': money(t.tax),
      'order-total': money(t.total), 'paying-now': money(mode === 'full' ? t.total : t.deposit), 'balance-due': money(mode === 'full' ? 0 : t.balance),
      'event-type': v('d_type'), guests: v('d_guests'), 'delivery-window': v('d_delivery'), 'pickup-window': v('d_pickup'),
      surface: v('d_surface'), power: v('d_power'), notes: v('d_notes')
    };
    return fetch('/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() })
      .catch(function () {});
  }

  function pay() {
    if (!$('#agree').checked) { showError('Please agree to the rental terms.'); return; }
    var btn = $('#nextBtn'); btn.disabled = true; btn.textContent = 'Opening secure payment…'; showError('');
    var t = calc();
    var body = {
      items: Object.keys(cart).map(function (id) { return { id: id, qty: cart[id] }; }),
      eventDate: eventDate, payMode: payMode(), agree: true,
      customer: { name: v('c_name'), email: v('c_email'), phone: v('c_phone') },
      address: { street: v('a_street'), city: v('a_city'), state: $('#a_state').value, zip: v('a_zip') },
      details: { eventType: v('d_type'), guests: v('d_guests'), deliveryWindow: v('d_delivery'), pickupWindow: v('d_pickup'), surface: v('d_surface'), power: v('d_power'), notes: v('d_notes') }
    };
    fetch('/.netlify/functions/create-checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.d.url) throw new Error(res.d.error || 'Could not open payment.');
        return recordOrder(t).then(function () { window.location.href = res.d.url; });
      })
      .catch(function (err) {
        showError(err.message || 'Something went wrong. Please call (228) 243-7493.');
        btn.disabled = false; btn.textContent = 'Continue to payment';
      });
  }

  // ---------- Drawer ----------
  function openDrawer() { $('#drawer').hidden = false; document.body.style.overflow = 'hidden'; show(1); }
  function closeDrawer() { $('#drawer').hidden = true; document.body.style.overflow = ''; }
  $('#openCart').addEventListener('click', openDrawer);
  $('#closeCart').addEventListener('click', closeDrawer);
  $('#drawer').addEventListener('click', function (e) { if (e.target === $('#drawer')) closeDrawer(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer(); });

  // ---------- Init ----------
  fetch('data/catalog.json').then(function (r) { return r.json(); }).then(function (data) {
    S = data.settings; GROUPS = data.groups;
    GROUPS.forEach(function (g) { g.items.forEach(function (it) { ITEMS[it.id] = it; }); });
    cart = load('bbh_cart') || {};
    Object.keys(cart).forEach(function (id) { if (!ITEMS[id]) delete cart[id]; });
    $('#evDate').min = minDate();
    var saved = load('bbh_date');
    if (saved && setDate(saved)) $('#evDate').value = saved;
    renderChips(); renderCatalog(); renderCart();
    if (/canceled=1/.test(location.search) && Object.keys(cart).length) toast('Payment canceled — your cart is saved.');
  }).catch(function () {
    $('#catalog').innerHTML = '<p class="muted">Rentals could not be loaded. Please refresh, or call (228) 243-7493.</p>';
  });
})();
