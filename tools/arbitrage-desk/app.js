/* OPXP Arbitrage Desk - UI layer. Engine math lives in fee-engine.js. */
(function () {
  'use strict';

  /* fees.config.js is loaded before app.js and sets window.OPXP_FEES, so the app
     works from file:// where fetch() of a local JSON file is blocked. When served
     over http, the fresher fees.config.json is fetched and takes over. */
  var FEES = (typeof window !== 'undefined' && window.OPXP_FEES) ? window.OPXP_FEES : null;
  var SNAPSHOT = (typeof window !== 'undefined' && window.OPXP_SNAPSHOT) ? window.OPXP_SNAPSHOT : null;

  /* Price confidence badge + detail line styles.
     Injected from here instead of index.html so the badge markup and its styling
     travel together. Move this block into index.html's <style> if you ever prefer
     the CSS to live in one place. */
  function injectStyles() {
    var css =
      '.hit .d { color:var(--dim); font-size:.72rem; margin-top:5px;' +
      ' font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }' +
      '.flag { display:inline-block; vertical-align:middle; margin-left:6px; padding:1px 6px;' +
      ' border-radius:999px; font-size:.62rem; font-weight:600; text-transform:uppercase;' +
      ' letter-spacing:.05em; border:1px solid; }' +
      '.flag.ok { color:var(--ok); border-color:#065f46; background:#064e3b; }' +
      '.flag.warn { color:#fbbf24; border-color:#92400e; background:#422006; }' +
      '.flag.bad { color:var(--bad); border-color:#9f1239; background:#4c0519; }' +
      '.vcard .tier { display:block; margin:6px 0 2px; font-size:.68rem;' +
      ' text-transform:uppercase; letter-spacing:.05em; color:var(--dim); }' +
      '.vcard .tier select { display:block; width:100%; margin-top:3px; padding:5px 6px;' +
      ' background:#0f172a; color:#e2e8f0; border:1px solid #334155; border-radius:6px;' +
      ' font-size:.78rem; }' +
      '.vcard .warn { color:#fbbf24; font-size:.7rem; line-height:1.35; margin:6px 0 0; }';
    var s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }
  injectStyles();

  function $(id) { return document.getElementById(id); }
  function money(v) { return '$' + (v === null || v === undefined ? '0.00' : Number(v).toFixed(2)); }
  function pct(v) { return (v === null || v === undefined ? '-' : Number(v).toFixed(1)) + '%'; }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function num(id) {
    var v = parseFloat($(id).value);
    return isFinite(v) ? v : 0;
  }

  /* ---------- store tier selection ----------
     A venue can offer several seller tiers (eBay store subscription, Misprint Seller
     Rewards). The engine takes a profileId in the context. The choice is kept per
     venue in localStorage so it survives a reload, and it is per browser, not per
     account: two different sellers using the same machine will each pick their tier. */
  var PROFILE_KEY = 'opxp_profiles';

  function loadProfiles() {
    try {
      var raw = window.localStorage.getItem(PROFILE_KEY);
      var obj = raw ? JSON.parse(raw) : {};
      return (obj && typeof obj === 'object') ? obj : {};
    } catch (e) { return {}; }
  }

  var PROFILES = loadProfiles();

  function saveProfiles() {
    try { window.localStorage.setItem(PROFILE_KEY, JSON.stringify(PROFILES)); } catch (e) {}
  }

  function venueProfiles(venue) {
    return (venue && venue.profiles && venue.profiles.length) ? venue.profiles : [];
  }

  function profileFor(venue) {
    var list = venueProfiles(venue);
    if (!list.length) return null;
    var want = PROFILES[venue.id];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === want) return list[i];
    }
    for (var j = 0; j < list.length; j++) {
      if (list[j].id === venue.default_profile) return list[j];
    }
    return list[0];
  }

  function tierSelect(venue) {
    var list = venueProfiles(venue);
    if (!list.length) return '';
    var cur = profileFor(venue);
    var opts = list.map(function (p) {
      var sel = (cur && p.id === cur.id) ? ' selected' : '';
      return '<option value="' + esc(p.id) + '"' + sel + '>' + esc(p.name) + '</option>';
    }).join('');
    return '<label class="tier">Store tier <select data-venue="' + esc(venue.id) + '">' + opts + '</select></label>';
  }

  function bindTierSelects(wrap) {
    Array.prototype.forEach.call(wrap.querySelectorAll('select[data-venue]'), function (sel) {
      sel.addEventListener('change', function () {
        PROFILES[sel.dataset.venue] = sel.value;
        saveProfiles();
        renderFees();
        renderBuy();
      });
    });
  }

  /* ---------- tabs ---------- */
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (btn) {
    btn.addEventListener('click', function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) { b.classList.remove('active'); });
      Array.prototype.forEach.call(document.querySelectorAll('.panel'), function (p) { p.classList.remove('active'); });
      btn.classList.add('active');
      $(btn.dataset.panel).classList.add('active');
    });
  });

  /* ---------- fee & margin ---------- */
  function feeCtx() {
    return {
      price: num('f-price'),
      cogs: num('f-cogs'),
      postage: num('f-postage'),
      supplies: num('f-supplies'),
      targetMargin: (num('f-target') || 0) / 100
    };
  }

  function renderFees() {
    if (!FEES) return;
    var ctx = feeCtx();
    var wrap = $('feeResults');
    var tbody = document.querySelector('#feeTable tbody');
    tbody.innerHTML = '';
    wrap.innerHTML = '';

    FEES.venues.forEach(function (venue) {
      var vctx = Object.assign({}, ctx, { profileId: (profileFor(venue) || {}).id });
      var r = OPXPFees.compute(venue, vctx);
      var cls = r.profit >= 0 ? 'ok' : 'bad';
      var el = document.createElement('div');
      el.className = 'vcard';
      el.innerHTML =
        '<h3>' + esc(venue.name) + '</h3>' +
        '<p class="note">' + (venue.confidence === 'unverified' ? 'unverified fee schedule' : 'verified') +
        (venue.last_verified ? ' as of ' + esc(venue.last_verified) : '') + '</p>' +
        tierSelect(venue) +
        (venue.eligibility_note ? '<p class="warn">' + esc(venue.eligibility_note) + '</p>' : '') +
        '<div class="row"><span>Fees</span><span>-' + money(r.feesTotal) + '</span></div>' +
        '<div class="row"><span>You receive</span><span>' + money(r.netPayout) + '</span></div>' +
        '<div class="row"><span>Net profit</span><span class="' + cls + '">' + money(r.profit) + '</span></div>' +
        '<div class="row"><span>Margin</span><span class="' + cls + '">' + pct(r.margin * 100) + '</span></div>' +
        '<div class="row"><span>Break-even price</span><span>' + (r.breakEvenPrice === null ? 'n/a' : money(r.breakEvenPrice)) + '</span></div>' +
        '<div class="row"><span>Floor for ' + pct(ctx.targetMargin * 100) + '</span><span>' + (r.floorPrice === null ? 'n/a' : money(r.floorPrice)) + '</span></div>';
      wrap.appendChild(el);

      r.lines.forEach(function (ln) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' + esc(venue.name) + '</td>' +
          '<td>' + esc(ln.label) + '<div class="src">' + esc(ln.confidence) + '</div></td>' +
          '<td class="src">' + esc(ln.formula) + '</td>' +
          '<td class="num">' + money(ln.amount) + '</td>';
        tbody.appendChild(tr);
      });
    });
    bindTierSelects(wrap);
  }

  /* ---------- max buy offer ---------- */
  function renderBuy() {
    if (!FEES) return;
    var ctx = {
      price: num('b-market'),
      marketValue: num('b-market'),
      targetMargin: (num('b-target') || 0) / 100,
      postage: num('b-postage'),
      supplies: num('b-supplies')
    };
    var wrap = $('buyResults');
    wrap.innerHTML = '';
    FEES.venues.forEach(function (venue) {
      var vctx = Object.assign({}, ctx, { profileId: (profileFor(venue) || {}).id });
      var r = OPXPFees.compute(venue, vctx);
      var offer = r.maxBuyOffer;
      var cls = offer >= 0 ? 'ok' : 'bad';
      var el = document.createElement('div');
      el.className = 'vcard';
      el.innerHTML =
        '<h3>' + esc(venue.name) + '</h3>' +
        '<p class="note">max cost at a ' + money(ctx.marketValue) + ' sale price</p>' +
        tierSelect(venue) +
        '<div class="big ' + cls + '">' + money(offer) + '</div>' +
        '<div class="row"><span>Fees at that price</span><span>-' + money(r.feesTotal) + '</span></div>' +
        '<div class="row"><span>Margin if bought at offer</span><span>' + pct(ctx.targetMargin * 100) + '</span></div>';
      wrap.appendChild(el);
    });
    bindTierSelects(wrap);
  }

  /* ---------- price confidence display ---------- */
  function confBadge(c) {
    if (c.price_outlier) {
      var reason = c.price_outlier_reason || 'outlier';
      var label = 'price outlier';
      if (reason === 'own_history') { label = 'price off history'; }
      else if (reason === 'peer_outlier') { label = 'price vs peers'; }
      else if (reason === 'unbacked_ask') { label = 'unbacked ask'; }
      return '<span class="flag bad" title="' + esc(c.price_outlier_detail || '') + '">' +
        label + '</span>';
    }
    if (c.price_confidence === 'low') {
      return '<span class="flag warn">thin market</span>';
    }
    if (c.price_confidence === 'unknown') {
      return '<span class="flag warn">no seller count</span>';
    }
    return '<span class="flag ok">price ok</span>';
  }

  function detailLine(c) {
    var bits = [];
    if (c.price_median_45d !== null && c.price_median_45d !== undefined) {
      bits.push('45d med ' + money(c.price_median_45d));
    }
    var peerMed = (c.peer_median_px !== null && c.peer_median_px !== undefined)
      ? c.peer_median_px : c.sibling_median_px;
    var peerPct = (c.price_vs_peer_pct !== null && c.price_vs_peer_pct !== undefined)
      ? c.price_vs_peer_pct : c.price_vs_sibling_pct;
    if (peerMed !== null && peerMed !== undefined) {
      bits.push('same-tier peer med ' + money(peerMed) +
        (peerPct !== null && peerPct !== undefined
          ? ' (' + pct(peerPct) + ' vs peers)' : ''));
    }
    if (c.line_median_px !== null && c.line_median_px !== undefined) {
      bits.push('card-line med ' + money(c.line_median_px));
    }
    if (c.price_flat_obs > 1) {
      bits.push('price flat ' + c.price_flat_obs + ' obs / ' + c.price_flat_days + ' days');
    }
    if (c.ebay_psa10_median !== null && c.ebay_psa10_median !== undefined) {
      bits.push('eBay PSA10 ' + money(c.ebay_psa10_median) +
        (c.ebay_psa_sales ? ' (' + c.ebay_psa_sales + ' sales)' : ''));
    } else if (c.ebay_psa9_median !== null && c.ebay_psa9_median !== undefined) {
      bits.push('eBay PSA9 ' + money(c.ebay_psa9_median));
    }
    return bits.join('  |  ');
  }

  /* Cards excluded by tier_flags.py (staff promos, League & Champions energy) are
     single-ask markets. They stay in the data files for the audit trail but they are
     not offered as tradeable references, so they are filtered out of lookup. */
  function isExcluded(c) {
    return !!(c && (c.excluded_from_lookup || c.price_confidence === 'excluded'));
  }

  /* ---------- lookup ---------- */
  function renderLookup() {
    var q = ($('l-query').value || '').trim().toLowerCase();
    var wrap = $('lookupResults');
    if (!SNAPSHOT || !SNAPSHOT.cards) {
      wrap.innerHTML = '<p class="sub">Market data not loaded. Run scripts/build_snapshot.py and place latest.json and latest.js in data/.</p>';
      return;
    }
    var total = SNAPSHOT.lookup_card_count || SNAPSHOT.card_count;
    if (q.length < 2) {
      wrap.innerHTML = '<p class="sub">Type at least two characters. ' + total + ' cards loaded, as of ' + esc(SNAPSHOT.as_of) + '.</p>';
      return;
    }
    var hits = SNAPSHOT.cards.filter(function (c) {
      if (isExcluded(c)) return false;
      return (c.name || '').toLowerCase().indexOf(q) >= 0 ||
        (c.number || '').toLowerCase().indexOf(q) >= 0 ||
        (c.set_name || '').toLowerCase().indexOf(q) >= 0;
    }).slice(0, 25);

    if (!hits.length) {
      wrap.innerHTML = '<p class="sub">No match in the last scan.</p>';
      return;
    }
    wrap.innerHTML = hits.map(function (c) {
      var detail = detailLine(c);
      return '<div class="hit" data-price="' + esc(c.market_price) + '">' +
        '<div class="t">' + esc(c.name) + ' ' + confBadge(c) + '</div>' +
        '<div class="m">' + esc(c.number) + ' - ' + esc(c.set_name) + ' - ' + money(c.market_price) +
        ' - 7d ' + pct(c.chg_7d) + ' - 30d ' + pct(c.chg_30d) +
        (c.active_sellers !== null && c.active_sellers !== undefined ? ' - sellers ' + c.active_sellers : '') +
        '</div>' +
        (detail ? '<div class="d">' + detail + '</div>' : '') +
        '</div>';
    }).join('');

    Array.prototype.forEach.call(wrap.querySelectorAll('.hit'), function (h) {
      h.addEventListener('click', function () {
        $('f-price').value = parseFloat(h.dataset.price).toFixed(2);
        $('f-cogs').value = '0.00';
        renderFees();
        document.querySelector('.tab[data-panel="p-fee"]').click();
      });
    });
  }

  /* ---------- boot ---------- */
  function loadJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ' -> HTTP ' + r.status);
      return r.json();
    });
  }

  function applyFees(cfg) {
    if (!cfg) return;
    FEES = cfg;
    $('feeVersion').textContent = cfg.fee_schedule_version + (cfg.last_verified ? ' (verified ' + cfg.last_verified + ')' : ' (unverified)');
    var unverified = cfg.venues.filter(function (v) { return v.confidence === 'unverified'; });
    if (unverified.length) {
      var w = $('verifyWarn');
      w.style.display = 'block';
      w.textContent = 'Fee schedule for ' + unverified.length + ' venue(s) is a draft, not verified against current seller terms. Numbers can be off. Verify before you rely on them.';
    }
    renderFees();
    renderBuy();
  }

  loadJSON('fees.config.json').then(applyFees).catch(function (e) {
    if (FEES) {
      applyFees(FEES);
      return;
    }
    var w = $('verifyWarn');
    w.style.display = 'block';
    w.textContent = 'Could not load fee schedule: ' + e.message;
  });

  // Prefer the freshly fetched snapshot; fall back to the embedded latest.js (works from file://).
  loadJSON('data/latest.json').then(function (snap) {
    SNAPSHOT = snap;
    showDataBanner();
    renderLookup();
  }).catch(function () {
    showDataBanner();
    renderLookup();
  });

  function showDataBanner() {
    var d = $('dataWarn');
    d.style.display = 'block';
    if (SNAPSHOT && SNAPSHOT.cards && SNAPSHOT.cards.length) {
      d.textContent = 'Market data as of ' + SNAPSHOT.as_of + ' (' + SNAPSHOT.card_count + ' cards). Last completed scan, not live, not a prediction.';
    } else {
      d.textContent = 'No market snapshot loaded. Fee math still works; card lookup needs data/latest.json and data/latest.js.';
    }
  }

  ['f-price', 'f-cogs', 'f-postage', 'f-supplies', 'f-target'].forEach(function (id) {
    $(id).addEventListener('input', renderFees);
  });
  ['b-market', 'b-target', 'b-postage', 'b-supplies'].forEach(function (id) {
    $(id).addEventListener('input', renderBuy);
  });
  $('l-query').addEventListener('input', renderLookup);

  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  renderLookup();
})();
