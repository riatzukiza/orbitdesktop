// Protocol-level signed-token tests; no real identity/provider credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import {
  createAxxiumAuth,
  validateAxxiumConfiguration,
  AUTH_PATHS,
  AuthorityUnavailable,
} from "./axxium-auth.mjs";

const issuer = "https://axxium.promethean.rest/oidc";
const origin = "https://orbit.example";
const owner = "actor_existing-human";
const secret = "fixture-confidential-client-secret-32-characters";
const keys = await generateKeyPair("RS256");
const wrongKeys = await generateKeyPair("RS256");
const jwk = {
  ...(await exportJWK(keys.publicKey)),
  kid: "fixture-signing",
  alg: "RS256",
  use: "sig",
};
const config = {
  issuer,
  client_id: "orbit-desktop",
  client_secret: secret,
  allowed_subjects: [owner],
  allow_owner_token: false,
};
const response = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function fixture(overrides = {}) {
  const state = {
    ...overrides,
    revoked: false,
    code: null,
    requests: [],
    introspections: 0,
  };
  const transport = async (input, init = {}) => {
    const url = new URL(input);
    state.requests.push(url.href);
    if (state.unavailable) throw Error("fixture transport unavailable");
    if (url.pathname === "/oidc/.well-known/openid-configuration")
      return response({
        issuer,
        authorization_endpoint: issuer + "/auth",
        token_endpoint: state.evilEndpoint
          ? "https://untrusted.example/token"
          : issuer + "/token",
        jwks_uri: issuer + "/jwks",
        introspection_endpoint: issuer + "/introspection",
        revocation_endpoint: issuer + "/revocation",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      });
    if (url.pathname === "/oidc/jwks") return response({ keys: [jwk] });
    const form = new URLSearchParams(init.body);
    assert.equal(form.get("client_id"), config.client_id);
    assert.equal(form.get("client_secret"), secret);
    if (url.pathname === "/oidc/token") {
      if (form.get("code") !== "fixture-code" || state.code.used)
        return new Response(JSON.stringify({error:"invalid_grant"}),{status:400,headers:{"content-type":"application/json"}});
      state.code.used = true;
      assert.equal(form.get("redirect_uri"), origin + AUTH_PATHS.callback);
      const challenge = await import("openid-client").then((c) =>
        c.calculatePKCECodeChallenge(form.get("code_verifier")),
      );
      assert.equal(
        challenge,
        state.code.challenge,
        "The actual token request must prove PKCE",
      );
      const id = await new SignJWT({
        nonce: state.wrongNonce ? "unbound-nonce" : state.code.nonce,
      })
        .setProtectedHeader({ alg: "RS256", kid: "fixture-signing" })
        .setIssuer(
          state.wrongIssuer ? "https://untrusted.example/oidc" : issuer,
        )
        .setAudience(state.wrongAudience ? "other-client" : config.client_id)
        .setSubject(state.otherSubject || owner)
        .setIssuedAt()
        .setExpirationTime(state.expired ? "1 second ago" : "5m")
        .sign(state.wrongSignature ? wrongKeys.privateKey : keys.privateKey);
      return response({
        access_token: "fixture-access-token",
        token_type: "Bearer",
        expires_in: 300,
        id_token: id,
        scope: "openid profile",
      });
    }
    if (url.pathname === "/oidc/introspection") {
      state.introspections++;
      return response({
        active: !state.revoked,
        client_id: state.foreignClient ? "other-client" : config.client_id,
        sub: state.foreignEvidence
          ? "actor_not-owner"
          : state.otherSubject || owner,
        exp: Math.floor(Date.now() / 1000) + 300,
        scope: state.missingOpenid ? "profile" : "openid profile",
        iss: issuer,
      });
    }
    if (url.pathname === "/oidc/revocation") {
      state.revoked = true;
      return new Response(null, { status: 200 });
    }
    throw Error("Unexpected fixture endpoint");
  };
  const auth = createAxxiumAuth({
    config,
    origin,
    transport,
    clock: () => state.now ?? Date.now(),
  });
  async function begin() {
    const start = await auth.start();
    const url = new URL(start.location);
    assert.equal(url.origin, "https://axxium.promethean.rest");
    assert.equal(url.searchParams.get("scope"), "openid profile");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    state.code = {
      nonce: url.searchParams.get("nonce"),
      challenge: url.searchParams.get("code_challenge"),
    };
    return {
      req: { headers: { cookie: start.cookies[0].split(";")[0] } },
      url: new URL(
        origin +
          AUTH_PATHS.callback +
          "?code=fixture-code&state=" +
          url.searchParams.get("state"),
      ),
    };
  }
  async function login() {
    const start = await begin();
    const completed = await auth.complete(start.req, start.url);
    return {
      headers: {
        cookie: completed.cookies
          .find((c) => c.startsWith("__Host-orbit_axxium_session="))
          .split(";")[0],
      },
    };
  }
  return { state, auth, begin, login };
}

