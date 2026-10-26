// Inspect the public sign-in entry in a fresh, unauthenticated browser context.
// This never fabricates an Axxium login or claims issuer activation.
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright-core";
const origin =
  process.env.ORBIT_VERIFY_ORIGIN || "https://orbit.promethean.rest";
const browser = await chromium.launch({
  executablePath:
    process.env.ORBIT_TEST_BROWSER ||
    path.join(
      os.homedir(),
      ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
    ),
  headless: true,
});
try {
  const context = await browser.newContext({
    viewport: { width: 1100, height: 800 },
  });
  const page = await context.newPage();
  await page.goto(origin + "/login");
  const link = page.getByRole("link", { name: "Sign in with Axxium" });
  assert.equal(await link.getAttribute("href"), "/auth/axxium/start");
  if (process.env.ORBIT_TEST_SCREENSHOT)
    await page.screenshot({
      path: process.env.ORBIT_TEST_SCREENSHOT,
      fullPage: true,
    });
  const status = await context.request.get(origin + "/auth/axxium/status");
  assert.equal(status.status(), 200);
  const value = await status.json();
  assert.equal(value.issuer, "https://axxium.promethean.rest/oidc");
  const start = await context.request.get(origin + "/auth/axxium/start", {
    maxRedirects: 0,
  });
  assert.equal(start.status(), value.available ? 303 : 503);
  if (!value.available)
    assert.match(await start.text(), /Axxium shared sign-in is unavailable/);
  assert.equal(
    (
      await context.request.get(origin + "/constellation/api/snapshot")
    ).status(),
    401,
  );
  console.log(
    JSON.stringify({
      entry_verified: true,
      issuer: value.issuer,
      authority_available: value.available,
      authorization_start_status: start.status(),
      anonymous_private_api_status: 401,
      real_identity_login_verified: false,
    }),
  );
} finally {
  await browser.close();
}
