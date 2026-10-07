/* Developer log: a small ring buffer in extension storage.
   Never stores the API key; anything that looks like one is masked. */
const HJLog = (() => {
  const MAX = 400;
  const KEY_RE = /\b[A-Za-z0-9]{16}\b/g;
  let queue = [];
  let timer = null;
  let verbose = false;

  chrome.storage.local.get("settings").then(r => { verbose = !!(r.settings && r.settings.devVerbose); });
  chrome.storage.onChanged.addListener(ch => {
    if (ch.settings) verbose = !!(ch.settings.newValue && ch.settings.newValue.devVerbose);
  });

  function clean(v, depth = 0) {
    if (v === null || v === undefined) return v;
    if (typeof v === "string") return v.replace(/key=[^&\s]+/gi, "key=***").replace(KEY_RE, m => (/\d/.test(m) && /[a-z]/i.test(m) ? "***key***" : m)).slice(0, 2000);
    if (typeof v !== "object") return v;
    if (depth > 4) return "[…]";
    if (Array.isArray(v)) return v.slice(0, 30).map(x => clean(x, depth + 1));
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = /apikey|^key$/i.test(k) ? "***" : clean(x, depth + 1);
    return out;
  }

  function add(lvl, src, msg, data) {
    if (lvl === "debug" && !verbose) return;
    queue.push({ t: Date.now(), lvl, src, msg: clean(String(msg)), data: data === undefined ? undefined : clean(data) });
    if (!timer) timer = setTimeout(flush, 250);
  }

  async function flush() {
    timer = null;
    if (!queue.length) return;
    const batch = queue; queue = [];
    const { devLog = [] } = await chrome.storage.local.get("devLog");
    await chrome.storage.local.set({ devLog: [...devLog, ...batch].slice(-MAX) });
  }

  /** Short, readable sample of a raw API response for debugging its shape. */
  function sample(obj, max = 1500) {
    try { return clean(JSON.stringify(obj)).slice(0, max); } catch (e) { return String(obj).slice(0, max); }
  }

  function format(e) {
    const d = new Date(e.t);
    const ts = `${d.toISOString().slice(0, 10)} ${d.toTimeString().slice(0, 8)}`;
    return `${ts} [${e.lvl}] ${e.src}: ${e.msg}${e.data !== undefined ? " " + (typeof e.data === "string" ? e.data : JSON.stringify(e.data)) : ""}`;
  }

  return {
    error: (src, msg, data) => add("error", src, msg, data),
    warn: (src, msg, data) => add("warn", src, msg, data),
    info: (src, msg, data) => add("info", src, msg, data),
    debug: (src, msg, data) => add("debug", src, msg, data),
    flush, sample, format
  };
})();
if (typeof self !== "undefined") self.HJLog = HJLog;
