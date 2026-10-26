// SPDX-License-Identifier: GPL-3.0-or-later
// Trusted single-owner ingress; existing Orbit retains API and PTY authority.
import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { createAxxiumAuth, AUTH_PATHS } from "./axxium-auth.mjs";
import { createTerminalScope } from "./terminal-scope.mjs";
const configPath = process.env.ORBIT_CONSTELLATION_CONFIG;
if (!configPath || fs.statSync(configPath).mode & 0o077)
  throw Error("Owner-only configuration required");
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
const orbitToken = fs.readFileSync(cfg.orbit_token_file, "utf8").trim();
const axxium = createAxxiumAuth({
  config: cfg.axxium,
  origin: cfg.public_origin,
});
const secret = crypto.randomBytes(32),
  port = cfg.gateway_port;
const origins = new Set([cfg.public_origin, `http://127.0.0.1:${port}`]);
const hosts = new Set([...origins].map((v) => new URL(v).host));
const equal = (a, b) =>
  typeof a === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const sign = (v) =>
  crypto.createHmac("sha256", secret).update(v).digest("base64url");
const cookieName = "orbit_constellation_owner";
let loginAttempts = [];
function legacyAuthenticated(req) {
  const raw =
    (req.headers.cookie || "")
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1) || "";
  const [expiry, nonce, signature] = raw.split(".");
  return (
    /^\d+$/.test(expiry || "") &&
    Number(expiry) > Date.now() &&
    Number(expiry) < Date.now() + 13 * 3600000 &&
    equal(signature, sign(expiry + "." + nonce))
  );
}
async function authenticated(req) {
  if (axxium) {
    const identity = await axxium.authenticate(req);
    if (identity) return identity;
    if (!axxium.allowOwnerToken) return null;
  }
  return legacyAuthenticated(req) ? { source: "explicit-owner-token" } : null;
}
const headers = (type = "text/html; charset=utf-8") => ({
  "Content-Type": type,
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
});
function reply(res, status, data, type) {
  res.writeHead(status, headers(type));
  res.end(data);
}
const ownerForm = `<form action="/login" method="post"><label for="token">Orbit owner token</label><input id="token" name="token" type="password" required autocomplete="off"><button>Unlock desktop</button></form>`;
const login = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unlock Knoxx desktop</title><style>body{background:#0b1015;color:#dce6ee;font:15px system-ui;display:grid;place-items:center;min-height:95vh}main{width:min(380px,85vw)}small{color:#b9d990;letter-spacing:.2em}h1{font-weight:500;letter-spacing:-.04em}p{color:#8b9ead;line-height:1.6}input,button,.sign-in{font:inherit;padding:12px;border:1px solid #344653;border-radius:6px;box-sizing:border-box;width:100%;margin:8px 0;background:#14202c;color:#dce6ee}button,.sign-in{background:#c3e89e;color:#132219;font-weight:600;cursor:pointer}.sign-in{display:block;text-align:center;text-decoration:none}details{margin-top:24px;color:#8b9ead}summary{cursor:pointer}</style></head><body><main><small>ORBIT × KNOXX</small><h1>One shared desktop.</h1>${axxium ? `<p>Use your Axxium identity to open your desktop and connected harnesses.</p><a class="sign-in" href="${AUTH_PATHS.start}">Sign in with Axxium</a>${axxium.allowOwnerToken ? `<details><summary>Existing development owner access</summary><p>The owner-token route remains explicitly available while shared sign-in is being activated.</p>${ownerForm}</details>` : ""}` : `<p>Unlock your workspace with the existing Orbit owner token. Agent processes stay on their own machines.</p>${ownerForm}`}<p>Your account credentials stay with the identity service.</p></main></body></html>`;
async function body(req, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > max) throw Error("Body exceeds limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function proxy(req, res, targetPort, path, raw, extra = {}) {
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: targetPort,
      path,
      method: req.method,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${targetPort}`,
        ...(req.headers.origin
          ? { origin: `http://127.0.0.1:${targetPort}` }
          : {}),
        ...extra,
        ...(raw ? { "content-length": raw.length } : {}),
        cookie: "",
      },
    },
    (up) => {
      if (
        path === "/" &&
        up.statusCode === 200 &&
        String(up.headers["content-type"]).includes("text/html")
      ) {
        const chunks = [];
        up.on("data", (chunk) => chunks.push(chunk));
        up.on("end", () => {
          const html = Buffer.concat(chunks)
            .toString()
            .replace(
              '<html lang="en">',
              '<html lang="en" data-orbit-shared="1">',
            );
          const outHeaders = { ...up.headers, "cache-control": "no-store" };
          delete outHeaders["content-length"];
          delete outHeaders["content-encoding"];
          res.writeHead(up.statusCode, outHeaders);
          res.end(html);
        });
      } else {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      }
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent)
      reply(res, 502, "Shared desktop upstream unavailable.");
    else res.end();
  });
  res.on("close", () => upstream.destroy());
  if (axxium && req.orbitBrowserIdentity) {
    let checking = false;
    const recheck = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        if (!(await authenticated(req))) {
          upstream.destroy();
          res.destroy();
        }
      } catch {
        upstream.destroy();
        res.destroy();
      } finally {
        checking = false;
      }
    }, 10000);
    res.on("close", () => clearInterval(recheck));
  }
  if (raw) upstream.end(raw);
  else req.pipe(upstream);
}
const server = http.createServer(async (req, res) => {
  try {
    if (!hosts.has(req.headers.host)) return reply(res, 403, "Host rejected.");
    const origin = req.headers.origin;
    if (origin && !origins.has(origin))
      return reply(res, 403, "Origin rejected.");
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/health")
      return reply(
        res,
        200,
        JSON.stringify({ ok: true, service: "orbit-shared-gateway" }),
        "application/json",
      );
    if (url.pathname === "/login" && req.method === "GET")
      return reply(res, 200, login);
    if (axxium && url.pathname === AUTH_PATHS.status && req.method === "GET")
      return reply(
        res,
        200,
        JSON.stringify(await axxium.status()),
        "application/json",
      );
    if (axxium && url.pathname === AUTH_PATHS.start && req.method === "GET") {
      const result = await axxium.start();
      res.writeHead(303, {
        ...headers(),
        "Set-Cookie": result.cookies,
        Location: result.location,
      });
      return res.end();
    }
    if (
      axxium &&
      url.pathname === AUTH_PATHS.callback &&
      req.method === "GET"
    ) {
      const result = await axxium.complete(
        req,
        new URL(req.url, cfg.public_origin),
      );
      res.writeHead(303, {
        ...headers(),
        "Set-Cookie": [
          ...result.cookies,
          `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
        ],
        Location: result.location,
      });
      return res.end();
    }
    if (axxium && url.pathname === AUTH_PATHS.logout && req.method === "POST") {
      if (origin !== cfg.public_origin)
        return reply(res, 403, "Same-origin logout required.");
      const result = await axxium.logout(req);
      res.writeHead(result.status, {
        ...headers("application/json"),
        "Set-Cookie": [
          ...result.cookies,
          `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
        ],
      });
      return res.end(JSON.stringify(result.body));
    }
    if (url.pathname === "/login" && req.method === "POST") {
      if (axxium && !axxium.allowOwnerToken)
        return reply(res, 403, "Use Axxium to sign in to this desktop.");
      if (!origin || !origins.has(origin))
        return reply(res, 403, "Same-origin login required.");
      const current = Date.now();
      loginAttempts = loginAttempts.filter((t) => current - t < 60000);
      const form = new URLSearchParams((await body(req, 4096)).toString());
      if (!equal(form.get("token"), orbitToken)) {
        if (loginAttempts.length >= 12)
          return reply(res, 429, "Try again in one minute.");
        loginAttempts.push(current);
        return reply(res, 401, login);
      }
      const value =
        String(Date.now() + 12 * 3600000) +
        "." +
        crypto.randomBytes(24).toString("base64url");
      const secure =
        req.headers.host === new URL(cfg.public_origin).host ? "; Secure" : "";
      res.writeHead(303, {
        ...headers(),
        "Set-Cookie": `${cookieName}=${value}.${sign(value)}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=43200`,
        Location: "/",
      });
      return res.end();
    }
    // Remote MCP clients receive only the finite tool surface, never an owner
    // browser session, session bootstrap token or unrestricted Orbit API proxy.
    if (
      url.pathname === "/constellation/api/tool" &&
      req.method === "POST" &&
      typeof cfg.token === "string" && cfg.token.trim().length > 0 &&
      equal(req.headers.authorization, "Bearer " + cfg.token)
    ) {
      return proxy(req, res, cfg.port, "/api/tool", await body(req, 65536), {
        authorization: "Bearer " + cfg.token,
      });
    }
    const identity = await authenticated(req);
    if (!identity) {
      if (
        url.pathname.startsWith("/api/") ||
        url.pathname.startsWith("/constellation/api/") ||
        url.pathname === "/constellation/session"
      )
        return reply(
          res,
          401,
          '{"error":"Owner login required"}',
          "application/json",
        );
      res.writeHead(303, { ...headers(), Location: "/login" });
      return res.end();
    }
    req.orbitBrowserIdentity = identity;
    if (
      !["GET", "HEAD"].includes(req.method) &&
      (!origin || !origins.has(origin))
    )
      return reply(res, 403, "Same-origin action required.");
    if (url.pathname === "/constellation/session" && req.method === "GET")
      return reply(
        res,
        200,
        JSON.stringify({
          workspace_id: cfg.workspace_id,
          token: orbitToken,
          identity,
        }),
        "application/json",
      );
    if (url.pathname === "/constellation/bootstrap.js" && req.method === "GET")
      return reply(
        res,
        200,
        `localStorage.setItem('orbit.workspace.id',${JSON.stringify(cfg.workspace_id)});`,
        "text/javascript",
      );
    if (url.pathname === "/constellation") {
      res.writeHead(303, {
        Location: "/constellation/",
        "Cache-Control": "no-store",
      });
      return res.end();
    }
    if (url.pathname.startsWith("/constellation/")) {
      const raw = ["GET", "HEAD"].includes(req.method)
        ? undefined
        : await body(req, 65536);
      return proxy(
        req,
        res,
        cfg.port,
        url.pathname.slice("/constellation".length) + url.search,
        raw,
        { authorization: "Bearer " + cfg.token },
      );
    }
    if (
      ["GET", "HEAD"].includes(req.method) &&
      !url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/apps/") &&
      !url.pathname.startsWith("/vendor/") &&
      !url.pathname.startsWith("/recovery")
    ) {
      const root = fs.realpathSync(cfg.dist);
      const filename = fs.realpathSync(
        path.join(
          root,
          decodeURIComponent(
            url.pathname === "/" ? "index.html" : url.pathname,
          ),
        ),
      );
      if (
        !filename.startsWith(root + path.sep) ||
        !fs.statSync(filename).isFile()
      )
        return reply(res, 404, "Not found.");
      const types = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".woff2": "font/woff2",
        ".wasm": "application/wasm",
        ".json": "application/json",
      };
      let data = fs.readFileSync(filename);
      if (url.pathname === "/")
        data = Buffer.from(
          data
            .toString()
            .replace(
              '<html lang="en">',
              '<html lang="en" data-orbit-shared="1">',
            )
            .replace(
              "<head>",
              '<head><script src="/constellation/bootstrap.js"></script>',
            ),
        );
      res.writeHead(200, {
        ...headers(types[path.extname(filename)] || "application/octet-stream"),
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src https: http:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      return res.end(req.method === "HEAD" ? undefined : data);
    }
    const raw = ["GET", "HEAD"].includes(req.method)
      ? undefined
      : await body(req, 2_000_000);
    if (
      raw &&
      String(req.headers["content-type"]).startsWith("application/json")
    ) {
      const value = JSON.parse(raw);
      if (value.workspace_id && value.workspace_id !== cfg.workspace_id)
        return reply(res, 403, "Shared workspace mismatch.");
    }
    return proxy(req, res, cfg.orbit_port, url.pathname + url.search, raw, {
      "accept-encoding": "identity",
    });
  } catch (error) {
    // Preserve the refusal while draining an oversized or unread request body.
    if (!req.readableEnded) {
      req.resume();
      if (!res.headersSent) res.setHeader("Connection", "close");
    }
    if (!res.headersSent)
      reply(
        res,
        error.status || 400,
        error.status ? error.message : "Invalid request.",
      );
    else res.end();
  }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 2_000_000 });
server.on("upgrade", async (req, socket, head) => {
  try {
    if (
      !hosts.has(req.headers.host) ||
      !origins.has(req.headers.origin) ||
      !(await authenticated(req)) ||
      req.url !== "/api/terminal"
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(
        `ws://127.0.0.1:${cfg.orbit_port}${req.url}`,
        { headers: { Origin: `http://127.0.0.1:${cfg.orbit_port}` } },
      );
      const queued = [];
      let bytes = 0;
      const scope = createTerminalScope({
        workspaceId: cfg.workspace_id,
        readWorkspace: async () => {
          const response = await fetch(`http://127.0.0.1:${cfg.orbit_port}/api/workspace`, {
            method: "POST",
            headers: { Authorization: `Bearer ${orbitToken}`, Origin: `http://127.0.0.1:${cfg.orbit_port}`, "Content-Type": "application/json" },
            body: JSON.stringify({workspace_id: cfg.workspace_id, action: "read"}),
            signal: AbortSignal.timeout(3000),
          });
          if (!response.ok) throw Error("Workspace unavailable");
          return response.json();
        },
      });
      let forwarding = Promise.resolve(), pendingBytes = 0;
      client.on("message", (raw, binary) => {
        pendingBytes += raw.length;
        if (binary || pendingBytes >= 65536) return client.close(1008);
        forwarding = forwarding.then(async () => {
          if (client.readyState !== WebSocket.OPEN) return;
          await scope(raw);
          if (client.readyState !== WebSocket.OPEN) return;
          if (upstream.readyState === WebSocket.OPEN) upstream.send(raw, { binary: false });
          else if (upstream.readyState === WebSocket.CONNECTING && (bytes += raw.length) < 65536)
            queued.push([raw, false]);
          else client.close(1008);
        }).catch(() => client.close(1008, "Shared terminal membership required"))
          .finally(() => { pendingBytes -= raw.length; });
      });
      upstream.on("open", () => {
        for (const [raw, binary] of queued) upstream.send(raw, { binary });
        queued.length = 0;
      });
      upstream.on("message", (raw, binary) => {
        if (client.readyState === WebSocket.OPEN) client.send(raw, { binary });
      });
      upstream.on("close", () => client.close());
      client.on("close", () => upstream.close());
      upstream.on("error", () => client.close(1011));
      client.on("error", () => upstream.close());
      let checking = false;
      const recheck = setInterval(async () => {
        if (checking) return;
        checking = true;
        try {
          if (!(await authenticated(req)))
            client.close(1008, "Desktop identity session ended");
        } catch {
          client.close(1011, "Identity authority unavailable");
        } finally {
          checking = false;
        }
      }, 10000);
      client.on("close", () => clearInterval(recheck));
    });
  } catch {
    socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Orbit shared owner gateway listening on loopback ${port}`),
);
