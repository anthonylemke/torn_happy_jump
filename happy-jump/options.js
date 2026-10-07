window.addEventListener("error", e => {
  if (e.filename && !e.filename.startsWith("chrome-extension://")) return; // ignore Torn's own page errors
  HJLog.error("settings", `Uncaught: ${e.message}`, { file: (e.filename || "").split("/").pop(), line: e.lineno });
});
window.addEventListener("unhandledrejection", e => HJLog.error("settings", `Unhandled rejection: ${e.reason && e.reason.message || e.reason}`));
const $ = id => document.getElementById(id);
const FIELDS = Object.keys(HJ.DEFAULT_SETTINGS);

async function load() {
  const { settings, snapshot } = await HJ.getAll();
  for (const k of FIELDS) {
    const el = $(k); if (!el) continue;
    if (el.type === "checkbox") el.checked = !!settings[k]; else el.value = settings[k];
  }
  if (snapshot) {
    const { found } = HJ.parseGymPerks(snapshot);
    $("perkList").textContent = found.length ? `Gym perks found: ${found.join("; ")}` : "No gym gain perks found in your API data yet.";
  }
}

function read() {
  const out = {};
  for (const k of FIELDS) {
    const el = $(k); if (!el) continue;
    if (el.type === "checkbox") out[k] = el.checked;
    else if (el.type === "number") {
      const isOverride = k.endsWith("Override");
      out[k] = el.value === "" ? (isOverride ? "" : HJ.DEFAULT_SETTINGS[k]) : Number(el.value);
    } else out[k] = el.value.trim();
  }
  out.xanaxCount = Math.max(0, Math.min(4, out.xanaxCount | 0));
  return out;
}

