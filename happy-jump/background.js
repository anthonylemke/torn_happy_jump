/* Background: polls the Torn API, tracks where you are in a jump, and sends alerts.
   It only READS data. It never performs actions on Torn. */
importScripts("lib/log.js", "lib/calc.js", "lib/plan.js");

self.addEventListener("error", e => HJLog.error("background", `Uncaught: ${e.message}`, { file: e.filename, line: e.lineno }));
self.addEventListener("unhandledrejection", e => HJLog.error("background", `Unhandled rejection: ${e.reason && e.reason.message || e.reason}`));

const API = "https://api.torn.com";
const USER_SELECTIONS = "basic,bars,cooldowns,battlestats,gym,refills,perks";
const EXTRA_SELECTIONS = "icons,personalstats,education,money";
const COMPANY_EVERY_MS = 5 * 60 * 1000;
const INVENTORY_EVERY_MS = 5 * 60 * 1000;
const INVENTORY_ACTIVE_MS = 90 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const ADDICT_ALERT_GAP_MS = 6 * 3600 * 1000;
const NOTIFY_STAGES = {
  stackTake: "Time for your next Xanax",
  ready: "Ready to jump",
  blocked: "Your jump is blocked",
  rehab: "Rehab before your next Xanax",
  waitDrug: "Stack complete"
};

function ensureAlarm() {
  chrome.alarms.create("poll", { periodInMinutes: 1 });
  // Older versions opened a side panel and cleared the popup; restore it for upgraded installs.
  chrome.action.setPopup({ popup: "popup.html" });
}
chrome.runtime.onInstalled.addListener(details => {
  ensureAlarm();
  if (details.reason === "install") chrome.runtime.openOptionsPage();
  if (details.reason === "update") migrateSettings();
  refresh(true);
});
/** One-time fixes to saved settings when the extension updates. */
async function migrateSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  // Old default of 5 eDVDs (30h of booster cooldown) can never fit the 24h cap; drop it to 4.
  if (settings && settings.edvdCount === 5 && (settings.boosterCapH ?? 24) === 24) {
    await chrome.storage.local.set({ settings: { ...settings, edvdCount: 4 } });
    HJLog.info("settings", "eDVDs changed from 5 to 4 to fit the 24h booster cap");
  }
}
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); refresh(); });

// "poll" every minute, plus one-shot alarms when the drug or booster cooldown ends.
chrome.alarms.onAlarm.addListener(() => refresh());

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg && msg.type === "refresh") { refresh(!!msg.force).then(send); return true; }
});

async function apiGet(path, key, { quiet = false } = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(`${API}${path}${sep}key=${encodeURIComponent(key)}&comment=HappyJumpHelper`);
  } catch (e) {
    HJLog.error("api", `Network error on ${path}: ${e.message}`);
    throw e;
  }
  if (!res.ok) {
    HJLog.error("api", `HTTP ${res.status} on ${path}`);
    throw new Error(`Torn API returned HTTP ${res.status}`);
  }
  const j = await res.json();
  if (j.error) {
    (quiet ? HJLog.debug : HJLog.warn)("api", `Error ${j.error.code} (${j.error.error}) on ${path}`);
    throw new Error(`Torn API error ${j.error.code}: ${j.error.error}`);
  }
  HJLog.debug("api", `OK ${path} in ${Date.now() - t0}ms`);
  return j;
}

