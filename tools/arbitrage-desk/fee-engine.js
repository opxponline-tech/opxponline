(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OPXPFees = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function n(v, d) {
    const x = parseFloat(v);
    return isFinite(x) ? x : (d === undefined ? 0 : d);
  }

  function round2(v) {
    return Math.round((v + Number.EPSILON) * 100) / 100;
  }

  function money(v) {
    return '$' + round2(n(v)).toFixed(2);
  }

  function pct(rate) {
    return (n(rate) * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + '%';
  }

  function tierFee(tiers, base) {
    for (const t of tiers) {
      if (t.upTo === null || t.upTo === undefined || base <= n(t.upTo)) return n(t.fee);
    }
    const last = tiers[tiers.length - 1];
    return last ? n(last.fee) : 0;
  }

  /*
   * graduatedAmount(): a rate that changes above a breakpoint.
   * eBay: 12.35% through $2,500 per item, 2.35% on the portion above.
   * Misprint: 7% + 3% through $7,500 per item, 3.5% combined above.
   * The breakpoint is measured on the same base the percentage applies to, and the
   * split is by dollars, not by applying the top rate to the whole amount.
   *
   * line.breakpoint_base === 'item' means the source publishes the breakpoint on
   * the individual item's price while the fee base also carries other revenue
   * (Misprint charges fees on the buyer shipping credit). In that mode only the
   * item portion is graduated and the remainder is charged at the standard rate.
   */
  function graduatedAmount(base, line, itemPrice) {
    const bp = n(line.breakpoint);
    const rate = n(line.rate);
    const rateAbove = line.rate_above === undefined ? rate : n(line.rate_above);
    let amount;
    if (line.breakpoint_base === 'item') {
      // The breakpoint is published on the item price, while the fee base can also
      // carry revenue that is not item price. The item portion is graduated and the
      // remainder is charged at the standard rate.
      const itemPart = Math.min(n(itemPrice), base);
      const rest = base - itemPart;
      const lower = Math.min(itemPart, bp);
      const upper = Math.max(0, itemPart - bp);
      amount = lower * rate + upper * rateAbove + rest * rate;
    } else {
      // The breakpoint is taken on the fee base itself. The engine prices one card
      // at a time, so a per-item breakpoint and a per-computation breakpoint are
      // the same thing here.
      const lower = Math.min(base, bp);
      const upper = Math.max(0, base - bp);
      amount = lower * rate + upper * rateAbove;
    }
    if (line.fixed !== undefined) amount += n(line.fixed);
    return amount;
  }

  function graduatedFormula(base, line) {
    let parts = money(base) + ' x ' + pct(line.rate) + ' up to ' + money(line.breakpoint);
    const rateAbove = line.rate_above === undefined ? line.rate : line.rate_above;
    if (rateAbove !== line.rate) parts += ', ' + pct(rateAbove) + ' above';
    if (line.fixed !== undefined) parts += ' + ' + money(line.fixed);
    return parts;
  }

  /*
   * Profiles: a venue can offer several seller tiers (eBay store subscription,
   * Misprint Seller Rewards). The percentage lines change with the tier; the
   * fixed per-order fee does not, so a profile only overrides the lines it
   * names and leaves everything else shared.
   */
  function cloneVenue(venue) {
    const v = Object.assign({}, venue);
    v.lines = (venue.lines || []).map(function (l) { return Object.assign({}, l); });
    return v;
  }

  function findProfile(venue, profileId) {
    const profiles = venue.profiles || [];
    if (!profiles.length) return null;
    if (profileId !== undefined && profileId !== null && profileId !== '') {
      for (const p of profiles) {
        if (String(p.id) === String(profileId)) return p;
      }
    }
    const def = venue.default_profile;
    for (const p of profiles) {
      if (String(p.id) === String(def)) return p;
    }
    return profiles[0];
  }

  function resolveVenue(venue, ctx) {
    const v = cloneVenue(venue);
    const profile = findProfile(venue, ctx && ctx.profileId);
    if (profile && profile.lines) {
      for (const line of v.lines) {
        const ov = profile.lines[line.id];
        if (!ov) continue;
        if (ov.rate !== undefined) line.rate = ov.rate;
        if (ov.rate_above !== undefined) line.rate_above = ov.rate_above;
        if (ov.breakpoint !== undefined) line.breakpoint = ov.breakpoint;
        if (ov.cap !== undefined) line.cap = ov.cap;
        if (ov.fixed !== undefined) line.fixed = ov.fixed;
        if (ov.base !== undefined) line.base = ov.base;
        if (ov.note) line.note = ov.note;
      }
    }
    return { venue: v, profile: profile };
  }

  /*
   * resolveBuyerShipping(): the buyer-paid shipping amount that lands on the order.
   * A venue can carry a flat credit, or a tiered credit:
   *   { "tiers": [ { "upTo": 50, "fee": 2.5 } ], "default": 5 }
   * Tiers are selected on the item price, which is the closest proxy available when
   * one card is priced at a time.
   */
  function resolveBuyerShipping(venue, ctx, price) {
    if (ctx.buyerShipping !== undefined && ctx.buyerShipping !== null) return n(ctx.buyerShipping);
    const credit = venue.buyer_shipping_credit;
    if (credit === undefined || credit === null) return 0;
    if (typeof credit === 'number') return n(credit);
    if (typeof credit === 'object') {
      const tiers = credit.tiers || [];
      for (const t of tiers) {
        if (t.upTo === null || t.upTo === undefined) return n(t.fee);
        const bound = n(t.upTo);
        // An exclusive tier applies strictly below the bound. Misprint publishes
        // "under $50" for the $2.50 shipping tier, so a $50.00 package is not in it.
        const inTier = t.exclusive ? price < bound : price <= bound;
        if (inTier) return n(t.fee);
      }
      return credit.default === undefined ? 0 : n(credit.default);
    }
    return 0;
  }

  /*
   * core() evaluates one price point and never recurses.
   * Fee line amounts are rounded to cents BEFORE they are summed, so the line items
   * shown in the UI always add up to the total shown. That matters more than a fraction
   * of a cent of precision when the product's whole promise is that the math is honest.
   *
   * price may be passed as the third argument or left on ctx.price. Both work.
   */
  function core(venue, ctx, price) {
    ctx = ctx || {};
    price = Math.max(0, n(price !== undefined && price !== null ? price : ctx.price));
    const cogs = Math.max(0, n(ctx.cogs));
    const postage = Math.max(0, n(ctx.postage));
    const supplies = Math.max(0, n(ctx.supplies));
    const buyerShipping = resolveBuyerShipping(venue, ctx, price);
    const taxRate = ctx.taxRate !== undefined && ctx.taxRate !== null
      ? n(ctx.taxRate)
      : n(venue.tax_drag_rate);

    const orderTotal = price + buyerShipping;

    // Buyer sales tax. A venue can say whether the tax applies to buyer-paid
    // shipping as well as to the item. Most states tax items only; eBay's fee
    // base is documented as including buyer sales tax, so its default is on.
    const taxOnShipping = venue.tax_on_shipping !== false;
    const taxable = taxOnShipping ? orderTotal : price;
    const salesTax = taxable * taxRate;

    // tax_base: the eBay-style fee base (items + buyer shipping + buyer tax).
    // processing_tax_base: TCGplayer's processing base (items + buyer shipping
    //   + buyer sales tax), which is the same shape but uses the venue's own
    //   tax rule.
    const taxBase = orderTotal + salesTax;
    const processingTaxBase = price + buyerShipping + salesTax;
    const bases = {
      price: price,
      order_total: orderTotal,
      tax_base: taxBase,
      processing_tax_base: processingTaxBase,
      buyer_shipping: buyerShipping
    };

    const lines = [];
    let fees = 0;

    for (const line of (venue.lines || [])) {
      const base = bases[line.base || 'price'];
      let amount = 0;
      let formula = '';
      if (line.type === 'percent') {
        amount = base * n(line.rate);
        formula = money(base) + ' x ' + pct(line.rate);
      } else if (line.type === 'percent_fixed') {
        amount = base * n(line.rate) + n(line.fixed);
        formula = money(base) + ' x ' + pct(line.rate) + ' + ' + money(line.fixed);
      } else if (line.type === 'fixed') {
        amount = n(line.fixed);
        formula = money(line.fixed) + ' flat';
      } else if (line.type === 'tiers') {
        amount = tierFee(line.tiers || [], base);
        formula = 'tier on ' + money(base) + ' = ' + money(amount);
      } else if (line.type === 'graduated') {
        amount = graduatedAmount(base, line, price);
        formula = graduatedFormula(base, line);
      }
      if (line.cap !== undefined && amount > n(line.cap)) {
        formula += ' (capped from ' + money(amount) + ')';
        amount = n(line.cap);
      }
      if (line.min !== undefined && amount < n(line.min)) {
        formula += ' (min ' + money(line.fixed === undefined ? 0 : line.min) + ')';
        amount = n(line.min);
      }
      amount = round2(amount);
      fees += amount;
      lines.push({
        id: line.id,
        label: line.label,
        formula: formula,
        base: round2(base),
        amount: amount,
        confidence: line.confidence || venue.confidence || 'unverified'
      });
    }

    fees = round2(fees);
    const netPayout = round2(orderTotal - fees);
    const profit = round2(netPayout - cogs - postage - supplies);
    const margin = price > 0 ? profit / price : 0;

    return {
      venue: venue.id,
      venueName: venue.name,
      price: round2(price),
      buyerShipping: round2(buyerShipping),
      taxRate: taxRate,
      orderTotal: round2(orderTotal),
      taxBase: round2(taxBase),
      lines: lines,
      feesTotal: fees,
      netPayout: netPayout,
      cogs: round2(cogs),
      postage: round2(postage),
      supplies: round2(supplies),
      profit: profit,
      margin: margin
    };
  }

  /*
   * solvePrice(): lowest sale price whose margin ratio hits the target.
   * Coarse scan to find the first crossing, then bisection to refine. Margin ratio is
   * monotone in price for every venue config here, so the first crossing is the answer.
   * Flat-fee tier boundaries make the function steppy; results are accurate to a few cents.
   */
  function solvePrice(venue, ctx, targetMargin) {
    const target = n(targetMargin);
    const hi = Math.min(5000, Math.max(10, n(ctx.price) * 3, n(ctx.marketValue) * 2, 50));
    const step = 0.05;
    let prev = 0.01;
    let prevMargin = core(venue, ctx, prev).margin;
    for (let p = prev + step; p <= hi + step; p += step) {
      const m = core(venue, ctx, p).margin;
      if (m >= target && prevMargin < target) {
        return round2(bisect(venue, ctx, prev, p, target));
      }
      prev = p;
      prevMargin = m;
    }
    return null;
  }

  function bisect(venue, ctx, lo, hi, target) {
    let a = lo;
    let b = hi;
    for (let i = 0; i < 50; i++) {
      const mid = (a + b) / 2;
      if (core(venue, ctx, mid).margin < target) a = mid;
      else b = mid;
    }
    return (a + b) / 2;
  }

  /*
   * maxBuyOffer(): the most you can pay for an item and still hit the target margin
   * when you sell it at marketValue.
   *   profit = netPayout(marketValue) - cogs - postage - supplies
   *   margin = profit / marketValue
   *   => cogs_max = netPayout - postage - supplies - target * marketValue
   */
  function maxBuyOffer(venue, ctx) {
    const mv = n(ctx.marketValue);
    const target = n(ctx.targetMargin);
    const probe = core(venue, ctx, mv);
    return round2(probe.netPayout - n(ctx.postage) - n(ctx.supplies) - target * mv);
  }

  function compute(venue, ctx) {
    ctx = ctx || {};
    const resolved = resolveVenue(venue, ctx);
    const v = resolved.venue;
    const out = core(v, ctx, n(ctx.price));
    out.confidence = v.confidence || 'unverified';
    out.lastVerified = v.last_verified || null;
    out.profileId = resolved.profile ? resolved.profile.id : null;
    out.profileName = resolved.profile ? resolved.profile.name : null;

    if (ctx.marketValue !== undefined && ctx.marketValue !== null && ctx.marketValue !== '') {
      out.maxBuyOffer = maxBuyOffer(v, ctx);
    }
    if (ctx.targetMargin !== undefined && ctx.targetMargin !== null && ctx.targetMargin !== '') {
      out.floorPrice = solvePrice(v, ctx, n(ctx.targetMargin));
    }
    out.breakEvenPrice = solvePrice(v, ctx, 0);
    return out;
  }

  return {
    compute: compute,
    core: core,
    maxBuyOffer: maxBuyOffer,
    solvePrice: solvePrice,
    round2: round2
  };
});
