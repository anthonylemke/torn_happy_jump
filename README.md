# Torn Happy Jump Helper

A browser extension for Chrome, Edge and Brave that plans and tracks your [Torn](https://www.torn.com) happy jumps from your own API data. It tells you what to do next, using the items you actually own.

It only **reads** your data. It never clicks, buys, trains or uses items for you, so it stays within Torn's rules on scripts and tools.

## What it does

- **Knows which step you're on.** From your energy, happy, cooldowns and refill, it works out where you are: not stacking yet, stacking Xanax, waiting on your drug cooldown, ready to jump, Ecstasy, refill, training, done.
- **Plans with your inventory.** It reads your Xanax, eDVDs, Ecstasy, candy, energy drinks, points and cash, fits boosters into your booster cooldown, and shows what you're short on and roughly what it costs.
- **Lets you skip what you don't have.** Use **Skip** on any item and the plan rebuilds without it.
- **Alerts you.** A notification when it's time for your next Xanax, when your stack is complete and when you're ready to jump. The icon badge shows `XAN`, `WAIT`, `RDY`, `GO` or `RHB` at a glance.
- **Watches addiction and overdose risk.** Your debuff, how many Xanax you can take before your rehab line, overdose odds for the rest of the stack, and warnings if your education course is at risk.
- **Estimates gains.** Per-stat estimates from Vladar's gym formula, plus an info panel on Torn's gym page with a quarter-tick countdown.

## Install

1. **Download** `happy-jump-vX.Y.Z.zip` from the [latest release](https://github.com/anthonylemke/torn_happy_jump/releases/latest).
2. **Unzip** it. You'll get a `happy-jump` folder.
3. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`) and turn on **Developer mode**.
4. Click **Load unpacked** and choose the `happy-jump` folder (the one that contains `manifest.json`).
5. The settings page opens. Paste your Torn API key, click **Test key**, then **Save settings**.
6. Pin the extension to your toolbar and click its icon to open the popup.

A **Limited Access** key is enough. Create one on Torn under *Settings → API Keys*.

**Updating:** download the new zip, replace your `happy-jump` folder with the new one, then press the reload icon on the extension in `chrome://extensions`. Your settings are kept.

## Privacy

Your API key and data stay in your browser's extension storage and are only ever sent to `api.torn.com`. The built-in developer log masks your key.

## Support

Enjoying the helper? In-game donations and tips are appreciated: [toneykey #4412379](https://www.torn.com/profiles.php?XID=4412379).

## License

[GPL-3.0](LICENSE)
