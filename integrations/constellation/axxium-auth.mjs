// SPDX-License-Identifier: GPL-3.0-or-later
// Orbit's relying-party adapter. Axxium remains identity/session authority;
// openid-client owns the protocol, PKCE and signed-token validation.
import crypto from "node:crypto";
import * as oidc from "openid-client";

const ISSUER = "https://axxium.promethean.rest/oidc";
export const AUTH_PATHS = {
  start: "/auth/axxium/start",
  callback: "/auth/axxium/callback",
  logout: "/auth/axxium/logout",
  status: "/auth/axxium/status",
};
const sessionCookie = "__Host-orbit_axxium_session";
const transactionCookie = "__Host-orbit_axxium_transaction";
const random = () => crypto.randomBytes(32).toString("base64url");
const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
function cookieValue(header, name) {
  return (
    (header || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(name + "="))
      ?.slice(name.length + 1) || ""
  );
}
function cookie(name, value, seconds) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
}
export class AuthorityUnavailable extends Error {
  constructor() {
    super(
      "Axxium shared sign-in is unavailable. The identity authority must be activated before this desktop can use it.",
    );
    this.status = 503;
  }
}
function denied() {
  return Object.assign(
    new Error(
      "Axxium sign-in was refused. Start sign-in again with the approved desktop identity.",
    ),
    { status: 401 },
  );
}

export function validateAxxiumConfiguration(config, origin) {
  if (!config) return null;
  const publicUrl = new URL(origin);
  if (
    config.issuer !== ISSUER ||
    publicUrl.protocol !== "https:" ||
    publicUrl.origin !== origin ||
    publicUrl.username ||
    publicUrl.password
  )
    throw Error(
      "Axxium requires the fixed shared issuer and exact HTTPS desktop origin",
    );
  if (
    typeof config.client_id !== "string" ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(config.client_id) ||
    typeof config.client_secret !== "string" ||
    config.client_secret.length < 32
  )
    throw Error("Axxium requires an explicit registered confidential client");
  if (
    !Array.isArray(config.allowed_subjects) ||
    !config.allowed_subjects.length ||
    config.allowed_subjects.length > 16 ||
    new Set(config.allowed_subjects).size !== config.allowed_subjects.length ||
    config.allowed_subjects.some(
      (s) => typeof s !== "string" || !/^actor_[A-Za-z0-9-]{1,128}$/.test(s),
    )
  )
    throw Error(
      "Axxium requires explicitly approved actor subjects; email and role matching are not supported",
    );
  if (
    config.allow_owner_token !== undefined &&
    typeof config.allow_owner_token !== "boolean"
  )
    throw Error("Invalid owner-token migration setting");
  return Object.freeze({
    ...config,
    allowed_subjects: Object.freeze([...config.allowed_subjects]),
  });
}