async function fetchExtra(key, user, prev) {
  const out = { at: Date.now() };
  try {
    const d = await apiGet(`/user/?selections=${EXTRA_SELECTIONS}`, key);
    out.icons = d.icons || Object.fromEntries(Object.entries(d).filter(([k]) => /^icon\d+$/.test(k)));
    out.personalstats = d.personalstats || null;
    out.education = { education_current: d.education_current, education_timeleft: d.education_timeleft };
    out.money = { money_onhand: d.money_onhand, points: d.points };
    const iconTexts = Object.values(out.icons || {}).filter(v => typeof v === "string");
    const addictIcon = iconTexts.find(t => /addict/i.test(t));
    if (addictIcon) HJLog.debug("addiction", "Addiction icon text", addictIcon);
    else HJLog.debug("addiction", `No addiction icon among ${iconTexts.length} icons`, iconTexts.slice(0, 12));
    if (!d.personalstats) HJLog.warn("api", "personalstats missing from response", HJLog.sample(Object.keys(d)));
    if (d.points === undefined) HJLog.warn("api", "money/points missing from response", HJLog.sample(Object.keys(d)));
  } catch (e) { out.error = e.message; HJLog.error("extra", `Addiction/money call failed: ${e.message}`); }

  const old = prev && prev.addict;
  if (old && Date.now() - (old.companyAt || 0) < COMPANY_EVERY_MS) {
    out.companyAddiction = old.companyAddiction; out.companyAt = old.companyAt;
  } else {
    out.companyAt = Date.now();
    try {
      const c = await apiGet("/company/?selections=employees", key, { quiet: true });
      const me = c.company_employees && c.company_employees[user.player_id];
      const v = me && me.effectiveness && me.effectiveness.addiction;
      out.companyAddiction = typeof v === "number" ? v : null;
      HJLog.debug("addiction", `Company addiction value: ${out.companyAddiction}`);
    } catch (e) { out.companyAddiction = null; HJLog.debug("addiction", `Company record unavailable: ${e.message}`); }
  }
  return out;
}

// Inventory needs an item category. These four cover everything a jump uses.
const INV_CATEGORIES = ["Drug", "Booster", "Candy", "Energy Drink"];
// Spellings to try, in case the endpoint wants a different format. The one that works is remembered.
const CAT_STYLES = [c => c, c => c.toLowerCase(), c => c.replace(/\s+/g, ""), c => c.toLowerCase().replace(/\s+/g, "_")];

// Torn caches user/inventory for an hour per category; `inventory.timestamp` is when that copy was taken.
// `timestamp` only skips the 30s service cache. It isn't sent on other calls because there it can mean
// "data as of this time".
async function fetchCategory(key, cat, style) {
  const items = [];
  let cachedAt = null;
  for (let page = 0, offset = 0; page < 5; page++, offset += 100) {
    const j = await apiGet(`/v2/user/inventory?cat=${encodeURIComponent(CAT_STYLES[style](cat))}&limit=100&offset=${offset}&timestamp=${Math.floor(Date.now() / 1000)}`, key, { quiet: true });
    const got = HJP.extractInventory(j);
    if (page === 0) {
      const ts = j && j.inventory && Number(j.inventory.timestamp);
      if (ts > 0) cachedAt = ts * 1000;
      HJLog.debug("inventory", `${cat}: ${got.length} item rows${cachedAt ? `, Torn copy from ${Math.round((Date.now() - cachedAt) / 60000)}m ago` : ""}`, HJLog.sample(j, 800));
      // A non-trivial response with nothing parsed means the response shape has changed,
      // unless it's an empty category (an empty items list, or a total of 0).
      const empty = (j && j._metadata && j._metadata.total === 0) || (j && j.inventory && Array.isArray(j.inventory.items) && !j.inventory.items.length);
      if (!got.length && !empty && JSON.stringify(j).length > 60) HJLog.warn("inventory", `${cat}: response not understood`, HJLog.sample(j));
    }
    items.push(...got);
    if (got.length < 100) break;
  }
  return { items, cachedAt };
}

