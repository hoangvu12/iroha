// Signs in to a running Iroha as the Owner and screenshots one page.
//
// Usage (see SKILL.md, "UI pages"):
//   NODE_PATH=<dir>/node_modules node screenshot.cjs <base_url> <owner_password> <path> <out.png> [--full] [--width=1440] [--height=900]
//
// Prints one JSON line: the URL shown, the page title, the screenshot path
// and any console errors or failed requests, so a verdict can quote them.
const fs = require("fs");
const nodePath = require("path");
const { chromium } = require("playwright-core");

// The newest Chromium under ms-playwright, so any playwright-core version
// works with the browser already installed. IROHA_CHROME overrides it.
function chrome() {
  if (process.env.IROHA_CHROME) return process.env.IROHA_CHROME;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH
    || (process.env.LOCALAPPDATA && nodePath.join(process.env.LOCALAPPDATA, "ms-playwright"))
    || nodePath.join(require("os").homedir(), ".cache", "ms-playwright");
  const dirs = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)) : [];
  dirs.sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const d of dirs) {
    for (const exe of ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux64/chrome", "chrome-linux/chrome"]) {
      const p = nodePath.join(root, d, exe);
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined; // playwright-core's own lookup
}

async function main() {
  const args = process.argv.slice(2);
  const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.slice(2).split("=");
    return [k, v ?? true];
  }));
  const [base, password, path, out] = args.filter((a) => !a.startsWith("--"));
  if (!base || !password || !path || !out) {
    console.error("usage: node screenshot.cjs <base_url> <owner_password> <path> <out.png> [--full] [--width=1440] [--height=900]");
    process.exit(2);
  }
  if (/^[a-zA-Z]:[\\/]/.test(path)) {
    console.error(`"${path}" is a file path: Git Bash rewrote the page path. Pass it without the leading slash (providers/openrouter) or set MSYS_NO_PATHCONV=1.`);
    process.exit(2);
  }
  const browser = await chromium.launch({ executablePath: chrome() });
  try {
    const context = await browser.newContext({
      viewport: { width: Number(flags.width ?? 1440), height: Number(flags.height ?? 900) },
    });
    // Sign in the way the UI does; the session cookie lands in this context.
    const res = await context.request.post(new URL("/api/session", base).href, { data: { password } });
    if (res.status() !== 201) {
      throw new Error(`sign-in answered ${res.status()}: ${await res.text()} (is owner_password from the launcher's JSON?)`);
    }
    const page = await context.newPage();
    const problems = [];
    // "Failed to load resource" repeats a response below, without its URL.
    page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) problems.push(`console: ${m.text()}`); });
    page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
    page.on("requestfailed", (r) => problems.push(`request failed: ${r.method()} ${r.url()} ${r.failure()?.errorText ?? ""}`));
    // Logos answer 404 under iroha-dev (it fetches none); the page draws a letter instead.
    page.on("response", (r) => {
      if (r.status() >= 400 && !/\/logo(\?|$)|\/api\/logos\?/.test(r.url())) problems.push(`HTTP ${r.status()}: ${r.request().method()} ${r.url()}`);
    });
    await page.goto(new URL(path, base).href, { waitUntil: "networkidle" });
    await page.waitForTimeout(Number(flags.settle ?? 500)); // let entrance motion finish
    await page.screenshot({ path: out, fullPage: Boolean(flags.full) });
    console.log(JSON.stringify({ url: page.url(), title: await page.title(), screenshot: out, problems }));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(`screenshot.cjs: ${e.message}`);
  process.exit(1);
});
