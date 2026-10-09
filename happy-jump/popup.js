window.addEventListener("error", e => HJLog.error("popup", `Uncaught: ${e.message}`, { file: (e.filename || "").split("/").pop(), line: e.lineno }));
window.addEventListener("unhandledrejection", e => HJLog.error("popup", `Unhandled rejection: ${e.reason && e.reason.message || e.reason}`));
const $ = id => document.getElementById(id);
let state = null;
let lastRowsKey = "";

// Colour of the step card for each step.
const PHASE_TONE = { ecstasy: "active", refill: "active", drink: "active", train: "active", ready: "ready", stackTake: "ready",
  stackWait: "waiting", waitDrug: "waiting", blocked: "waiting", rehab: "waiting" };
const TICK_STEPS = ["ready", "ecstasy", "refill", "drink", "train", "waitDrug"];

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
  if (document.body.classList.contains("plan-mode")) renderSteps();
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
  $("safeXan").title = st.safeXanax !== null ? `~${st.perXan.toFixed(2)}% per Xanax, learned` : "Learns from how your addiction % rises across your Xanax. Needs a visible debuff (1% or more) and usually 1–3 Xanax.";
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
/** The current step and plan as plain text. Cooldowns are clock times (TCT or local, per settings), since pasted text can't count down. */
function planText() {
  const { settings, snapshot } = state;
  const { js, ad } = HJP.fullState({ snap: snapshot, settings, inv: state.inventory, catalog: state.catalog,
    skips: state.skips || {}, track: state.jumpTrack || {}, gymsCache: state.gymsCache }, state.addictLearn);
  const plan = js.plan;
  const L = HJ.live(snapshot);
  const at = secs => HJ.clock(Date.now() + secs * 1000, settings);
  const lines = [
    `Happy jump · ${L.name} · ${at(0)} ${HJ.zoneLabel(settings)}`,
    js.title,
    js.action,
    `Drug ${L.drugLeft > 0 ? `ready ${at(L.drugLeft)}` : "clear"} · Booster ${L.boosterLeft > 0 ? `ready ${at(L.boosterLeft)}` : "clear"} · Refill ${L.refillUsed ? "used" : "ready"}`,
    `Happy ${HJ.num(L.happy)}/${HJ.num(L.maxHappy)} · Energy ${HJ.num(L.energy)}/${HJ.num(plan.stackTarget)}`,
    ""
  ];
  for (const r of plan.rows) {
    if (!r.want && !r.use && !r.skipped && r.key !== "candy") continue;
    const parts = r.skipped ? ["skipped"] : [`use ${r.use || 0}`];
    if (!r.skipped && r.have !== null && r.have !== undefined) parts.push(`own ${HJ.num(r.have)}`);
    if (!r.skipped && r.short > 0) parts.push(r.noBuy ? "unavailable" : `short ${r.short}`);
    lines.push(`${r.label}: ${parts.join(", ")}${r.note ? ` (${r.note})` : ""}`);
  }
  const best = HJ.project(snapshot, state.gymsCache, settings, plan.happy, plan.energy).best;
  lines.push("", `Jump: ${HJ.num(plan.happy)} happy · ${HJ.num(plan.energy)} energy${best ? ` → ${HJ.cap(best.stat)} +${HJ.num(best.total)}` : ""}`);
  if (plan.shopping.length) lines.push(`To buy: ${plan.shopping.map(s => `${s.qty}× ${s.name}`).join(", ")} (~$${HJ.num(plan.shoppingCost)})`);
  if (ad.pct !== null) lines.push(`Addiction ${ad.pct}% · OD risk ${(ad.odStack * 100).toFixed(1)}%`);
  return lines.join("\n");
}
$("copyPlan").onclick = async () => {
  const b = $("copyPlan");
  if (!state || !state.snapshot) return;
  try { await navigator.clipboard.writeText(planText()); b.textContent = "Copied ✓"; }
  catch (e) { b.textContent = "Couldn't copy"; HJLog.error("popup", `Copy plan failed: ${e.message}`); }
  setTimeout(() => { b.textContent = "Copy plan"; }, 2000);
};
const STEP_MARK = { done: "✓", todo: "○", partial: "◐", skip: "✕" };
const STEP_LABEL = { done: "Done", todo: "To do", partial: "Fewer than planned", skip: "Dropped" };
function renderSteps() {
  const { settings, snapshot } = state;
  const { steps, plan } = HJP.planSteps({ snap: snapshot, settings, inv: state.inventory, catalog: state.catalog,
    skips: state.skips || {}, track: state.jumpTrack || {}, gymsCache: state.gymsCache });
  const ol = $("steps");
  ol.textContent = "";
  for (const s of steps) {
    const li = document.createElement("li");
    li.dataset.status = s.status;
    if (s.next) li.dataset.next = "";
    const mark = Object.assign(document.createElement("span"), { className: "mark", textContent: s.next ? "▶" : STEP_MARK[s.status] });
    mark.title = s.next ? "Next" : STEP_LABEL[s.status];
    const body = document.createElement("div");
    body.append(Object.assign(document.createElement("b"), { textContent: s.title }));
    if (s.detail) body.append(Object.assign(document.createElement("small"), { textContent: s.detail }));
    li.append(mark, body);
    ol.appendChild(li);
  }
  const dropped = steps.filter(s => s.status === "skip" || s.status === "partial").length;
  renderShopping(plan);
  $("stepsNote").textContent = [
    dropped ? `${dropped} reduced or dropped. Change with Skip/Undo on the main view.` : ""
  ].filter(Boolean).join(" ");
}