async function fetchInventory(key) {
  const { invCatStyle } = await chrome.storage.local.get("invCatStyle");
  const items = [];
  const failed = [];
  const failedCats = [];
  const cachedAt = {};
  let style = Number.isInteger(invCatStyle) ? invCatStyle : null;
  for (const cat of INV_CATEGORIES) {
    const tryStyles = style !== null ? [style, ...CAT_STYLES.keys()].filter((v, i, a) => a.indexOf(v) === i) : [...CAT_STYLES.keys()];
    let ok = false, lastErr = "";
    for (const st of tryStyles) {
      try {
        const got = await fetchCategory(key, cat, st);
        items.push(...got.items);
        if (got.cachedAt) cachedAt[cat] = got.cachedAt;
        if (style !== st) {
          style = st;
          await chrome.storage.local.set({ invCatStyle: st });
          HJLog.info("inventory", `Category spelling that works: "${CAT_STYLES[st]("Energy Drink")}" style (#${st}), e.g. cat=${CAT_STYLES[st](cat)}`);
        }
        ok = true;
        break;
      } catch (e) {
        lastErr = e.message;
        if (!/error 21\b/.test(e.message)) break; // only retry spellings on "Incorrect category"
      }
    }
    if (!ok) { failed.push(`${cat}: ${lastErr}`); failedCats.push(cat); HJLog.error("inventory", `Couldn't read category ${cat}`, lastErr); }
  }
  HJLog.debug("inventory", `Read ${items.length} item rows`, items.map(i => `${i.name || i.id}×${i.amount}`).join(", "));
  if (failed.length === INV_CATEGORIES.length) {
    return { ok: false, at: Date.now(), error: failed[0], items: [] };
  }
  // Some categories can fail (e.g. empty ones) without breaking the rest. Items in them count as unknown, not zero.
  return { ok: true, at: Date.now(), items, partial: failed, failedCats, cachedAt };
}

// Torn returns an empty log, not an error, when asked for more than 10 log ids at once.
const LOG_IDS_PER_CALL = 10;

/** Buys and uses since Torn's cached inventory copy, read from your log. Needs a Full Access key. */
async function fetchItemLog(key, cachedAt, catalog, sign) {
  const times = Object.values(cachedAt || {});
  const ids = Object.keys(sign || {});
  if (!times.length || !ids.length) return null;
  const from = Math.floor(Math.min(...times) / 1000);
  const entries = new Map();
  try {
    for (let i = 0; i < ids.length; i += LOG_IDS_PER_CALL) {
      const batch = ids.slice(i, i + LOG_IDS_PER_CALL).join(",");
      let to = null;
      for (let page = 0; page < 5; page++) {
        const j = await apiGet(`/v2/user/log?log=${batch}&from=${from}${to ? `&to=${to}` : ""}&limit=100`, key, { quiet: true });
        const log = j.log || [];
        for (const e of log) entries.set(e.id, e);
        if (log.length < 100) break;
        to = Math.min(...log.map(e => e.timestamp));
      }
    }
  } catch (e) {
    const denied = /error 16\b/.test(e.message); // key access level too low
    (denied ? HJLog.debug : HJLog.warn)("itemlog", `Item log unavailable: ${e.message}`);
    return { at: Date.now(), denied, error: e.message };
  }
  const { delta, applied, unparsed } = HJP.logDelta([...entries.values()], sign, catalog, cachedAt);
  if (unparsed.length) HJLog.warn("itemlog", `${unparsed.length} log entries without items understood`, HJLog.sample(unparsed.slice(0, 3)));
  HJLog.debug("itemlog", `${entries.size} item log entries since ${new Date(from * 1000).toLocaleTimeString()}, ${applied} applied`,
    Object.entries(delta).map(([id, n]) => `${catalog.items[id].name} ${n > 0 ? "+" : ""}${n}`).join(", "));
  return { at: Date.now(), delta, applied };
}

// Alarms, the popup, settings and the gym page can all ask for a refresh at once. Share one run
// so they don't race on stored state; a forced request waits for the current run, then forces its own.
let inflight = null;
function refresh(force = false) {
  if (inflight) return force ? inflight.then(() => refresh(true)) : inflight;
  inflight = doRefresh(force).finally(() => { inflight = null; });
  return inflight;
}

