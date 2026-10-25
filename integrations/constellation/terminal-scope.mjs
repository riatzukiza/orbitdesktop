// SPDX-License-Identifier: GPL-3.0-or-later
// The gateway delegates membership to Orbit's current workspace snapshot.
export function workspaceTerminal(snapshot, workspaceId, paneId) {
  if (snapshot?.workspace_id !== workspaceId || typeof paneId !== 'string') return false;
  const visit = node => node?.type === 'pane'
    ? node.pane?.id === paneId && node.pane?.kind === 'terminal'
    : node?.type === 'split' && (visit(node.first) || visit(node.second));
  return Array.isArray(snapshot.state?.monitors) && snapshot.state.monitors.some(window => visit(window.layout));
}
export function createTerminalScope({workspaceId, readWorkspace}) {
  let paneId;
  return async raw => {
    const frame = JSON.parse(raw.toString());
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw Error('Invalid terminal frame');
    if (frame.workspace_id !== undefined && frame.workspace_id !== workspaceId) throw Error('Workspace mismatch');
    if (!paneId) {
      if (frame.type !== 'auth' || typeof frame.pane_id !== 'string') throw Error('Terminal authentication required');
      paneId = frame.pane_id;
    } else if (frame.type === 'auth' || (frame.pane_id !== undefined && frame.pane_id !== paneId)) {
      throw Error('Terminal identity changed');
    }
    if (!workspaceTerminal(await readWorkspace(), workspaceId, paneId)) throw Error('Terminal outside shared workspace');
  };
}
