window.addEventListener("error", e => {
  if (e.filename && !e.filename.startsWith("chrome-extension://")) return; // ignore Torn's own page errors
  HJLog.error("panel", `Uncaught: ${e.message}`, { file: (e.filename || "").split("/").pop(), line: e.lineno });
});
window.addEventListener("unhandledrejection", e => HJLog.error("panel", `Unhandled rejection: ${e.reason && e.reason.message || e.reason}`));
const $ = id => document.getElementById(id);
let state = null;
let lastRowsKey = "";

function ctx() {
  return { snap: state.snapshot, settings: state.settings, inv: state.inventory, catalog: state.catalog,
    skips: state.skips || {}, track: state.jumpTrack || {}, gymsCache: state.gymsCache };
}

async function setSkip(key, on) {
  const skips = { ...(state.skips || {}) };
  if (on) skips[key] = true; else delete skips[key];
  state.skips = skips;
  await chrome.storage.local.set({ skips });
  lastRowsKey = "";
  render();
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
  if (lastError) { err.hidden = false; err.textContent = lastError; } else err.hidden = true;
  if (!snapshot) { $("who").textContent = "Waiting for first update…"; return; }

  $("main").hidden = false;
  const L = HJ.live(snapshot);
  const age = Math.round((Date.now() - snapshot.at) / 1000);
  $("who").textContent = `${L.name} · updated ${age < 5 ? "just now" : HJ.dur(age) + " ago"}`;

  const { js, ad } = HJP.fullState(ctx(), state.addictLearn);
  const plan = js.plan;

  // Current step
  $("phase").dataset.k = { stackWait: "stacking", stackTake: "ready", waitDrug: "waitEcstasy", blocked: "waitEcstasy",
    ready: "ready", ecstasy: "active", refill: "active", train: "active", rehab: "waitEcstasy" }[js.key] || "idle";
  $("phase").dataset.urgent = !!js.urgent;
  $("phaseTitle").textContent = js.title;
  $("phaseDetail").textContent = js.action;
  $("tickLine").hidden = !["ready", "ecstasy", "refill", "train", "waitDrug"].includes(js.key);
  $("tick").textContent = HJ.dur(HJ.msToQuarterTick() / 1000);
  const actions = $("phaseActions");
  const btnKey = js.button ? js.button.skip : "";
  if (actions.dataset.k !== btnKey) {
    actions.dataset.k = btnKey;
    actions.innerHTML = "";
    if (js.button) {
      const b = document.createElement("button");
      b.className = "btn primary";
      b.textContent = js.button.label;
      b.onclick = () => setSkip(js.button.skip, true);
      actions.appendChild(b);
    }
  }
  const lj = state.jumpTrack && state.jumpTrack.lastJump;
  $("lastJump").hidden = !(lj && Date.now() - lj.endedAt < 12 * 3600 * 1000);
  if (lj) $("lastJump").textContent = `Last jump ${HJ.dur((Date.now() - lj.endedAt) / 1000)} ago: +${HJ.num(lj.gained)} total battle stats.`;

  // Meters
  const happyScale = Math.max(plan.happy, L.happy, L.maxHappy);
  $("happyVal").textContent = `${HJ.num(L.happy)} / ${HJ.num(L.maxHappy)}`;
  $("happyBar").style.width = `${Math.min(100, (L.happy / happyScale) * 100)}%`;
  $("happyMax").style.left = `${Math.min(100, (L.maxHappy / happyScale) * 100)}%`;
  const target = Math.max(plan.stackTarget, 1);
  $("energyVal").textContent = `${HJ.num(L.energy)} / ${HJ.num(plan.stackTarget)}`;
  $("energyBar").style.width = `${Math.min(100, (L.energy / target) * 100)}%`;
  $("drugCd").textContent = L.drugLeft > 0 ? HJ.dur(L.drugLeft) : "Clear";
  $("boosterCd").textContent = L.boosterLeft > 0 ? HJ.dur(L.boosterLeft) : "Clear";
  $("refill").textContent = `${L.refillUsed ? "Used" : "Ready"}${plan.points !== null ? ` · ${HJ.num(plan.points)} pts` : ""}`;

  renderRows(plan);

  // Totals for the jump you can actually do
  const proj = HJ.project(snapshot, state.gymsCache, settings, plan.happy, plan.energy);
  const normal = HJ.project(snapshot, state.gymsCache, settings, L.maxHappy, plan.energy);
  const best = proj.best;
  $("planHappy").textContent = HJ.num(plan.happy);
  $("planEnergy").textContent = HJ.num(plan.energy);
  $("planStat").textContent = best ? HJ.cap(best.stat) : "–";
  $("planGain").textContent = best ? `+${HJ.num(best.total)}` : "–";
  const ns = best && normal.rows.find(r => r.stat === best.stat);
  $("planCompare").textContent = best && ns && ns.total > 0
    ? `About ${(best.total / ns.total).toFixed(1)}× what this energy gets at normal max happy. ${proj.gym.name}, ${proj.gym.energy}E per train.`
    : proj.gym.known ? "" : "Gym data unavailable. Set your gym's gains and energy per train in settings.";

  const parts = [];
  if (plan.missingCost > 0) parts.push(`Buying what's missing costs about $${HJ.num(plan.missingCost)} at market value.`);
  if (plan.money !== null) parts.push(`You have $${HJ.num(plan.money)} on hand.`);
  $("moneyLine").textContent = parts.join(" ");

  renderRisk(ad);
  $("pause").textContent = settings.paused ? "Resume tracking" : "Pause tracking (not jumping now)";
  $("foot").textContent = "Gains are estimates from Vladar's gym formula. You perform every action yourself in Torn.";
}