$("save").onclick = async () => {
  const { settings: current } = await HJ.getAll();
  await chrome.storage.local.set({ settings: { ...current, ...read() } });
  $("saved").textContent = "Saved. Updating from Torn…";
  const r = await chrome.runtime.sendMessage({ type: "refresh", force: true });
  $("saved").textContent = r && r.ok ? "Saved and updated." : `Saved, but the update failed: ${r ? r.error : "unknown error"}`;
  HJLog.info("settings", "Settings saved", { ...read(), apiKey: undefined });
  /* ---------- Developer log ---------- */
const LEVELS = { problems: ["error", "warn"], info: ["error", "warn", "info"] };
let logEntries = [];

async function loadDev() {
  const st = await chrome.storage.local.get(["devLog", "invCatStyle", "inventory", "catalog", "keyInfo", "snapshot", "lastStageKey"]);
  logEntries = st.devLog || [];
  const styles = ["Energy Drink", "energy drink", "EnergyDrink", "energy_drink"];
  const inv = st.inventory;
  const rows = [
    ["Extension version", chrome.runtime.getManifest().version],
    ["Browser", navigator.userAgent.match(/(Edg|Chrome|Brave)\/[\d.]+/g)?.join(" ") || navigator.userAgent],
    ["Inventory category spelling", Number.isInteger(st.invCatStyle) ? `"${styles[st.invCatStyle]}" (style #${st.invCatStyle})` : "Not found yet"],
    ["Last inventory read", inv ? `${inv.ok ? "OK" : "Failed"}, ${inv.items.length} rows, ${new Date(inv.at).toLocaleTimeString()}${inv.error ? ` — ${inv.error}` : ""}${inv.partial && inv.partial.length ? ` — partial: ${inv.partial.join("; ")}` : ""}` : "Never"],
    ["Item catalog", st.catalog ? `${Object.keys(st.catalog.items).length} usable items, ${new Date(st.catalog.at).toLocaleString()}` : "Not loaded"],
    ["Key info", st.keyInfo ? (st.keyInfo.error || st.keyInfo.raw) : "Not checked"],
    ["Last update", st.snapshot ? new Date(st.snapshot.at).toLocaleTimeString() : "Never"],
    ["Current step", st.lastStageKey || "–"]
  ];
  $("diag").innerHTML = "";
  for (const [k, v] of rows) {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    $("diag").append(dt, dd);
  }
  renderLog();
}

function filtered() {
  const f = $("logFilter").value;
  return f === "all" ? logEntries : logEntries.filter(e => LEVELS[f].includes(e.lvl));
}

function renderLog() {
  const list = filtered().slice().reverse();
  const view = $("logView");
  view.innerHTML = "";
  if (!list.length) { view.textContent = "No entries yet."; return; }
  for (const e of list) {
    const line = document.createElement("div");
    line.className = e.lvl;
    line.textContent = HJLog.format(e);
    view.appendChild(line);
  }
}

function diagText() {
  const lines = [...$("diag").querySelectorAll("dt")].map(dt => `${dt.textContent}: ${dt.nextElementSibling.textContent}`);
  return `Happy Jump Helper diagnostics\n${lines.join("\n")}\n\nLog (oldest first):\n${filtered().map(HJLog.format).join("\n")}`;
}

$("logFilter").onchange = renderLog;
$("logRefresh").onclick = loadDev;
$("logCopy").onclick = async () => {
  await navigator.clipboard.writeText(diagText());
  $("logStatus").textContent = "Copied to clipboard.";
};
$("logDownload").onclick = () => {
  const url = URL.createObjectURL(new Blob([diagText()], { type: "text/plain" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `happy-jump-log-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.txt` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $("logStatus").textContent = "Downloaded.";
};
$("logClear").onclick = async () => {
  await chrome.storage.local.set({ devLog: [] });
  HJLog.info("settings", "Log cleared");
  $("logStatus").textContent = "Cleared.";
  setTimeout(loadDev, 400);
};
$("devVerbose").onchange = async e => {
  const { settings } = await HJ.getAll();
  await chrome.storage.local.set({ settings: { ...settings, devVerbose: e.target.checked } });
  HJLog.info("settings", `Verbose logging ${e.target.checked ? "on" : "off"}`);
  $("logStatus").textContent = e.target.checked ? "Verbose logging on." : "Verbose logging off.";
};
chrome.storage.onChanged.addListener(ch => { if (ch.devLog && $("dev").open) loadDev(); });
$("dev").addEventListener("toggle", () => { if ($("dev").open) loadDev(); });

load();
};

$("toggleKey").onclick = () => {
  const el = $("apiKey");
  el.type = el.type === "password" ? "text" : "password";
  $("toggleKey").textContent = el.type === "password" ? "Show" : "Hide";
};

$("testKey").onclick = async () => {
  const key = $("apiKey").value.trim();
  const status = $("keyStatus");
  status.className = "hint";
  if (!key) { status.textContent = "Enter a key first."; status.classList.add("bad"); return; }
  status.textContent = "Checking…";
  try {
    const r = await fetch(`https://api.torn.com/user/?selections=basic,bars,cooldowns,battlestats,gym,refills,perks&key=${encodeURIComponent(key)}&comment=HappyJumpHelper`);
    const j = await r.json();
    if (j.error) throw new Error(`Torn API error ${j.error.code}: ${j.error.error}`);
    status.textContent = `Key works for ${j.name} [${j.player_id}]. Save settings to start tracking.`;
    HJLog.info("settings", "Key test passed");
    status.classList.add("ok");
  } catch (e) {
    status.textContent = e.message; status.classList.add("bad");
    HJLog.error("settings", `Key test failed: ${e.message}`);
  }
};

/* ---------- Developer log ---------- */
const LEVELS = { problems: ["error", "warn"], info: ["error", "warn", "info"] };
let logEntries = [];

async function loadDev() {
  const st = await chrome.storage.local.get(["devLog", "invCatStyle", "inventory", "catalog", "keyInfo", "snapshot", "lastStageKey"]);
  logEntries = st.devLog || [];
  const styles = ["Energy Drink", "energy drink", "EnergyDrink", "energy_drink"];
  const inv = st.inventory;
  const rows = [
    ["Extension version", chrome.runtime.getManifest().version],
    ["Browser", navigator.userAgent.match(/(Edg|Chrome|Brave)\/[\d.]+/g)?.join(" ") || navigator.userAgent],
    ["Inventory category spelling", Number.isInteger(st.invCatStyle) ? `"${styles[st.invCatStyle]}" (style #${st.invCatStyle})` : "Not found yet"],
    ["Last inventory read", inv ? `${inv.ok ? "OK" : "Failed"}, ${inv.items.length} rows, ${new Date(inv.at).toLocaleTimeString()}${inv.error ? ` — ${inv.error}` : ""}${inv.partial && inv.partial.length ? ` — partial: ${inv.partial.join("; ")}` : ""}` : "Never"],
    ["Item catalog", st.catalog ? `${Object.keys(st.catalog.items).length} usable items, ${new Date(st.catalog.at).toLocaleString()}` : "Not loaded"],
    ["Key info", st.keyInfo ? (st.keyInfo.error || st.keyInfo.raw) : "Not checked"],
    ["Last update", st.snapshot ? new Date(st.snapshot.at).toLocaleTimeString() : "Never"],
    ["Current step", st.lastStageKey || "–"]
  ];
  $("diag").innerHTML = "";
  for (const [k, v] of rows) {
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    $("diag").append(dt, dd);
  }
  renderLog();
}

function filtered() {
  const f = $("logFilter").value;
  return f === "all" ? logEntries : logEntries.filter(e => LEVELS[f].includes(e.lvl));
}

function renderLog() {
  const list = filtered().slice().reverse();
  const view = $("logView");
  view.innerHTML = "";
  if (!list.length) { view.textContent = "No entries yet."; return; }
  for (const e of list) {
    const line = document.createElement("div");
    line.className = e.lvl;
    line.textContent = HJLog.format(e);
    view.appendChild(line);
  }
}

function diagText() {
  const lines = [...$("diag").querySelectorAll("dt")].map(dt => `${dt.textContent}: ${dt.nextElementSibling.textContent}`);
  return `Happy Jump Helper diagnostics\n${lines.join("\n")}\n\nLog (oldest first):\n${filtered().map(HJLog.format).join("\n")}`;
}

$("logFilter").onchange = renderLog;
$("logRefresh").onclick = loadDev;
$("logCopy").onclick = async () => {
  await navigator.clipboard.writeText(diagText());
  $("logStatus").textContent = "Copied to clipboard.";
};
$("logDownload").onclick = () => {
  const url = URL.createObjectURL(new Blob([diagText()], { type: "text/plain" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `happy-jump-log-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.txt` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $("logStatus").textContent = "Downloaded.";
};
$("logClear").onclick = async () => {
  await chrome.storage.local.set({ devLog: [] });
  HJLog.info("settings", "Log cleared");
  $("logStatus").textContent = "Cleared.";
  setTimeout(loadDev, 400);
};
$("devVerbose").onchange = async e => {
  const { settings } = await HJ.getAll();
  await chrome.storage.local.set({ settings: { ...settings, devVerbose: e.target.checked } });
  HJLog.info("settings", `Verbose logging ${e.target.checked ? "on" : "off"}`);
  $("logStatus").textContent = e.target.checked ? "Verbose logging on." : "Verbose logging off.";
};
chrome.storage.onChanged.addListener(ch => { if (ch.devLog && $("dev").open) loadDev(); });
$("dev").addEventListener("toggle", () => { if ($("dev").open) loadDev(); });

load();
