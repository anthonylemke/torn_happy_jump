window.addEventListener("error", e => HJLog.error("popup", `Uncaught: ${e.message}`, { file: (e.filename || "").split("/").pop(), line: e.lineno }));
window.addEventListener("unhandledrejection", e => HJLog.error("popup", `Unhandled rejection: ${e.reason && e.reason.message || e.reason}`));
const $ = id => document.getElementById(id);
let state = null;
let lastRowsKey = "";

// Colour of the step card for each step.
const PHASE_TONE = { ecstasy: "active", refill: "active", train: "active", ready: "ready", stackTake: "ready",
  stackWait: "waiting", waitDrug: "waiting", blocked: "waiting", rehab: "waiting" };
const TICK_STEPS = ["ready", "ecstasy", "refill", "train", "waitDrug"];

async function setSkip(key, on) {
  const skips = { ...(state.skips || {}) };
  if (on) skips[key] = true; else delete skips[key];
  await chrome.storage.local.set({ skips });
  chrome.runtime.sendMessage({ type: "refresh" });
}

function render() {
  const { settings, snapshot, lastError } = state;
  const err = $("error");
  if (!settings.apiKey) {
    err.hidden = false;
    err.innerHTML = 'Add your Torn API key to get started.<br><button id="goSettings">Open settings</button>';
    $("goSettings").onclick = () => chrome.runtime.openOptionsPage();
    $("who").textContent = "No API key";
    return;
  }
  err.hidden = !lastError;
  err.textContent = lastError || "";
  if (!snapshot) { $("who").textContent = "Waiting for first update…"; return; }

  $("main").hidden = false;
  const L = HJ.live(snapshot);
  const age = Math.round((Date.now() - snapshot.at) / 1000);
  $("who").textContent = `${L.name} · updated ${age < 5 ? "just now" : HJ.dur(age) + " ago"}`;

  const { js, ad } = HJP.fullState({ snap: snapshot, settings, inv: state.inventory, catalog: state.catalog,
    skips: state.skips || {}, track: state.jumpTrack || {}, gymsCache: state.gymsCache }, state.addictLearn);
  const plan = js.plan;

  // Current step
  $("phase").dataset.k = PHASE_TONE[js.key] || "idle";
  $("phase").dataset.urgent = !!js.urgent;
  $("phaseTitle").textContent = js.title;
  $("phaseDetail").textContent = js.action;
  $("tickLine").hidden = !TICK_STEPS.includes(js.key);
  $("tick").textContent = HJ.dur(HJ.msToQuarterTick() / 1000);
  const actions = $("phaseActions");
  const btnKey = js.button ? js.button.skip : "";
  if (actions.dataset.k !== btnKey) {
    actions.dataset.k = btnKey;
    actions.textContent = "";
    if (js.button) {
      const b = Object.assign(document.createElement("button"), { className: "btn", textContent: js.button.label });
      b.onclick = () => setSkip(js.button.skip, true);
      actions.appendChild(b);
    }
  }

  // Meters
  const happyScale = Math.max(plan.happy, L.happy, L.maxHappy);
  $("happyVal").textContent = `${HJ.num(L.happy)} / ${HJ.num(L.maxHappy)}`;
  $("happyBar").style.width = `${Math.min(100, (L.happy / happyScale) * 100)}%`;
  $("happyMax").style.left = `${Math.min(100, (L.maxHappy / happyScale) * 100)}%`;
  $("energyVal").textContent = `${HJ.num(L.energy)} / ${HJ.num(plan.stackTarget)}`;
  $("energyBar").style.width = `${Math.min(100, (L.energy / Math.max(plan.stackTarget, 1)) * 100)}%`;
  $("drugCd").textContent = L.drugLeft > 0 ? HJ.dur(L.drugLeft) : "Clear";
  $("boosterCd").textContent = L.boosterLeft > 0 ? HJ.dur(L.boosterLeft) : "Clear";
  $("refill").textContent = L.refillUsed ? "Used" : "Ready";
  $("refill").title = plan.points !== null ? `${HJ.num(plan.points)} points` : "";

  renderRows(plan);
  renderInvAge();

  // Totals for the jump you can actually do
  const proj = HJ.project(snapshot, state.gymsCache, settings, plan.happy, plan.energy);
  const best = proj.best;
  $("planHappy").textContent = HJ.num(plan.happy);
  $("planEnergy").textContent = HJ.num(plan.energy);
  $("planStat").textContent = best ? HJ.cap(best.stat) : "–";
  $("planGain").textContent = best ? `+${HJ.num(best.total)}` : "–";
  const notes = [];
  if (!proj.gym.known) notes.push("Gym data unavailable; set your gym's gains in settings.");
  else if (best) {
    const normal = HJ.project(snapshot, state.gymsCache, settings, L.maxHappy, plan.energy).rows.find(r => r.stat === best.stat);
    if (normal && normal.total > 0) notes.push(`${(best.total / normal.total).toFixed(1)}× a normal train at ${proj.gym.name}.`);
  }
  if (plan.missingCost > 0) notes.push(`Missing items cost ~$${HJ.num(plan.missingCost)}${plan.money !== null ? ` (you have $${HJ.num(plan.money)})` : ""}.`);
  $("planNote").textContent = notes.join(" ");

  renderRisk(ad);
  $("pause").textContent = settings.paused ? "Resume tracking" : "Pause tracking";
  $("resetSkips").hidden = !Object.keys(state.skips || {}).length;
}