test("configuration requires explicit actor links and pinned HTTPS issuer", () => {
  assert.throws(() =>
    validateAxxiumConfiguration({ ...config, allowed_subjects: [] }, origin),
  );
  assert.throws(() =>
    validateAxxiumConfiguration(
      { ...config, allowed_subjects: ["someone@example.com"] },
      origin,
    ),
  );
  assert.throws(() =>
    validateAxxiumConfiguration(
      { ...config, issuer: "https://other.example" },
      origin,
    ),
  );
  assert.throws(() =>
    validateAxxiumConfiguration(config, "http://orbit.example"),
  );
});
test("real OIDC library verifies signed ID token, nonce, state and PKCE, then rechecks current grant", async () => {
  const f = fixture(),
    req = await f.login();
  assert.equal((await f.auth.authenticate(req)).subject, owner);
  await f.auth.authenticate(req);
  assert.equal(f.state.introspections, 3, "No positive session-status cache");
  assert.equal(f.auth.allowOwnerToken, false);
});
test("an unbound callback cannot consume the legitimate browser transaction", async () => {
  const f = fixture(),
    start = await f.begin();
  await assert.rejects(
    f.auth.complete({ headers: { cookie: "" } }, start.url),
    { status: 401 },
  );
  await f.auth.complete(start.req, start.url);
});
test("a successful callback cannot be replayed", async () => {
  const f = fixture(),
    start = await f.begin();
  await f.auth.complete(start.req, start.url);
  await assert.rejects(f.auth.complete(start.req, start.url), { status: 401 });
});
for (const flag of [
  "wrongNonce",
  "wrongIssuer",
  "wrongAudience",
  "wrongSignature",
  "expired",
  "missingOpenid",
  "foreignClient",
  "foreignEvidence",
]) {
  test("refuses " + flag + " identity evidence", async () => {
    const f = fixture({ [flag]: true }),
      start = await f.begin();
    await assert.rejects(f.auth.complete(start.req, start.url), {
      status: 401,
    });
  });
}
test("another valid Axxium account never becomes desktop owner", async () => {
  const f = fixture({ otherSubject: "actor_someone-else" }),
    start = await f.begin();
  await assert.rejects(f.auth.complete(start.req, start.url), { status: 401 });
});
test("current authority revocation rejects an already issued desktop cookie", async () => {
  const f = fixture(),
    req = await f.login();
  f.state.revoked = true;
  assert.equal(await f.auth.authenticate(req), null);
});
test("authority outage refuses access rather than retaining cached permission", async () => {
  const f = fixture(),
    req = await f.login();
  f.state.unavailable = true;
  await assert.rejects(f.auth.authenticate(req), AuthorityUnavailable);
});
test("discovery cannot move credentials to an untrusted endpoint", async () => {
  const f = fixture({ evilEndpoint: true });
  await assert.rejects(f.auth.start(), AuthorityUnavailable);
  assert.ok(
    f.state.requests.every(
      (url) => new URL(url).origin === "https://axxium.promethean.rest",
    ),
  );
});
test("logout revokes the client grant and destroys the local cookie session", async () => {
  const f = fixture(),
    req = await f.login(),
    result = await f.auth.logout(req);
  assert.equal(result.status, 200);
  assert.equal(f.state.revoked, true);
  assert.equal(await f.auth.authenticate(req), null);
  assert.ok(result.cookies.every((c) => c.includes("Max-Age=0")));
});
test("logout remains local on authority outage and reports unconfirmed revocation", async () => {
  const f = fixture(),
    req = await f.login();
  f.state.unavailable = true;
  assert.equal((await f.auth.logout(req)).status, 503);
  assert.equal(await f.auth.authenticate(req), null);
});
test("expired local session cannot outlive ID/access-token evidence", async () => {
  const f = fixture(),
    req = await f.login();
  f.state.now = Date.now() + 301000;
  assert.equal(await f.auth.authenticate(req), null);
});
test("expired sign-in transaction cannot be redeemed", async () => {
  const f = fixture(),
    start = await f.begin();
  f.state.now = Date.now() + 301000;
  await assert.rejects(f.auth.complete(start.req, start.url), { status: 401 });
});
test("tampered local session cookies do not authenticate", async () => {
  const f = fixture(),
    req = await f.login();
  const altered = req.headers.cookie + "X";
  assert.equal(
    await f.auth.authenticate({ headers: { cookie: altered } }),
    null,
  );
});

