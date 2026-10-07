window.addEventListener("error", e => {
  if (e.filename && !e.filename.startsWith("chrome-extension://")) return; // ignore Torn's own page errors
  HJLog.error("gym-panel", `Uncaught: ${e.message}`, { file: (e.filename || "").split("/").pop(), line: e.lineno });
});
window.addEventListener("unhandledrejection", e => HJLog.error("gym-panel", `Unhandled rejection: ${e.reason && e.reason.message || e.reason}`));
/* Gym page info panel. Display only — it never clicks or trains for you. */
(() => {
  let state = null;
  const root = document.createElement("aside");
  root.className = "hjh-panel";
  root.setAttribute("aria-label", "Happy jump info");
  root.innerHTML = `
    <div class="hjh-head">
      <strong>Happy jump</strong>
      <span class="hjh-tick" title="Time until the next quarter tick"></span>
      <button class="hjh-min" type="button" aria-label="Collapse panel">–</button>
    </div>
    <div class="hjh-body">
      <p class="hjh-phase"></p>
      <p class="hjh-action"></p>
      <div class="hjh-nums">
        <span>Happy <b class="hjh-happy"></b></span>
        <span>Energy <b class="hjh-energy"></b></span>
      </div>
      <p class="hjh-addict"></p>
      <table class="hjh-table">
        <thead><tr><th>Stat</th><th>Per train</th><th>All energy</th></tr></thead>
        <tbody></tbody>
      </table>
      <p class="hjh-note"></p>
    </div>`;
  const $ = sel => root.querySelector(sel);

  async function load() {
    state = await HJ.getAll();
    if (!state.settings.showOverlay) { root.remove(); return; }
    if (!root.isConnected) document.body.appendChild(root);
    const collapsed = (await chrome.storage.local.get("overlayCollapsed")).overlayCollapsed;
    root.classList.toggle("hjh-collapsed", !!collapsed);
    $(".hjh-min").textContent = collapsed ? "+" : "–";
    render();
  }

  function render() {
    if (!state) return;
    $(".hjh-tick").textContent = `tick ${HJ.dur(HJ.msToQuarterTick() / 1000)}`;
    const { snapshot, settings, gymsCache, lastError } = state;
    if (!snapshot) { $(".hjh-phase").textContent = lastError || "Add your API key in the extension settings."; return; }
    const L = HJ.live(snapshot);
    const { js: p, ad: st } = HJP.fullState({ snap: snapshot, settings, inv: state.inventory, catalog: state.catalog,
      skips: state.skips || {}, track: state.jumpTrack || {}, gymsCache }, state.addictLearn);
    root.dataset.k = { ecstasy: "active", refill: "active", train: "active", ready: "ready", stackTake: "ready",
      stackWait: "stacking", waitDrug: "waitEcstasy", blocked: "waitEcstasy", rehab: "waitEcstasy" }[p.key] || "idle";
    $(".hjh-phase").textContent = p.title;
    $(".hjh-action").textContent = p.action;
    $(".hjh-happy").textContent = `${HJ.num(L.happy)} / ${HJ.num(L.maxHappy)}`;
    $(".hjh-energy").textContent = `${HJ.num(L.energy)} / ${HJ.num(L.maxEnergy)}`;

    const ad = $(".hjh-addict");
    ad.dataset.level = st.level;
    ad.textContent = st.level === "rehab"
      ? `Addiction ${st.pct}% — rehab before your next drug`
      : st.visible ? `Addiction ${st.pct}%${st.safeXanax !== null ? `, ~${st.safeXanax} safe Xanax left` : ""}` : "Addiction below the visible line";
    const proj = HJ.project(snapshot, gymsCache, settings, L.happy, L.energy);
    const tbody = $(".hjh-table tbody");
    tbody.innerHTML = "";
    for (const r of proj.rows) {
      const tr = document.createElement("tr");
      if (proj.best && r.stat === proj.best.stat) tr.className = "hjh-best";
      tr.innerHTML = r.unavailable
        ? `<td>${HJ.cap(r.stat)}</td><td colspan="2">Not trainable here</td>`
        : `<td>${HJ.cap(r.stat)}</td><td>+${HJ.num(r.perTrain, 1)}</td><td>+${HJ.num(r.total)}</td>`;
      tbody.appendChild(tr);
    }
    const age = Math.round((Date.now() - snapshot.at) / 1000);
    $(".hjh-note").textContent = `${proj.gym.name}, ${proj.gym.energy}E per train. Data ${age < 5 ? "just updated" : HJ.dur(age) + " old"}. Estimates only.`;
  }

  $(".hjh-min").onclick = async () => {
    const c = !root.classList.contains("hjh-collapsed");
    root.classList.toggle("hjh-collapsed", c);
    $(".hjh-min").textContent = c ? "+" : "–";
    $(".hjh-min").setAttribute("aria-label", c ? "Expand panel" : "Collapse panel");
    await chrome.storage.local.set({ overlayCollapsed: c });
  };

  chrome.storage.onChanged.addListener(changes => {
    if (Object.keys(changes).every(k => ["overlayCollapsed", "addictNotify", "lastStageKey"].includes(k))) return;
    load();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") chrome.runtime.sendMessage({ type: "refresh" });
  });
  const seen = new Set();
  setInterval(() => {
    try { render(); } catch (e) {
      if (!seen.has(e.message)) { seen.add(e.message); HJLog.error("gym-panel", `Render failed: ${e.message}`, (e.stack || "").split("\n").slice(0, 4).join(" | ")); }
    }
  }, 1000);
  chrome.runtime.sendMessage({ type: "refresh" });
  load();
})();
