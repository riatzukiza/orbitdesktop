import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { el, button, select } from "./dom";
import { createAgentChat } from "./agent-chat";
import { mountSharedBrowser } from './shared-browser';
import {mountWorkbenchReviewHost,REVIEW_URL} from './workbench-review-host';
import {mountProjectToolHost,PROJECT_TOOL_URL_PREFIX,projectToolId} from './project-tool-host';
import { mountManagedTerminalControls } from './managed-terminals';
import { hostSurfaceId, mountHostSurface } from './host-surfaces';
import {documentSurfaceId} from './technology-surfaces';
import { bindToolFeed } from "./tool-feed";
import type { Pane, PaneKind } from "./model";
import { sharedOrbitSession, isConstellationDashboard } from './constellation-session';
export interface PaneView {
  element: HTMLElement;
  resize: () => void;
  setFont: (n: number) => void;
  dispose: () => void;
}
export interface PaneActions {
  kind: (id: string, kind: PaneKind) => void;
  split: (id: string, axis: "row" | "column") => void;
  close: (id: string) => void;
  move?: (id: string, popout: boolean) => void;
  url: (id: string, url: string) => void;
}
export let sessionToken = sharedOrbitSession?.token || "";
export function setToken(t: string) {
  sessionToken = t;
  window.dispatchEvent(new Event('orbit-host-connected'));
}
export function createPane(p: Pane, font: number, a: PaneActions): PaneView {
  const root = el("section", "pane");
  root.dataset.paneId = p.id;
  const head = el("div", "pane-head");
  const type = select(
    [
      ["terminal", "Terminal"],
      ["browser", "Browser"],
      ["agent", "Agent chat"],
    ],
    p.kind,
    (v) => a.kind(p.id, v as PaneKind),
  );
  type.setAttribute("aria-label", "Pane type");
  head.append(
    type,
    el("span", "pane-spacer"),
    button("◫", "Split pane side by side", () => a.split(p.id, "row")),
    button("⬒", "Split pane top and bottom", () => a.split(p.id, "column")),
    button("×", "Close pane", () => a.close(p.id)),
  );
  if (p.kind === 'terminal' && a.move) head.append(
    button('↗', 'Pop terminal out into its own window', () => a.move!(p.id, true)),
    button('Attach…', 'Attach terminal to another window', () => a.move!(p.id, false)),
  );
  const body = el("div", "pane-body");
  root.append(head, body);
  let cleanup = () => {},
    resize = () => {},
    setFont = (n: number) => {
      body.style.fontSize = `${n}px`;
    };
  body.style.fontSize = `${font}px`;
  if (p.kind === "terminal") {
    const bar = el("div", "terminal-bar");
    const status = el("span", "connection-state", "DISCONNECTED");
    let ws: WebSocket | null = null,
      disposed = false;
    const connect = button(
      "Connect shell",
      "Connect to local host shell",
      () => open(),
      "small-button",
    );
    bar.append(status, connect);
    body.append(bar);
    const host = el("div", "terminal-host");
    body.append(host);
    const term = new Terminal({
      fontSize: font,
      fontFamily: '"SFMono-Regular",Consolas,"Liberation Mono",monospace',
      cursorBlink: true,
      scrollback: 30000,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: true,
      theme: {
        background: "#10191e",
        foreground: "#d5e2df",
        cursor: "#c2ed90",
        selectionBackground: "#41544d",
        green: "#c2ed90",
        cyan: "#86cccb",
      },
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    const copy = button('Copy selection', 'Copy selected terminal text (Ctrl+Shift+C; Ctrl+C with selection)', () => { void copySelection(); }, 'small-button');
    copy.disabled = true;
    const copyStatus = el('span', 'terminal-copy-status');
    copyStatus.setAttribute('role', 'status');
    let selecting = false, historySupported = false;
    let historyView: HTMLTextAreaElement | null = null;
    let historyHint: HTMLElement | null = null;
    let historyDialog: HTMLDialogElement | null = null;
    const selectionMode = button('Selection mode', 'Toggle persistent selection; drag and scroll without holding Shift', () => {
      selecting = !selecting;
      selectionMode.setAttribute('aria-pressed', String(selecting));
      copyStatus.textContent = selecting ? 'Selection mode on — drag to select; Escape exits' : 'Selection mode off';
      term.focus();
    }, 'small-button');
    selectionMode.setAttribute('aria-pressed', 'false');
    // Use xterm's own force-selection gesture, without accessing private services.
    for (const type of ['mousedown', 'mousemove', 'mouseup', 'wheel']) {
      host.addEventListener(type, event => {
        if (!selecting) return;
        if (event instanceof WheelEvent) {
          event.preventDefault(); event.stopImmediatePropagation();
          term.scrollLines(Math.sign(event.deltaY) * Math.max(1, Math.ceil(Math.abs(event.deltaY) / (event.deltaMode === 0 ? 20 : 1))));
          return;
        }
        Object.defineProperty(event, 'shiftKey', { value: true });
        if (/Mac/.test(navigator.platform)) Object.defineProperty(event, 'altKey', { value: true });
      }, true);
    }
    const selectText = button('History / text', 'Open native terminal text selection (no Shift needed)', () => {
      const dialog = document.createElement('dialog');
      dialog.setAttribute('aria-label', 'Terminal text selection');
      dialog.style.cssText = 'width:min(900px,90vw);padding:16px;background:#10191e;color:#d5e2df;border:1px solid #86cccb';
      const hint = el('p', '', 'Read-only snapshot. Drag to select, then Ctrl+C / ⌘C or right-click Copy. Escape closes. Shell continues running.');
      const text = document.createElement('textarea');
      text.readOnly = true;
      text.setAttribute('aria-label', 'Terminal scrollback text');
      text.style.cssText = 'display:block;box-sizing:border-box;width:100%;height:60vh;white-space:pre;overflow:auto;user-select:text;font:14px monospace;background:#10191e;color:#d5e2df';
      let snapshot = '';
      for (const buffer of [term.buffer.normal, ...(term.buffer.active === term.buffer.normal ? [] : [term.buffer.active])]) {
      if (snapshot) snapshot += '\n\n--- Current application screen ---\n';
      for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (!line) continue;
        if (i && !line.isWrapped) snapshot += '\n';
        snapshot += line.translateToString(true);
      }
      }
      text.value = snapshot.replace(/\n+$/, '');
      historyView = text; historyHint = hint; historyDialog = dialog;
      hint.textContent = 'Browser-retained history and current screen. Native Ctrl+C / ⌘C or right-click Copy. Escape closes.';
      const loadHistory = button('Load tmux history', 'Load retained shell history beyond the browser viewport', () => {
        if (!historySupported || ws?.readyState !== WebSocket.OPEN) {
          hint.textContent = 'Showing browser history only. Connect to a history-capable backend (backend reload may be required).';
          return;
        }
        hint.textContent = 'Loading retained tmux history…';
        send({ type: 'history' });
      }, 'small-button');
      const close = button('Close', 'Close terminal text selection', () => dialog.close(), 'small-button');
      dialog.append(hint, text, loadHistory, close);
      // Do not let desktop navigation shortcuts consume native copy/select-all.
      dialog.addEventListener('keydown', e => e.stopPropagation());
      dialog.addEventListener('close', () => { historyView = null; historyHint = null; historyDialog = null; dialog.remove(); if (!disposed) term.focus(); }, { once: true });
      document.body.append(dialog);
      dialog.showModal();
      text.focus();
      text.scrollTop = text.scrollHeight;
    }, 'small-button');
    const paste = button('Paste', 'Paste system clipboard into terminal', async () => {
      if (ws?.readyState !== WebSocket.OPEN) { copyStatus.textContent = 'Connect shell first'; return; }
      try {
        const text = await navigator.clipboard.readText();
        if (disposed || ws?.readyState !== WebSocket.OPEN) return;
        if (/[\r\n]/.test(text) && !window.confirm('Paste multiple lines into the terminal? This may execute commands.')) return;
        term.paste(text);
        term.focus();
        copyStatus.textContent = 'Pasted';
      } catch { copyStatus.textContent = 'Clipboard blocked — use Ctrl+Shift+V or ⌘V'; }
    }, 'small-button');
    bar.append(selectionMode, selectText, copy, paste, copyStatus);
    const managed = mountManagedTerminalControls(bar, p.id, () => sessionToken);
    // Keep xterm's selection when clicking the toolbar.
    copy.addEventListener('mousedown', e => e.preventDefault());
    term.onSelectionChange(() => { copy.disabled = !term.hasSelection(); copyStatus.textContent = ''; });
    async function copySelection() {
      const text = term.getSelection();
      if (!text) { copyStatus.textContent = 'Select text first'; return; }
      try {
        await navigator.clipboard.writeText(text);
        copyStatus.textContent = 'Copied';
      } catch {
        // Fallback for HTTP or browsers that deny the async clipboard API.
        const input = document.createElement('textarea');
        input.value = text;
        input.style.cssText = 'position:fixed;left:-10000px;top:0';
        document.body.append(input);
        input.select();
        try { copyStatus.textContent = document.execCommand('copy') ? 'Copied' : 'Copy blocked — allow clipboard access'; }
        catch { copyStatus.textContent = 'Copy blocked — allow clipboard access'; }
        finally { input.remove(); term.focus(); }
      }
    }
    term.attachCustomKeyEventHandler(e => {
      if (selecting && e.key === 'Escape') {
        if (e.type === 'keydown') selectionMode.click();
        e.preventDefault(); return false;
      }
      const shortcut = e.key.toLowerCase() === 'c' && !e.altKey && (e.ctrlKey || e.metaKey);
      // Let the browser dispatch its native copy event; xterm owns clipboardData.
      if (shortcut && term.hasSelection() && !e.shiftKey) return false;
      if (shortcut && (term.hasSelection() || e.shiftKey)) {
        e.preventDefault();
        if (e.type === 'keydown') void copySelection();
        return false;
      }
      return true; // Ctrl+C without a selection still interrupts the shell.
    });
    host.title = 'Enable Selection mode to drag without Shift. Ctrl+C / ⌘C or right-click Copy; History / text includes off-screen retained output.';
    term.writeln("\x1b[38;2;194;237;144mORBIT / LOCAL TERMINAL\x1b[0m\r\n");
    term.writeln("A real shell on the machine running Orbit.\r\n");
    term.writeln(
      "1. Start the included local server.\r\n2. Unlock host access with its session token.\r\n3. Select Connect shell.\r\n",
    );
    term.writeln("\x1b[90mNo shell is running in this pane yet.\x1b[0m");
    const send = (v: unknown) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(v));
    };
    function open() {
      if (
        ws &&
        (ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING)
      )
        return;
      if (!sessionToken) {
        term.writeln(
          "\r\n\x1b[33mUse “Connect host” in the top bar first.\x1b[0m",
        );
        return;
      }
      status.textContent = "CONNECTING";
      connect.disabled = true;
      const socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/terminal`,
      );
      ws = socket;
      socket.onopen = () => {
        fit.fit();
        send({
          type: "auth",
          pane_id: p.id,
          token: sessionToken,
          cols: term.cols,
          rows: term.rows,
        });
      };
      socket.onmessage = (e) => {
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        if (m.type === 'history' && historyView && historyHint) {
          if (typeof m.text === 'string') {
            historyView.value = m.text;
            historyHint.textContent = 'Retained tmux history and screen (not unlimited; discarded output cannot be recovered). Native copy available.';
          } else historyHint.textContent = m.error || 'History unavailable';
        }
        if (m.type === "ready") {
          historySupported = m.history === true;
          term.clear();
          status.textContent = `LIVE SHELL · ${m.user || 'host'}`;
          term.writeln(`Connected to ${m.user || 'user'}@${m.host || 'host'} — ${m.cwd || ''}\r\n`);
          status.classList.add("live");
          connect.textContent = "Connected";
        }
        if (m.type === "data")
          term.write(m.data, () =>
            send({ type: "ack", length: m.data.length }),
          );
        if (m.type === "error") term.writeln(`\r\n${m.message}`);
        if (m.type === "exit") term.writeln(`\r\n[Shell exited: ${m.code}]`);
      };
      socket.onerror = () => {
        status.textContent = "UNAVAILABLE";
      };
      socket.onclose = () => {
        if (disposed) return;
        status.textContent = "DISCONNECTED";
        status.classList.remove("live");
        connect.disabled = false;
        connect.textContent = "Reconnect";
        term.writeln(
          "\r\n\x1b[90mConnection closed. Reconnect resumes this pane’s persistent shell.\x1b[0m",
        );
      };
    }
    term.onData((data) => send({ type: "input", data }));
    term.onResize(({ cols, rows }) => send({ type: "resize", cols, rows }));
    resize = () => {
      try {
        if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
      } catch {
        /* detached during focus transitions */
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    setFont = (n) => {
      term.options.fontSize = n;
      resize();
    };
    cleanup = () => {
      disposed = true;
      managed.dispose();
      historyDialog?.close();
      historyDialog?.remove();
      ro.disconnect();
      ws?.close();
      term.dispose();
    };
  } else if (p.kind === 'browser' && hostSurfaceId(p.url)) {
    cleanup=mountHostSurface(body,hostSurfaceId(p.url)!,()=>sessionToken,{paneId:p.id,surfaceUrl:p.url});
  } else if (p.kind === 'browser' && documentSurfaceId(p.url)) {
    let disposed=false;
    let dispose=()=>{};
    void import('./document-host').then(module=>{
      if(disposed)return;
      const mounted=module.mountDocumentHost(body,documentSurfaceId(p.url)!,()=>sessionToken,{paneId:p.id});
      dispose=()=>mounted.dispose();
    }).catch(()=>{if(!disposed)body.textContent='Document surface unavailable';});
    cleanup=()=>{disposed=true;dispose();};
  } else if (p.kind === 'browser' && p.url === REVIEW_URL) {
    body.style.overflow='auto';
    body.style.padding='.75rem';
    cleanup=mountWorkbenchReviewHost(body,p.id,()=>sessionToken);
  } else if (p.kind === 'browser' && p.url.startsWith(PROJECT_TOOL_URL_PREFIX)) {
    body.style.overflow='auto';
    body.style.padding='.75rem';
    cleanup=mountProjectToolHost(body,p.id,()=>sessionToken,projectToolId(p.url)??undefined);
  } else if (p.kind === 'browser' && p.url === 'orbit://shared-browser') {
    head.style.display='none';
    cleanup=mountSharedBrowser(body,()=>sessionToken,p.id);
  } else if (p.kind === "browser") {
    body.classList.add("browser-body");
    const nav = el("form", "browser-nav");
    const address = el("input");
    address.value = p.url;
    address.setAttribute("aria-label", "Browser address");
    address.placeholder = "https://example.com";
    let current = p.url;
    const surface = el("div", "browser-surface");
    let frame: HTMLIFrameElement | null = null;
    let browserFont = font;
    const zoomFrame = () => {
      if (!frame) return;
      const zoom = browserFont / 19;
      frame.style.position = "absolute";
      frame.style.left = "0";
      frame.style.top = "0";
      frame.style.transformOrigin = "top left";
      frame.style.width = `${100 / zoom}%`;
      frame.style.height = `${100 / zoom}%`;
      frame.style.transform = `scale(${zoom})`;
    };
    function navigate(raw: string) {
      cleanup();
      cleanup = () => {};
      head.style.display = "";
      nav.style.display = "";
      root.classList.remove("app-pane");
      let url = raw.trim();
      if (url === "orbit://welcome") {
        current = url;
        a.url(p.id, url);
        address.value = url;
        surface.replaceChildren();
        frame = null;
        const welcome = el("div", "welcome");
        welcome.append(
          el("div", "eyebrow", "YOUR SPACE, IN EVERY DIMENSION"),
          el("h1", "", "Room to think."),
          el("p", "", "One workspace. As many perspectives as you need."),
        );
        const cards = el("div", "welcome-cards");
        for (const [n, t, d] of [
          [
            "01",
            "Make it yours",
            "Select a display, then adjust its shape and position.",
          ],
          [
            "02",
            "Divide your attention",
            "Split any pane into terminals, browsers, and agents.",
          ],
          [
            "03",
            "Get closer",
            "Use Focus for a full-size, distraction-free display.",
          ],
        ]) {
          const c = el("div", "welcome-card");
          c.append(
            el("span", "card-number", n),
            el("strong", "", t),
            el("p", "", d),
          );
          cards.append(c);
        }
        welcome.append(
          cards,
          el("div", "welcome-foot", "ORBIT  /  WORKSPACE GUIDE"),
        );
        surface.append(welcome);
        return;
      }
      try {
        if (url.startsWith('/apps/')) url = new URL(url, location.origin).href;
        else if (!/^https?:\/\//i.test(url)) url = "https://" + url;
        const u = new URL(url);
        if (
          !["http:", "https:"].includes(u.protocol) ||
          u.username ||
          u.password
        )
          throw Error();
        const localApp = u.origin === location.origin && /^\/apps\/[a-z0-9][a-z0-9-]{0,60}\//.test(u.pathname);
        const constellation = isConstellationDashboard(u, location.origin, !!sharedOrbitSession);
        if (u.origin === location.origin && !localApp && !constellation)
          throw Error("The Orbit host cannot be embedded.");
        if (localApp) {
          head.style.display = "none";
          nav.style.display = "none";
          root.classList.add("app-pane");
        }
        current = u.href;
        address.value = current;
        a.url(p.id, localApp ? u.pathname + u.search + u.hash : current);
        frame = el("iframe");
        frame.title = "Embedded browser";
        frame.referrerPolicy = "no-referrer";
        frame.setAttribute(
          "sandbox",
          localApp ? "allow-scripts allow-forms allow-modals allow-downloads" : constellation ? "allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation" : "allow-scripts allow-forms allow-same-origin allow-popups",
        );
        frame.src = current;
        surface.replaceChildren(frame);
        if (localApp) cleanup = bindToolFeed(frame);
        zoomFrame();
      } catch (e) {
        surface.replaceChildren(
          el(
            "p",
            "browser-error",
            e instanceof Error && e.message
              ? e.message
              : "Enter a valid HTTP or HTTPS address.",
          ),
        );
      }
    }
    nav.append(
      button("⌂", "Browser home", () => navigate("orbit://welcome")),
      address,
      button("↻", "Reload page", () => navigate(current)),
      button("↗", "Open browser page in new tab", () => {
        if (/^https?:/.test(current))
          window.open(current, "_blank", "noopener,noreferrer");
      }),
    );
    nav.onsubmit = (e) => {
      e.preventDefault();
      navigate(address.value);
    };
    body.append(nav, surface);
    navigate(current);
    setFont = (n) => {
      browserFont = n;
      body.style.fontSize = `${n}px`;
      zoomFrame();
    };
  } else {
    cleanup = createAgentChat(body, p.id, () => sessionToken, head);
  }
  return { element: root, resize, setFont, dispose: cleanup };
}