function renderRows(plan) {
  const key = JSON.stringify(plan.rows) + plan.inventoryKnown;
  if (key === lastRowsKey) return; // avoid rebuilding buttons every second
  lastRowsKey = key;
  const tb = $("itemRows");
  tb.textContent = "";
  for (const r of plan.rows) {
    if (!r.want && !r.use && !r.skipped && r.key !== "candy") continue;
    const tr = document.createElement("tr");
    if (r.skipped) tr.className = "skipped";
    const status = document.createElement("td");
    if (r.skipped) status.append(miniButton("Undo", () => setSkip(r.key, false)));
    else if (r.short > 0) {
      const short = span("short", r.noBuy ? "Unavailable" : `Short ${r.short}`);
      if (r.cost) short.title = `~$${HJ.num(r.cost)} at market value`;
      status.append(short, miniButton("Skip", () => setSkip(r.key, true), "Proceed without"));
    } else if (r.done) status.append(span("ok", "Done"));
    else if (r.use) status.append(span("ok", "✓"));
    const label = document.createElement("td");
    label.textContent = r.label;
    if (r.note) label.append(Object.assign(document.createElement("small"), { textContent: r.note }));
    label.title = r.note ? `${r.label}: ${r.note}` : r.label;
    tr.append(label, cell(r.use || 0), cell(r.have === null || r.have === undefined ? "–" : HJ.num(r.have)), status);
    tb.appendChild(tr);
  }

  const inv = state.inventory;
  const partial = inv && inv.ok && inv.partial && inv.partial.length;
  $("invNote").hidden = plan.inventoryKnown && !partial;
  $("invNote").textContent = partial
    ? `Some item categories couldn't be read, so they show as unknown (–) and the plan assumes you have them: ${inv.partial.join("; ")}`
    : inv && inv.error
    ? `Couldn't read your inventory (${inv.error}). Planning as if you have everything; skip anything you don't.`
    : "Reading your inventory…";
}