async function doRefresh(force) {
  const st = await HJ.getAll();
  const { settings, gymsCache, snapshot: prev } = st;
  if (!settings.apiKey) {
    await chrome.storage.local.set({ lastError: "Add your API key in the extension settings." });
    return { ok: false, error: "No API key" };
  }
  try {
    const key = settings.apiKey;
    const user = await apiGet(`/user/?selections=${USER_SELECTIONS}`, key);
    const addict = await fetchExtra(key, user, prev);
    const updates = {};

    if (!gymsCache || Date.now() - gymsCache.at > DAY_MS) {
      try { updates.gymsCache = { at: Date.now(), data: (await apiGet("/torn/?selections=gyms", key)).gyms }; } catch (e) { HJLog.error("gyms", `Gym list failed: ${e.message}`); }
    }
    if (!st.keyInfo || Date.now() - st.keyInfo.at > DAY_MS) {
      try {
        const ki = await apiGet("/v2/key/info", key, { quiet: true });
        // The selection lists fill any sample before the useful part, so log the access level when present.
        const access = ki && ki.info && ki.info.access;
        updates.keyInfo = { at: Date.now(), raw: HJLog.sample(access || ki, 600) };
        HJLog.info("key", "Key info", updates.keyInfo.raw);
      } catch (e) { updates.keyInfo = { at: Date.now(), error: e.message }; HJLog.debug("key", `Key info unavailable: ${e.message}`); }
    }
    if (!st.catalog || Date.now() - st.catalog.at > DAY_MS) {
      try {
        updates.catalog = { at: Date.now(), items: HJP.reduceCatalog((await apiGet("/torn/?selections=items", key)).items) };
        const byKind = {};
        for (const it of Object.values(updates.catalog.items)) (byKind[it.kind] = byKind[it.kind] || []).push(`${it.name}(${it.happy || it.energy || ""}/${it.boosterMin || ""}m)`);
        HJLog.info("catalog", `Item catalog loaded: ${Object.keys(updates.catalog.items).length} usable items`, Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, v.length])));
        HJLog.debug("catalog", "Usable items by kind", byKind);
        for (const need of ["xanax", "ecstasy", "erotic dvd"]) {
          if (!Object.values(updates.catalog.items).some(i => i.name.toLowerCase() === need)) HJLog.warn("catalog", `"${need}" not found in item catalog`);
        }
      } catch (e) { HJLog.error("catalog", `Item catalog failed: ${e.message}`); }
    }
    if (!st.logTypes || Date.now() - st.logTypes.at > DAY_MS) {
      try {
        const sign = {};
        for (const t of (await apiGet("/v2/torn/logtypes", key)).logtypes || []) {
          const title = String(t.title).toLowerCase();
          if (HJP.LOG_GAIN.includes(title)) sign[t.id] = 1;
          else if (HJP.LOG_LOSE.includes(title)) sign[t.id] = -1;
        }
        updates.logTypes = { at: Date.now(), sign };
        HJLog.info("itemlog", `Item log types: ${Object.keys(sign).length} found`, sign);
      } catch (e) { HJLog.error("itemlog", `Log type list failed: ${e.message}`); }
    }
    const active = st.jumpTrack && (st.jumpTrack.boostAt || st.jumpTrack.stackXans);
    const invAge = st.inventory ? Date.now() - st.inventory.at : Infinity;
    if (force || invAge > (active ? INVENTORY_ACTIVE_MS : INVENTORY_EVERY_MS)) {
      const inv = updates.inventory = await fetchInventory(key);
      const catalog = updates.catalog || st.catalog, logTypes = updates.logTypes || st.logTypes;
      if (inv.ok && catalog && logTypes) inv.log = await fetchItemLog(key, inv.cachedAt, catalog, logTypes.sign);
    }

    const snapshot = { at: Date.now(), user, addict };
    updates.snapshot = snapshot;
    updates.lastError = null;
    const { jumpTrack, clearSkips } = updateTrack(st.jumpTrack, prev, snapshot,
      HJ.gymInfo(snapshot, updates.gymsCache || gymsCache, settings).energy);
    updates.jumpTrack = jumpTrack;
    if (clearSkips) updates.skips = {};
    await chrome.storage.local.set(updates);

    scheduleCooldownAlarms(snapshot);
    const learn = await trackAddiction(snapshot, settings);
    await reactToStage({ ...st, ...updates, addictLearn: learn });
    await HJLog.flush();
    return { ok: true };
  } catch (e) {
    await chrome.storage.local.set({ lastError: e.message });
    HJLog.error("refresh", `Update failed: ${e.message}`);
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#c0392b" });
    return { ok: false, error: e.message };
  }
}

