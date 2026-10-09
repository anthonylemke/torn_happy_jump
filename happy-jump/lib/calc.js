/* Shared maths and helpers for Happy Jump Helper. Read-only: nothing here acts on Torn. */
const HJ = (() => {
  const STATS = ["strength", "speed", "dexterity", "defense"];
  // Constants from Vladar's gym gain formula (Torn wiki)
  const STAT_CONST = {
    strength: [1600, 1700],
    speed: [1600, 2000],
    dexterity: [1800, 1500],
    defense: [2100, -600]
  };

  const DEFAULT_SETTINGS = {
    apiKey: "",
    xanaxCount: 4,
    edvdCount: 4,
    useEcstasy: true,
    useRefill: true,
    extraEnergy: 0,
    targetStat: "auto",
    gymDotsOverride: "",
    gymEnergyOverride: "",
    gymBonusOverride: "",
    happyLossPerEnergy: 0.5,
    notifyDrug: true,
    showOverlay: true,
    odRatePct: 2,
    kickPct: 6,
    warnMarginPct: 1,
    notifyAddiction: true,
    notifyOverdose: true,
    boosterCapH: 24,
    useCandy: true,
    useEnergyItems: true,
    refillPointCost: 25,
    paused: false,
    timeDisplay: "tct",
    devVerbose: false
  };

  const r = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

  /** Estimated stat gain from one train. */
  function gainPerTrain(stat, S, H, dots, energyPerTrain, mult) {
    const [A, B] = STAT_CONST[stat];
    let s = S;
    if (s > 5e7) s = (s - 5e7) / (8.77635 * Math.log10(s)) + 5e7;
    const h = Math.max(0, Math.min(H, 99999));
    const v =
      (s * r(1 + 0.07 * r(Math.log(1 + h / 250), 4), 4) +
        8 * Math.pow(h, 1.05) +
        (1 - Math.pow(h / 99999, 2)) * A +
        B) *
      (1 / 200000) * dots * energyPerTrain * mult;
    return Math.max(0, v);
  }

  /** Simulate spending `energy` in one stat, happy draining after each train. */
  function simulate({ stat, S, H, energy, dots, ePerTrain, mult, happyLoss }) {
    const trains = Math.floor(energy / ePerTrain);
    let s = S, h = H, total = 0;
    for (let i = 0; i < trains; i++) {
      const g = gainPerTrain(stat, s, h, dots, ePerTrain, mult);
      s += g; total += g;
      h = Math.max(0, h - ePerTrain * happyLoss);
    }
    return { trains, total, endHappy: h, endStat: s };
  }

  /** Parse "+ x% (stat) gym gains" style perk strings into multipliers. */
  function parseGymPerks(snap) {
    const mult = { strength: 1, speed: 1, dexterity: 1, defense: 1 };
    const found = [];
    const u = snap && snap.user;
    if (!u) return { mult, found };
    for (const [k, v] of Object.entries(u)) {
      if (!k.endsWith("_perks") && k !== "book_perk") continue;
      const list = Array.isArray(v) ? v : [v];
      for (const p of list) {
        if (typeof p !== "string") continue;
        const m = p.match(/\+\s*(\d+(?:\.\d+)?)\s*%\s*(strength|speed|defen[cs]e|dexterity)?\s*gym gain/i);
        if (!m) continue;
        const pct = parseFloat(m[1]) / 100;
        const target = m[2] ? m[2].toLowerCase().replace("defence", "defense") : null;
        for (const st of STATS) if (!target || target === st) mult[st] *= 1 + pct;
        found.push(p.trim());
      }
    }
    return { mult, found };
  }

  /** Active gym info, with dots normalised (the API may report 7.3 as 73). */
  function gymInfo(snap, gymsCache, settings) {
    const id = snap && snap.user && snap.user.active_gym;
    const g = gymsCache && gymsCache.data && id ? gymsCache.data[id] : null;
    const dots = { strength: 0, speed: 0, dexterity: 0, defense: 0 };
    let energy = 10, name = g ? g.name : "Unknown gym";
    if (g) {
      const raw = STATS.map(s => Number(g[s]) || 0);
      const scale = Math.max(...raw) > 12 ? 10 : 1;
      STATS.forEach((s, i) => (dots[s] = raw[i] / scale));
      energy = Number(g.energy) || 10;
    }
    if (settings.gymDotsOverride !== "" && !isNaN(+settings.gymDotsOverride)) {
      STATS.forEach(s => (dots[s] = +settings.gymDotsOverride));
      name += " (manual gains)";
    }
    if (settings.gymEnergyOverride !== "" && +settings.gymEnergyOverride > 0) energy = +settings.gymEnergyOverride;
    return { id, name, dots, energy, known: !!g };
  }

  function multipliers(snap, settings) {
    if (settings.gymBonusOverride !== "" && !isNaN(+settings.gymBonusOverride)) {
      const m = 1 + +settings.gymBonusOverride / 100;
      return { mult: { strength: m, speed: m, dexterity: m, defense: m }, found: [], manual: true };
    }
    return { ...parseGymPerks(snap), manual: false };
  }

  /** Live values, with cooldowns aged by time since the snapshot. */
  function live(snap) {
    const u = snap.user;
    const elapsed = (Date.now() - snap.at) / 1000;
    const cd = u.cooldowns || {};
    return {
      name: u.name,
      energy: u.energy.current, maxEnergy: u.energy.maximum,
      happy: u.happy.current, maxHappy: u.happy.maximum,
      drugLeft: Math.max(0, (cd.drug || 0) - elapsed),
      boosterLeft: Math.max(0, (cd.booster || 0) - elapsed),
      refillUsed: !!u.energy_refill_used,
      stats: { strength: u.strength, speed: u.speed, dexterity: u.dexterity, defense: u.defense }
    };
  }

  function stackTarget(settings) {
    return Math.min(1000, settings.xanaxCount * 250);
  }

  /** Projections per stat for a given happy and energy; picks best or chosen stat. */
  function project(snap, gymsCache, settings, H, energy) {
    const L = live(snap);
    const gym = gymInfo(snap, gymsCache, settings);
    const { mult } = multipliers(snap, settings);
    const rows = STATS.map(stat => {
      const dots = gym.dots[stat];
      if (!dots) return { stat, dots, perTrain: 0, total: 0, trains: 0, current: L.stats[stat], unavailable: true };
      const perTrain = gainPerTrain(stat, L.stats[stat], H, dots, gym.energy, mult[stat]);
      const sim = simulate({ stat, S: L.stats[stat], H, energy, dots, ePerTrain: gym.energy, mult: mult[stat], happyLoss: settings.happyLossPerEnergy });
      return { stat, dots, perTrain, total: sim.total, trains: sim.trains, current: L.stats[stat] };
    });
    let best = rows.filter(x => !x.unavailable).sort((a, b) => b.total - a.total)[0];
    if (settings.targetStat !== "auto") best = rows.find(x => x.stat === settings.targetStat) || best;
    return { rows, best, gym };
  }

  /** Torn ticks on UTC quarter hours. Happy above max decays on these ticks. */
  function msToQuarterTick(now = Date.now()) {
    const q = 15 * 60 * 1000;
    return q - (now % q);
  }

  /* ---------- Addiction & overdose ---------- */
  const DRUG_KEYS = ["cantaken", "exttaken", "kettaken", "lsdtaken", "opitaken", "pcptaken", "shrtaken", "spetaken", "victaken", "xantaken"];

  /** Collect every string inside the icons data, whatever its exact shape. */
  function iconStrings(obj, out = []) {
    if (!obj) return out;
    if (typeof obj === "string") out.push(obj);
    else if (typeof obj === "object") for (const v of Object.values(obj)) iconStrings(v, out);
    return out;
  }

  /** Current addiction debuff as a positive %, from the brain icon or the company record. */
  function readAddiction(snap) {
    const a = snap && snap.addict;
    if (!a) return { pct: null, source: "none", visible: false };
    let pct = null, source = "none";
    for (const t of iconStrings(a.icons)) {
      if (!/addict/i.test(t)) continue;
      const m = t.match(/(-?\d+(?:\.\d+)?)\s*%/);
      if (m) { pct = Math.abs(parseFloat(m[1])); source = "icon"; break; }
    }
    if (typeof a.companyAddiction === "number") {
      const c = Math.abs(a.companyAddiction);
      if (pct === null || c > pct) { pct = c; source = "company"; }
    }
    if (pct === null && a.icons) return { pct: 0, source: "below", visible: false };
    return { pct, source, visible: pct !== null };
  }

  function odChance(ratePct, doses) {
    const p = Math.max(0, Math.min(100, ratePct)) / 100;
    return doses > 0 ? 1 - Math.pow(1 - p, doses) : 0;
  }

  function lifetimeDrugs(ps) {
    if (!ps) return null;
    const taken = DRUG_KEYS.reduce((n, k) => n + (Number(ps[k]) || 0), 0);
    const od = Number(ps.overdosed) || 0;
    return { taken, od, xan: Number(ps.xantaken) || 0, rehabs: Number(ps.rehabs) || 0, rate: taken ? od / taken : null };
  }

  // Torn shows the debuff in whole percents, so one Xanax often doesn't move it. Instead, measure across a
  // run of Xanax: from the first visible % to the latest, rise in % divided by Xanax taken. A run ends, and
  // its estimate is kept, on an overdose, a rehab, any other drug (those add addiction too), the % dropping,
  // or after 36h, when natural decay starts to skew it.
  const RUN_MAX_MS = 36 * 3600 * 1000;

  function runEstimate(run) {
    if (!run) return null;
    const dx = run.endXan - run.xan, dp = run.endPct - run.pct;
    return dx >= 1 && dp > 0 ? dp / dx : null;
  }

  /** Fold one reading ({ xan, other, od, rehabs, pct, at }) into what's been learned about addiction per Xanax. */
  function learnAddiction(learn, now) {
    const out = { samples: [...((learn && learn.samples) || [])], run: learn && learn.run ? { ...learn.run } : null };
    const run = out.run;
    if (run) {
      const broken = now.od !== run.od || now.rehabs !== run.rehabs || now.other !== run.other || now.xan < run.endXan
        || (now.pct !== null && now.pct < run.endPct) || now.at - run.at > RUN_MAX_MS;
      if (broken) {
        const est = runEstimate(run);
        if (est) out.samples = [...out.samples, est].slice(-8);
        out.run = null;
      } else if (now.pct > 0) { run.endXan = now.xan; run.endPct = now.pct; }
    }
    if (!out.run && now.pct > 0) {
      out.run = { xan: now.xan, pct: now.pct, at: now.at, od: now.od, rehabs: now.rehabs, other: now.other, endXan: now.xan, endPct: now.pct };
    }
    return out;
  }

  /** Average addiction % per Xanax from finished runs plus the current one. */
  function perXanaxEstimate(learn) {
    const vals = [...((learn && learn.samples) || [])];
    const cur = runEstimate(learn && learn.run);
    if (cur) vals.push(cur);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }

  /** Everything the UI needs about addiction risk for the current jump. */
  function addictionStatus(snap, settings, learn, xansLeftOverride) {
    const L = live(snap);
    const read = readAddiction(snap);
    const edu = snap.addict && snap.addict.education;
    const inCourse = !!(edu && Number(edu.education_timeleft) > 0);
    const perXan = perXanaxEstimate(learn);
    const warnAt = settings.kickPct - settings.warnMarginPct;
    const target = stackTarget(settings);
    const xansLeft = xansLeftOverride ?? Math.max(0, Math.ceil((target - L.energy) / 250));
    let safeXanax = null;
    if (read.pct !== null && perXan) safeXanax = Math.max(0, Math.floor((warnAt - read.pct) / perXan));
    let level = "ok";
    if (read.pct !== null && read.pct >= warnAt) level = "rehab";
    else if (safeXanax !== null && safeXanax < xansLeft) level = "watch";
    return {
      pct: read.pct, source: read.source, visible: read.visible,
      inCourse, eduLeft: edu ? Number(edu.education_timeleft) || 0 : 0,
      perXan, safeXanax, warnAt, level, xansLeft,
      odStack: odChance(settings.odRatePct, xansLeft),
      odStackWithXtc: odChance(settings.odRatePct, xansLeft + (settings.useEcstasy ? 1 : 0)),
      odFull: odChance(settings.odRatePct, settings.xanaxCount),
      lifetime: lifetimeDrugs(snap.addict && snap.addict.personalstats)
    };
  }

  function dur(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${String(s).padStart(2, "0")}s`;
    return `${s}s`;
  }
  /** Clock time for a timestamp, in Torn City Time (UTC, 24h) or the user's local time per settings.
      Adds the date when it isn't today in that zone. */
  function clock(ms, settings) {
    const tct = settings.timeDisplay !== "local";
    const zone = tct ? { timeZone: "UTC" } : {};
    const day = t => new Date(t).toLocaleDateString("en-CA", zone);
    const time = new Date(ms).toLocaleTimeString(undefined, { hour: tct ? "2-digit" : "numeric", minute: "2-digit", ...zone, ...(tct ? { hourCycle: "h23" } : {}) });
    return day(ms) === day(Date.now()) ? time : `${time} ${new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", ...zone })}`;
  }
  /** "TCT", or the local zone's short name such as "EDT". */
  function zoneLabel(settings) {
    if (settings.timeDisplay !== "local") return "TCT";
    const part = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date()).find(p => p.type === "timeZoneName");
    return part ? part.value : "local";
  }
  const num = (n, d = 0) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  async function getAll() {
    const data = await chrome.storage.local.get(["settings", "snapshot", "gymsCache", "lastError", "addictLearn", "inventory", "catalog", "skips", "jumpTrack", "keyInfo", "logTypes"]);
    data.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    return data;
  }

  return { STATS, DEFAULT_SETTINGS, gainPerTrain, simulate, parseGymPerks, gymInfo, multipliers, live,
    stackTarget, project, msToQuarterTick, dur, clock, zoneLabel, num, cap, getAll,
    readAddiction, odChance, lifetimeDrugs, learnAddiction, perXanaxEstimate, addictionStatus };
})();
if (typeof self !== "undefined") self.HJ = HJ;
