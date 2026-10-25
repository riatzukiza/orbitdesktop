// SPDX-License-Identifier: GPL-3.0-or-later
const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem("orbit.constellation.token") || "";
let current,
  busy = false,
  dispatchHost = "",
  retainedSubmission;
const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
async function api(path, body) {
  const response = await fetch("api/" + path, {
    method: body ? "POST" : "GET",
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });
  const value = await response.json();
  if (response.status === 401) {
    $("unlock").hidden = false;
    throw Error("Unlock the dashboard to load private fleet data.");
  }
  if (!response.ok) throw Error(value.error || "Request failed");
  $("unlock").hidden = true;
  return value;
}
function metric(label, value) {
  const n = el("div", undefined, "metric");
  n.append(el("strong", value), el("span", label));
  return n;
}
function age(ms) {
  const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  return minutes < 60
    ? minutes + "m"
    : minutes < 1440
      ? Math.floor(minutes / 60) + "h"
      : Math.floor(minutes / 1440) + "d";
}
function sessionRows() {
  const rows = [];
  for (const [host, result] of Object.entries(current.hosts)) {
    if (!result.ok) continue;
    for (const harness of result.data.harnesses) {
      if (!harness.sessions.ok) continue;
      for (const session of harness.sessions.data) {
        rows.push({
          host,
          harness: harness.id,
          ...session,
          time: session.time?.updated || session.updated_at * 1000 || 0,
        });
      }
    }
  }
  return rows.sort((a, b) => b.time - a.time);
}
function renderSessions() {
  const filter = $("filter").value;
  const rows = sessionRows()
    .filter((row) => filter === "all" || row.harness === filter)
    .slice(0, 24);
  $("sessions").replaceChildren();
  for (const row of rows) {
    const item = el("article", undefined, "session");
    item.dataset.harness = row.harness;
    const text = el("div");
    text.append(
      el("h3", row.title || row.id),
      el(
        "p",
        row.host +
          " · " +
          (row.cwd || row.directory || "Recorded context") +
          " · " +
          row.id,
      ),
    );
    item.append(
      el("span", row.harness, "badge"),
      text,
      el("span", age(row.time), "age"),
    );
    $("sessions").append(item);
  }
  if (!rows.length)
    $("sessions").append(
      el("p", "No matching recorded contexts were returned.", "muted"),
    );
}
const dollars = (micro) => Number.isFinite(micro) ? "$" + (micro / 1e6).toFixed(3) : "Unknown";
function renderProxx(result) {
  const data = result?.ok ? result.data : undefined;
  $("proxx-status").textContent = data?.configured ? "Configured source" : "Unavailable";
  $("proxx-description").textContent = data?.configured
    ? data.label + " · observed " + data.observed_at + ". Runtime activation and model evaluation require separate evidence."
    : "No Proxx observation available. Missing data does not mean zero spending.";
  $("proxx-budgets").replaceChildren();
  $("proxx-routes").replaceChildren();
  if (!data?.configured) return;
  if (data.budgets?.ok) {
    for (const budget of data.budgets.data.budgets || []) {
      const card = el("article", undefined, "session");
      const text = el("div");
      text.append(el("h3", budget.scopeId));
      if (budget.status === "ok") {
        const u = budget.usage;
        text.append(el("p", "Today: " + dollars(budget.dailyRemainingMicrousd) + " remaining of " + dollars(budget.dailyMicrousd)
          + " · Month: " + dollars(budget.monthlyRemainingMicrousd) + " remaining of " + dollars(budget.monthlyMicrousd)));
        text.append(el("p", "Confirmed: " + dollars(u.dailyChargedMicrousd) + " today / " + dollars(u.monthlyChargedMicrousd)
          + " this month · Held: " + dollars(u.heldMicrousd) + " (" + u.unresolvedCount + " unresolved)"));
        text.append(el("p", "Carried holds: " + dollars(u.dailyCarriedMicrousd) + " from prior days / " + dollars(u.monthlyCarriedMicrousd) + " from prior months", "muted"));
      } else text.append(el("p", "Ledger unavailable; remaining allowance is unknown.", "muted"));
      text.append(el("p", "Allowed routes: " + (budget.routes || []).map(r => r.upstreamModel + " [" + r.billing + "]").join(" · "), "muted"));
      card.append(text); $("proxx-budgets").append(card);
    }
  } else $("proxx-budgets").append(el("p", "Budget API unavailable; remaining allowance is unknown.", "muted"));
  if (!data.usage?.ok) {
    $("proxx-routes").append(el("p", "Recent route evidence unavailable.", "muted")); return;
  }
  const entries = data.usage.data.entries || [];
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.providerId + " / " + (entry.upstreamModel || "Unknown upstream (requested " + entry.model + ")");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const table = el("table"), head = el("tr");
  for (const label of ["Actual route", "Attempts", "Successes", "Recorded cost", "Mean TTFT", "Mean decode TPS"])
    head.append(el("th", label));
  table.append(head);
  for (const [route, rows] of groups) {
    const success = rows.filter(r => r.status >= 200 && r.status < 300);
    const mean = field => {
      const values = success.map(r => r[field]).filter(Number.isFinite);
      return values.length ? (values.reduce((a,b) => a+b,0) / values.length).toFixed(1) : "Unknown";
    };
    const costs = rows.map(r => r.costUsd).filter(Number.isFinite);
    const cost = costs.length ? "$" + costs.reduce((a,b) => a+b,0).toFixed(4) + (costs.length < rows.length ? " + unknown" : "") : "Unknown";
    const tr = el("tr");
    for (const value of [route, rows.length, success.length, cost, mean("ttftMs") + " ms", mean("tps")]) tr.append(el("td", value));
    table.append(tr);
  }
  $("proxx-routes").append(el("p", entries.length + " recent attempts. This sample is not the monthly invoice or proof that a specific agent made every request.", "muted"), table);
}
function render(snapshot) {
  current = snapshot;
  renderProxx(snapshot.proxx);
  $("hosts").replaceChildren();
  for (const [name, result] of Object.entries(snapshot.hosts)) {
    const card = el("article", undefined, "host"),
      top = el("div", undefined, "host-top");
    top.append(
      el("h2", name),
      el(
        "span",
        result.ok ? "Observed" : "Unavailable",
        result.ok ? "tag green" : "tag amber",
      ),
    );
    card.append(top);
    if (result.ok) {
      const data = result.data;
      card.append(el("div", data.hostname, "hostname"));
      const metrics = el("div", undefined, "metrics"),
        mem = data.memory;
      const used = mem.MemTotal ? 1 - mem.MemAvailable / mem.MemTotal : null;
      metrics.append(
        metric("1-minute load", data.load[0].toFixed(2)),
        metric(
          "RAM in use",
          used === null ? "Unknown" : Math.round(used * 100) + "%",
        ),
        metric(
          "Harness processes",
          data.harnesses.reduce((n, h) => n + h.process_count, 0),
        ),
      );
      card.append(metrics);
      const bar = el("div", undefined, "bar"),
        fill = el("i");
      fill.style.width = (used === null ? 0 : used * 100) + "%";
      bar.append(fill);
      card.append(bar);
      const badges = el("div", undefined, "harnesses");
      for (const h of data.harnesses) {
        badges.append(
          el(
            "span",
            h.id + " · " + (h.installed ? "available" : "not installed"),
            h.installed ? "tag" : "tag amber",
          ),
        );
      }
      card.append(badges);
      for (const [service, health] of Object.entries(data.services || {})) {
        card.append(
          el(
            "p",
            service + " · " + (health.ok ? "reachable" : health.error),
            "muted",
          ),
        );
      }
    } else
      card.append(
        el(
          "p",
          "Probe failed: " +
            result.error +
            ". This machine has not been marked healthy.",
          "muted",
        ),
      );
    $("hosts").append(card);
  }
  renderSessions();
  const op = snapshot.openplanner;
  let health, graph;
  if (op.ok) {
    health = op.data.health;
    graph = op.data.graph;
  }
  $("memory-status").textContent = health?.ok ? "Reachable" : "Unavailable";
  $("memory-status").className = health?.ok ? "tag green" : "tag amber";
  $("memory-stats").replaceChildren();
  if (graph?.ok) {
    for (const [key, val] of Object.entries(graph.data)) {
      if (typeof val === "number")
        $("memory-stats").append(
          metric(key.replaceAll("_", " "), val.toLocaleString()),
        );
    }
  }
  $("embedding").textContent = health?.ok
    ? "Storage: " +
      health.data.storageBackend +
      " · embeddings: " +
      JSON.stringify(health.data.embeddingModels) +
      " · shallow health; inference not tested."
    : "Memory service evidence is unavailable.";
  $("memory-evidence").textContent = JSON.stringify(op, null, 2);
  $("links").replaceChildren();
  for (const [name, url] of Object.entries(snapshot.links)) {
    try {
      const u = new URL(url);
      if (u.protocol !== "https:") continue;
      const link = el("a", name);
      link.href = u.href;
      link.target = "_blank";
      link.rel = "noopener";
      $("links").append(link);
    } catch {}
  }
  const prior = $("target").value;
  $("target").replaceChildren();
  for (const name of Object.keys(snapshot.hosts)) {
    $("target").append(new Option(name, name));
  }
  if (prior) $("target").value = prior;
  $("freshness").textContent =
    "Observed " + new Date(snapshot.observed_at).toLocaleTimeString();
  $("light").style.background = "#b9d990";
}
async function refresh() {
  if (busy) return;
  busy = true;
  $("refresh").disabled = true;
  try {
    render(await api("snapshot"));
    $("error").hidden = true;
    if (!dispatchHost) await projects();
    await refreshJobs();
  } catch (error) {
    $("error").textContent = error.message;
    $("error").hidden = false;
    $("light").style.background = "#deaf68";
    $("freshness").textContent = current
      ? "Stale · last " + new Date(current.observed_at).toLocaleTimeString()
      : "Not connected";
  } finally {
    busy = false;
    $("refresh").disabled = false;
  }
}
async function projects() {
  dispatchHost = $("target").value;
  try {
    const data = await api("projects", { host: dispatchHost });
    $("project").replaceChildren(...data.projects.map((p) => new Option(p, p)));
    $("harness").replaceChildren(
      ...data.harnesses.map((p) => new Option(p, p)),
    );
    $("send").disabled = !data.projects.length || !data.harnesses.length;
    $("dispatch-status").textContent = data.projects.length
      ? ""
      : "No dispatch project is configured for this account on this machine.";
  } catch (error) {
    $("send").disabled = true;
    $("dispatch-status").textContent = error.message;
  }
}
async function refreshJobs() {
  try {
    const list = await api(
      "jobs?host=" + encodeURIComponent($("target").value || "stealth"),
    );
    $("jobs").replaceChildren();
    for (const job of list) {
      const item = el("article", undefined, "job"),
        head = el("div", undefined, "job-head");
      head.append(
        el("span", job.harness + " @ " + job.host + " / " + job.project),
        el("span", job.state, "tag"),
      );
      item.append(head, el("p", job.id, "muted"));
      if (job.answer) item.append(el("pre", job.answer));
      if (job.error) item.append(el("p", job.error, "muted"));
      $("jobs").append(item);
    }
  } catch (error) {
    $("dispatch-status").textContent = error.message;
  }
}
$("unlock").onsubmit = (event) => {
  event.preventDefault();
  token = $("token").value;
  sessionStorage.setItem("orbit.constellation.token", token);
  $("token").value = "";
  refresh();
};
$("refresh").onclick = refresh;
$("filter").onchange = renderSessions;
$("target").onchange = async () => {
  retainedSubmission = undefined;
  await projects();
  await refreshJobs();
};
$("search").onsubmit = async (event) => {
  event.preventDefault();
  $("results").replaceChildren(el("p", "Searching…", "muted"));
  try {
    const result = await api("search", { query: $("query").value });
    const rows = Array.isArray(result)
      ? result
      : result.rows || result.results || result.items || result.events || [];
    $("results").replaceChildren();
    for (const row of rows) {
      const item = el("article", undefined, "result");
      item.append(
        el("code", row.id || row.event_id || row.session_id || "Memory result"),
        el(
          "p",
          typeof row.text === "string"
            ? row.text
            : typeof row.content === "string"
              ? row.content
              : JSON.stringify(row),
        ),
      );
      $("results").append(item);
    }
    if (!rows.length)
      $("results").append(el("p", "No results returned.", "muted"));
  } catch (error) {
    $("results").replaceChildren(el("p", error.message, "muted"));
  }
};
$("dispatch").onsubmit = async (event) => {
  event.preventDefault();
  const request = {
    host: $("target").value,
    harness: $("harness").value,
    project: $("project").value,
    prompt: $("prompt").value,
    confirm: $("confirm").checked,
  };
  if (
    !retainedSubmission ||
    JSON.stringify(retainedSubmission.request) !== JSON.stringify(request)
  )
    retainedSubmission = { request, operation_id: crypto.randomUUID() };
  $("send").disabled = true;
  try {
    const job = await api("submit", {
      ...request,
      operation_id: retainedSubmission.operation_id,
    });
    $("dispatch-status").textContent = "Worker " + job.id + " · " + job.state;
    retainedSubmission = undefined;
    $("confirm").checked = false;
    await refreshJobs();
  } catch (error) {
    $("dispatch-status").textContent =
      error.message +
      " · The exact operation ID is retained for recovery; do not start a duplicate.";
  } finally {
    $("send").disabled = false;
  }
};
refresh();
setInterval(refresh, 30000);