export function createAxxiumAuth({
  config,
  origin,
  transport,
  clock = Date.now,
}) {
  const cfg = validateAxxiumConfiguration(config, origin);
  if (!cfg) return null;
  const callback = origin + AUTH_PATHS.callback;
  // Anonymous starts allocate no server-side pending state. Short-lived
  // consumed callback digests preserve one-use, including failed attempts.
  const transactions = new Map(), sessions = new Map(), inFlight = new Set();
  const transactionKey = crypto.randomBytes(32);
  const transactionAad = Buffer.from(origin + "|" + cfg.issuer + "|" + cfg.client_id);
  function sealTransaction(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", transactionKey, iv);
    cipher.setAAD(transactionAad);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  }
  function openTransaction(value) {
    if (!value || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw denied();
    try {
      const bytes = Buffer.from(value, "base64url");
      if (bytes.length < 29) throw denied();
      const decipher = crypto.createDecipheriv("aes-256-gcm", transactionKey, bytes.subarray(0, 12));
      decipher.setAAD(transactionAad);
      decipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
    } catch { throw denied(); }
  }
  let discovery;
  const approved = (subject) => cfg.allowed_subjects.includes(subject);
  function prune() {
    const at = clock();
    for (const [key, value] of transactions)
      if (value.expiresAt <= at) transactions.delete(key);
    for (const [key, value] of sessions)
      if (value.expiresAt <= at) sessions.delete(key);
  }
  async function client() {
    if (!discovery) {
      discovery = (async () => {
        // The custom fetch is dependency injection for protocol tests, never a
        // runtime/config-file option. No insecure-HTTP mode is accepted here.
        const options = {
          timeout: 5,
          execute: [oidc.enableNonRepudiationChecks],
        };
        if (transport) options[oidc.customFetch] = transport;
        const rp = await oidc.discovery(
          new URL(cfg.issuer),
          cfg.client_id,
          {
            client_secret: cfg.client_secret,
            id_token_signed_response_alg: "RS256",
          },
          oidc.ClientSecretPost(cfg.client_secret),
          options,
        );
        const metadata = rp.serverMetadata();
        for (const field of [
          "authorization_endpoint",
          "token_endpoint",
          "jwks_uri",
          "introspection_endpoint",
          "revocation_endpoint",
        ]) {
          const endpoint = new URL(metadata[field]);
          if (
            endpoint.origin !== new URL(cfg.issuer).origin ||
            endpoint.protocol !== "https:" ||
            endpoint.username ||
            endpoint.password ||
            endpoint.hash ||
            endpoint.search
          )
            throw new AuthorityUnavailable();
        }
        return rp;
      })().catch(() => {
        discovery = undefined;
        throw new AuthorityUnavailable();
      });
    }
    return discovery;
  }
  async function current(session) {
    if (!session || session.expiresAt <= clock() || !approved(session.subject))
      return false;
    let evidence;
    try {
      evidence = await oidc.tokenIntrospection(
        await client(),
        session.accessToken,
        { token_type_hint: "access_token" },
      );
    } catch {
      throw new AuthorityUnavailable();
    }
    const audiences =
      typeof evidence.aud === "string" ? [evidence.aud] : evidence.aud;
    const accepted =
      evidence.active === true &&
      evidence.client_id === cfg.client_id &&
      evidence.sub === session.subject &&
      typeof evidence.exp === "number" &&
      evidence.exp * 1000 > clock() &&
      typeof evidence.scope === "string" &&
      evidence.scope.split(/\s+/).includes("openid") &&
      (evidence.iss === undefined || evidence.iss === cfg.issuer) &&
      (audiences === undefined ||
        (Array.isArray(audiences) && audiences.includes(cfg.client_id)));
    if (accepted)
      session.expiresAt = Math.min(session.expiresAt, evidence.exp * 1000);
    return accepted;
  }
  async function authenticate(req) {
    prune();
    const handle = cookieValue(req.headers.cookie, sessionCookie);
    if (!handle || handle.length > 256) return null;
    const key = digest(handle),
      session = sessions.get(key);
    if (!session) return null;
    if (!(await current(session))) {
      sessions.delete(key);
      return null;
    }
    return {
      issuer: cfg.issuer,
      subject: session.subject,
      expires_at: session.expiresAt,
    };
  }
  async function start() {
    prune();
    const rp = await client();
    const verifier = oidc.randomPKCECodeVerifier(),
      state = sealTransaction({kind: "state", id: random(), expiresAt: clock() + 300000}),
      nonce = oidc.randomNonce();
    const url = oidc.buildAuthorizationUrl(rp, {
      redirect_uri: callback,
      response_type: "code",
      scope: "openid profile",
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
    });
    const binding = sealTransaction({kind: "transaction", state, nonce, verifier, expiresAt: clock() + 300000});
    return {
      location: url.href,
      cookies: [cookie(transactionCookie, binding, 300)],
    };
  }
  async function complete(req, url) {
    prune();
    const states = url.searchParams.getAll("state");
    if (states.length !== 1) throw denied();
    // Validate server-issued state before retaining any callback digest. Random
    // unauthenticated URL values cannot allocate this bounded replay cache.
    const issued = openTransaction(states[0]);
    if (issued.kind !== "state" || typeof issued.id !== "string"
        || !Number.isFinite(issued.expiresAt) || issued.expiresAt <= clock()
        || transactions.has(states[0])) throw denied();
    if (transactions.size >= 10000)
      throw Object.assign(new Error("Sign-in callback capacity reached; try again shortly."), {status: 429});
    // Consume before browser/token checks, including malformed/failed attempts.
    transactions.set(states[0], {expiresAt: issued.expiresAt});
    const transaction = openTransaction(cookieValue(req.headers.cookie, transactionCookie));
    if (transaction.kind !== "transaction" || transaction.state !== states[0] || typeof transaction.nonce !== "string"
        || typeof transaction.verifier !== "string" || !Number.isFinite(transaction.expiresAt)
        || transaction.expiresAt <= clock() || inFlight.has(states[0]))
      throw denied();
    // Bound only simultaneous token exchanges, not five minutes of anonymous
    // starts. An unsuccessful exchange cannot create a desktop session.
    if (inFlight.size >= 1000)
      throw Object.assign(new Error("Sign-in exchanges are busy; try again shortly."), {status: 429});
    inFlight.add(states[0]);
    try {
      const result = await redeem(transaction, url);
      return result;
    } finally { inFlight.delete(states[0]); }
  }
  async function redeem(transaction, url) {
    const rp = await client();
    let tokens;
    try {
      tokens = await oidc.authorizationCodeGrant(rp, url, {
        pkceCodeVerifier: transaction.verifier,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        idTokenExpected: true,
      });
    } catch {
      throw denied();
    }
    const claims = tokens.claims();
    if (
      !claims ||
      claims.iss !== cfg.issuer ||
      !approved(claims.sub) ||
      typeof claims.exp !== "number" ||
      typeof tokens.access_token !== "string" ||
      typeof tokens.expires_in !== "number" ||
      tokens.expires_in <= 0
    )
      throw denied();
    const session = {
      subject: claims.sub,
      accessToken: tokens.access_token,
      expiresAt: Math.min(
        claims.exp * 1000,
        clock() + tokens.expires_in * 1000,
        clock() + 12 * 3600000,
      ),
    };
    if (!(await current(session))) throw denied();
    prune();
    if (sessions.size >= 10000)
      throw Object.assign(new Error("Desktop session capacity reached."), {
        status: 503,
      });
    const handle = random();
    sessions.set(digest(handle), session);
    return {
      location: "/",
      cookies: [
        cookie(transactionCookie, "", 0),
        cookie(
          sessionCookie,
          handle,
          Math.max(1, Math.floor((session.expiresAt - clock()) / 1000)),
        ),
      ],
    };
  }
  async function logout(req) {
    const handle = cookieValue(req.headers.cookie, sessionCookie),
      key = digest(handle),
      session = sessions.get(key);
    sessions.delete(key);
    let unavailable = false;
    if (session) {
      try {
        await oidc.tokenRevocation(await client(), session.accessToken, {
          token_type_hint: "access_token",
        });
      } catch {
        unavailable = true;
      }
    }
    return {
      cookies: [cookie(sessionCookie, "", 0), cookie(transactionCookie, "", 0)],
      status: unavailable ? 503 : 200,
      body: unavailable
        ? {
            ok: false,
            error:
              "Desktop signed out locally; Axxium revocation could not be confirmed.",
          }
        : { ok: true },
    };
  }
  async function status() {
    try {
      await client();
      return { configured: true, issuer: cfg.issuer, available: true };
    } catch {
      return { configured: true, issuer: cfg.issuer, available: false };
    }
  }
  return {
    authenticate,
    start,
    complete,
    logout,
    status,
    allowOwnerToken: cfg.allow_owner_token === true,
  };
}