test("anonymous sign-in starts cannot fill a shared pending-state map", async () => {
  const f = fixture();
  for (let i = 0; i < 1005; i++) await f.auth.start();
  const req = await f.login();
  assert.equal((await f.auth.authenticate(req)).subject, owner);
});

test("tampered transaction cookies are refused before any token exchange", async () => {
  const f = fixture(), start = await f.begin();
  const before = f.state.requests.length;
  const cookie = start.req.headers.cookie;
  const split = cookie.indexOf('=') + 1;
  const altered = cookie.slice(0, split + 8) + (cookie[split + 8] === 'A' ? 'B' : 'A') + cookie.slice(split + 9);
  await assert.rejects(f.auth.complete({headers:{cookie:altered}}, start.url));
  assert.equal(f.state.requests.length, before);
});

test("concurrent copies of one transaction cannot mint two sessions", async () => {
  const f=fixture(), start=await f.begin();
  const results=await Promise.allSettled([f.auth.complete(start.req,start.url),f.auth.complete(start.req,start.url)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(results.filter(x=>x.status==='rejected').length,1);
});

test("a process-local transaction cannot be redeemed by another adapter instance", async () => {
  const first=fixture(), second=fixture(), start=await first.begin();
  await assert.rejects(second.auth.complete(start.req,start.url));
});

test("arbitrary callback state cannot allocate replay capacity", async () => {
  const f=fixture();
  for(let i=0;i<10005;i++) {
    await assert.rejects(f.auth.complete({headers:{cookie:''}},new URL(origin+AUTH_PATHS.callback+'?code=bad&state=random-'+i)));
  }
  assert.equal((await f.auth.authenticate(await f.login())).subject,owner);
});


test("server-issued states without browser cookies cannot exhaust callback capacity", async () => {
  const f = fixture();
  for (let i=0; i<10005; i++) {
    const started = await f.auth.start();
    const state = new URL(started.location).searchParams.get('state');
    await assert.rejects(f.auth.complete({headers:{cookie:''}}, new URL(origin+AUTH_PATHS.callback+'?code=bad&state='+state)), {status:401});
  }
  assert.equal((await f.auth.authenticate(await f.login())).subject, owner);
});

test("browser-bound invalid authorization codes cannot exhaust callback capacity", async () => {
  const f = fixture();
  for (let i=0; i<10005; i++) {
    const started=await f.begin(); started.url.searchParams.set('code','invalid-code');
    await assert.rejects(f.auth.complete(started.req,started.url),{status:401});
  }
  assert.equal((await f.auth.authenticate(await f.login())).subject,owner);
});


test("a code consumed by a rejected signed-token response cannot be redeemed twice", async () => {
  const f=fixture(), start=await f.begin(); f.state.wrongNonce=true;
  await assert.rejects(f.auth.complete(start.req,start.url),{status:401});
  f.state.wrongNonce=false;
  await assert.rejects(f.auth.complete(start.req,start.url),{status:401});
});
