import test from "node:test";
import assert from "node:assert/strict";
import { isConstellationDashboard } from "../../src/constellation-session.ts";
test("only the exact reviewed dashboard origin/path gets the trusted iframe exception", () => {
  const origin = "https://orbit.example";
  assert.equal(
    isConstellationDashboard(new URL(origin + "/constellation/"), origin, true),
    true,
  );
  for (const url of [
    origin + "/api/agent",
    origin + "/constellation/session",
    origin + "/apps/widget/index.html",
    origin + "/constellation/?url=other",
    origin + "/constellation/#other",
    "https://other.example/constellation/",
  ])
    assert.equal(isConstellationDashboard(new URL(url), origin, true), false);
  assert.equal(
    isConstellationDashboard(
      new URL(origin + "/constellation/"),
      origin,
      false,
    ),
    false,
  );
});