function renderShopping(plan) {
  const { settings } = state;
  $("optEdvd").checked = !!settings.useEdvd;
  $("optDrinks").checked = !!settings.useEnergyItems;
  $("optCandy").checked = !!settings.useCandy;
  const ul = $("shopList");
  ul.textContent = "";
  for (const s of plan.shopping) {
    const li = document.createElement("li");
    const what = document.createElement("span");
    what.append(`${s.qty}× ${s.name} `, Object.assign(document.createElement("small"), { textContent: s.why }));
    li.append(what, Object.assign(document.createElement("span"), { className: "cost", textContent: s.cost ? `~$${HJ.num(s.cost)}` : "–" }));
    ul.appendChild(li);
  }
  $("shopNote").textContent = !plan.inventoryKnown ? "Waiting for your inventory to work out what to buy."
    : plan.shopping.length ? `Total ~$${HJ.num(plan.shoppingCost)} at market value${plan.money !== null ? ` (you have $${HJ.num(plan.money)})` : ""}.`
    : "Nothing to buy: you have everything for this plan.";
}
const setOpt = (key, on) => {
  chrome.storage.local.set({ settings: { ...state.settings, [key]: on } });
  chrome.runtime.sendMessage({ type: "refresh" });
};
$("optEdvd").onchange = e => setOpt("useEdvd", e.target.checked);
$("optDrinks").onchange = e => setOpt("useEnergyItems", e.target.checked);
$("optCandy").onchange = e => setOpt("useCandy", e.target.checked);

function setPlanMode(on) {
  document.body.classList.toggle("plan-mode", on);
  const b = $("viewPlan");
  b.setAttribute("aria-pressed", String(on));
  b.title = on ? "Back to current status" : "Show plan steps";
  b.setAttribute("aria-label", b.title);
  try { localStorage.setItem("hjPlanMode", on ? "1" : ""); } catch (e) { /* storage unavailable: just don't remember */ }
  if (state && state.snapshot && state.settings.apiKey) render();
}
$("viewPlan").onclick = () => setPlanMode(!document.body.classList.contains("plan-mode"));

function setPlanTab(tab) {
  $("planView").dataset.tab = tab;
  $("tabSteps").setAttribute("aria-selected", String(tab === "steps"));
  $("tabShop").setAttribute("aria-selected", String(tab === "shop"));
  try { localStorage.setItem("hjPlanTab", tab); } catch (e) { /* storage unavailable: just don't remember */ }
}
$("tabSteps").onclick = () => setPlanTab("steps");
$("tabShop").onclick = () => setPlanTab("shop");
try { setPlanTab(localStorage.getItem("hjPlanTab") === "shop" ? "shop" : "steps"); } catch (e) { setPlanTab("steps"); }
try { if (localStorage.getItem("hjPlanMode")) setPlanMode(true); } catch (e) { /* ignore */ }

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