function renderRows(plan) {
  const key = JSON.stringify(plan.rows) + plan.inventoryKnown;
  if (key === lastRowsKey) return; // avoid rebuilding buttons every second
  lastRowsKey = key;
  const tb = $("itemRows");
  tb.innerHTML = "";
  for (const r of plan.rows) {
    if (!r.want && !r.use && !r.skipped && r.key !== "candy") continue;
    const tr = document.createElement("tr");
    if (r.skipped) tr.className = "skipped";
    const haveTxt = r.have === null || r.have === undefined ? "–" : HJ.num(r.have);
    let status = "";
    if (r.skipped) status = `<button class="mini" data-undo="${r.key}">Undo</button>`;
    else if (r.short > 0) {
      const cost = r.cost ? `~$${HJ.num(r.cost)}` : "";
      status = `<span class="short">${r.noBuy ? "Unavailable" : `Short ${r.short}`} ${cost}</span><button class="mini" data-skip="${r.key}">Proceed without</button>`;
    } else if (r.done) status = `<span class="ok">Done</span>`;
    else if (r.use) status = `<span class="ok">✓</span>`;
    tr.innerHTML = `<td>${r.label}${r.note ? `<small>${r.note}</small>` : ""}</td><td>${r.use || 0}</td><td>${haveTxt}</td><td>${status}</td>`;
    tb.appendChild(tr);
  }
  tb.querySelectorAll("[data-skip]").forEach(b => (b.onclick = () => setSkip(b.dataset.skip, true)));
  tb.querySelectorAll("[data-undo]").forEach(b => (b.onclick = () => setSkip(b.dataset.undo, false)));

  const inv = state.inventory;
  const partial = inv && inv.ok && inv.partial && inv.partial.length;
  $("invNote").hidden = plan.inventoryKnown && !partial;
  $("invNote").textContent = partial
    ? `Some item categories couldn't be read, so they show as 0 owned: ${inv.partial.join("; ")}`
    : inv && inv.error
    ? `Couldn't read your inventory (${inv.error}). Planning as if you have everything; use "Proceed without" for anything you don't.`
    : "Reading your inventory…";
}

