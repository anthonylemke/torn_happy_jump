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

  // Log entries that move items in or out of your inventory, by title. Torn renumbers log types
  // (old ids live on as "(old)" or "(legacy)"), so ids are looked up from torn/logtypes by these titles.
  const LOG_GAIN = ["item market buy", "bazaar buy", "item shop buy", "item abroad buy", "item receive",
    "trade items incoming", "auction house item win", "item market remove", "bazaar remove", "display remove"];
  const LOG_LOSE = ["item use xanax", "item use xanax overdose", "item use ecstasy", "item use ecstasy overdose",
    "item use erotic dvd", "item use candy", "item use energy drink", "item send", "trade items outgoing",
    "item market add", "bazaar add", "display add", "item shop sell"];

  /** Items in a log entry's data: `items: [{id, qty}]` (market, bazaar) or `item` + `quantity` (abroad, use). */
  function logItems(d) {
    if (Array.isArray(d.items)) return d.items.map(x => ({ id: String(x.id), qty: Number(x.qty ?? x.quantity ?? x.amount ?? 1) || 0 }));
    if (d.item !== undefined && d.item !== null) return [{ id: String(d.item), qty: Number(d.quantity ?? d.qty ?? d.amount ?? 1) || 0 }];
    return [];
  }

  /** Item changes from log entries made after Torn's cached inventory copy of each item's category. */
  function logDelta(entries, sign, catalog, cachedAt) {
    const delta = {};
    const unparsed = [];
    let applied = 0;
    for (const e of entries) {
      const s = sign[e.details && e.details.id];
      const d = e.data || {};
      if (!s || d.faction) continue; // items used from the faction armory never touch your inventory
      const list = logItems(d);
      if (!list.length) unparsed.push(e);
      for (const { id, qty } of list) {
        const it = catalog && catalog.items[id];
        const since = it && cachedAt && cachedAt[it.type];
        if (!since || e.timestamp * 1000 <= since) continue;
        delta[id] = (delta[id] || 0) + s * qty;
        applied++;
      }
    }
    return { delta, applied, unparsed };
  }

  /** Inventory totals keyed by lower-case name, joined to the catalog, plus changes logged since Torn's copy. */
  function ownedMap(inv, catalog) {
    if (!inv || !inv.ok) return null;
    const m = {};
    for (const x of inv.items) {
      const name = (x.name || (catalog && catalog.items[x.id] && catalog.items[x.id].name) || "").toLowerCase();
      if (!name) continue;
      m[name] = (m[name] || 0) + x.amount;
    }
    for (const [id, n] of Object.entries((inv.log && inv.log.delta) || {})) {
      const it = catalog && catalog.items[id];
      if (it) m[it.name.toLowerCase()] = Math.max(0, (m[it.name.toLowerCase()] || 0) + n);
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
      note: stacked ? `${stacked} taken` : "" });

    // Energy refill. Decided before boosters because it limits how much drink energy fits.
    const points = money ? Number(money.points) : null;
    const refillDone = boosted && L.refillUsed && !track.refillUsedAtBoost;
    const refillUse = settings.useRefill && !skips.refill && (refillDone || (!L.refillUsed && (points === null || points >= settings.refillPointCost)));

    // Booster room shared by eDVDs, candy and energy drinks
    const roomStart = settings.boosterCapH * 60 - L.boosterLeft / 60;
    let room = roomStart;
    const boosterUses = [];
    let happyGain = 0, energyGain = 0;

    const dvdWant = settings.useEdvd ? settings.edvdCount : 0;
    const dvdHave = have("erotic dvd");
    const dvdFit = Math.max(0, Math.floor(room / EDVD_MIN));
    const dvdUse = boosted || skips.edvd ? 0 : Math.min(dvdWant, dvdHave ?? dvdWant, dvdFit);
    const dvdShort = boosted || skips.edvd || dvdHave === null ? 0 : Math.max(0, Math.min(dvdWant, dvdFit) - dvdHave);
    if (dvdUse) { boosterUses.push({ name: "Erotic DVD", n: dvdUse }); room -= dvdUse * EDVD_MIN; happyGain += dvdUse * 2500; }
    rows.push({ key: "edvd", label: "eDVDs", want: dvdWant, have: dvdHave, use: dvdUse, short: dvdShort,
      cost: dvdShort * priceOf("erotic dvd"), skipped: !!skips.edvd,
      note: dvdFit < dvdWant && !boosted ? `room for ${dvdFit}` : "" });

    // Drinks come after the stack is trained down and the refill (which fills to max) is used,
    // so only the energy that fits under the 1,000 cap from there counts.
    const drinkCap = 1000 - (refillUse ? L.maxEnergy : 0);
    let drinkRoom = drinkCap;
    // Best first: most happy or energy per minute of booster cooldown, then cheapest for it.
    const rate = i => (i.happy || i.energy) / i.boosterMin;
    const byRate = (a, b) => rate(b) - rate(a) || a.value / (a.happy || a.energy) - b.value / (b.happy || b.energy);
    const fill = (kind, enabled) => {
      // Candy is a pre-boost happy item; drinks are still to come mid-jump unless already drunk.
      if (!enabled || !owned || (boosted && (kind === "candy" || track.drinksAt))) return [];
      const pool = items.filter(i => i.kind === kind && owned[i.name.toLowerCase()] > 0).sort(byRate);
      const used = [];
      for (const it of pool) {
        let n = Math.min(owned[it.name.toLowerCase()], Math.floor(room / it.boosterMin));
        if (kind === "energy") { n = Math.min(n, Math.floor(drinkRoom / it.energy)); drinkRoom -= Math.max(0, n) * it.energy; }
        if (n <= 0) continue;
        room -= n * it.boosterMin;
        used.push({ name: it.name, n, each: it.happy || it.energy, kind });
        if (kind === "candy") happyGain += n * it.happy; else energyGain += n * it.energy;
      }
      return used;
    };
    // Spare room goes to energy drinks before candy: per hour of booster cooldown, a can's energy
    // adds several times more gain than candy's happy.
    const drinks = fill("energy", settings.useEnergyItems && !skips.drinks);
    const candy = fill("candy", settings.useCandy && !skips.candy);
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

    // Energy refill row
    let refillNote = "";
    if (settings.useRefill && !refillDone && L.refillUsed) refillNote = "used today";
    else if (settings.useRefill && points !== null && points < settings.refillPointCost) refillNote = `${points}/${settings.refillPointCost} points`;
    rows.push({ key: "refill", label: "Energy refill", want: settings.useRefill ? 1 : 0, use: refillUse ? 1 : 0,
      short: settings.useRefill && !refillUse && !skips.refill ? 1 : 0, skipped: !!skips.refill, note: refillNote, done: refillDone ? 1 : 0, noBuy: true });

    const happy = boosted ? L.happy * (xtcUse && !track.ecstasyAt ? 2 : 1)
      : (L.maxHappy + happyGain) * (xtcUse ? 2 : 1);
    const energy = stackTarget + (refillUse && !refillDone ? L.maxEnergy : 0) + energyGain + (+settings.extraEnergy || 0);
    const missingCost = rows.reduce((a, r) => a + (r.skipped || r.noBuy ? 0 : r.cost || 0), 0);

    // Shopping list for the full jump: what's short, then the best drinks and candy to fill the
    // booster room left once all the eDVDs you want are in. Only items with a market price are suggested.
    const shopping = [];
    const buy = (name, qty, why) => { if (qty > 0) shopping.push({ name, qty, why, cost: qty * priceOf(name.toLowerCase()) }); };
    if (!boosted) {
      buy("Xanax", xanShort, "to finish your stack");
      buy("Erotic DVD", dvdShort, `for ${Math.min(dvdWant, dvdFit)} eDVDs`);
      buy("Ecstasy", xtcShort, "to double your happy");
      let r = roomStart - (skips.edvd ? 0 : Math.min(dvdWant, dvdFit)) * EDVD_MIN;
      let cap = drinkCap;
      const topUp = (kind, enabled, why) => {
        if (!enabled || !owned) return;
        const fit = it => Math.min(Math.floor(r / it.boosterMin), kind === "energy" ? Math.floor(cap / it.energy) : Infinity);
        const take = (it, n) => { r -= n * it.boosterMin; if (kind === "energy") cap -= n * it.energy; };
        const pool = items.filter(i => i.kind === kind).sort(byRate);
        for (const it of pool) take(it, Math.max(0, Math.min(owned[it.name.toLowerCase()] || 0, fit(it))));
        const best = pool.find(i => i.value > 0);
        if (best && fit(best) > 0) { const n = fit(best); buy(best.name, n, why); take(best, n); }
      };
      topUp("energy", settings.useEnergyItems && !skips.drinks, "to fill booster room with energy");
      topUp("candy", settings.useCandy && !skips.candy, "to fill booster room with happy");
    }

    return { shopping, shoppingCost: shopping.reduce((a, s) => a + s.cost, 0), rows, boosterUses, stacked, stackTarget, xanUse, xanHave, xtcUse, refillUse, refillDone, happy, energy,
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
    const list = uses => uses.map(b => `${b.n}× ${b.name}`).join(", ");
    const boostList = list(plan.boosterUses.filter(b => b.kind !== "energy"));
    const drinkList = list(plan.boosterUses.filter(b => b.kind === "energy"));
    const S = (key, title, action, extra = {}) => ({ key, title, action, plan, ...extra });

    if (settings.paused) return S("paused", "Tracking paused", "Resume when you want to plan a jump.");

    // After the stack is trained down: the refill first (it fills to max rather than adding), then
    // energy drinks (they add, up to the 1,000 cap), then train again.
    const refillLeft = plan.refillUse && !plan.refillDone;
    const after = [...(refillLeft ? ["use your energy refill"] : []), ...(drinkList ? [`drink ${drinkList}`] : [])];
    if (track.boostAt) {
      if (plan.xtcUse && !track.ecstasyAt) {
        if (L.drugLeft > 0) return S("train", "Ecstasy is blocked", `Your drug cooldown has ${HJ.dur(L.drugLeft)} left, so Ecstasy can't be taken in time. Train now before the tick in ${tick}.`, { urgent: true });
        return S("ecstasy", "Take Ecstasy now", `It doubles your current happy. Then train${after.length ? " down to zero" : ""}. Tick in ${tick}.`, { urgent: true });
      }
      if (L.energy >= gym.energy) return S("train", "Train now", `Spend all ${HJ.num(L.energy)} energy before the tick in ${tick}.${after.length ? ` Then ${after.join(", then ")} and train again.` : ""}`, { urgent: true });
      if (refillLeft) return S("refill", "Use your energy refill", `You're out of energy, so it fills you back to ${HJ.num(L.maxEnergy)}. Then ${drinkList ? `drink ${drinkList} and ` : ""}train again before the tick in ${tick}.`, { urgent: true });
      if (drinkList) return S("drink", "Drink your energy cans", `Drink ${drinkList} (+${HJ.num(plan.energyGain)} energy), then train again before the tick in ${tick}.`, { urgent: true });
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
    if (after.length) steps.push("train down to zero", ...after, "train again");
    else steps.push("train everything");
    const blocker = plan.shortages.find(r => r.key === "edvd" || r.key === "ecstasy");
    if (!boostList && !plan.xtcUse) {
      return S("ready", "Ready to train", `Nothing to boost happy with, so this is a normal train at ${HJ.num(L.happy)} happy. ${steps.join(", then ")}.`);
    }
    return S("ready", "Ready to jump", `Right after the next quarter tick (in ${tick}): ${steps.join(", then ")}.`,
      blocker ? { button: { label: `Proceed without ${blocker.label}`, skip: blocker.key } } : {});
  }

  /** The whole jump as ordered steps: done, todo, partial (fewer than planned) or skip, each with the reason.
      The first todo or partial step is marked `next`. */
  function planSteps(ctx) {
    const { settings, track = {}, skips = {} } = ctx;
    const plan = buildPlan(ctx);
    const L = HJ.live(ctx.snap);
    const row = k => plan.rows.find(r => r.key === k);
    const boosted = !!track.boostAt;
    const steps = [];
    const add = (status, title, detail = "") => steps.push({ status, title, detail });
    const chosen = "You chose to go without";

    // One step per Xanax, with runs in the same state merged ("Xanax 1–2").
    const xan = row("xanax");
    const xanTotal = Math.max(settings.xanaxCount, plan.stacked);
    const xanStep = i => i <= plan.stacked ? ["done", "Taken"]
      : boosted ? ["skip", "Not taken before the jump started"]
      : i <= plan.stacked + plan.xanUse ? ["todo", i === plan.stacked + 1 ? "+250 energy. Don't spend energy while stacking." : "+250 energy each"]
      : ["skip", skips.xanax ? chosen : `Not in your inventory (you own ${HJ.num(xan.have)}, short ${xan.short})`];
    for (let i = 1; i <= xanTotal; i++) {
      const [status, detail] = xanStep(i);
      let j = i;
      // The next Xanax keeps its own line so it stands out.
      if (!(status === "todo" && i === plan.stacked + 1)) while (j < xanTotal && xanStep(j + 1)[0] === status) j++;
      add(status, j > i ? `Xanax ${i}–${j}` : `Xanax ${i}`, detail);
      i = j;
    }
    const xanLeft = boosted ? 0 : plan.xanUse;

    if (boosted) {
      add("done", "Boost", `Happy is at ${HJ.num(L.happy)}`);
    } else {
      if (plan.xtcUse) {
        add(xanLeft || L.drugLeft > 0 ? "todo" : "done", "Drug cooldown clears",
          xanLeft ? "Ecstasy needs it clear, so wait after your last Xanax" : L.drugLeft > 0 ? `${HJ.dur(L.drugLeft)} left` : "Clear for Ecstasy");
      }
      add("todo", "Wait for a quarter tick", "Boost right after one so it lasts the full 15 minutes");

      const dvd = row("edvd");
      if (settings.useEdvd && settings.edvdCount > 0) {
        // Only name the limits that actually cut the count.
        const why = [];
        const room = dvd.note ? Number((dvd.note.match(/\d+/) || [])[0]) : Infinity;
        if (dvd.have !== null && dvd.have < settings.edvdCount && dvd.have <= room) why.push(`you own ${dvd.have}`);
        if (room < settings.edvdCount && room <= (dvd.have ?? Infinity)) why.push(`booster cooldown has ${dvd.note}`);
        if (dvd.skipped) add("skip", "eDVDs", chosen);
        else if (!dvd.use) add("skip", "eDVDs", why.length ? `None: ${why.join(", ")}` : "None fit");
        else add(dvd.use < settings.edvdCount ? "partial" : "todo", `${dvd.use}${dvd.use < settings.edvdCount ? ` of ${settings.edvdCount}` : ""} eDVDs`,
          `+${HJ.num(dvd.use * 2500)} happy${why.length ? `. Fewer because ${why.join(" and ")}` : ""}`);
      }
      const uses = kind => plan.boosterUses.filter(b => b.kind === kind);
      for (const b of uses("candy")) add("todo", `${b.n}× ${b.name}`, `+${HJ.num(b.n * b.each)} happy`);
      const candy = row("candy");
      if (settings.useCandy && candy && !uses("candy").length) add("skip", "Candy", skips.candy ? chosen : candy.have === 0 ? "None in your inventory" : "No booster cooldown room left");
    }

    if (settings.useEcstasy) {
      const xtc = row("ecstasy");
      if (track.ecstasyAt) add("done", "Ecstasy", "Taken");
      else if (skips.ecstasy) add("skip", "Ecstasy", chosen);
      else if (!plan.xtcUse) add("skip", "Ecstasy", "Not in your inventory");
      else if (boosted && L.drugLeft > 0) add("skip", "Ecstasy", `Drug cooldown has ${HJ.dur(L.drugLeft)} left, so it can't be taken in time`);
      else add("todo", "Take Ecstasy", `Doubles your happy${xtc.have === null ? "" : ` (you own ${xtc.have})`}`);
    }
    // After the stack is trained down: the refill first (it fills to max rather than adding to what's left),
    // then energy drinks (they add, up to the 1,000 cap), then train again.
    const best = HJ.project(ctx.snap, ctx.gymsCache, settings, plan.happy, plan.energy).best;
    const gain = best ? ` in ${HJ.cap(best.stat)}, about +${HJ.num(best.total)} ${boosted ? "from the energy left" : "for the whole jump"}` : "";
    const trainCost = HJ.gymInfo(ctx.snap, ctx.gymsCache, settings).energy;
    const drinks = plan.boosterUses.filter(b => b.kind === "energy");
    const drinkE = drinks.reduce((a, b) => a + b.n * b.each, 0);
    const refillLeft = plan.refillUse && !plan.refillDone;
    if (!plan.refillUse && !drinks.length && !track.drinksAt) {
      add("todo", "Train", `${HJ.num(plan.energy)} energy at ${HJ.num(plan.happy)} happy${gain}, before the tick`);
    } else {
      const spent = plan.refillDone || !!track.drinksAt || (boosted && L.energy < trainCost);
      add(spent ? "done" : "todo", "Train down to zero", spent ? "Stack spent"
        : `${HJ.num(plan.energy - (refillLeft ? L.maxEnergy : 0) - drinkE)} energy at ${HJ.num(plan.happy)} happy. ` +
          (refillLeft ? "The refill fills to max, so spend it all first." : "Cans stop at 1,000 energy, so drink them once you're low."));
      if (plan.refillDone) add("done", "Energy refill", "Used");
      else if (refillLeft) add("todo", "Use your energy refill", `Fills you back to ${HJ.num(L.maxEnergy)} energy`);
      if (track.drinksAt) add("done", "Energy drinks", "Drunk");
      for (const b of drinks) add("todo", `Drink ${b.n}× ${b.name}`, `+${HJ.num(b.n * b.each)} energy${refillLeft ? ", after the refill" : ""}`);
      add("todo", "Train again", `${HJ.num(spent ? plan.energy : (refillLeft ? L.maxEnergy : 0) + drinkE)} energy${gain}, before the tick`);
    }
    if (settings.useRefill && !plan.refillUse) {
      const refill = row("refill");
      add("skip", "Energy refill", skips.refill ? chosen : refill.note === "used today" ? "Already used today" : refill.note ? `Not enough points (${refill.note})` : "Not available");
    }

    const next = steps.find(s => s.status === "todo" || s.status === "partial");
    if (next) next.next = true;
    return { steps, plan, best };
  }

  /** Plan, addiction status (sized to the Xanax this plan still uses) and current step together. */
  function fullState(base, addictLearn) {
    const pre = buildPlan(base);
    const ad = HJ.addictionStatus(base.snap, base.settings, addictLearn, pre.xanUse);
    return { ad, js: jumpState({ ...base, addictStatus: ad }) };
  }

  return { reduceCatalog, extractInventory, buildPlan, jumpState, fullState, planSteps, classify, LOG_GAIN, LOG_LOSE, logDelta };
})();
if (typeof self !== "undefined") self.HJP = HJP;
