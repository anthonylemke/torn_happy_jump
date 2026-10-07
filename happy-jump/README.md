# Torn Happy Jump Helper

A Chrome / Edge / Brave extension that reads your Torn API data and tells you what to do next in a happy jump, using the items you actually have.

## Install
1. Unzip the download. You'll get this `happy-jump` folder.
2. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and pick the `happy-jump` folder. (Updating? Replace the folder and press the reload icon on the extension.)
4. In settings, paste your API key, click **Test key**, then **Save settings**.
5. Pin the extension and click its icon to open the popup.

## How it works
- **It knows where you are.** From your energy, happy, drug and booster cooldowns, refill status and recent changes, it detects each step: not stacking yet (no alerts until your first Xanax), stacking Xanax, waiting on the drug cooldown, ready to boost, Ecstasy, refill, training, and done. There's no checklist to tick.
- **It plans with your inventory.** It reads your items (Xanax, eDVDs, Ecstasy, candy, energy drinks), your points and your cash. The plan uses what you own and fits boosters into your remaining booster cooldown room.
- **Short on something?** Each missing item shows how many you need and roughly what it costs at market value. Press **Skip** (or **Proceed without** on the current step) and the plan rebuilds around what you have, for example a candy-only jump, no Ecstasy, or a smaller stack. Skips reset automatically after each jump.
- **Alerts:** a notification whenever your next step changes (time for a Xanax, stack complete, ready to jump, blocked, rehab first). The badge shows `XAN`, stack energy, `WAIT`, `RDY`, `GO` or `RHB`.
- **Addiction and overdose:** debuff %, safe Xanax count before your rehab line, overdose odds for the rest of your stack, and education kick-risk warnings.
- **Gym page panel:** your current step, live happy/energy, quarter-tick countdown and per-stat gain estimates.
- **Not jumping right now?** Use **Pause tracking** in the popup to silence step alerts.

## What it does not do
It never clicks, buys, trains or uses items. Torn allows tools that read the API and display information, not ones that act for you.

## Notes
- Inventory comes from Torn's API v2 `user/inventory`. If it can't be read, the plan assumes you have everything and you can **Skip** anything you don't have.
- Candy and energy drink values are read from each item's description in Torn's item list. Booster cap (24h), refill cost (25 points), overdose chance (2%) and the education kick line (6%) are adjustable in settings.
- Gains are estimates from Vladar's gym formula with an approximate happy loss per train.
- Your key stays in this browser and is only sent to api.torn.com.

## Developer log
Settings → **Developer log** shows errors, warnings and what the extension has learned about the API (inventory category spelling, item catalog contents, key access level, step changes, detected Xanax/Ecstasy/boost events). Turn on **Verbose logging** to also record every API call and raw response samples. Use **Copy log** or **Download** to share it. The API key is never written to the log. The log keeps the most recent 400 entries.
