// Builds dist/happy-jump-v<version>.zip from the committed extension folder.
// Usage: node scripts/package.mjs   (commit first: only committed files are packed)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

if (git("status", "--porcelain", "--", "happy-jump")) {
  console.warn("Warning: happy-jump/ has uncommitted changes; they won't be in the zip.");
}
const { version } = JSON.parse(readFileSync(join(root, "happy-jump", "manifest.json"), "utf8"));
const out = join("dist", `happy-jump-v${version}.zip`);
mkdirSync(join(root, "dist"), { recursive: true });
// The zip holds a single happy-jump/ folder with manifest.json at its top, ready for "Load unpacked".
git("archive", "--format=zip", "--prefix=happy-jump/", "-o", out, "HEAD:happy-jump");
console.log(`Wrote ${out}`);
