// Explicit trusted ingress authentication; ordinary Orbit has no shared binding.
export interface SharedOrbitSession {
  workspace_id: string;
  token: string;
}
async function session(): Promise<SharedOrbitSession | null> {
  if (
    typeof document === "undefined" ||
    document.documentElement.dataset.orbitShared !== "1"
  )
    return null;
  if (location.protocol !== "https:" && location.hostname !== "127.0.0.1")
    return null;
  const response = await fetch("/constellation/session", {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok)
    throw Error(
      "Shared Orbit owner session is unavailable; unlock the desktop again.",
    );
  const value = await response.json();
  if (
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.workspace_id) ||
    typeof value.token !== "string" ||
    value.token.length < 32
  )
    throw Error("Invalid shared Orbit binding");
  localStorage.setItem("orbit.workspace.id", value.workspace_id);
  return { workspace_id: value.workspace_id, token: value.token };
}
export const sharedOrbitSession = await session();

// Reviewed host integration only. No generated app or arbitrary same-origin
// page gains an iframe exception from the presence of the shared gateway.
export function isConstellationDashboard(
  url: URL,
  origin: string,
  enabled: boolean,
): boolean {
  return (
    enabled &&
    url.origin === origin &&
    url.pathname === "/constellation/" &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password
  );
}
