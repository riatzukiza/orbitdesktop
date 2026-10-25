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

test("unavailable owner session fails closed without rejecting desktop startup", async () => {
  const names = ["document", "location", "localStorage", "fetch"];
  const saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let calls = 0, writes = 0;
  try {
    Object.defineProperty(globalThis, "document", {configurable:true,value:{documentElement:{dataset:{orbitShared:"1"}}}});
    Object.defineProperty(globalThis, "location", {configurable:true,value:{protocol:"https:",hostname:"orbit.example"}});
    Object.defineProperty(globalThis, "localStorage", {configurable:true,value:{setItem(){writes++;}}});
    for (const [label, response] of [
      ["unauthorized", () => new Response("not authorized", {status:401})],
      ["invalid", () => Response.json({workspace_id:"invalid",token:"x"})],
      ["offline", () => {throw Error("offline");}],
    ]) {
      Object.defineProperty(globalThis, "fetch", {configurable:true,value:async()=>{calls++;return response();}});
      const module = await import(`../../src/constellation-session.ts?failure=${label}`);
      assert.equal(module.sharedOrbitSession, null);
    }
    assert.equal(calls,3);assert.equal(writes,0);
  } finally {
    for (const name of names) {
      const descriptor=saved.get(name);
      if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];
    }
  }
});