function renderRisk(st) {
  const { settings, snapshot } = state;
  $("risk").dataset.level = st.level;
  if (!snapshot.addict || snapshot.addict.error) {
    $("addPct").textContent = "–";
    $("addSrc").textContent = snapshot.addict && snapshot.addict.error ? "Couldn't read addiction data" : "Waiting for data";
  } else if (st.visible) {
    $("addPct").textContent = `${st.pct}%`;
    $("addSrc").textContent = st.source === "company" ? "From your company record" : "From your brain icon";
  } else {
    $("addPct").textContent = "Under icon";
    $("addSrc").textContent = "Too low for Torn to show";
  }
  const scale = Math.max(settings.kickPct * 1.25, st.pct || 0, 1);
  $("addBar").style.width = `${Math.min(100, ((st.pct || 0) / scale) * 100)}%`;
  $("addWarn").style.left = `${(st.warnAt / scale) * 100}%`;
  $("addKick").style.left = `${Math.min(99, (settings.kickPct / scale) * 100)}%`;
  if (st.safeXanax !== null) {
    $("safeXan").textContent = String(st.safeXanax);
    $("safeNote").textContent = `~${st.perXan.toFixed(2)}% per Xanax, learned`;
  } else {
    $("safeXan").textContent = "Learning";
    $("safeNote").textContent = st.visible ? "Updates after your next Xanax" : "Needs a visible debuff";
  }
  let msg;
  if (st.level === "rehab") msg = `Rehab before your next drug. You're at or past your rehab line (${st.warnAt}%), close to the ~${settings.kickPct}% education kick.`;
  else if (st.level === "watch") msg = `Your stack needs ${st.xansLeft} more Xanax but only about ${st.safeXanax} fit under your rehab line.`;
  else msg = st.inCourse ? "You're clear of the education kick line for now." : "Not in a course, so there's no kick risk. Addiction still lowers battle stats and job effectiveness.";
  $("riskMsg").textContent = msg;
  $("odStack").textContent = st.xansLeft ? `${(st.odStack * 100).toFixed(1)}% (${st.xansLeft} Xanax)` : "Stack done";
  $("odStack").title = `At ${settings.odRatePct}% per dose (community estimate). Including Ecstasy: ${(st.odStackWithXtc * 100).toFixed(1)}%.`;
  const lt = st.lifetime;
  $("odLife").textContent = lt && lt.rate !== null ? `${(lt.rate * 100).toFixed(1)}% (${lt.od}/${HJ.num(lt.taken)})` : "–";
  $("eduState").textContent = st.inCourse ? `In course, ${HJ.dur(st.eduLeft)} left` : "No course";
}

async function load() { state = await HJ.getAll(); render(); }

$("refresh").onclick = async () => {
  $("refresh").classList.add("spin");
  await chrome.runtime.sendMessage({ type: "refresh", force: true });
  $("refresh").classList.remove("spin");
  lastRowsKey = "";
  load();
};
$("openSettings").onclick = () => chrome.runtime.openOptionsPage();
$("pause").onclick = async () => {
  const settings = { ...state.settings, paused: !state.settings.paused };
  await chrome.storage.local.set({ settings });
  chrome.runtime.sendMessage({ type: "refresh" });
};
$("resetSkips").onclick = async () => { await chrome.storage.local.set({ skips: {} }); lastRowsKey = ""; chrome.runtime.sendMessage({ type: "refresh" }); };
chrome.storage.onChanged.addListener(changes => {
  if (Object.keys(changes).every(k => ["addictNotify", "lastStageKey"].includes(k))) return;
  load();
});
const seenErrors = new Set();
setInterval(() => {
  if (!state) return;
  try { render(); } catch (e) {
    if (!seenErrors.has(e.message)) { seenErrors.add(e.message); HJLog.error("panel", `Render failed: ${e.message}`, (e.stack || "").split("\n").slice(0, 4).join(" | ")); }
  }
}, 1000);
load();
chrome.runtime.sendMessage({ type: "refresh" });
