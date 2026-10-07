/* Adaptive jump planning: works out what you own, what the jump can use,
   and which step you're on, from live API data. Read-only. */
const HJP = (() => {
  const EDVD_MIN = 360;

  // Known items, matched by name. Everything else is classified from its catalog effect text.
  const KNOWN = {
    "xanax": { kind: "xanax", energy: 250 },
    "ecstasy": { kind: "ecstasy" },
    "erotic dvd": { kind: "edvd", happy: 2500, boosterMin: EDVD_MIN }
  };
  // Inventory category of each known item, for when the catalog isn't loaded.
  const KNOWN_TYPE = { "xanax": "Drug", "ecstasy": "Drug", "erotic dvd": "Booster" };

  const toNum = s => Number(String(s).replace(/,/g, ""));

  /** Turn a catalog entry into something the planner understands. */
  function classify(id, c) {
    const name = c.name || "";
    const key = name.toLowerCase();
    const base = { id, name, type: c.type || "", value: Number(c.market_value || c.value) || 0 };
    if (KNOWN[key]) return { ...base, ...KNOWN[key] };
    if (/drug/i.test(base.type)) return { ...base, kind: null }; // other drugs have side effects; never planned
    const eff = `${c.effect || ""} ${c.description || ""}`;
    const happy = eff.match(/happiness\D{0,12}?(\d[\d,]*)/i) || eff.match(/(\d[\d,]*)\s+happiness/i);
    const energy = eff.match(/energy\D{0,12}?(\d[\d,]*)/i) || eff.match(/(\d[\d,]*)\s+energy/i);
    const bh = eff.match(/booster cooldown\D{0,20}?(\d+(?:\.\d+)?)\s*(hour|minute|min)/i);
    const boosterMin = bh ? toNum(bh[1]) * (/hour/i.test(bh[2]) ? 60 : 1) : null;
    const isBoosterLike = /candy|booster|energy drink|alcohol/i.test(base.type);
    if (!isBoosterLike) return { ...base, kind: null };
    if (energy && !happy) return { ...base, kind: "energy", energy: toNum(energy[1]), boosterMin: boosterMin ?? 120 };
    if (happy) return { ...base, kind: "candy", happy: toNum(happy[1]), boosterMin: boosterMin ?? 30 };
    return { ...base, kind: null };
  }

  /** Reduce the full torn/items catalog to the bits we need. */
  function reduceCatalog(items) {
    const out = {};
    for (const [id, c] of Object.entries(items || {})) {
      const it = classify(id, c);
      if (it.kind) out[id] = it;
    }
    return out;
  }

  /** Find the item list inside an inventory response, whatever its exact shape. */
  function extractInventory(json) {
    let found = null;
    (function walk(o) {
      if (found || !o || typeof o !== "object") return;
      const arr = Array.isArray(o) ? o : null;
      if (arr && arr.length && typeof arr[0] === "object" && arr.some(x => x && ("amount" in x || "quantity" in x || "qty" in x))) { found = arr; return; }
      for (const v of Object.values(o)) walk(v);
    })(json);
    return (found || []).map(x => ({
      id: String(x.id ?? x.ID ?? x.item_id ?? ""),
      name: x.name || "",
      amount: Number(x.amount ?? x.quantity ?? x.qty ?? 1) || 0
    }));
  }

  /** Inventory totals keyed by lower-case name, joined to the catalog. */
  function ownedMap(inv, catalog) {
    if (!inv || !inv.ok) return null;
    const m = {};
    for (const x of inv.items) {
      const name = (x.name || (catalog && catalog.items[x.id] && catalog.items[x.id].name) || "").toLowerCase();
      if (!name) continue;
      m[name] = (m[name] || 0) + x.amount;
    }
    return m;
  }

  /** Build the jump that's possible with what you have, and note anything missing. */
  function buildPlan({ snap, settings, inv, catalog, skips = {}, track = {} }) {
    const L = HJ.live(snap);
    const owned = ownedMap(inv, catalog);
    const items = catalog ? Object.values(catalog.items) : [];
    // Inventory categories that couldn't be read: their items are unknown (null), not zero.
    const failedCats = (owned && inv.failedCats || []).map(c => c.toLowerCase());
    const catKnown = cat => !failedCats.includes(cat.toLowerCase());
    const typeOf = name => (items.find(i => i.name.toLowerCase() === name) || {}).type || KNOWN_TYPE[name] || "";
    const have = name => (owned && catKnown(typeOf(name)) ? owned[name] || 0 : null);
    const priceOf = name => (items.find(i => i.name.toLowerCase() === name) || {}).value || 0;
    const money = snap.addict && snap.addict.money;
    const rows = [];
    const boosted = !!track.boostAt;

    // Energy stack
    const stacked = Math.max(track.stackXans || 0, L.energy > L.maxEnergy ? Math.ceil((L.energy - L.maxEnergy) / 250) : 0);
    const xanWant = Math.max(0, settings.xanaxCount - stacked);
    const xanHave = have("xanax");
    const xanUse = boosted || skips.xanax ? 0 : xanHave === null ? xanWant : Math.min(xanWant, xanHave);
    const xanShort = boosted || skips.xanax || xanHave === null ? 0 : xanWant - xanUse;
    const stackTarget = boosted ? L.energy : Math.min(1000, Math.max(L.energy, L.energy + xanUse * 250));
    rows.push({ key: "xanax", label: "Xanax", want: xanWant, have: xanHave, use: xanUse, short: xanShort,
      done: stacked, cost: xanShort * priceOf("xanax"), skipped: !!skips.xanax,
      note: stacked ? `${stacked} in stack` : "" });

    // Booster room shared by eDVDs, candy and energy drinks
    let room = settings.boosterCapH * 60 - L.boosterLeft / 60;
    const boosterUses = [];
    let happyGain = 0, energyGain = 0;

    const dvdHave = have("erotic dvd");
    const dvdFit = Math.max(0, Math.floor(room / EDVD_MIN));
    const dvdUse = boosted || skips.edvd ? 0 : Math.min(settings.edvdCount, dvdHave ?? settings.edvdCount, dvdFit);
    const dvdShort = boosted || skips.edvd || dvdHave === null ? 0 : Math.max(0, Math.min(settings.edvdCount, dvdFit) - dvdHave);
    if (dvdUse) { boosterUses.push({ name: "Erotic DVD", n: dvdUse }); room -= dvdUse * EDVD_MIN; happyGain += dvdUse * 2500; }
    rows.push({ key: "edvd", label: "eDVDs", want: settings.edvdCount, have: dvdHave, use: dvdUse, short: dvdShort,
      cost: dvdShort * priceOf("erotic dvd"), skipped: !!skips.edvd,
      note: dvdFit < settings.edvdCount && !boosted ? `room for ${dvdFit}` : "" });

    const fill = (kind, enabled) => {
      if (!enabled || !owned || boosted) return [];
      const pool = items.filter(i => i.kind === kind && owned[i.name.toLowerCase()] > 0)
        .sort((a, b) => ((b.happy || b.energy) / b.boosterMin) - ((a.happy || a.energy) / a.boosterMin));
      const used = [];
      for (const it of pool) {
        const n = Math.min(owned[it.name.toLowerCase()], Math.floor(room / it.boosterMin));
        if (n <= 0) continue;
        room -= n * it.boosterMin;
        used.push({ name: it.name, n, each: it.happy || it.energy });
        if (kind === "candy") happyGain += n * it.happy; else energyGain += n * it.energy;
      }
      return used;
    };
    // With eDVDs, spare room goes to energy first. Without them, candy is the happy source.
    let candy = [], drinks = [];
    if (dvdUse) { drinks = fill("energy", settings.useEnergyItems && !skips.drinks); candy = fill("candy", settings.useCandy && !skips.candy); }
    else { candy = fill("candy", settings.useCandy && !skips.candy); drinks = fill("energy", settings.useEnergyItems && !skips.drinks); }
    boosterUses.push(...candy, ...drinks);
    if (candy.length || (settings.useCandy && owned && !boosted)) {
      const candyOwned = items.filter(i => i.kind === "candy").reduce((a, i) => a + (owned[i.name.toLowerCase()] || 0), 0);
      rows.push({ key: "candy", label: "Candy", use: candy.reduce((a, c) => a + c.n, 0), have: catKnown("Candy") ? candyOwned : null, short: 0, skipped: !!skips.candy,
        note: candy.length ? candy.map(c => `${c.n}× ${c.name}`).join(", ") : "none usable" });
    }
    if (drinks.length) {
      rows.push({ key: "drinks", label: "Energy drinks", use: drinks.reduce((a, c) => a + c.n, 0),
        have: items.filter(i => i.kind === "energy").reduce((a, i) => a + (owned[i.name.toLowerCase()] || 0), 0), short: 0, skipped: !!skips.drinks,
        note: drinks.map(c => `${c.n}× ${c.name}`).join(", ") });
    }

    // Ecstasy
    const xtcHave = have("ecstasy");
    const xtcWanted = settings.useEcstasy && !skips.ecstasy;
    const xtcUse = xtcWanted && (track.ecstasyAt ? true : xtcHave === null || xtcHave > 0);
    const xtcShort = xtcWanted && !track.ecstasyAt && xtcHave === 0 ? 1 : 0;
    rows.push({ key: "ecstasy", label: "Ecstasy", want: settings.useEcstasy ? 1 : 0, have: xtcHave, use: xtcUse ? 1 : 0,
      short: xtcShort, cost: xtcShort * priceOf("ecstasy"), skipped: !!skips.ecstasy, done: track.ecstasyAt ? 1 : 0 });

    // Energy refill
    const points = money ? Number(money.points) : null;
    const refillDone = boosted && L.refillUsed && !track.refillUsedAtBoost;
    let refillUse = settings.useRefill && !skips.refill && (refillDone || (!L.refillUsed && (points === null || points >= settings.refillPointCost)));
    let refillNote = "";
    if (settings.useRefill && !refillDone && L.refillUsed) refillNote = "used today";
    else if (settings.useRefill && points !== null && points < settings.refillPointCost) refillNote = `${points}/${settings.refillPointCost} points`;
    rows.push({ key: "refill", label: "Energy refill", want: settings.useRefill ? 1 : 0, use: refillUse ? 1 : 0,
      short: settings.useRefill && !refillUse && !skips.refill ? 1 : 0, skipped: !!skips.refill, note: refillNote, done: refillDone ? 1 : 0, noBuy: true });

    const happy = boosted ? L.happy * (xtcUse && !track.ecstasyAt ? 2 : 1)
      : (L.maxHappy + happyGain) * (xtcUse ? 2 : 1);
    const energy = stackTarget + (refillUse && !refillDone ? L.maxEnergy : 0) + energyGain + (+settings.extraEnergy || 0);
    const missingCost = rows.reduce((a, r) => a + (r.skipped || r.noBuy ? 0 : r.cost || 0), 0);

    return { rows, boosterUses, stacked, stackTarget, xanUse, xanHave, xtcUse, refillUse, refillDone, happy, energy,
      happyGain, energyGain, missingCost, money: money ? Number(money.money_onhand) || 0 : null, points,
      shortages: rows.filter(r => r.short > 0 && !r.skipped), inventoryKnown: !!owned };
  }

  /** Work out which step you're on and what to do next. */
  function jumpState(ctx) {
    const { snap, settings, track = {}, gymsCache } = ctx;
    const plan = buildPlan(ctx);
    const L = HJ.live(snap);
    const gym = HJ.gymInfo(snap, gymsCache, settings);
    const tick = HJ.dur(HJ.msToQuarterTick() / 1000);
    const boostList = plan.boosterUses.map(b => `${b.n}× ${b.name}`).join(", ");
    const S = (key, title, action, extra = {}) => ({ key, title, action, plan, ...extra });

    if (settings.paused) return S("paused", "Tracking paused", "Resume when you want to plan a jump.");

    if (track.boostAt) {
      if (plan.xtcUse && !track.ecstasyAt) {
        if (L.drugLeft > 0) return S("train", "Ecstasy is blocked", `Your drug cooldown has ${HJ.dur(L.drugLeft)} left, so Ecstasy can't be taken in time. Train now before the tick in ${tick}.`, { urgent: true });
        return S("ecstasy", "Take Ecstasy now", `It doubles your current happy. Then ${plan.refillUse && !plan.refillDone ? "refill energy and " : ""}train. Tick in ${tick}.`, { urgent: true });
      }
      if (plan.refillUse && !plan.refillDone) return S("refill", "Use your energy refill", `Then train everything. Tick in ${tick}.`, { urgent: true });
      if (L.energy >= gym.energy) return S("train", "Train now", `Spend all ${HJ.num(L.energy)} energy before the tick in ${tick}.`, { urgent: true });
      return S("done", "Jump done", "You're out of energy. Nice work.");
    }

    const lj = track.lastJump;
    if (lj && Date.now() - lj.endedAt < 3 * 3600 * 1000 && plan.stacked === 0) {
      return S("done", "Jump finished", `You gained about +${HJ.num(lj.gained)} battle stats. The plan for your next jump starts here when you're ready.`);
    }
    if (plan.xanUse > 0) {
      // Nothing stacked yet and energy at or under max: not jumping. Show how to start, but this
      // isn't a stacking step, so it sends no alerts.
      if (plan.stacked === 0 && L.energy <= L.maxEnergy) {
        const start = `When you're ready to jump, take Xanax 1 of ${plan.xanUse} and stop spending energy.`;
        return S("idle", "Not stacking", L.drugLeft > 0 ? `Drug cooldown ends in ${HJ.dur(L.drugLeft)}. ${start}` : start);
      }
      const n = plan.stacked + 1;
      const ad = ctx.addictStatus;
      if (ad && ad.inCourse && (ad.level === "rehab" || ad.safeXanax === 0)) {
        return S("rehab", "Rehab before your next Xanax", `Your addiction (${ad.pct}%) is near the education kick line. Fly to Switzerland and rehab, then carry on stacking. Your stack energy stays while you travel.`);
      }
      if (L.drugLeft > 0) return S("stackWait", `Stacking: ${HJ.num(L.energy)} / ${HJ.num(plan.stackTarget)} energy`, `Next Xanax (${n} of ${n - 1 + plan.xanUse}) in ${HJ.dur(L.drugLeft)}. Don't spend energy.`);
      return S("stackTake", `Take Xanax ${n} of ${n - 1 + plan.xanUse}`, "Your drug cooldown is clear. Don't spend energy while stacking.");
    }
    const xanRow = plan.rows.find(r => r.key === "xanax");
    if (xanRow.short > 0 && plan.xanUse === 0) {
      return S("blocked", "You're out of Xanax", `Your stack needs ${xanRow.short} more. Buy them, or go ahead with the ${HJ.num(L.energy)} energy you have.`,
        { button: { label: "Proceed without", skip: "xanax" } });
    }
    if (plan.xtcUse && L.drugLeft > 0) {
      return S("waitDrug", "Stack ready — waiting on drug cooldown", `Ecstasy needs it clear: ${HJ.dur(L.drugLeft)} left. You can skip Ecstasy and jump now instead.`,
        { button: { label: "Jump without Ecstasy", skip: "ecstasy" } });
    }
    const steps = [];
    if (boostList) steps.push(`use ${boostList}`);
    if (plan.xtcUse) steps.push("take Ecstasy");
    if (plan.refillUse) steps.push("refill energy");
    steps.push("train everything");
    const blocker = plan.shortages.find(r => r.key === "edvd" || r.key === "ecstasy");
    if (!boostList && !plan.xtcUse) {
      return S("ready", "Ready to train", `Nothing to boost happy with, so this is a normal train at ${HJ.num(L.happy)} happy. ${steps.join(", then ")}.`);
    }
    return S("ready", "Ready to jump", `Right after the next quarter tick (in ${tick}): ${steps.join(", then ")}.`,
      blocker ? { button: { label: `Proceed without ${blocker.label}`, skip: blocker.key } } : {});
  }

  /** Plan, addiction status (sized to the Xanax this plan still uses) and current step together. */
  function fullState(base, addictLearn) {
    const pre = buildPlan(base);
    const ad = HJ.addictionStatus(base.snap, base.settings, addictLearn, pre.xanUse);
    return { ad, js: jumpState({ ...base, addictStatus: ad }) };
  }

  return { reduceCatalog, extractInventory, buildPlan, jumpState, fullState, classify };
})();
if (typeof self !== "undefined") self.HJP = HJP;
