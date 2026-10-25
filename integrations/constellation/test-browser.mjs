// Real application journey in a separate workspace. No model calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
const source = path.dirname(new URL(import.meta.url).pathname);
const original = JSON.parse(
  fs.readFileSync(
    process.env.ORBIT_CONSTELLATION_CONFIG ||
      path.join(os.homedir(), ".config/orbit/constellation.json"),
  ),
);
const scratch = fs.mkdtempSync(
  path.join(
    process.env.ORBIT_TEST_SCRATCH || os.tmpdir(),
    "orbit-constellation-test-",
  ),
);
const cfg = {
  ...original,
  axxium: undefined, // This journey preserves the explicit legacy migration path.
  gateway_port: 14321,
  port: 14320,
  workspace_id: crypto.randomUUID(),
  state: path.join(scratch, "state"),
  token: crypto.randomBytes(32).toString("base64url"),
};
const configPath = path.join(scratch, "config.json");
fs.writeFileSync(configPath, JSON.stringify(cfg), { mode: 0o600 });
const env = { ...process.env, ORBIT_CONSTELLATION_CONFIG: configPath };
const bridge = spawn("python3", [path.join(source, "bridge.py"), "serve"], {
  env,
  stdio: "ignore",
});
const gateway = spawn(process.execPath, [path.join(source, "gateway.mjs")], {
  env,
  stdio: "ignore",
});
const base = "http://127.0.0.1:14321";
let browser;
try {
  for (let n = 0; n < 80; n++) {
    try {
      if ((await fetch(base + "/health")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal((await fetch(base + "/constellation/api/snapshot")).status, 401);
  assert.equal(
    (
      await fetch(base + "/constellation/api/tool", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + cfg.token,
          "Content-Type": "application/json",
          Origin: "https://untrusted.example",
        },
        body: JSON.stringify({ name: "orbit_projects", arguments: {} }),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/api/agent", {
        method: "POST",
        headers: { Authorization: "Bearer " + cfg.token },
        body: "{}",
      })
    ).status,
    401,
  );
  const executable =
    process.env.ORBIT_TEST_BROWSER ||
    path.join(
      os.homedir(),
      ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
    );
  browser = await chromium.launch({
    executablePath: executable,
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1500, height: 1000 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/login");
  await page
    .getByLabel("Orbit owner token")
    .fill(fs.readFileSync(cfg.orbit_token_file, "utf8").trim());
  await page.getByRole("button", { name: "Unlock desktop" }).click();
  await page.waitForURL(base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelector("#app")?.children.length > 0,
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem("orbit.workspace.id")),
    cfg.workspace_id,
  );
  const accessPath = path.join(
    cfg.orbit_runtime,
    "workspace-access",
    cfg.workspace_id + ".json",
  );
  for (let n = 0; n < 100 && !fs.existsSync(accessPath); n++)
    await new Promise((r) => setTimeout(r, 100));
  const access = JSON.parse(fs.readFileSync(accessPath));
  const control = async (body) => {
    const r = await fetch(access.api + "/api/workspace/control", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + access.capability,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workspace_id: cfg.workspace_id, ...body }),
    });
    assert.equal(r.status, 200);
    return r.json();
  };
  const state = await control({ action: "read" });
  const applied = await control({
    action: "apply",
    base_revision: state.revision,
    operation_id: crypto.randomUUID(),
    intent: "Isolated Constellation browser verification",
    operations: [
      {
        action: "add_window",
        kind: "browser",
        name: "Constellation test",
        url: base + "/constellation/",
        frame: { x: 20, y: 20, width: 1180, height: 800, z: 20 },
      },
      { action: "set_view", view: "windows" },
    ],
  });
  const added = await control({ action: "read" });
  const selected = await control({
    action: "apply",
    base_revision: added.revision,
    operation_id: crypto.randomUUID(),
    intent: "Select the isolated test dashboard",
    operations: [
      {
        action: "select",
        window_id: added.state.monitors.find(
          (m) => m.name === "Constellation test",
        ).id,
      },
    ],
  });
  await page.waitForFunction(
    () => document.querySelectorAll("iframe").length > 0,
  );
  const frame = page.frameLocator("iframe").last();
  await frame
    .getByRole("heading", { name: "OpenPlanner memory" })
    .waitFor({ timeout: 30000 });
  await frame.locator("#hosts .host").first().waitFor({ timeout: 35000 });
  assert.equal(await frame.locator("#hosts .host").count(), 3);
  assert.ok(
    (await control({ action: "read" })).observed_revision >= selected.revision,
  );
  await page.goto(base + "/constellation/");
  await page.locator("#hosts .host").first().waitFor({ timeout: 35000 });
  assert.equal(await page.locator("#hosts .host").count(), 3);
  assert.ok((await page.locator("#sessions .session").count()) > 0);
  await page.getByLabel("Find a context, idea, or memory").fill("orbit");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.waitForFunction(
    () =>
      !document.querySelector("#results")?.textContent.includes("Searching…"),
  );
  assert.ok(
    (await page.locator("#results .result").count()) > 0,
    "OpenPlanner must return actual result rows, not merely an error message",
  );
  const screenshot =
    process.env.ORBIT_TEST_SCREENSHOT || path.join(scratch, "dashboard.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => ({
    fits: document.documentElement.scrollWidth <= innerWidth,
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflow: [...document.querySelectorAll("body *")]
      .filter(node => node.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 12).map(node => ({tag:node.tagName,id:node.id,className:node.className,right:node.getBoundingClientRect().right})),
  }));
  assert.equal(mobile.fits, true, JSON.stringify(mobile));
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        "owner login",
        "unauthorized API rejection",
        "origin rejection",
        "MCP token cannot unlock owner API",
        "shared workspace bootstrap",
        "real iframe rendering",
        "browser revision acknowledgement in isolated workspace",
        "three live host cards",
        "recorded contexts",
        "OpenPlanner search",
        "mobile layout",
      ],
      screenshot,
      workspace_id: cfg.workspace_id,
      scratch,
    }),
  );
} finally {
  await browser?.close();
  bridge.kill();
  gateway.kill();
}