// Torn only refreshes its inventory copy hourly. Buys and uses since then come from your log when
// the key allows it; otherwise say how stale the counts are.
const INV_CACHE_MS = 60 * 60 * 1000;
function renderInvAge() {
  const inv = state.inventory;
  const times = Object.values((inv && inv.ok && inv.cachedAt) || {});
  const log = inv && inv.log;
  let text = "";
  if (log && !log.error) {
    if (log.applied) text = `Includes ${log.applied} buy${log.applied === 1 ? "" : "s"}/use${log.applied === 1 ? "" : "s"} from your log since Torn's hourly inventory update.`;
  } else if (times.length) {
    const oldest = Math.min(...times);
    const age = Date.now() - oldest;
    if (age > 2 * 60 * 1000) {
      const next = oldest + INV_CACHE_MS - Date.now();
      text = `Torn updates inventory hourly: counts are from ${Math.round(age / 60000)}m ago, next update ${next > 60000 ? `in ~${Math.ceil(next / 60000)}m` : "soon"}.` +
        (log && log.denied ? " A Full Access key shows buys and uses right away." : " New buys show up then.");
    }
  }
  $("invAge").textContent = text;
}

const cell = text => Object.assign(document.createElement("td"), { textContent: text });
const span = (className, text) => Object.assign(document.createElement("span"), { className, textContent: text });
function miniButton(text, onclick, title = "") {
  return Object.assign(document.createElement("button"), { className: "mini", textContent: text, title, onclick });
}

function renderRisk(st) {
  const { settings, snapshot } = state;
  $("risk").dataset.level = st.level;
  const pct = $("addPct");
  if (!snapshot.addict || snapshot.addict.error) {
    pct.textContent = "–";
    pct.title = snapshot.addict ? "Couldn't read addiction data" : "Waiting for data";
  } else if (st.visible) {
    pct.textContent = `${st.pct}%`;
    pct.title = st.source === "company" ? "From your company record" : "From your brain icon";
  } else {
    pct.textContent = "Low";
    pct.title = "Too low for Torn to show";
  }
  $("safeXan").textContent = st.safeXanax !== null ? String(st.safeXanax) : "Learning";
  $("safeXan").title = st.safeXanax !== null ? `~${st.perXan.toFixed(2)}% per Xanax, learned` : "Updates after your next Xanax with a visible debuff";
  $("odStack").textContent = st.xansLeft ? `${(st.odStack * 100).toFixed(1)}%` : "Done";
  $("odStack").title = `${st.xansLeft} Xanax left at ${settings.odRatePct}% per dose (community estimate). Including Ecstasy: ${(st.odStackWithXtc * 100).toFixed(1)}%.`;

  let msg = "";
  if (st.level === "rehab") msg = `Rehab before your next drug: you're past your rehab line (${st.warnAt}%), near the ~${settings.kickPct}% education kick.`;
  else if (st.level === "watch") msg = `Your stack needs ${st.xansLeft} more Xanax but only ~${st.safeXanax} fit under your rehab line.`;
  else if (st.inCourse) msg = `In a course (${HJ.dur(st.eduLeft)} left), clear of the kick line for now.`;
  $("riskMsg").textContent = msg;
}

async function load() { state = await HJ.getAll(); render(); }

$("refresh").onclick = async () => {
  $("refresh").classList.add("spin");
  await chrome.runtime.sendMessage({ type: "refresh", force: true });
  $("refresh").classList.remove("spin");
};
$("openSettings").onclick = () => chrome.runtime.openOptionsPage();
$("pause").onclick = async () => {
  await chrome.storage.local.set({ settings: { ...state.settings, paused: !state.settings.paused } });
  chrome.runtime.sendMessage({ type: "refresh" });
};
$("resetSkips").onclick = async () => {
  await chrome.storage.local.set({ skips: {} });
  chrome.runtime.sendMessage({ type: "refresh" });
};
// Storage changes (new data, skips, settings) re-render; the timer keeps countdowns live.
chrome.storage.onChanged.addListener(changes => {
  if (Object.keys(changes).every(k => ["addictNotify", "lastStageKey", "devLog"].includes(k))) return;
  load();
});
const seenErrors = new Set();
setInterval(() => {
  if (!state) return;
  try { render(); } catch (e) {
    if (!seenErrors.has(e.message)) { seenErrors.add(e.message); HJLog.error("popup", `Render failed: ${e.message}`, (e.stack || "").split("\n").slice(0, 4).join(" | ")); }
  }
}, 1000);
load();
chrome.runtime.sendMessage({ type: "refresh" });