/** Follow the jump from snapshot to snapshot: Xanax taken, boost start, Ecstasy, end. */
function updateTrack(track, prevSnap, snap, trainCost) {
  const t = { stackXans: 0, ...(track || {}) };
  const L = HJ.live(snap);
  let clearSkips = false;
  if (prevSnap) {
    const P = HJ.live(prevSnap);
    const elapsed = (snap.at - prevSnap.at) / 1000;
    const prevCd = (prevSnap.user.cooldowns || {}).drug || 0;
    const nowCd = (snap.user.cooldowns || {}).drug || 0;
    const drugTaken = nowCd > prevCd - elapsed + 60;
    if (drugTaken) {
      if (L.energy - P.energy >= 200) { t.stackXans += 1; HJLog.info("track", `Xanax detected (${t.stackXans} taken this stack), energy ${P.energy} → ${L.energy}`); }
      else if (L.happy > L.maxHappy && L.happy >= P.happy * 1.6) { t.ecstasyAt = Date.now(); HJLog.info("track", `Ecstasy detected, happy ${P.happy} → ${L.happy}`); }
      else HJLog.info("track", "Drug taken (not Xanax by energy change)", { energy: [P.energy, L.energy], happy: [P.happy, L.happy] });
    }
    if (!t.boostAt && L.happy > L.maxHappy) {
      t.boostAt = Date.now();
      t.refillUsedAtBoost = P.refillUsed;
      t.drugEndAtBoost = prevSnap.at + prevCd * 1000;
      t.statsAtBoost = Object.values(P.stats).reduce((a, b) => a + b, 0);
      HJLog.info("track", `Boost started: happy ${P.happy} → ${L.happy} (max ${L.maxHappy}), energy ${L.energy}`);
    }
  } else if (!t.boostAt && L.happy > L.maxHappy) {
    t.boostAt = Date.now(); t.refillUsedAtBoost = L.refillUsed;
    t.drugEndAtBoost = snap.at + ((snap.user.cooldowns || {}).drug || 0) * 1000;
    t.statsAtBoost = Object.values(L.stats).reduce((a, b) => a + b, 0);
  }
  // Any drug taken after the boost started (that isn't a Xanax) is the Ecstasy.
  if (t.boostAt && !t.ecstasyAt) {
    const drugEnd = snap.at + ((snap.user.cooldowns || {}).drug || 0) * 1000;
    if (drugEnd > (t.drugEndAtBoost || 0) + 60000) { t.ecstasyAt = Date.now(); HJLog.info("track", "Ecstasy detected from new drug cooldown during boost"); }
  }
  // Happy can dip below max mid-train on a small boost, so the jump only ends once energy is
  // spent or a quarter tick has reset happy since the boost started.
  const q = 15 * 60 * 1000;
  const tickPassed = t.boostAt && Math.floor(t.boostAt / q) < Math.floor(snap.at / q);
  if (t.boostAt && L.happy <= L.maxHappy && (L.energy < trainCost || tickPassed)) {
    const total = Object.values(L.stats).reduce((a, b) => a + b, 0);
    t.lastJump = { endedAt: Date.now(), gained: total - (t.statsAtBoost || total) };
    HJLog.info("track", `Jump ended: +${t.lastJump.gained} total stats`);
    delete t.boostAt; delete t.ecstasyAt; delete t.refillUsedAtBoost; delete t.statsAtBoost; delete t.drugEndAtBoost;
    t.stackXans = 0; clearSkips = true;
  }
  if (!t.boostAt && L.energy <= L.maxEnergy) t.stackXans = 0;
  return { jumpTrack: t, clearSkips };
}

async function reactToStage(st) {
  const settings = st.settings;
  const { js: state, ad } = HJP.fullState({ snap: st.snapshot, settings, inv: st.inventory, catalog: st.catalog,
    skips: st.skips || {}, track: st.jumpTrack || {}, gymsCache: st.gymsCache }, st.addictLearn);
  updateBadge(state, ad);

  const { lastStageKey } = await chrome.storage.local.get("lastStageKey");
  if (state.key !== lastStageKey) {
    await chrome.storage.local.set({ lastStageKey: state.key });
    HJLog.info("stage", `${lastStageKey || "none"} → ${state.key}: ${state.title}`, { action: state.action, shortages: state.plan.shortages.map(r => `${r.key}:${r.short}`) });
    if (settings.notifyDrug && !settings.paused && NOTIFY_STAGES[state.key]) {
      notify("stage", NOTIFY_STAGES[state.key], state.action);
    }
  }
}

/** Learn debuff-per-Xanax, spot overdoses and rehabs, and send addiction alerts. */
async function trackAddiction(snap, settings) {
  const { addictLearn = { samples: [] }, addictNotify = {} } = await chrome.storage.local.get(["addictLearn", "addictNotify"]);
  const ps = snap.addict && snap.addict.personalstats;
  if (!ps) return addictLearn;
  const read = HJ.readAddiction(snap);
  const now = { xan: Number(ps.xantaken) || 0, od: Number(ps.overdosed) || 0, rehabs: Number(ps.rehabs) || 0, pct: read.pct, at: Date.now() };
  const last = addictLearn.last;
  if (last) {
    const dXan = now.xan - last.xan;
    const clean = now.od === last.od && now.rehabs === last.rehabs;
    if (clean && dXan > 0 && dXan <= 2 && last.pct > 0 && now.pct > last.pct) {
      addictLearn.samples = [...(addictLearn.samples || []), (now.pct - last.pct) / dXan].slice(-8);
    }
    if (now.od > last.od && settings.notifyOverdose) {
      notify("od", "You overdosed",
        "An overdose adds roughly 2–5× the addiction of a normal dose and usually ruins a stack. Check your addiction and consider rehab before the next drug.");
    }
    if (now.rehabs > last.rehabs) addictNotify.lastAlertAt = 0;
  }
  addictLearn.last = now;

  const st = HJ.addictionStatus(snap, settings, addictLearn);
  const due = Date.now() - (addictNotify.lastAlertAt || 0) > ADDICT_ALERT_GAP_MS;
  if (settings.notifyAddiction && !settings.paused && st.inCourse && due && st.level === "rehab") {
    notify("addict", "Education course at risk",
      `Addiction is at ${st.pct}%, near the education kick line (~${settings.kickPct}%). Rehab before taking more drugs.`);
    addictNotify.lastAlertAt = Date.now();
  }
  await chrome.storage.local.set({ addictLearn, addictNotify });
  return addictLearn;
}

function scheduleCooldownAlarms(snap) {
  const cd = snap.user.cooldowns || {};
  for (const [name, secs] of [["drugReady", cd.drug], ["boosterReady", cd.booster]]) {
    if (secs > 0) chrome.alarms.create(name, { when: snap.at + secs * 1000 + 2000 });
    else chrome.alarms.clear(name);
  }
}

// Badge only when a step is due. Waiting steps (cooldown running, stack building) show nothing.
function updateBadge(state, ad) {
  const map = {
    stackTake: ["XAN", "#e8467c"],
    blocked: ["!", "#b07a1c"],
    ready: ["RDY", "#e8467c"],
    ecstasy: ["GO", "#e8467c"],
    refill: ["GO", "#e8467c"],
    train: ["GO", "#e8467c"],
    rehab: ["RHB", "#c0392b"]
  };
  let [text, color] = map[state.key] || ["", "#555"];
  if (ad.level === "rehab" && !["ecstasy", "refill", "train"].includes(state.key)) { text = "RHB"; color = "#c0392b"; }
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function notify(id, title, message) {
  chrome.notifications.create(`hj-${id}-${Date.now()}`, {
    type: "basic", iconUrl: "icons/icon128.png", title, message, priority: 2
  });
}
