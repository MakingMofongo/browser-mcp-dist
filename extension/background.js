/**
 * Agent360 Browser MCP — Background Service Worker
 *
 * Handles Chrome API calls relayed from the offscreen document.
 * Each MCP session (port) gets its own Chrome Tab Group with color coding.
 * Tabs are isolated per session — no cross-session interference.
 */

// ── Session Tab Management ─────────────────────────────────────────────────

const SESSION_COLORS = ['blue', 'green', 'yellow', 'red', 'pink', 'purple', 'cyan', 'orange'];
// Select-all modifier is platform-dependent: Cmd (meta=4) on macOS, Ctrl (2) elsewhere.
// Get this wrong and the field isn't selected — Backspace no-ops and new text concatenates onto the old.
const SELECT_ALL_MODS = /Mac/i.test(navigator.userAgent) ? 4 : 2;
const sessions = new Map(); // port → { tabIds: Set, groupId: number|null, color: string, label: string }
// FIX-2: promise-cache latch (not a boolean). The old `if(sessionsLoaded) return`
// flipped the flag BEFORE awaiting storage, so a second concurrent caller on a freshly
// woken service worker proceeded against an EMPTY sessions Map. Caching the promise makes
// every concurrent caller await the SAME populated completion. Resets to null on SW
// eviction (module re-init) and on error, so the next wake retries.
let restorePromise = null;

// Restore sessions from storage (service workers lose in-memory state on suspend)
function restoreSessions() {
  if (restorePromise) return restorePromise;
  restorePromise = (async () => {
    const { sessions: saved } = await chrome.storage.local.get({ sessions: {} });
    for (const [port, data] of Object.entries(saved)) {
      // Verify tabs still exist
      const validTabIds = new Set();
      for (const tabId of (data.tabIds || [])) {
        try {
          await chrome.tabs.get(tabId);
          validTabIds.add(tabId);
        } catch {} // tab no longer exists
      }
      if (validTabIds.size > 0) {
        const activeTabId = data.activeTabId && validTabIds.has(data.activeTabId) ? data.activeTabId : null;
        sessions.set(Number(port), {
          tabIds: validTabIds,
          activeTabId,
          // Tabs adopted from the user's own browsing (browser_attach_tab). They are
          // never auto-evicted and never closed on session teardown — we did not
          // open them, so we must not take them away.
          adopted: new Set((data.adopted || []).filter(id => validTabIds.has(id))),
          groupId: data.groupId || null,
          // Port-derived, so a restored session keeps the same name/colour it had
          // and can never collide with a live session on another port.
          ...sessionIdentity(Number(port)),
        });
      }
    }
    // Re-stamp restored groups with their port-derived identity, so groups that
    // were created under the old size-based naming (which could produce two
    // "Claude 2"s) are renamed in place instead of being left as duplicates.
    for (const [p, s] of sessions) {
      if (s.groupId == null) continue;
      try { await chrome.tabGroups.update(s.groupId, { title: s.label, color: s.color }); }
      catch { s.groupId = null; }
    }
  })().catch(err => { restorePromise = null; throw err; });
  return restorePromise;
}

// Identity is derived from the PORT, which is unique per MCP server and stable
// across service-worker restarts. Deriving it from sessions.size (the old way)
// collided whenever the map was rebuilt — two concurrent sessions both computed
// "Claude 2"/green and Chrome showed two identically named tab groups.
const BASE_WS_PORT = 9876;
function sessionIdentity(port) {
  const idx = Math.max(0, (Number(port) || BASE_WS_PORT) - BASE_WS_PORT);
  return { label: `Claude ${idx + 1}`, color: SESSION_COLORS[idx % SESSION_COLORS.length] };
}

function getSession(port) {
  if (!sessions.has(port)) {
    const { label, color } = sessionIdentity(port);
    sessions.set(port, {
      tabIds: new Set(),
      activeTabId: null,
      adopted: new Set(),
      groupId: null,
      color,
      label,
    });
  }
  return sessions.get(port);
}

// LRU eviction cap: hver session må højst have N åbne tabs samtidigt.
// Når en ny tab tilføjes ud over cap'en, lukkes den ÆLDSTE tab i sessionen
// (insertion-order via Set) — bortset fra session.activeTabId (current tab).
// Begrundelse: Claude Code-flows kan åbne 20+ navigate(new_tab=true) per session
// over en længere conversation. Uden eviction akkumulerer disse i Chrome som
// orphan-tabs der spiser RAM + giver "extension localhost 19+" tab-noise.
const MAX_TABS_PER_SESSION = 10;

async function evictOldestTabs(session, justAddedTabId) {
  // Drop dead tab-ids først (user manually closed dem)
  for (const id of [...session.tabIds]) {
    try {
      await chrome.tabs.get(id);
    } catch {
      session.tabIds.delete(id);
    }
  }
  // Evict oldest indtil ≤ cap. Skip activeTabId og just-added tab.
  const ordered = [...session.tabIds];
  for (const oldId of ordered) {
    if (session.tabIds.size <= MAX_TABS_PER_SESSION) break;
    if (oldId === session.activeTabId) continue;
    if (oldId === justAddedTabId) continue;
    if (session.adopted?.has(oldId)) continue; // never auto-close the user's own tabs
    try {
      await chrome.tabs.remove(oldId);
    } catch {} // tab may already be closed
    session.tabIds.delete(oldId);
  }
}

async function addTabToSession(port, tabId) {
  const session = getSession(port);
  session.tabIds.add(tabId);

  // LRU eviction: når sessionen overstiger cap, luk de ældste tabs.
  if (session.tabIds.size > MAX_TABS_PER_SESSION) {
    await evictOldestTabs(session, tabId);
  }

  try {
    if (session.groupId !== null) {
      try {
        await chrome.tabs.group({ tabIds: [tabId], groupId: session.groupId });
      } catch {
        // Group no longer valid — will create new one below
        session.groupId = null;
      }
    }

    if (session.groupId === null) {
      // Adopt an existing group with this session's title before making a new one.
      // After a service-worker restart the old group still exists in Chrome, and
      // blindly creating another produced two identically named groups.
      let existing = null;
      try {
        const found = await chrome.tabGroups.query({ title: session.label });
        const claimed = new Set([...sessions.values()].map(s => s.groupId).filter(g => g != null));
        existing = found.find(g => !claimed.has(g.id)) || null;
      } catch {}
      if (existing) {
        session.groupId = existing.id;
        try { await chrome.tabs.group({ tabIds: [tabId], groupId: existing.id }); } catch { session.groupId = null; }
      }
      if (session.groupId === null) {
        session.groupId = await chrome.tabs.group({ tabIds: [...session.tabIds] });
      }
      await chrome.tabGroups.update(session.groupId, {
        title: session.label,
        color: session.color,
        collapsed: false,
      });
    }
  } catch (e) {
    console.warn('[MCP] Tab group error:', e.message);
  }

  persistSessions();
}

async function releaseSession(port) {
  const session = sessions.get(port);
  if (!session) return;

  // Detach debugger + close the tabs WE opened. Adopted tabs (the user's own,
  // brought in via browser_attach_tab) are released, never closed.
  const tabIds = [...session.tabIds];
  for (const tabId of tabIds) {
    debuggerForceDetach(tabId);
    stickyTabs.delete(tabId);
    if (session.adopted?.has(tabId)) continue;
    try {
      await chrome.tabs.remove(tabId);
    } catch {} // tab may already be closed
  }

  sessions.delete(port);
  persistSessions();
}

function persistSessions() {
  const data = {};
  for (const [port, session] of sessions) {
    data[port] = {
      tabIds: [...session.tabIds],
      activeTabId: session.activeTabId,
      adopted: [...(session.adopted || [])],
      groupId: session.groupId,
      color: session.color,
      label: session.label,
    };
  }
  chrome.storage.local.set({ sessions: data });
}

// Get the active tab for this session (last navigated), or create one.
// activate=false (default): runs in background — no focus stealing.
// activate=true: only for commands that NEED visible tab (screenshot, ask_user, navigate, execute_script).
async function getSessionTab(port, activate = false) {
  const session = getSession(port);
  let target = null;
  // Remember our OWN about:blank placeholder so we reuse it instead of spawning another
  // on every read-only call before the first navigate (FIX-4: about:blank proliferation).
  let blankFallback = null;
  const consider = (tab) => {
    if (!tab) return false;
    if (tab.url.startsWith('chrome://')) return false;
    if (tab.url.startsWith('about:')) { if (!blankFallback) blankFallback = tab; return false; }
    return true;
  };

  // Prefer the active (last navigated) tab
  if (session.activeTabId) {
    try {
      const tab = await chrome.tabs.get(session.activeTabId);
      if (consider(tab)) target = tab;
    } catch {
      const dead = session.activeTabId;   // FIX-17: capture id BEFORE nulling (was deleting null)
      session.activeTabId = null;
      session.tabIds.delete(dead);
    }
  }

  // Fallback: any usable session tab
  if (!target) {
    for (const tabId of session.tabIds) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (consider(tab)) { session.activeTabId = tabId; target = tab; break; }
      } catch {
        session.tabIds.delete(tabId);
      }
    }
  }

  // Reuse our own blank placeholder rather than spawning yet another one (FIX-4).
  if (!target && blankFallback) {
    target = blankFallback;
    session.activeTabId = target.id;
    persistSessions();
  }

  // No usable tab at all — create ONE placeholder and pin it as the active tab so the
  // NEXT call reuses it (FIX-4) instead of creating a fresh about:blank every time.
  if (!target) {
    target = await chrome.tabs.create({ url: 'about:blank', active: false });
    await addTabToSession(port, target.id);
    session.activeTabId = target.id;
    persistSessions();
    // fall through to the activate branch (SC-3: previously returned early, skipping it)
  }

  // Activate the tab WITHOUT stealing the user's focus (FIX-1). This is a BACKGROUND tool:
  // screenshot/press_key run constantly, so we must NOT chrome.windows.update({focused:true})
  // here — that yanked Chrome to the foreground on every action. We only (a) un-minimize a
  // minimized window (needed so it can composite) and (b) make the tab active within its
  // window. The truly-occluded (covered) case is handled as a bounded last-resort
  // raise-and-restore inside the screenshot handler only.
  if (activate) {
    try {
      if (target.windowId != null) {
        const win = await chrome.windows.get(target.windowId).catch(() => null);
        if (win && win.state === 'minimized') {
          await chrome.windows.update(target.windowId, { state: 'normal' }); // no focused:true
        }
      }
      if (!target.active) await chrome.tabs.update(target.id, { active: true });
      await new Promise(r => setTimeout(r, 150));
      target = await chrome.tabs.get(target.id);
    } catch { /* best-effort; capture path surfaces the real error */ }
  }

  return target;
}

// ── Chrome Debugger API Helpers (CSP-bypass for Google, Stripe, Slack) ─────

// Track which tabs have debugger attached to avoid repeated attach/detach
const debuggerAttached = new Set();

// Chrome does not route CDP Input.* events (mouse, keys, insertText) to a tab that
// is not the ACTIVE tab of its window — the command succeeds, the page sees nothing,
// and everything silently degrades to the synthetic/native fallbacks. Measured on
// Chrome 150: identical click on the same element is 'synthetic-fallback' while the
// tab is backgrounded and 'trusted' once it is active. So every tool that dispatches
// real input activates its tab first. This activates the TAB within its window only —
// it never calls windows.update({focused:true}), so it does not pull Chrome in front
// of whatever the user is doing.
const INPUT_METHODS = new Set([
  'click', 'fill', 'double_click', 'right_click', 'click_xy', 'press_key',
  'select_option', 'set_date', 'set_combobox', 'hover', 'paste_from_clipboard',
  'solve_captcha', 'upload_file', 'drop_file',
]);

// Verify Chrome's actual debugger-truth before trusting local cache.
// Fixes "ghost-attached" state where Set says attached but Chrome side is gone
// (happens on SW lifecycle events, user-canceled banners, anti-automation evictions).
async function verifyAttachedWithChrome(tabId) {
  try {
    const targets = await chrome.debugger.getTargets();
    const t = targets.find(x => x.tabId === tabId);
    return !!t?.attached;
  } catch {
    return false; // assume not-attached on API error
  }
}

async function debuggerAttach(tabId) {
  // First check local cache — fast path
  if (debuggerAttached.has(tabId)) {
    // Verify with Chrome before trusting cache (cheap, ~1ms)
    if (await verifyAttachedWithChrome(tabId)) return;
    // Cache was stale — Chrome doesn't actually have us attached
    debuggerAttached.delete(tabId);
  }

  // Up to 3 attempts. A "ghost attach" (attach resolves but getTargets shows the tab
  // NOT attached) is usually TRANSIENT: the page is mid-navigation/reload — e.g. the
  // Metro dev-server rebuilding localhost:8081 auto-detaches the debugger. Retrying
  // after a short delay lets the reload settle. Only a ghost that survives all retries
  // is a real user-canceled banner. (Previously we threw on the first ghost, which made
  // dev-server URLs unusable during their initial bundle.)
  let lastMsg = '';
  // FORCE-GRAB: 6 attempts with escalating backoff, and before every retry we
  // force-detach whatever session is lingering on the tab (ours or an orphan left
  // by another extension / a closed DevTools window). Chrome allows exactly one
  // debugger client per tab, so the only way to win a contested tab is to clear
  // the stale claim and re-attach immediately.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      if (await verifyAttachedWithChrome(tabId)) {
        debuggerAttached.add(tabId);
        stickyTabs.add(tabId); // hold this tab across future navigations
        // Start recording network from the moment we own the tab, so the log is
        // there when someone asks — not only after they think to ask.
        chrome.debugger.sendCommand({ tabId }, 'Network.enable', {}).catch(() => {});
        return;
      }
      // Ghost — detach cleanly so the next attempt starts fresh, then retry.
      lastMsg = 'attach resolved but Chrome shows tab not attached (ghost — page likely mid-reload)';
      try { await chrome.debugger.detach({ tabId }); } catch {}
    } catch (e) {
      if (e.message?.includes('Already attached')) {
        // Chrome side has session — sync local cache
        debuggerAttached.add(tabId);
        stickyTabs.add(tabId);
        return;
      }
      // "Cannot attach"/"canceled" can also be transient during navigation — retry too.
      lastMsg = e.message || String(e);
      // A debugger session left behind by ANOTHER extension (or by our own
      // pre-reload instance) makes Chrome answer with "Cannot access a
      // chrome-extension:// URL of different extension" — observed right after
      // disabling a competing automation extension. A forced detach clears the
      // orphaned session so the next attempt can attach cleanly.
      if (/Cannot access|different extension|Another debugger|already attached to a different/i.test(lastMsg)) {
        try { await chrome.debugger.detach({ tabId }); } catch {}
      }
    }
    // Force-detach before EVERY retry, not only on contention messages: a ghost
    // attach (attach resolves, Chrome says not attached) also clears this way.
    if (attempt >= 1) { try { await chrome.debugger.detach({ tabId }); } catch {} }
    if (attempt < 5) await new Promise(r => setTimeout(r, 200 + attempt * 300));
  }
  throw new Error(
    `Debugger attach failed after 6 force-grab attempts (tab ${tabId}). Last: ${lastMsg}. ` +
    `Chrome allows ONE debugger client per tab — check for another automation extension ` +
    `(e.g. Claude in Chrome) or an open DevTools window on this tab, then call browser_reattach_debugger. ` +
    `Note: interactive tools still work via the synthetic fallback; only isTrusted=true is lost.`
  );
}

// STICKY ATTACH: Chrome auto-detaches the debugger on cross-document navigation, and
// whoever re-attaches first owns the tab. Re-claiming immediately on load means a
// competing extension can't take it during the gap — and the next click gets trusted
// events instead of quietly falling back. Only session tabs we already held are
// re-claimed, so this never attaches to tabs the user is browsing manually.
const stickyTabs = new Set();
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete' || !stickyTabs.has(tabId)) return;
  if (debuggerAttached.has(tabId)) return;
  debuggerAttach(tabId).catch(() => {}); // best-effort re-claim
});
chrome.tabs.onRemoved.addListener((tabId) => stickyTabs.delete(tabId));

async function debuggerDetach(tabId) {
  // Don't detach immediately — keep attached for subsequent commands.
  // Will be cleaned up when tab closes or session ends.
}

function debuggerForceDetach(tabId) {
  if (!debuggerAttached.has(tabId)) return;
  debuggerAttached.delete(tabId);
  try {
    chrome.debugger.detach({ tabId });
  } catch {}
}

// ── Network request log (parity gap vs Claude-in-Chrome) ───────────────────
// wait_for_network only ever waited for ONE request. This keeps a rolling log per
// tab from the moment the debugger attaches, so "what did this page call?" is
// answerable retroactively — the same reasoning as capturing console at
// document_start instead of at first read.
const networkLogs = new Map(); // tabId → [{id, method, url, status, type, ms, failed, body}]
const NET_MAX = 300;
const NET_BODY_MAX = 200_000;      // per response
const NET_BODY_BUDGET = 4_000_000; // per tab, so a chatty page cannot grow without bound

function netBodyBytes(tabId) {
  const buf = networkLogs.get(tabId) || [];
  let n = 0;
  for (const e of buf) n += e.body ? e.body.length : 0;
  return n;
}

function netBuf(tabId) {
  let b = networkLogs.get(tabId);
  if (!b) { b = []; networkLogs.set(tabId, b); }
  return b;
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId || !method.startsWith('Network.')) return;
  const buf = netBuf(tabId);
  if (method === 'Network.requestWillBeSent') {
    buf.push({
      id: params.requestId,
      method: params.request?.method,
      url: (params.request?.url || '').slice(0, 300),
      type: params.type,
      started: params.timestamp,
      t0: Date.now(),
    });
    if (buf.length > NET_MAX) buf.splice(0, buf.length - NET_MAX);
  } else if (method === 'Network.responseReceived') {
    const e = buf.find(x => x.id === params.requestId);
    if (e) { e.status = params.response?.status; e.mime = params.response?.mimeType; }
  } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
    const e = buf.find(x => x.id === params.requestId);
    if (e) {
      if (e.started != null && params.timestamp != null) e.ms = Math.round((params.timestamp - e.started) * 1000);
      if (method === 'Network.loadingFailed') { e.failed = true; e.error = params.errorText; }
      delete e.started;
      // Capture data responses while the body is still retrievable. Knowing that a
      // request fired without being able to see what came back is the difference
      // between scraping a virtualised table row by row and just reading the JSON
      // the page already fetched. Bodies are held but only returned on request.
      const isData = e.type === 'XHR' || e.type === 'Fetch' ||
        (e.mime && /json|javascript|text\/plain|xml/i.test(e.mime));
      if (method === 'Network.loadingFinished' && isData && netBodyBytes(tabId) < NET_BODY_BUDGET) {
        chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId: params.requestId })
          .then((r) => {
            if (!r || r.body == null) return;
            if (r.base64Encoded) { e.body_note = 'binary response, not captured'; return; }
            const s = String(r.body);
            e.body_bytes = s.length;
            e.body = s.length > NET_BODY_MAX ? s.slice(0, NET_BODY_MAX) : s;
            if (s.length > NET_BODY_MAX) e.body_truncated = s.length;
          })
          .catch(() => { /* body already evicted from Chrome's cache */ });
      }
    }
  }
});

// Sync local Set when Chrome auto-detaches (navigation, idle, devtools opened, etc.)
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId) {
    debuggerAttached.delete(source.tabId);
    if (reason && reason !== 'target_closed') {
      console.log(`[MCP] Debugger auto-detached from tab ${source.tabId} (reason: ${reason})`);
    }
  }
});

// Methods that are safe to retry without double-effect.
// Side-effectful methods (Input.*, DOM.setFileInputFiles) must NEVER auto-retry:
// Chrome may detach AFTER processing the input (e.g., keystroke triggered navigation),
// and a blind retry would double-type or double-click.
const RETRYABLE_CDP_METHODS = new Set([
  'DOM.getDocument',
  'DOM.querySelector',
  'DOM.querySelectorAll',
  'DOM.focus',
  'DOM.describeNode',
  'Runtime.evaluate',
  'Runtime.enable',
  'Page.captureScreenshot',
  'Page.enable',
  'Network.enable',
  'Network.disable',
  'Network.getResponseBody',
]);

// CDP wrapper with auto-recovery: re-attaches on detach errors.
// For read-only methods (whitelist above), retries once after re-attach.
// For side-effectful methods, only re-attaches and throws — caller must decide.
async function cdpSend(tabId, method, params = {}) {
  await debuggerAttach(tabId);
  let lastMsg = '';
  // 4 total attempts (initial + 3 retries) for read-only methods; backoff 100/300/500ms.
  // Handles aggressive auto-detach on anti-automation sites (Apple ASC, Salesforce, etc.)
  // where Chrome re-detaches between attach and command execution.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await chrome.debugger.sendCommand({ tabId }, method, params);
    } catch (e) {
      const msg = e?.message || String(e);
      const isDetachError =
        msg.includes('not attached') ||
        msg.includes('Detached') ||
        msg.includes('detached') ||
        msg.includes('Debugger is gone') ||
        msg.includes('No tab with given id');
      if (!isDetachError) throw e;
      lastMsg = msg;
      debuggerAttached.delete(tabId);
      if (!RETRYABLE_CDP_METHODS.has(method)) {
        // Side-effectful methods (Input.*) — re-attach for next caller but signal
        // to handler so it can fall back to chrome.scripting (e.g., synthetic click).
        try { await debuggerAttach(tabId); } catch {}
        throw new Error(`Debugger detached during ${method} — not auto-retried (side-effect risk). Original: ${msg}`);
      }
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 100 + attempt * 200));
        try { await debuggerAttach(tabId); } catch (attachErr) {
          throw new Error(`Re-attach failed during ${method}: ${attachErr.message}`);
        }
      }
    }
  }
  throw new Error(`Debugger detached repeatedly during ${method} (4 attempts). Last: ${lastMsg}`);
}

// Clean up debugger + session refs when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
  debuggerAttached.delete(tabId);
  for (const [port, session] of sessions) {
    if (!session.tabIds.has(tabId)) continue;
    session.tabIds.delete(tabId);
    if (session.tabIds.size === 0) {
      // Last tab closed — tell offscreen to terminate the MCP server.
      // Resulting WS-close triggers the existing session_disconnect → releaseSession path.
      chrome.runtime.sendMessage({ type: 'terminate_mcp_session', port }).catch(() => {});
    } else {
      persistSessions();
    }
  }
});

// Physical-key `code` for a character, US layout. We used to build this as
// `Key${char.toUpperCase()}`, which is only correct for letters: "1" became "Key1",
// "@" became "Key@", " " became "Key ". Frameworks that branch on event.code —
// masked inputs, shortcut handlers, several React form libraries — see an unknown
// code and drop the keystroke, so typing an email or URL misbehaved on strict SPAs.
// Shifted symbols report the code of the physical key they sit on ("@" is Digit2).
const CDP_CHAR_CODES = {
  ' ': 'Space', '\n': 'Enter', '\t': 'Tab',
  '-': 'Minus', '_': 'Minus', '=': 'Equal', '+': 'Equal',
  '[': 'BracketLeft', '{': 'BracketLeft', ']': 'BracketRight', '}': 'BracketRight',
  '\\': 'Backslash', '|': 'Backslash', ';': 'Semicolon', ':': 'Semicolon',
  "'": 'Quote', '"': 'Quote', ',': 'Comma', '<': 'Comma',
  '.': 'Period', '>': 'Period', '/': 'Slash', '?': 'Slash',
  '`': 'Backquote', '~': 'Backquote',
  '!': 'Digit1', '@': 'Digit2', '#': 'Digit3', '$': 'Digit4', '%': 'Digit5',
  '^': 'Digit6', '&': 'Digit7', '*': 'Digit8', '(': 'Digit9', ')': 'Digit0',
};
function cdpCodeForChar(ch) {
  if (ch >= 'a' && ch <= 'z') return `Key${ch.toUpperCase()}`;
  if (ch >= 'A' && ch <= 'Z') return `Key${ch}`;
  if (ch >= '0' && ch <= '9') return `Digit${ch}`;
  // Unknown (accented letters, CJK, emoji): omit it. CDP accepts a missing code,
  // and an omitted code is honest where a fabricated one is actively misleading.
  return CDP_CHAR_CODES[ch] || '';
}

// Types text as individual key events. Assumes the debugger is already attached —
// debuggerType() is the public wrapper that manages attach/detach.
async function typeCharsAttached(tabId, text) {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const code = cdpCodeForChar(char);
    await cdpSend(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      text: char,
      key: char,
      ...(code ? { code } : {}),
      unmodifiedText: char,
    });
    await cdpSend(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: char,
      ...(code ? { code } : {}),
    });
    // Human-like typing: random 30-120ms, occasional longer pause
    const pause = (i > 0 && i % (7 + Math.floor(Math.random() * 5)) === 0)
      ? 150 + Math.random() * 200  // thinking pause every ~10 chars
      : 30 + Math.random() * 90;   // normal keystroke
    await new Promise(r => setTimeout(r, pause));
  }
}

async function debuggerType(tabId, text) {
  await debuggerAttach(tabId);
  try {
    await typeCharsAttached(tabId, text);
  } finally {
    await debuggerDetach(tabId);
  }
}

async function debuggerClick(tabId, x, y) {
  await debuggerAttach(tabId);
  try {
    // 0. Capture the DEEPEST target element under the point BEFORE dispatching.
    //    Web-components (Google Ads <button-panel>, Material Web) keep their real
    //    <button> inside an (open) shadow root, so we pierce shadow roots to reach
    //    it. We stash it on window so the framework fallback (step 3) can verify it
    //    is still connected — if the trusted click already navigated/re-rendered,
    //    the ref is detached and we must NOT re-fire (avoids mis-clicks on the new
    //    view / double-submits).
    await cdpSend(tabId, 'Runtime.evaluate', {
      expression: `(() => {
        let el = document.elementFromPoint(${x}, ${y});
        let host = el;
        for (let i = 0; i < 20 && host && host.shadowRoot; i++) {
          const inner = host.shadowRoot.elementFromPoint(${x}, ${y});
          if (!inner || inner === host) break;
          el = inner; host = inner;
        }
        window.__bmcpClickTarget = el || null;
        // FIX-13: watch whether the trusted click (step 2) actually lands on the target,
        // so step 3's framework-fallback does NOT double-fire on elements that stay
        // connected (toggles, checkboxes, add-to-cart, form fields).
        window.__bmcpClicked = false;
        try { window.__bmcpClickListener && document.removeEventListener('click', window.__bmcpClickListener, true); } catch (e) {}
        window.__bmcpClickListener = (ev) => {
          try {
            const t = ev.target;
            if (el && (t === el || el.contains(t) || (ev.composedPath && ev.composedPath().includes(el)))) {
              window.__bmcpClicked = true;
            }
          } catch (e) {}
        };
        document.addEventListener('click', window.__bmcpClickListener, true);
      })()`,
    });
    // 1. mouseMoved first (triggers hover state, required by some frameworks)
    await cdpSend(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y,
    });
    await new Promise(r => setTimeout(r, 30));
    // 2. mousePressed + mouseReleased. The `buttons` bitmask (1 while pressed,
    //    0 on release) plus a small press→release gap are REQUIRED for Chrome to
    //    synthesize a *trusted* 'click' from the pair. Without them, web-components
    //    that gate on the trusted click event (Google Ads, Material Web) never fire.
    await cdpSend(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
    });
    await new Promise(r => setTimeout(r, 30));
    await cdpSend(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
    });
    // 3. Framework fallback — only if the captured target is STILL connected (i.e.
    //    the trusted click in step 2 did not already handle it). Settle delay lets
    //    SPA re-renders (Google Ads) detach the element first. Fires a full pointer
    //    + mouse sequence on the shadow-pierced target, then React/Angular handlers.
    await new Promise(r => setTimeout(r, 120));
    const verdictRes = await cdpSend(tabId, 'Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        let el = window.__bmcpClickTarget;
        const landed = window.__bmcpClicked === true;
        try { window.__bmcpClickListener && document.removeEventListener('click', window.__bmcpClickListener, true); } catch (e) {}
        try { delete window.__bmcpClickTarget; delete window.__bmcpClicked; delete window.__bmcpClickListener; } catch (e) {}
        if (landed) return { landed: true, path: 'trusted' };  // FIX-13: trusted click landed — do NOT double-fire
        if (!el || !el.isConnected) return { landed: true, path: 'navigated' };  // page navigated/re-rendered — click had effect
        // Resolve to the ACTIONABLE control before synthetic dispatch: elementFromPoint
        // returns the deepest element (e.g. the <i> icon inside a submit button), and
        // HTMLElement.click() only runs activation behavior (form submit, checkbox
        // toggle) on the control itself — clicking the icon submits nothing.
        const actionable = (el.closest && el.closest('a,button,input,select,textarea,label,summary,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="option"],[role="checkbox"],[role="radio"],[onclick]'));
        if (actionable) el = actionable;
        const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: ${x}, clientY: ${y} };
        // Watch for the click actually reaching the page, so the verdict is earned
        // rather than assumed.
        let observed = false;
        const spy = () => { observed = true; };
        el.addEventListener('click', spy, true);
        try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) {}
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) {}
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        // EXACTLY ONE activating click. Firing dispatchEvent('click') AND el.click()
        // sends two activations: on a checkbox that toggles twice and lands back on
        // the original value while still looking like a successful click.
        if (typeof el.click === 'function') el.click();
        else el.dispatchEvent(new MouseEvent('click', opts));

        // Framework fallbacks ONLY when no click event was observed — otherwise they
        // re-fire a handler that already ran (double-submits, double-toggles).
        if (!observed) {
          const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
          if (fiberKey) {
            let fiber = el[fiberKey];
            for (let i = 0; i < 10 && fiber; i++) {
              if (fiber.memoizedProps?.onClick) { fiber.memoizedProps.onClick(new MouseEvent('click', {bubbles:true})); observed = true; break; }
              fiber = fiber.return;
            }
          }
          const ngKey = Object.keys(el).find(k => k.startsWith('__ng'));
          if (!observed && (ngKey || el.getAttribute('ng-click') || el.getAttribute('(click)'))) {
            const matRipple = el.closest && el.closest('[mat-button], [mat-raised-button], [mat-icon-button], [mat-fab], mat-checkbox, mat-slide-toggle, mat-radio-button');
            if (matRipple) { matRipple.dispatchEvent(new MouseEvent('click', opts)); observed = true; }
          }
        }
        el.removeEventListener('click', spy, true);
        return { landed: observed, path: observed ? 'synthetic-fallback' : 'no-effect' };
      })()`,
    });
    // Honest reporting: never claim success when zero events reached the page.
    // (The competing tool's worst failure mode — "Clicked at (x,y)" while an
    // instrumented listener records nothing — is exactly what this prevents.)
    return verdictRes?.result?.value || { landed: false, path: 'unverified' };
  } finally {
    await debuggerDetach(tabId);
  }
}

async function debuggerFocus(tabId, selector) {
  await debuggerAttach(tabId);
  try {
    const { root } = await cdpSend(tabId, 'DOM.getDocument', {});
    const { nodeId } = await cdpSend(tabId, 'DOM.querySelector', {
      nodeId: root.nodeId, selector,
    });
    if (!nodeId) throw new Error('Element not found: ' + selector);
    await cdpSend(tabId, 'DOM.focus', { nodeId });
    return nodeId;
  } catch (e) {
    await debuggerDetach(tabId);
    throw e;
  }
}

// Runtime.evaluate that leaves attach state alone. debuggerEval() detaches in its
// finally, which would pull the debugger out from under a fill that is mid-flight.
async function evalAttached(tabId, expression) {
  const result = await cdpSend(tabId, 'Runtime.evaluate', { expression, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Script execution failed');
  }
  return result.result?.value;
}

// Focus + clear a SPECIFIC element via injected JS. Replaces select-all+Backspace
// in the fill paths: those CDP keystrokes go wherever focus happens to be, so when
// a preceding CDP focus/click is swallowed they silently wipe the PREVIOUS field
// (observed: filling password erased the already-filled username, and the form
// submitted empty). Targeting the element directly cannot damage its neighbours.
async function focusAndClearElement(tabId, selectorOrRef) {
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [selectorOrRef],
      func: (sel) => {
        let el = null;
        if (sel && sel.startsWith('ref_')) el = window.__bmcpRefEls && window.__bmcpRefEls[sel];
        else if (sel) { try { el = document.querySelector(sel); } catch {} }
        if (!el || !el.isConnected) return { ok: false };
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.focus();
        if ('value' in el) {
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, ''); else el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (el.isContentEditable) {
          el.textContent = '';
        }
        return { ok: true, focused: document.activeElement === el };
      },
    });
    return r?.result || { ok: false };
  } catch {
    return { ok: false };
  }
}

// Select-all + Backspace. Assumes the debugger is already attached.
// NOTE: only for widget flows (date pickers, comboboxes) where the widget owns
// focus. Never use it in a plain fill — see focusAndClearElement above.
async function clearFieldAttached(tabId) {
  await cdpSend(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'a', code: 'KeyA', modifiers: SELECT_ALL_MODS,
  });
  await cdpSend(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'a', code: 'KeyA',
  });
  await cdpSend(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Backspace', code: 'Backspace',
  });
  await cdpSend(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Backspace', code: 'Backspace',
  });
}

// ── Robust fill (v2.3) ─────────────────────────────────────────────────────
// Replaces the old focus-then-type-then-read-by-selector flow, which could type
// into whatever had focus at that instant and then read back through the ORIGINAL
// selector — reporting a clean success while the text landed in a different field
// (observed on Gmail: a subject value overwrote the To address). Everything here
// operates on ONE element captured up front, tagged with a unique attribute, and
// every step re-resolves that tag — including through shadow roots.

const BMCP_TAG = 'data-bmcp-fill-target';

// Single self-contained injected worker. MV3's extension CSP forbids `new Function`
// in the service worker, and chrome.scripting does not serialize closures, so the
// shadow-piercing resolver is declared inside the function that uses it and the
// operation is selected by argument.
function bmcpFillOp(op, selOrExpected, TAG, extra) {
  const deepQ = (root, s) => {
    let el = null;
    try { el = root.querySelector(s); } catch (e) { return null; }
    if (el) return el;
    for (const n of root.querySelectorAll('*')) if (n.shadowRoot) { const f = deepQ(n.shadowRoot, s); if (f) return f; }
    return null;
  };
  const walkAll = (root, out) => {
    for (const e of root.querySelectorAll('*')) { out.push(e); if (e.shadowRoot) walkAll(e.shadowRoot, out); }
    return out;
  };
  const resolve = (sel) => {
    if (!sel) return null;
    const rm = /^ref[_=](\d+)$/.exec(sel);
    if (rm) {
      const key = 'ref_' + rm[1];
      let e = window.__bmcpRefEls && window.__bmcpRefEls[key];
      if (e && e.isConnected) return e;
      // Re-identify a node the framework replaced, rather than failing the fill.
      const meta = (window.__bmcpRefMeta || {})[key];
      if (!meta) return null;
      const nm = (x) => {
        const a = x.getAttribute && x.getAttribute('aria-label');
        if (a) return a.trim();
        if (x.labels && x.labels[0]) return x.labels[0].textContent.trim().replace(/\s+/g, ' ');
        if (x.placeholder) return x.placeholder.trim();
        const t = (x.textContent || '').trim().replace(/\s+/g, ' ');
        return t ? t.slice(0, 80) : (x.name || x.id || '');
      };
      let cands = walkAll(document, []).filter(x =>
        x.tagName === meta.tag &&
        (meta.type ? (x.type || '').toLowerCase() === meta.type : true) &&
        nm(x) === meta.name);
      if (cands.length > 1 && meta.anchor) {
        const anch = (el2) => {
          const fs = el2.closest && el2.closest('fieldset');
          if (fs) { const lg = fs.querySelector('legend'); if (lg && lg.textContent.trim()) return lg.textContent.trim().replace(/s+/g, ' ').slice(0, 60); }
          const sec = el2.closest && el2.closest('[aria-label], [role="row"], tr, [role="group"], section, li');
          if (sec) {
            const al = sec.getAttribute && sec.getAttribute('aria-label');
            if (al) return al.trim().slice(0, 60);
            const cell = sec.querySelector && sec.querySelector('th, td, [role="rowheader"]');
            if (cell && cell.textContent.trim()) return cell.textContent.trim().replace(/s+/g, ' ').slice(0, 60);
          }
          return null;
        };
        const byAnchor = cands.filter(x => anch(x) === meta.anchor);
        if (byAnchor.length) cands = byAnchor;
      }
      if (!cands.length) return null;
      // Writing into the wrong row is worse than not writing at all.
      if (cands.length > 1) { window.__bmcpRefAmbiguous = cands.length; return null; }
      e = cands[0];
      window.__bmcpRefEls[key] = e;
      window.__bmcpRefHealed = key;
      return e;
    }
    const tm = /^(\w+):text\((.+)\)$/.exec(sel);
    if (tm || sel.startsWith('text=')) {
      const needle = (tm ? tm[2] : sel.slice(5)).trim();
      const want = tm ? tm[1].toUpperCase() : null;
      const all = walkAll(document, []);
      const m = all.filter(e => (!want || e.tagName === want) && (e.textContent || '').trim().includes(needle));
      const inner = m.filter(e => !m.some(o => o !== e && e.contains && e.contains(o)));
      return inner[0] || m[0] || null;
    }
    return deepQ(document, sel);
  };
  const readVal = (el) => el.isContentEditable ? (el.textContent || '') : (el.value != null ? el.value : '');
  const tagged = () => deepQ(document, '[' + TAG + ']');

  // Snapshot editable fields so collateral damage is detectable and reversible.
  // Scoped to the target's own form and capped: on a page with hundreds of fields
  // walking all of them costs real time on every keystroke-level call, and stray
  // text lands in a sibling field, not across the document.
  const snapshotFields = (target) => {
    const scope = (target && target.closest && target.closest('form, [role="form"], fieldset')) || document;
    const out = [];
    for (const e of scope.querySelectorAll('input, textarea, [contenteditable="true"]')) {
      const t = e.tagName;
      if (t !== 'INPUT' && t !== 'TEXTAREA' && !e.isContentEditable) continue;
      if (e.type === 'hidden' || e.type === 'password') continue;
      out.push({ el: e, v: String(readVal(e)) });
      if (out.length >= 80) break;
    }
    return out;
  };

  if (op === 'locate') {
    const el = resolve(selOrExpected);
    if (!el) return { found: false };
    window.__bmcpFieldSnapshot = snapshotFields(el);
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {}
    walkAll(document, []).forEach(n => { if (n.hasAttribute && n.hasAttribute(TAG)) n.removeAttribute(TAG); });
    el.setAttribute(TAG, '1');
    const before = readVal(el);
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
    const active = (el.getRootNode() && el.getRootNode().activeElement) || document.activeElement;
    const r = el.getBoundingClientRect();
    return {
      found: true, isCE: !!el.isContentEditable, tag: el.tagName,
      type: (el.type || '').toLowerCase(), before: String(before),
      focused: active === el,
      focus_landed_on: active === el ? null : ((active && (active.tagName + (active.name ? '[name=' + active.name + ']' : ''))) || 'none'),
      x: r.x + r.width / 2, y: r.y + r.height / 2,
      inShadow: el.getRootNode() !== document,
    };
  }

  if (op === 'verify') {
    const el = tagged();
    if (!el) return { gone: true };
    const expected = selOrExpected;
    let now = String(readVal(el));
    let repaired = false;
    const collateral = [];
    if (now !== expected) {
      // The value is not where we aimed. If trusted keystrokes went somewhere else
      // (focus moved after we checked), some OTHER field now holds our text — the
      // Gmail failure, where a subject line overwrote the recipient. Undo it.
      const snap = window.__bmcpFieldSnapshot || [];
      for (const s of snap) {
        if (!s.el || !s.el.isConnected || s.el === el) continue;
        const cur = String(readVal(s.el));
        if (cur === s.v) continue;
        if (cur.includes(expected) || expected.includes(cur)) {
          // Deliberately not repaired. Writing the old value back fires the
          // framework's change handlers and can flip the form to unsaved-changes,
          // and a silent repair hides the fact that a write went somewhere it
          // should not have. Report it and let the caller stop.
          collateral.push((s.el.name || s.el.id || s.el.tagName) + ' (received this value)');
        }
      }
    }
    if (now !== expected) {
      if (el.isContentEditable) {
        el.focus();
        el.textContent = '';
        try { document.execCommand('insertText', false, expected); } catch (e) { el.textContent = expected; }
      } else {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const d = Object.getOwnPropertyDescriptor(proto, 'value');
        if (d && d.set) d.set.call(el, expected); else el.value = expected;
      }
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      repaired = true;
      now = String(readVal(el));
    }
    return { gone: false, value: now, repaired, collateral };
  }

  if (op === 'ambiguity') {
    const c = window.__bmcpRefAmbiguous || 0;
    try { delete window.__bmcpRefAmbiguous; } catch (e) { window.__bmcpRefAmbiguous = 0; }
    return { count: c };
  }

  if (op === 'focuscheck') {
    const el = tagged();
    if (!el) return { focused: false };
    const active = (el.getRootNode() && el.getRootNode().activeElement) || document.activeElement;
    return { focused: active === el };
  }

  // 'settle' — final read after a tick, then drop the tag
  const el = tagged();
  if (!el) return { gone: true };
  const v = String(readVal(el));
  el.removeAttribute(TAG);
  try { delete window.__bmcpFieldSnapshot; } catch (e) { window.__bmcpFieldSnapshot = null; }
  return { gone: false, value: v };
}

async function fillElementDeep(tabId, selector, value) {
  if (typeof selector !== 'string' || !selector.trim()) {
    return { ok: false, error: 'selector is required and must be a string (received ' + (selector === undefined ? 'nothing' : typeof selector) + ')' };
  }
  const inject = async (args) => {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', args, func: bmcpFillOp,
    });
    return r?.result;
  };

  // 1. Locate ONCE (shadow-piercing), tag it, focus it, report whether focus stuck.
  const info = await inject(['locate', selector, BMCP_TAG, null]);

  if (!info || !info.found) {
    // Distinguish "gone" from "matches several now" — the second is a refusal to
    // act on the wrong element, and the caller needs to know which it was.
    const amb = await inject(['ambiguity', null, BMCP_TAG, null]).catch(() => null);
    if (amb && amb.count > 1) {
      return {
        ok: false,
        error: `${selector} was replaced and now matches ${amb.count} elements with the same label, even after narrowing by container. Refusing to pick by position, which would write into the wrong one. Re-run browser_read_page or browser_form_state for a current reference.`,
        ambiguous: amb.count,
      };
    }
    return { ok: false, error: 'Element not found: ' + selector };
  }

  // 2. Trusted typing ONLY when focus verifiably landed on our element. Otherwise
  //    keystrokes would go to whatever else holds focus — the Gmail failure.
  let method = null, typedTrusted = false;
  if (info.focused && !info.isCE) {
    try {
      await debuggerAttach(tabId);
      // Re-confirm focus immediately before typing — the gap between the focus
      // call and the keystrokes is exactly where a focus-stealing page diverts them.
      const stillFocused = await inject(['focuscheck', null, BMCP_TAG, null]);
      if (!stillFocused?.focused) throw new Error('focus drifted before typing');
      await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: SELECT_ALL_MODS });
      await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
      await cdpSend(tabId, 'Input.insertText', { text: value });
      typedTrusted = true;
      method = 'trusted-input';
    } catch { /* fall through to setter */ }
  }

  // 3. Read back FROM THE TAGGED ELEMENT (never the selector) and repair if needed.
  const verify = await inject(['verify', value, BMCP_TAG, typedTrusted]);

  if (verify?.gone) return { ok: false, error: 'Element left the DOM during fill (page re-rendered) — re-read the page and retry.' };
  if (verify?.repaired) method = typedTrusted ? 'trusted-input+setter-repair' : 'native-setter';

  // 4. Framework-acceptance check: reactive frameworks (LWC, React) can render the
  //    value and still not record it in component state, so a later save persists
  //    blank. Re-read after a tick; if the framework reverted it, say so.
  await new Promise(r => setTimeout(r, 90));
  const settled = await inject(['settle', null, BMCP_TAG, null]);

  const finalValue = settled?.gone ? null : settled.value;
  const accepted = finalValue === value;
  const redacted = info.type === 'password';
  const show = (v) => v == null ? null : (redacted ? `[${v.length} chars]` : String(v).slice(0, 120));

  return {
    ok: accepted,
    method: method || 'native-setter',
    value_before: show(info.before),
    value_after: show(finalValue),
    focus_verified: !!info.focused,
    ...(info.inShadow ? { shadow_dom: true } : {}),
    ...(info.focused ? {} : { focus_drift: info.focus_landed_on }),
    ...(verify?.collateral?.length ? {
      collateral_written: verify.collateral,
      error: "This value also landed in another field. Nothing was rewritten, because repairing it would fire the page's own change handlers and hide the fault. Check those fields before continuing.",
    } : {}),
    ...(accepted ? {} : {
      error: finalValue === '' || finalValue == null
        ? 'Value did not persist — the framework reverted it after input (common on Salesforce LWC / React controlled inputs). The field will likely save blank.'
        : 'Field holds a different value than requested (input mask or validator transformed it).',
    }),
  };
}

async function debuggerFill(tabId, selector, value) {
  // Check if element is contenteditable (rich text editors: LinkedIn, Slack)
  const isContentEditable = await debuggerEval(tabId, `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el?.isContentEditable || el?.getAttribute('contenteditable') === 'true';
    })()
  `);

  if (isContentEditable) {
    // Rich text editors (Quill, ProseMirror, Slate, Draft.js) maintain internal
    // state. Key events get ignored. execCommand('insertText') fires proper
    // InputEvent that these editors handle correctly.
    await debuggerEval(tabId, `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        el.focus();
        // Select all existing content and delete it
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        // Insert new text — fires InputEvent with inputType='insertText'
        document.execCommand('insertText', false, ${JSON.stringify(value)});
      })()
    `);
    return;
  }

  // Standard input/textarea — focus + clear THIS element (element-scoped, so a
  // swallowed CDP focus can never make the clear wipe a different field), then fill.
  await focusAndClearElement(tabId, selector);
  await debuggerFocus(tabId, selector).catch(() => {});
  await debuggerAttach(tabId);
  try {
    // Fast path: one trusted InputEvent instead of N key events. This is the same
    // primitive set_combobox and set_date already rely on, it avoids per-key `code`
    // mapping entirely, and it turns a 40-character value from ~3 seconds of
    // keystrokes into a single call — which also shrinks the window in which the
    // debugger can detach mid-fill.
    await cdpSend(tabId, 'Input.insertText', { text: value });

    // Verify something actually landed. Masked inputs, maxlength enforcement and
    // autocompletes that filter per keydown can swallow an inserted string, and
    // until now that failed silently: the caller got "ok" and the field stayed
    // empty. Only an EMPTY field triggers the fallback — a field that transformed
    // the text (phone/date masks reformatting it) did accept the input, and
    // retyping it per character would produce the same transform for no gain.
    const landed = await evalAttached(tabId, `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        return ('value' in el) ? el.value : el.textContent;
      })()
    `);
    if (!landed) {
      await focusAndClearElement(tabId, selector);
      await typeCharsAttached(tabId, value);
      // Last resort: if trusted typing was also swallowed, set the value natively.
      const still = await evalAttached(tabId, `
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          return ('value' in el) ? el.value : el.textContent;
        })()
      `).catch(() => null);
      if (!still) {
        await chrome.scripting.executeScript({
          target: { tabId }, world: 'MAIN', args: [selector, value],
          func: (sel, val) => {
            const el = document.querySelector(sel);
            if (!el) return;
            el.focus();
            const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter && 'value' in el) setter.call(el, val); else if ('value' in el) el.value = val;
            else if (el.isContentEditable) el.textContent = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          },
        }).catch(() => {});
      }
    }
  } finally {
    await debuggerDetach(tabId);
  }
}

async function debuggerEval(tabId, expression) {
  await debuggerAttach(tabId);
  try {
    const result = await cdpSend(tabId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Script execution failed');
    }
    return result.result?.value;
  } finally {
    await debuggerDetach(tabId);
  }
}

// Synthetic click via chrome.scripting — fallback when debugger detaches on
// anti-automation sites (Apple ASC, etc.). Loses isTrusted=true but works for
// the ~95% of sites that don't check it. Handles text= and :text() selectors.
async function scriptingClick(tabId, selector) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (sel) => {
        let el;
        const refM = sel.match(/^ref[_=](\d+)$/);
        if (refM) {
          el = window.__bmcpRefEls && window.__bmcpRefEls['ref_' + refM[1]];
          if (el && !el.isConnected) el = null;
        } else if (sel.startsWith('text=')) {
          const text = sel.slice(5).trim();
          el = Array.from(document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="tab"], [role="option"], input, label, span, div, p, li, td'))
            .find(e => (e.textContent || '').trim() === text);
        } else {
          const m = sel.match(/^([\w-]+):text\(([^)]+)\)$/);
          if (m) {
            const needle = m[2].trim();
            el = Array.from(document.querySelectorAll(m[1]))
              .find(e => (e.textContent || '').trim().includes(needle));
          } else {
            el = document.querySelector(sel);
          }
        }
        if (!el) return { ok: false, reason: 'not_found' };
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const opts = { bubbles: true, cancelable: true, view: window };
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.click();
        return { ok: true, tag: el.tagName };
      },
      args: [selector],
    });
    return result?.result || { ok: false, reason: 'no_result' };
  } catch (e) {
    return { ok: false, reason: 'exception', error: e.message };
  }
}

// Try executeScript first, fall back to debugger on CSP error
async function safeExecuteScript(tabId, func, args = [], world = 'MAIN') {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args,
      ...(world === 'MAIN' ? { world: 'MAIN' } : {}),
    });
    return { result: result.result, usedDebugger: false };
  } catch (e) {
    if (e.message?.includes('Content Security Policy') || e.message?.includes('unsafe-eval')) {
      // CSP blocked — this is expected on Google, Stripe, Slack
      return { cspBlocked: true };
    }
    throw e;
  }
}

// ── Smart Selector Resolution ─────────────────────────────────────────────
// Supports CSS selectors AND text-based selectors:
//   "button:text(Get started)" → finds button containing "Get started"
//   "#my-id" → standard CSS selector
//   "text=Submit" → any element containing "Submit"

function buildTextFinderJS(textPattern, tagFilter) {
  const escaped = JSON.stringify(textPattern);
  const wantTag = tagFilter ? JSON.stringify(tagFilter.toUpperCase()) : 'null';
  return `(function() {
    const text = ${escaped};
    const wantTag = ${wantTag};
    // Interactive controls we prefer to actually click. Fixes the class of bug where a
    // text match lands on a large CONTAINER (e.g. Angular Material <mat-nav-list>,
    // toolbar, list-item) whose center is NOT over the real <button> — so the trusted
    // click misses and menus/dropdowns never open.
    const CLICKABLE = 'a,button,summary,label,[role="button"],[role="menuitem"],' +
      '[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="tab"],' +
      '[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[onclick],' +
      '[mat-button],[mat-raised-button],[mat-stroked-button],[mat-flat-button],' +
      '[mat-icon-button],[mat-fab],[mat-mini-fab],[mat-menu-item],[mat-list-item],' +
      'mat-checkbox,mat-slide-toggle,mat-radio-button';
    function collectAll(root, results) {
      for (const el of root.querySelectorAll('*')) {
        results.push(el);
        if (el.shadowRoot) collectAll(el.shadowRoot, results);
      }
      return results;
    }
    const all = collectAll(document, []);
    const tagOk = (el) => !wantTag || el.tagName === wantTag;
    // Map a matched element to the ACTIONABLE control: itself if clickable, else the
    // nearest clickable ancestor (only if its own text isn't much larger than the match,
    // so we don't grab a whole toolbar), else a clickable descendant.
    function toClickable(el) {
      if (el.matches && el.matches(CLICKABLE)) return el;
      const anc = el.closest && el.closest(CLICKABLE);
      if (anc && (anc.textContent || '').trim().length <= text.length + 40) return anc;
      const desc = el.querySelector && el.querySelector(CLICKABLE);
      if (desc) return desc;
      return el;
    }
    function pick(test) {
      const matches = all.filter(el => tagOk(el) && test((el.textContent || '').trim()));
      if (!matches.length) return null;
      // Prefer the INNERMOST matches (an element that is not an ancestor of another
      // match) — this is what "prefer leaf nodes" was supposed to do.
      const inner = matches.filter(el => !matches.some(o => o !== el && el.contains && el.contains(o)));
      const pool = inner.length ? inner : matches;
      // Prefer a match that resolves to a real interactive control.
      for (const el of pool) {
        const c = toClickable(el);
        if (c && c.matches && c.matches(CLICKABLE)) return c;
      }
      return toClickable(pool[0]);
    }
    // Exact match first, then partial fallback.
    return pick(t => t === text) || pick(t => t && t.includes(text));
  })()`;
}

function parseSelector(selector) {
  if (typeof selector !== 'string') selector = '';
  // "ref_12" / "ref=12" → element handle from browser_read_page / browser_find
  const refMatch = selector.match(/^ref[_=](\d+)$/);
  if (refMatch) return { type: 'ref', ref: 'ref_' + refMatch[1] };

  // "button:text(Get started)" → { tag: 'button', text: 'Get started' }
  const tagTextMatch = selector.match(/^(\w+):text\((.+)\)$/);
  if (tagTextMatch) return { type: 'text', tag: tagTextMatch[1], text: tagTextMatch[2] };

  // "text=Submit" → { text: 'Submit' }
  if (selector.startsWith('text=')) return { type: 'text', tag: null, text: selector.slice(5) };

  // Standard CSS selector
  return { type: 'css', selector };
}

// Locate a ref-handle element (assigned by read_page/find) and return its center.
// Runs as a serialized function in MAIN world — page CSP cannot block it.
//
// Reactive frameworks (LWC, Angular Material, React) replace subtrees on every
// input event, so a ref captured moments earlier can point at a detached node.
// Failing there forces a re-read between every single action. Instead each ref
// carries a fingerprint — role, accessible name, tag and its index among
// same-looking elements — and a stale ref is re-resolved from that. The element is
// identified by what it IS, not by the object it happened to be.
function bmcpResolveRef(key) {
  const refs = window.__bmcpRefEls || {};
  const meta = (window.__bmcpRefMeta || {})[key];
  let el = refs[key];
  let healed = false;

  if ((!el || !el.isConnected) && meta) {
    const nameOf = (e) => {
      const a = e.getAttribute && e.getAttribute('aria-label');
      if (a) return a.trim();
      if (e.labels && e.labels[0]) return e.labels[0].textContent.trim().replace(/\s+/g, ' ');
      if (e.placeholder) return e.placeholder.trim();
      const t = (e.textContent || '').trim().replace(/\s+/g, ' ');
      if (t) return t.slice(0, 80);
      return e.name || e.id || '';
    };
    const all = [];
    const walk = (root) => {
      for (const e of root.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot); }
    };
    walk(document);
    const anchorOf = (e) => {
      const fs = e.closest && e.closest('fieldset');
      if (fs) { const lg = fs.querySelector('legend'); if (lg && lg.textContent.trim()) return lg.textContent.trim().replace(/\s+/g, ' ').slice(0, 60); }
      const sec = e.closest && e.closest('[aria-label], [role="row"], tr, [role="group"], section, li');
      if (sec) {
        const al = sec.getAttribute && sec.getAttribute('aria-label');
        if (al) return al.trim().slice(0, 60);
        const cell = sec.querySelector && sec.querySelector('th, td, [role="rowheader"]');
        if (cell && cell.textContent.trim()) return cell.textContent.trim().replace(/\s+/g, ' ').slice(0, 60);
      }
      return null;
    };
    let sameKind = all.filter(e =>
      e.tagName === meta.tag &&
      (meta.type ? (e.type || '').toLowerCase() === meta.type : true) &&
      nameOf(e) === meta.name);
    // Narrow by the container the element was recorded in before considering position.
    if (sameKind.length > 1 && meta.anchor) {
      const byAnchor = sameKind.filter(e => anchorOf(e) === meta.anchor);
      if (byAnchor.length) sameKind = byAnchor;
    }
    if (sameKind.length === 1) {
      el = sameKind[0];
      healed = true;
      refs[key] = el;
    } else if (sameKind.length > 1) {
      // Position is not identity. Guessing here lands on the wrong record, which
      // is worse than reporting that the reference can no longer be resolved.
      return { error: 'ambiguous-ref', candidates: sameKind.length, name: meta.name, anchor: meta.anchor || null };
    }
  }

  if (!el) return { error: meta ? 'stale-ref' : 'unknown-ref' };
  if (!el.isConnected) return { error: 'stale-ref' };
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const rect = el.getBoundingClientRect();
  return {
    x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
    tag: el.tagName, text: (el.textContent || '').trim().slice(0, 80), found: true, healed,
  };
}

async function resolveRefElement(tabId, refKey) {
  const r = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN', func: bmcpResolveRef, args: [refKey],
  });
  const res = r?.[0]?.result;
  if (!res || res.error) {
    if (res?.error === 'ambiguous-ref') {
      throw new Error(
        `Ref ${refKey} was replaced and now matches ${res.candidates} elements named "${res.name}"` +
        (res.anchor ? ` even within "${res.anchor}"` : '') +
        '. Refusing to guess by position, which would act on the wrong one. Re-run browser_read_page or browser_find to get an unambiguous reference.');
    }
    throw new Error(res?.error === 'stale-ref'
      ? `Ref ${refKey} no longer matches anything on the page — it was replaced and could not be re-identified. Re-run browser_read_page or browser_find.`
      : `Unknown ref ${refKey} on this page. Run browser_read_page or browser_find first (refs are per-page and reset on navigation).`);
  }
  return res;
}

async function resolveElement(tabId, selectorStr) {
  const parsed = parseSelector(selectorStr);

  if (parsed.type === 'ref') {
    return await resolveRefElement(tabId, parsed.ref);
  }

  if (parsed.type === 'css') {
    // Standard CSS with shadow DOM traversal — try executeScript first, debugger fallback
    const deepQueryFn = (sel) => {
      function queryDeep(root, s) {
        const el = root.querySelector(s);
        if (el) return el;
        for (const node of root.querySelectorAll('*')) {
          if (node.shadowRoot) {
            const found = queryDeep(node.shadowRoot, s);
            if (found) return found;
          }
        }
        return null;
      }
      const el = queryDeep(document, sel);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: el.tagName, found: true };
    };

    const scriptResult = await safeExecuteScript(tabId, deepQueryFn, [parsed.selector]);

    if (scriptResult.cspBlocked) {
      const sel = JSON.stringify(parsed.selector);
      const result = await debuggerEval(tabId, `
        (function() {
          function queryDeep(root, s) {
            const el = root.querySelector(s);
            if (el) return el;
            for (const node of root.querySelectorAll('*')) {
              if (node.shadowRoot) { const f = queryDeep(node.shadowRoot, s); if (f) return f; }
            }
            return null;
          }
          const el = queryDeep(document, ${sel});
          if (!el) return null;
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width/2, y: r.y + r.height/2, tag: el.tagName, found: true };
        })()
      `);
      return result ? { ...result, method: 'debugger' } : null;
    }
    return scriptResult.result;
  }

  // Text-based selector — always use debugger (more reliable, no CSP issues)
  const finderJS = buildTextFinderJS(parsed.text, parsed.tag);
  const result = await debuggerEval(tabId, `
    (function() {
      const el = ${finderJS};
      if (!el) return null;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2, tag: el.tagName, text: el.textContent?.trim().slice(0, 80), found: true };
    })()
  `);
  return result ? { ...result, method: 'debugger' } : null;
}

// ── Offscreen Document Setup ───────────────────────────────────────────────

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Maintain persistent WebSocket connection to local MCP server',
    });
  }
}

// ── Action Logging ─────────────────────────────────────────────────────────

const SENSITIVE = new Set(['get_cookies', 'get_local_storage', 'execute_script', 'extract_token']);

function logAction(port, method, params) {
  const category = SENSITIVE.has(method) ? 'sensitive' : 'safe';
  const session = sessions.get(port);
  const entry = {
    time: Date.now(),
    method,
    params: JSON.stringify(params).slice(0, 200),
    category,
    session: session?.label || `Port ${port}`,
    color: session?.color || 'grey',
  };
  chrome.storage.local.get({ actionLog: [] }, ({ actionLog }) => {
    actionLog.unshift(entry);
    if (actionLog.length > 50) actionLog.length = 50;
    chrome.storage.local.set({ actionLog });
  });
}

// ── Message Handler — receives commands from offscreen.js ──────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'mcp_command') {
    const port = msg.port;
    logAction(port, msg.method, msg.params);
    // Restore sessions from storage (service worker may have restarted)
    restoreSessions().then(() => {
      dispatch(port, msg.method, msg.params)
        .then(async (result) => {
          // v2.0: echo active-tab context on every response (like Claude-in-Chrome's
          // "Tab Context" footer) so the model never drifts on which page it's driving.
          if (result && typeof result === 'object' && !Array.isArray(result) && !result.__error) {
            // Always, not only when the result lacks a url. When something goes
            // wrong three steps later, knowing which tab each call acted on and
            // where it was is the difference between reading the trail and
            // spending a full page read to re-orient.
            try {
              const s = sessions.get(port);
              if (s?.activeTabId) {
                const t = await chrome.tabs.get(s.activeTabId);
                result._tab = `tab ${t.id} · ${(t.url || '').replace(/^https?:\/\//, '').slice(0, 90)}`;
              }
            } catch {}
          }
          sendResponse(result);
        })
        .catch(err => sendResponse({ __error: err.message || String(err) }));
    }).catch(err => sendResponse({ __error: err.message || String(err) })); // else a storage-restore reject hangs the caller
    return true; // async response
  }

  if (msg.type === 'bmcp_get_instance') {
    // Offscreen doc can't use chrome.storage — serve the persisted browser identity.
    chrome.storage.local.get(['bmcpInstanceId', 'bmcpLabel']).then(async (stored) => {
      let id = stored.bmcpInstanceId;
      if (!id) {
        id = crypto.randomUUID();
        await chrome.storage.local.set({ bmcpInstanceId: id });
      }
      sendResponse({ id, label: stored.bmcpLabel || null });
    }).catch(() => sendResponse(null));
    return true; // async response
  }

  if (msg.type === 'session_disconnect') {
    releaseSession(msg.port);
    return;
  }

  if (msg.type === 'reconnect') {
    chrome.offscreen.hasDocument().then(exists => {
      if (exists) chrome.offscreen.closeDocument().then(() => ensureOffscreen());
      else ensureOffscreen();
    });
    return;
  }

  if (msg.type === 'ws_status') {
    const count = msg.count || (msg.connected ? 1 : 0);
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    if (count > 0) {
      chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
    }
    chrome.storage.local.set({
      mcpConnected: msg.connected,
      mcpCount: count,
      mcpPorts: msg.ports || [],
    });
    return;
  }
});

// ── OAuth Popup Interception ─────────────────────────────────────────────────

const OAUTH_DOMAINS = ['accounts.google.com', 'login.microsoftonline.com', 'github.com/login/oauth', 'slack.com/oauth', 'app.hubspot.com/oauth'];

let lastCreatedTabId = null;

chrome.tabs.onCreated.addListener(async (tab) => {
  lastCreatedTabId = tab.id;

  // Auto-claim OAuth popups for the session that opened them
  if (tab.pendingUrl || tab.url) {
    const url = tab.pendingUrl || tab.url;
    const isOAuth = OAUTH_DOMAINS.some(d => url.includes(d));
    if (isOAuth) {
      for (const [port, session] of sessions) {
        if (tab.openerTabId && session.tabIds.has(tab.openerTabId)) {
          await addTabToSession(port, tab.id);
          session.activeTabId = tab.id;
          persistSessions();
          break;
        }
      }
    }
  }
});

// ── Deep Shadow DOM Query ────────────────────────────────────────────────────
// querySelectorDeep: finds elements inside shadow DOMs (Shopify, Salesforce, etc.)

function buildDeepQueryJS(selector) {
  return `(function() {
    function queryDeep(root, sel) {
      const el = root.querySelector(sel);
      if (el) return el;
      for (const node of root.querySelectorAll('*')) {
        if (node.shadowRoot) {
          const found = queryDeep(node.shadowRoot, sel);
          if (found) return found;
        }
      }
      return null;
    }
    return queryDeep(document, ${JSON.stringify(selector)});
  })()`;
}

// ── Date Input Helpers ──────────────────────────────────────────────────────

const MONTHS_EN = ['january','february','march','april','may','june','july','august','september','october','november','december'];
const MONTHS_DA = ['januar','februar','marts','april','maj','juni','juli','august','september','oktober','november','december'];
const MONTHS_ABBR_EN = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

function parsePlaceholderFormat(placeholder) {
  if (!placeholder) return null;
  const upper = placeholder.toUpperCase();
  let sep = null;
  if (upper.includes('/')) sep = '/';
  else if (upper.includes('-')) sep = '-';
  else if (upper.includes('.')) sep = '.';
  else return null;
  const parts = upper.split(sep);
  if (parts.length !== 3) return null;
  const order = parts.map(p => p.includes('Y') ? 'Y' : p.includes('M') ? 'M' : p.includes('D') ? 'D' : null);
  if (order.includes(null) || new Set(order).size !== 3) return null;
  const padded = parts.map(p => p.length >= 2);
  return { sep, order, padded };
}

function isoToFormat(iso, fmt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error('Invalid ISO date: ' + iso);
  const [, y, mo, d] = m;
  return fmt.order.map((slot, i) => {
    if (slot === 'Y') return y;
    if (slot === 'M') return fmt.padded[i] ? mo : String(parseInt(mo, 10));
    if (slot === 'D') return fmt.padded[i] ? d : String(parseInt(d, 10));
  }).join(fmt.sep);
}

function parseMonthYearText(text) {
  if (!text) return null;
  const cleaned = text.toLowerCase().trim();
  const tables = [MONTHS_EN, MONTHS_DA, MONTHS_ABBR_EN];
  for (const table of tables) {
    for (let i = 0; i < table.length; i++) {
      if (cleaned.includes(table[i])) {
        const ym = cleaned.match(/(\d{4})/);
        if (ym) return { year: parseInt(ym[1], 10), month: i + 1 };
      }
    }
  }
  const num = cleaned.match(/(\d{1,2})[\/\-\s.](\d{4})/);
  if (num) return { year: parseInt(num[2], 10), month: parseInt(num[1], 10) };
  return null;
}

function valueLooksLikeIso(value, iso) {
  if (!value || !iso) return false;
  const [y, m, d] = iso.split('-');
  const digits = value.replace(/\D/g, '');
  if (digits.includes(y + m + d)) return true;
  if (digits.includes(m + d + y)) return true;
  if (digits.includes(d + m + y)) return true;
  const hasYear = value.includes(y);
  const hasMonth = value.includes(m) || value.includes(String(parseInt(m, 10)));
  const hasDay = value.includes(d) || value.includes(String(parseInt(d, 10)));
  return hasYear && hasMonth && hasDay;
}

async function getDateInputInfo(tabId, selector) {
  const json = await debuggerEval(tabId, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return JSON.stringify({ found: false });
    return JSON.stringify({
      found: true,
      tag: el.tagName,
      inputType: (el.type || '').toLowerCase(),
      readOnly: !!el.readOnly,
      disabled: !!el.disabled,
      placeholder: el.placeholder || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      value: el.value !== undefined ? el.value : (el.textContent || ''),
    });
  })()`);
  return JSON.parse(json);
}

async function readBackValue(tabId, selector) {
  const json = await debuggerEval(tabId, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return JSON.stringify({ value: null });
    return JSON.stringify({ value: el.value !== undefined ? el.value : (el.textContent || '') });
  })()`);
  return JSON.parse(json).value;
}

async function setDateNative(tabId, selector, iso) {
  const r = await safeExecuteScript(tabId, (sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return { ok: false, error: 'not-found' };
    try {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.focus();
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, val); else el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
      return { ok: true, value: el.value };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }, [selector, iso]);
  if (r.cspBlocked) {
    await debuggerEval(tabId, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return;
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, ${JSON.stringify(iso)}); else el.value = ${JSON.stringify(iso)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    })()`);
    return { ok: true, csp: true };
  }
  return r.result || { ok: false, error: 'no-result' };
}

async function setDateMaskedTyping(tabId, selector, iso, format) {
  const formatted = isoToFormat(iso, format);
  await debuggerFocus(tabId, selector);
  await debuggerAttach(tabId);
  try {
    await cdpSend(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a', code: 'KeyA', modifiers: SELECT_ALL_MODS,
    });
    await cdpSend(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA',
    });
    await cdpSend(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Backspace', code: 'Backspace',
    });
    await cdpSend(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Backspace', code: 'Backspace',
    });
    await cdpSend(tabId, 'Input.insertText', { text: formatted });
    await cdpSend(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Tab', code: 'Tab',
    });
    await cdpSend(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Tab', code: 'Tab',
    });
  } finally {
    await debuggerDetach(tabId);
  }
  return { ok: true, formatted };
}

const PICKER_OPEN_SELECTORS = [
  '[role="dialog"] [role="grid"]',
  '[role="dialog"] [role="gridcell"]',
  '.react-datepicker',
  '.MuiPickersPopper-root',
  '.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)',
  '[class*="DayPicker"]:not(input)',
  '[class*="Calendar"][class*="open" i]',
];

async function isPickerOpen(tabId) {
  return await debuggerEval(tabId, `(() => {
    const sels = ${JSON.stringify(PICKER_OPEN_SELECTORS)};
    for (const s of sels) {
      try { if (document.querySelector(s)) return true; } catch {}
    }
    return false;
  })()`);
}

async function setDatePicker(tabId, selector, iso) {
  const [yStr, mStr, dStr] = iso.split('-');
  const targetYear = parseInt(yStr, 10);
  const targetMonth = parseInt(mStr, 10);
  const targetDay = parseInt(dStr, 10);

  const inputEl = await resolveElement(tabId, selector);
  if (!inputEl) return { ok: false, error: 'input-not-found' };
  await debuggerClick(tabId, inputEl.x, inputEl.y);

  let opened = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (await isPickerOpen(tabId)) { opened = true; break; }
  }

  if (!opened) {
    const triggerClicked = await safeExecuteScript(tabId, (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const candidates = [
        ...(el.parentElement?.querySelectorAll('button, [role="button"], [aria-haspopup]') || []),
        ...(el.parentElement?.parentElement?.querySelectorAll('button, [role="button"], [aria-haspopup]') || []),
      ];
      for (const c of candidates) {
        const label = (c.getAttribute('aria-label') || '').toLowerCase();
        if (label.includes('calendar') || label.includes('date') || label.includes('vælg dato') || label.includes('open') || label.includes('åbn')) {
          c.click();
          return true;
        }
      }
      for (const c of candidates) {
        if (c.querySelector('svg, [class*="calendar" i]')) {
          c.click();
          return true;
        }
      }
      return false;
    }, [selector]);
    if (triggerClicked.result) {
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (await isPickerOpen(tabId)) { opened = true; break; }
      }
    }
  }

  if (!opened) return { ok: false, error: 'picker-did-not-open' };

  const MAX_NAV = 36;
  let navAttempts = 0;
  let lastHeader = null;
  let stuck = 0;
  let navExitReason = 'reached-target';
  let lastReachedMonthYear = null;
  for (let i = 0; i < MAX_NAV; i++) {
    const headerJson = await debuggerEval(tabId, `(() => {
      const roots = [
        document.querySelector('[role="dialog"]'),
        document.querySelector('.react-datepicker'),
        document.querySelector('.MuiPickersPopper-root'),
        document.querySelector('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)'),
      ].filter(Boolean);
      for (const root of roots) {
        const candidates = [
          root.querySelector('[role="heading"]'),
          root.querySelector('[aria-live]'),
          root.querySelector('.MuiPickersCalendarHeader-label'),
          root.querySelector('.react-datepicker__current-month'),
          root.querySelector('.ant-picker-header-view'),
        ].filter(Boolean);
        for (const el of candidates) {
          const t = (el.textContent || '').trim();
          if (t.length > 0 && t.length < 80) return JSON.stringify({ text: t });
        }
      }
      return JSON.stringify({});
    })()`);
    const header = JSON.parse(headerJson);
    const parsed = parseMonthYearText(header.text || '');
    if (!parsed) {
      navExitReason = header.text ? 'header-parse-failed' : 'no-header-found';
      break;
    }
    lastReachedMonthYear = `${parsed.year}-${String(parsed.month).padStart(2, '0')}`;

    if (header.text === lastHeader) {
      stuck++;
      if (stuck >= 3) { navExitReason = 'navigation-stuck'; break; }
    } else {
      stuck = 0;
      lastHeader = header.text;
    }

    const delta = (targetYear * 12 + targetMonth) - (parsed.year * 12 + parsed.month);
    if (delta === 0) break;
    if (i === MAX_NAV - 1) {
      navExitReason = 'max-nav-exceeded';
    }

    const dir = delta > 0 ? 'next' : 'prev';
    const navClicked = await safeExecuteScript(tabId, (direction) => {
      const roots = [
        document.querySelector('[role="dialog"]'),
        document.querySelector('.react-datepicker'),
        document.querySelector('.MuiPickersPopper-root'),
        document.querySelector('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)'),
      ].filter(Boolean);
      const labels = direction === 'next'
        ? ['next month', 'next', 'forward', 'næste']
        : ['previous month', 'previous', 'prev', 'back', 'forrige'];
      const classFallbacks = direction === 'next'
        ? ['.react-datepicker__navigation--next', '.ant-picker-header-next-btn', '.ant-picker-header-super-next-btn']
        : ['.react-datepicker__navigation--previous', '.ant-picker-header-prev-btn', '.ant-picker-header-super-prev-btn'];
      for (const root of roots) {
        const buttons = [...root.querySelectorAll('button, [role="button"]')];
        for (const b of buttons) {
          const label = (b.getAttribute('aria-label') || b.title || '').toLowerCase();
          if (labels.some(l => label.includes(l))) { b.click(); return true; }
        }
        for (const cs of classFallbacks) {
          const b = root.querySelector(cs);
          if (b) { b.click(); return true; }
        }
      }
      return false;
    }, [dir]);

    if (!navClicked.result) {
      await debuggerAttach(tabId);
      try {
        const key = delta > 0 ? 'PageDown' : 'PageUp';
        await cdpSend(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyDown', key, code: key,
        });
        await cdpSend(tabId, 'Input.dispatchKeyEvent', {
          type: 'keyUp', key, code: key,
        });
      } finally {
        await debuggerDetach(tabId);
      }
    }
    navAttempts++;
    await new Promise(r => setTimeout(r, 90));
  }

  const dayResult = await safeExecuteScript(tabId, (day, year, month, monthsEn, monthsDa, monthsAbbr) => {
    const roots = [
      document.querySelector('[role="dialog"]'),
      document.querySelector('.react-datepicker'),
      document.querySelector('.MuiPickersPopper-root'),
      document.querySelector('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)'),
    ].filter(Boolean);
    const monthEn = monthsEn[month - 1];
    const monthDa = monthsDa[month - 1];
    const monthAbbr = monthsAbbr[month - 1];

    for (const root of roots) {
      const cells = [...root.querySelectorAll('[role="gridcell"], .react-datepicker__day, .ant-picker-cell, [class*="PickersDay"]')];
      const isDisabled = (c) => c.getAttribute('aria-disabled') === 'true' ||
        c.classList.contains('disabled') ||
        c.classList.contains('react-datepicker__day--disabled') ||
        c.classList.contains('ant-picker-cell-disabled') ||
        c.classList.contains('Mui-disabled');
      const isOutside = (c) => {
        const cls = c.className || '';
        if (/outside|other-month|--prev|--next|adjacent/i.test(cls)) return true;
        if (c.classList.contains('react-datepicker__day--outside-month')) return true;
        if (c.classList.contains('ant-picker-cell') && !c.classList.contains('ant-picker-cell-in-view')) return true;
        return false;
      };

      for (const c of cells) {
        if (isDisabled(c) || isOutside(c)) continue;
        const label = (c.getAttribute('aria-label') || '').toLowerCase();
        if (!label) continue;
        const matchesMonth = label.includes(monthEn) || label.includes(monthDa) || label.includes(monthAbbr);
        const matchesYear = label.includes(String(year));
        const dayPattern = new RegExp('\\b' + day + '(st|nd|rd|th)?\\b');
        const dayPaddedPattern = new RegExp('\\b' + String(day).padStart(2, '0') + '\\b');
        if (matchesMonth && matchesYear && (dayPattern.test(label) || dayPaddedPattern.test(label))) {
          c.click();
          return { ok: true, method: 'aria-label', label };
        }
      }

      for (const c of cells) {
        if (isDisabled(c) || isOutside(c)) continue;
        const text = (c.textContent || '').trim();
        if (text === String(day) || text === String(day).padStart(2, '0')) {
          c.click();
          return { ok: true, method: 'text-content' };
        }
      }
    }
    return { ok: false, error: 'day-not-found' };
  }, [targetDay, targetYear, targetMonth, MONTHS_EN, MONTHS_DA, MONTHS_ABBR_EN]);

  if (!dayResult.result || !dayResult.result.ok) {
    return {
      ok: false,
      error: dayResult.result?.error || 'day-click-failed',
      navAttempts,
      navExitReason,
      lastReachedMonthYear,
      targetMonthYear: `${targetYear}-${String(targetMonth).padStart(2, '0')}`,
    };
  }

  await new Promise(r => setTimeout(r, 350));
  return { ok: true, method: dayResult.result.method, navAttempts };
}

async function collectVisibleErrors(tabId, selector) {
  const json = await debuggerEval(tabId, `(() => {
    const errs = [];
    const el = document.querySelector(${JSON.stringify(selector)});
    if (el?.getAttribute('aria-invalid') === 'true') errs.push('aria-invalid=true on input');
    const candidates = [
      ...document.querySelectorAll('[role="alert"], .error-text, [class*="error" i]:not(input):not(button)'),
    ].slice(0, 8);
    for (const c of candidates) {
      const t = (c.textContent || '').trim();
      if (t && t.length < 200 && c.offsetHeight > 0) errs.push(t);
    }
    return JSON.stringify(errs);
  })()`);
  try { return JSON.parse(json); } catch { return []; }
}

// ── Overlay Dismissal Helper ────────────────────────────────────────────────

async function dismissOverlays(tabId, scope = 'non_critical', maxPasses = 3) {
  // Clamp to sensible range; reject sloppy input
  const passes = Math.max(1, Math.min(10, Number.isInteger(maxPasses) ? maxPasses : 3));
  const allDismissed = [];
  const allSkipped = [];

  for (let pass = 0; pass < passes; pass++) {
    const r = await safeExecuteScript(tabId, (s) => {
      const dismissed = [];
      const skipped = [];

      // "Safe" texts cannot revert form data — they're purely informational close affordances
      const safeTexts = [
        "luk", "dismiss", "close", "got it", "got it, thanks",
        "not now", "ikke nu", "senere", "later",
        "don't show", "don't show again", "dont show again", "dont show",
        "no thanks", "maybe later", "ok", "ok!", "okay",
      ];
      // "Ambiguous" texts MAY revert partial form data ("Cancel" usually reverts state)
      // — only used when overlay has no editable form fields, or in aggressive scope
      const ambiguousTexts = [
        "skip", "cancel", "afvis", "spring over",
      ];
      const xChars = ['×', '✕', '✖', '⨯'];

      const isVisible = (el) => {
        if (!el || !el.offsetParent && el.tagName !== 'BODY') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      // Consent dialogs get a decision, not just a close. Where a banner offers
      // both, take the option that shares the least: rejecting non-essential
      // cookies is the choice a user would want made on their behalf, and an
      // agent silently accepting all tracking on every site is not acceptable.
      const rejectTexts = [
        'reject all', 'reject non-essential', 'reject', 'decline all', 'decline',
        'necessary only', 'only necessary', 'essential only', 'only essential',
        'strictly necessary', 'deny', 'refuse', 'afvis alle', 'afvis',
      ];
      const acceptTexts = ['accept all', 'accept cookies', 'allow all', 'i agree', 'agree', 'accept'];

      const findCloseAffordance = (overlay, allowAmbiguous) => {
        const all = [...overlay.querySelectorAll('button, [role="button"], a[href="#"], [aria-label]')];

        // Reject before accept, and only consider accept when no refusal exists.
        const looksConsent = /cookie|consent|privacy|tracking|gdpr/i.test(
          (overlay.getAttribute('aria-label') || '') + ' ' + (overlay.textContent || '').slice(0, 400));
        if (looksConsent) {
          for (const list of [rejectTexts, acceptTexts]) {
            for (const c of all) {
              if (!isVisible(c)) continue;
              const t = (c.textContent || '').trim().toLowerCase();
              if (!t || t.length > 40) continue;
              if (list.some(x => t === x || t.startsWith(x))) {
                return { el: c, method: list === rejectTexts ? 'consent-reject' : 'consent-accept', label: t };
              }
            }
          }
        }

        const allTexts = allowAmbiguous ? [...safeTexts, ...ambiguousTexts] : safeTexts;

        // Priority 1: aria-label match (close/dismiss/luk/afvis are always safe)
        for (const c of all) {
          if (!isVisible(c)) continue;
          const label = (c.getAttribute('aria-label') || '').toLowerCase();
          if (!label) continue;
          if (label.includes('close') || label.includes('dismiss') || label.includes('luk')) {
            return { el: c, method: 'aria-label', label };
          }
          if (allowAmbiguous && label.includes('afvis')) {
            return { el: c, method: 'aria-label', label };
          }
        }

        // Priority 2: button text exact match
        for (const c of all) {
          if (!isVisible(c)) continue;
          const text = (c.textContent || '').trim().toLowerCase();
          if (!text || text.length > 30) continue;
          if (allTexts.some(t => text === t || text === t + '!' || text === t + '.')) {
            return { el: c, method: 'text-exact', label: text };
          }
        }
        // Priority 3: button text contains
        for (const c of all) {
          if (!isVisible(c)) continue;
          const text = (c.textContent || '').trim().toLowerCase();
          if (!text || text.length > 40) continue;
          if (allTexts.some(t => text.includes(t))) {
            return { el: c, method: 'text-contains', label: text };
          }
        }

        // Priority 4: × character buttons (always safe — these are universal close)
        for (const c of all) {
          if (!isVisible(c)) continue;
          const text = (c.textContent || '').trim();
          if (xChars.includes(text)) {
            return { el: c, method: 'x-char', label: text };
          }
        }

        return null;
      };

      const overlays = new Set();
      const selectors = [
        '[role="dialog"]:not([aria-hidden="true"])',
        '[role="alertdialog"]:not([aria-hidden="true"])',
        '[role="tooltip"]:not([aria-hidden="true"])',
        '[role="alert"]',
        '[class*="modal" i]:not([class*="-hidden"]):not([style*="display: none"])',
        '[class*="tooltip" i]:not([class*="-hidden"])',
        '[class*="popover" i]:not([class*="-hidden"])',
        '[class*="overlay" i]:not([class*="-hidden"])',
        '[class*="banner" i]:not([class*="-hidden"]):not(input):not(button)',
        '[data-testid*="dialog" i]',
        '[data-testid*="modal" i]',
      ];
      for (const sel of selectors) {
        try {
          for (const el of document.querySelectorAll(sel)) {
            if (isVisible(el) && el.tagName !== 'INPUT' && el.tagName !== 'BUTTON') {
              overlays.add(el);
            }
          }
        } catch {}
      }

      for (const overlay of overlays) {
        const role = overlay.getAttribute('role') || (overlay.className || '').split(' ')[0] || 'unknown';

        // Inspect for editable form fields
        const editableTextInputs = overlay.querySelectorAll(
          'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled]), [contenteditable="true"]'
        );
        const allEditableInputs = overlay.querySelectorAll(
          'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled]), [contenteditable="true"]'
        );
        const hasTextFields = editableTextInputs.length > 0;
        const hasOnlyCheckboxRadios = !hasTextFields && allEditableInputs.length > 0;

        // On plenty of portals the modal IS the workflow — it holds the form and the
        // button that submits it. Closing that is not tidying up, it is discarding
        // the step. Anything carrying a submit control is left alone unless the
        // caller explicitly asked for aggressive.
        // A submit control alone does not make a dialog a form: consent banners
        // routinely wrap "Accept all" in a form as type=submit, and refusing those
        // would break the exact case this tool exists for. What distinguishes a
        // workflow modal is a submit control AND fields to submit.
        const submitish = /^(submit|save|continue|next|apply|pay|confirm|send|finish|update|create|add|book|sign in|log in)\b/i;
        const hasSubmit = !!overlay.querySelector('button[type="submit"], input[type="submit"]') ||
          [...overlay.querySelectorAll('button, [role="button"], a.btn')].some(b => submitish.test((b.textContent || '').trim()));
        if (s !== 'aggressive' && hasSubmit && hasTextFields) {
          skipped.push({
            role,
            reason: 'left alone: has editable fields and a submit control, so this dialog is probably the form itself',
          });
          continue;
        }

        // Determine if ambiguous keywords (Skip/Cancel/Afvis) are allowed
        let allowAmbiguous;
        if (s === 'aggressive') {
          allowAmbiguous = true;
        } else if (role === 'tooltip' || role === 'alert') {
          allowAmbiguous = true;  // tooltips never hold form data
        } else if (hasTextFields) {
          allowAmbiguous = false; // protect form data — only safe keywords
        } else {
          allowAmbiguous = true;  // checkbox-only or empty dialogs — fair game
        }

        const found = findCloseAffordance(overlay, allowAmbiguous);
        if (found) {
          try {
            found.el.click();
            dismissed.push({ role, method: found.method, label: found.label, scope: allowAmbiguous ? 'ambiguous-ok' : 'safe-only' });
          } catch (e) {
            skipped.push({ role, reason: 'click-error', error: e.message });
          }
        } else {
          skipped.push({
            role,
            reason: hasTextFields && !allowAmbiguous
              ? 'no-safe-dismiss-affordance (text fields present)'
              : 'no-dismiss-affordance-found',
            hasTextFields,
            hasOnlyCheckboxRadios,
          });
        }
      }

      return { dismissed, skipped };
    }, [scope]);

    const passResult = r.result || { dismissed: [], skipped: [] };
    if (pass === 0) allSkipped.push(...passResult.skipped);
    if (passResult.dismissed.length === 0) break;
    allDismissed.push(...passResult.dismissed);
    await new Promise(r2 => setTimeout(r2, 250));
  }

  return { dismissed: allDismissed, skipped: allSkipped };
}

// ── Combobox / Autocomplete Helper ──────────────────────────────────────────

async function setCombobox(tabId, selector, values, opts = {}) {
  const valueList = Array.isArray(values) ? values : [values];
  const multi = !!opts.multi;
  const queryPrefixLen = opts.query_chars || 4;
  const waitMs = opts.wait_ms || 3000;
  const waitIterations = Math.max(1, Math.ceil(waitMs / 100));
  const results = [];

  for (const val of valueList) {
    try {
      const inputEl = await resolveElement(tabId, selector);
      if (!inputEl) {
        results.push({ value: val, ok: false, error: 'input-not-found' });
        continue;
      }
      await debuggerClick(tabId, inputEl.x, inputEl.y);
      await new Promise(r => setTimeout(r, 120));

      // Clear input only if non-empty. Backspace on empty multi-select deletes the previous chip
      // (react-select, MUI Autocomplete, Meta combobox all behave this way) — so we use native
      // value-setter to clear cleanly without ever pressing Backspace on an empty field.
      const currentValue = await readBackValue(tabId, selector);
      if (currentValue) {
        await safeExecuteScript(tabId, (sel) => {
          const el = document.querySelector(sel);
          if (!el) return;
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, ''); else el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }, [selector]);
      }

      // Type partial query via Input.insertText (bypasses per-keystroke validators)
      const query = val.slice(0, Math.min(queryPrefixLen, val.length));
      await debuggerAttach(tabId);
      await cdpSend(tabId, 'Input.insertText', { text: query });

      // Wait for listbox/options to appear
      let ready = false;
      for (let i = 0; i < waitIterations; i++) {
        await new Promise(r => setTimeout(r, 100));
        const found = await debuggerEval(tabId, `(() => {
          const lbs = document.querySelectorAll('[role="listbox"], [role="grid"][aria-label*="suggest" i], [class*="autocomplete" i] [class*="option" i], [class*="menu" i][role]:not([aria-hidden="true"])');
          for (const lb of lbs) {
            if (lb.offsetHeight === 0) continue;
            const opts = lb.querySelectorAll('[role="option"], [role="menuitem"], [data-option-index], [class*="option" i]:not([class*="optgroup" i])');
            if (opts.length > 0) return true;
          }
          return false;
        })()`);
        if (found) { ready = true; break; }
      }

      if (!ready) {
        results.push({ value: val, ok: false, error: 'no-options-rendered', query, waitMs });
        continue;
      }

      // Find and click matching option
      const click = await safeExecuteScript(tabId, (query) => {
        const lbs = [...document.querySelectorAll('[role="listbox"], [role="grid"][aria-label*="suggest" i], [class*="autocomplete" i], [class*="menu" i][role]:not([aria-hidden="true"])')]
          .filter(lb => lb.offsetHeight > 0);

        const queryLower = query.toLowerCase();
        const allOptions = [];
        for (const lb of lbs) {
          const opts = [...lb.querySelectorAll('[role="option"], [role="menuitem"], [data-option-index]')];
          if (opts.length === 0) {
            opts.push(...lb.querySelectorAll('li, [class*="option" i]:not([class*="optgroup" i])'));
          }
          const enabled = opts.filter(o =>
            o.getAttribute('aria-disabled') !== 'true' &&
            !o.classList.contains('disabled') &&
            o.offsetHeight > 0
          );
          allOptions.push(...enabled);
        }

        for (const o of allOptions) {
          const text = (o.textContent || '').trim().toLowerCase();
          if (text === queryLower) {
            o.click();
            return { ok: true, method: 'exact', text: o.textContent.trim() };
          }
        }
        for (const o of allOptions) {
          const text = (o.textContent || '').trim().toLowerCase();
          if (text.startsWith(queryLower)) {
            o.click();
            return { ok: true, method: 'startsWith', text: o.textContent.trim() };
          }
        }
        for (const o of allOptions) {
          const text = (o.textContent || '').trim().toLowerCase();
          if (text.includes(queryLower)) {
            o.click();
            return { ok: true, method: 'contains', text: o.textContent.trim() };
          }
        }

        return { ok: false, error: 'no-match-found', optionCount: allOptions.length };
      }, [val]);

      if (click.result?.ok) {
        results.push({ value: val, ok: true, method: click.result.method, selected: click.result.text });
        if (multi) {
          await new Promise(r => setTimeout(r, 250));
        }
      } else {
        results.push({ value: val, ok: false, error: click.result?.error || 'click-failed' });
      }
    } catch (e) {
      results.push({ value: val, ok: false, error: e?.message || String(e) });
    }
  }

  return { ok: results.every(r => r.ok), results };
}

// ── File Drop Helper (for drop-zones without <input type="file">) ───────────

async function dropFileOnTarget(tabId, selector, files) {
  const fileList = Array.isArray(files) ? files : [files];

  // Sweep any stale tags from previous failed runs before tagging fresh
  await debuggerEval(tabId, `(() => {
    document.querySelectorAll('[data-bmcp-drop-tag]').forEach(el => el.removeAttribute('data-bmcp-drop-tag'));
  })()`);

  // Strategy 1: search subtree (and 2 ancestor levels) for a file input — even if hidden
  const inputJson = await debuggerEval(tabId, `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) return JSON.stringify({ found: false, error: 'target-not-found' });

    const candidates = [];
    candidates.push(...target.querySelectorAll('input[type="file"]'));
    if (candidates.length === 0 && target.parentElement) {
      candidates.push(...target.parentElement.querySelectorAll('input[type="file"]'));
    }
    if (candidates.length === 0 && target.parentElement?.parentElement) {
      candidates.push(...target.parentElement.parentElement.querySelectorAll('input[type="file"]'));
    }
    if (candidates.length === 0) {
      // Last resort: any file input on the page
      candidates.push(...document.querySelectorAll('input[type="file"]'));
    }
    if (candidates.length === 0) return JSON.stringify({ found: false });

    // Tag the first viable input with a unique data-attribute so we can re-query reliably
    const tag = '__bmcp_drop_target_' + Math.random().toString(36).slice(2, 10);
    candidates[0].setAttribute('data-bmcp-drop-tag', tag);
    return JSON.stringify({ found: true, tag, accept: candidates[0].accept || '', multiple: !!candidates[0].multiple });
  })()`);

  const inputInfo = JSON.parse(inputJson);

  if (inputInfo.found) {
    const taggedSel = `[data-bmcp-drop-tag="${inputInfo.tag}"]`;
    let result;
    let caughtError;
    try {
      await debuggerAttach(tabId);
      const docResult = await cdpSend(tabId, 'DOM.getDocument', {});
      const queryResult = await cdpSend(tabId, 'DOM.querySelector', {
        nodeId: docResult.root.nodeId,
        selector: taggedSel,
      });
      if (queryResult.nodeId) {
        await cdpSend(tabId, 'DOM.setFileInputFiles', {
          nodeId: queryResult.nodeId,
          files: fileList,
        });
        result = { ok: true, method: 'hidden-input', files: fileList, accept: inputInfo.accept };
      }
    } catch (e) {
      caughtError = e?.message || String(e);
    } finally {
      // Always remove the tag attribute — success or failure
      try {
        await debuggerEval(tabId, `(() => {
          const el = document.querySelector(${JSON.stringify(taggedSel)});
          if (el) el.removeAttribute('data-bmcp-drop-tag');
        })()`);
      } catch {}
    }
    if (result) return result;
    if (caughtError) {
      return {
        ok: false,
        error: 'setFileInputFiles-failed',
        detail: caughtError,
      };
    }
  }

  return {
    ok: false,
    error: 'no-file-input-found',
    hint: 'No <input type="file"> found in target subtree, parent, or page. Pure drag-drop zones (without backing input) require synthesizing File objects from disk content via mcp-server, which is not yet implemented. Try selecting a more specific selector, or fall back to manual upload via browser_ask_user.',
  };
}

// ── Command Dispatcher ──────────────────────────────────────────────────────

// ── Flow recording and replay ──────────────────────────────────────────────
// A recorded step must survive a fresh page load, so the target is stored as a
// durable identity (id, name attribute, or role + accessible name + index) rather
// than a ref number, which is only meaningful within one page instance.

function bmcpPortableTarget(selector) {
  const deepQ = (root, s) => {
    let el = null;
    try { el = root.querySelector(s); } catch (e) { return null; }
    if (el) return el;
    for (const n of root.querySelectorAll('*')) if (n.shadowRoot) { const f = deepQ(n.shadowRoot, s); if (f) return f; }
    return null;
  };
  const walkAll = (root, out) => {
    for (const e of root.querySelectorAll('*')) { out.push(e); if (e.shadowRoot) walkAll(e.shadowRoot, out); }
    return out;
  };
  const nm = (e) => {
    const a = e.getAttribute && e.getAttribute('aria-label');
    if (a) return a.trim();
    if (e.labels && e.labels[0]) return e.labels[0].textContent.trim().replace(/\s+/g, ' ');
    if (e.placeholder) return e.placeholder.trim();
    const t = (e.textContent || '').trim().replace(/\s+/g, ' ');
    return t ? t.slice(0, 80) : (e.name || e.id || '');
  };
  let el = null;
  const rm = /^ref[_=](\d+)$/.exec(selector || '');
  if (rm) el = (window.__bmcpRefEls || {})['ref_' + rm[1]];
  else if (selector && (selector.startsWith('text=') || /^\w+:text\(/.test(selector))) {
    const tm = /^(\w+):text\((.+)\)$/.exec(selector);
    const needle = (tm ? tm[2] : selector.slice(5)).trim();
    const want = tm ? tm[1].toUpperCase() : null;
    const all = walkAll(document, []);
    const m = all.filter(e => (!want || e.tagName === want) && (e.textContent || '').trim().includes(needle));
    el = m.filter(e => !m.some(o => o !== e && e.contains && e.contains(o)))[0] || m[0] || null;
  } else if (selector) el = deepQ(document, selector);
  if (!el || !el.isConnected) return null;

  const name = nm(el);
  const peers = walkAll(document, []).filter(p => p.tagName === el.tagName && nm(p) === name);
  return {
    css: el.id ? '#' + CSS.escape(el.id)
       : (el.getAttribute('name') ? `${el.tagName.toLowerCase()}[name="${el.getAttribute('name')}"]` : null),
    tag: el.tagName,
    type: (el.type || '').toLowerCase(),
    name,
    idx: Math.max(0, peers.indexOf(el)),
    label_source: el.getAttribute('aria-label') ? 'aria-label' : (el.labels && el.labels[0] ? 'label' : 'text'),
  };
}

// Turn a stored identity back into a live element on whatever page is loaded now.
function bmcpResolvePortable(t) {
  const walkAll = (root, out) => {
    for (const e of root.querySelectorAll('*')) { out.push(e); if (e.shadowRoot) walkAll(e.shadowRoot, out); }
    return out;
  };
  const nm = (e) => {
    const a = e.getAttribute && e.getAttribute('aria-label');
    if (a) return a.trim();
    if (e.labels && e.labels[0]) return e.labels[0].textContent.trim().replace(/\s+/g, ' ');
    if (e.placeholder) return e.placeholder.trim();
    const x = (e.textContent || '').trim().replace(/\s+/g, ' ');
    return x ? x.slice(0, 80) : (e.name || e.id || '');
  };
  if (t.css) {
    try { const el = document.querySelector(t.css); if (el) return { found: true, css: t.css }; } catch (e) {}
  }
  const cands = walkAll(document, []).filter(e =>
    e.tagName === t.tag && (t.type ? (e.type || '').toLowerCase() === t.type : true) && nm(e) === t.name);
  if (!cands.length) return { found: false, tried: t };
  const el = cands[Math.min(t.idx || 0, cands.length - 1)];
  // Hand back a one-shot ref so the caller can act on exactly this element.
  if (!window.__bmcpRefEls) { window.__bmcpRefEls = {}; window.__bmcpRefSeq = 0; }
  const key = 'ref_' + (++window.__bmcpRefSeq);
  window.__bmcpRefEls[key] = el;
  return { found: true, ref: key, ambiguous: cands.length > 1 ? cands.length : undefined };
}

// ── Structured extraction ──────────────────────────────────────────────────
// Injected whole (chrome.scripting does not serialise closures). Prefers a real
// <table>; otherwise infers the repeated block that makes up a card or list layout
// and lines those items up into columns so the result is still tabular.
function bmcpExtractOp(selector, mode, budget) {
  const deepQ = (root, s) => {
    let el = null;
    try { el = root.querySelector(s); } catch (e) { return null; }
    if (el) return el;
    for (const n of root.querySelectorAll('*')) if (n.shadowRoot) { const f = deepQ(n.shadowRoot, s); if (f) return f; }
    return null;
  };
  const txt = (el) => (el ? (el.innerText || el.textContent || '') : '').replace(/\s+/g, ' ').trim();
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };
  const root = selector ? deepQ(document, selector) : document.body;
  if (!root) return { error: 'Container not found: ' + selector };

  // ── real tables ──
  if (mode !== 'list') {
    const tables = (root.tagName === 'TABLE' ? [root] : [...root.querySelectorAll('table')])
      .filter(t => vis(t) && t.rows.length > 1)
      .sort((a, b) => (b.rows.length * (b.rows[0]?.cells.length || 1)) - (a.rows.length * (a.rows[0]?.cells.length || 1)));
    if (tables.length) {
      const t = tables[0];
      let headers = [...t.querySelectorAll('thead th')].map(txt).filter(Boolean);
      let bodyRows = [...(t.tBodies[0]?.rows || t.rows)];
      if (!headers.length) {
        const first = t.rows[0];
        const allTh = first && [...first.cells].every(c => c.tagName === 'TH');
        if (allTh) { headers = [...first.cells].map(txt); bodyRows = [...t.rows].slice(1); }
      } else if (t.tHead && bodyRows.length && t.tHead.contains(bodyRows[0])) {
        bodyRows = [...t.rows].slice(t.tHead.rows.length);
      }
      const width = Math.max(headers.length, ...bodyRows.slice(0, 5).map(r => r.cells.length));
      if (!headers.length) headers = Array.from({ length: width }, (_, i) => `col${i + 1}`);
      const rows = [];
      for (const tr of bodyRows) {
        if (rows.length >= budget) break;
        if (!tr.cells.length) continue;
        const o = {};
        [...tr.cells].forEach((c, i) => {
          const key = headers[i] || `col${i + 1}`;
          const link = c.querySelector('a[href]');
          o[key] = txt(c);
          if (link && link.href) o[key + '_href'] = link.href;
        });
        rows.push(o);
      }
      return { source: 'table', columns: headers, rows };
    }
  }

  // ── repeated structures (cards, list items, result rows) ──
  const sig = (el) => {
    const cls = typeof el.className === 'string'
      ? el.className.trim().split(/\s+/).filter(c => c && !/\d{3,}|^(is|has)-|active|selected|hover/.test(c)).slice(0, 3).sort().join('.')
      : '';
    return el.tagName + (cls ? '.' + cls : '');
  };
  let best = null;
  const parents = [root, ...root.querySelectorAll('*')];
  for (const parent of parents) {
    const kids = [...parent.children].filter(vis);
    if (kids.length < 3) continue;
    const groups = new Map();
    for (const k of kids) {
      const s = sig(k);
      if (!groups.has(s)) groups.set(s, []);
      groups.get(s).push(k);
    }
    for (const [s, members] of groups) {
      if (members.length < 3) continue;
      const avgLen = members.reduce((a, m) => a + txt(m).length, 0) / members.length;
      if (avgLen < 12) continue;
      const score = members.length * Math.min(avgLen, 400);
      if (!best || score > best.score) best = { score, members, sig: s };
    }
  }
  if (!best) return { error: 'No table or repeated structure found. Pass a selector for the container, or use browser_get_page_content.' };

  // Columns = child signatures present in most items, so cards line up like rows.
  const counts = new Map();
  for (const m of best.members) {
    const seen = new Set();
    for (const c of m.querySelectorAll('*')) {
      if (!txt(c) || c.children.length > 2) continue;
      const s = sig(c);
      if (seen.has(s)) continue;
      seen.add(s);
      counts.set(s, (counts.get(s) || 0) + 1);
    }
  }
  const threshold = best.members.length * 0.6;
  const colSigs = [...counts.entries()].filter(([, n]) => n >= threshold).map(([s]) => s).slice(0, 8);
  const nameFor = (s, i) => {
    const cls = s.split('.').slice(1).join('_');
    return (cls || s.toLowerCase()).replace(/[^a-z0-9_]/gi, '_').slice(0, 24) || `field${i + 1}`;
  };
  const columns = colSigs.length ? colSigs.map(nameFor) : ['text'];
  const rows = [];
  for (const m of best.members) {
    if (rows.length >= budget) break;
    const o = {};
    if (colSigs.length) {
      colSigs.forEach((s, i) => {
        const hit = [...m.querySelectorAll('*')].find(c => sig(c) === s && txt(c));
        o[nameFor(s, i)] = hit ? txt(hit).slice(0, 300) : '';
      });
    } else {
      o.text = txt(m).slice(0, 300);
    }
    const a = m.querySelector('a[href]') || (m.tagName === 'A' ? m : null);
    if (a && a.href) o.href = a.href;
    if (Object.values(o).some(v => v)) rows.push(o);
  }
  return { source: 'repeated-structure:' + best.sig, columns: [...columns, ...(rows.some(r => r.href) ? ['href'] : [])], rows };
}

// ── Post-action observation ────────────────────────────────────────────────
// An image after every interaction is the obvious way to answer "what happened?",
// and the wrong one: it costs ~1500 tokens a call and most of the frame is
// unchanged. This captures the same answer semantically — what text appeared or
// disappeared, dialogs that opened, errors that surfaced, navigation — for a few
// dozen tokens, and only when the caller asks with observe:true.

function bmcpPageSignature() {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };
  const lines = (document.body ? document.body.innerText || '' : '')
    .split('\n').map(s => s.trim()).filter(Boolean);
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]')]
    .filter(vis).map(d => (d.getAttribute('aria-label') || d.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 90));
  const errors = [...document.querySelectorAll('[role="alert"], [aria-invalid="true"], .error, .invalid-feedback')]
    .filter(vis).map(e => (e.textContent || '').trim().replace(/\s+/g, ' ')).filter(t => t && t.length < 160);
  // Toggling a checkbox, picking a radio or typing into a field changes nothing in
  // the page text, so a text-only comparison reports "nothing happened" for actions
  // that plainly did. Control state is part of what changed.
  const fields = {};
  let idx = 0;
  for (const el of document.querySelectorAll('input, select, textarea')) {
    const key = el.name || el.id || `${el.tagName}#${idx++}`;
    const t = (el.type || '').toLowerCase();
    if (t === 'checkbox' || t === 'radio') fields[key] = el.checked ? '1' : '0';
    else if (t === 'password') fields[key] = String(el.value || '').length;
    else fields[key] = String(el.value || '').slice(0, 60);
  }
  return {
    url: location.href, title: document.title, lines,
    dialogs: [...new Set(dialogs)].filter(Boolean).slice(0, 5),
    errors: [...new Set(errors)].slice(0, 6),
    scrollY: Math.round(window.scrollY),
    fields,
  };
}

async function pageSignature(tabId) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: bmcpPageSignature });
  return r?.result || null;
}

function diffSignature(a, b, max = 8) {
  const out = {};
  if (a.url !== b.url) out.navigated_to = b.url;
  if (a.title !== b.title) out.title = b.title;
  const sa = new Set(a.lines), sb = new Set(b.lines);
  const appeared = b.lines.filter(l => !sa.has(l));
  const disappeared = a.lines.filter(l => !sb.has(l));
  if (appeared.length) {
    out.appeared = appeared.slice(0, max);
    if (appeared.length > max) out.appeared_more = appeared.length - max;
  }
  if (disappeared.length) {
    out.disappeared = disappeared.slice(0, max);
    if (disappeared.length > max) out.disappeared_more = disappeared.length - max;
  }
  const newDialogs = b.dialogs.filter(d => !a.dialogs.includes(d));
  if (newDialogs.length) out.dialogs_opened = newDialogs;
  const newErrors = b.errors.filter(e => !a.errors.includes(e));
  if (newErrors.length) out.errors_shown = newErrors;
  const fa = a.fields || {}, fb = b.fields || {};
  const changedFields = Object.keys(fb).filter(k => String(fa[k]) !== String(fb[k]));
  if (changedFields.length) out.fields_changed = changedFields.slice(0, 10);
  if (!Object.keys(out).length) out.no_visible_change = true;
  return out;
}

// Vision, but only where text has already failed. A full-page image after every
// step costs ~1.5k tokens and is mostly unchanged pixels; a crop around the element
// that just misbehaved is the one case where pixels beat a description.
async function captureAnomalyShot(tabId, selector) {
  let rect = null;
  if (selector) {
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN', args: [selector],
        func: (sel) => {
          const rm = /^ref[_=](\d+)$/.exec(sel || '');
          let el = null;
          if (rm) el = (window.__bmcpRefEls || {})['ref_' + rm[1]];
          else { try { el = document.querySelector(sel); } catch (e) {} }
          if (!el || !el.isConnected) return null;
          const b = el.getBoundingClientRect();
          return { x: b.x, y: b.y, w: b.width, h: b.height, vw: innerWidth, vh: innerHeight };
        },
      });
      rect = r?.result || null;
    } catch { /* fall through to viewport */ }
  }
  try {
    await debuggerAttach(tabId);
    const PAD = 60;
    let clip;
    if (rect && rect.w > 0 && rect.h > 0) {
      const x = Math.max(0, rect.x - PAD);
      const y = Math.max(0, rect.y - PAD);
      clip = {
        x, y,
        width: Math.min(rect.vw - x, rect.w + PAD * 2),
        height: Math.min(rect.vh - y, rect.h + PAD * 2),
        scale: 0.6,
      };
    } else {
      const [vp] = await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN', func: () => ({ vw: innerWidth, vh: innerHeight }),
      }).catch(() => [null]);
      const v = vp?.result || { vw: 1280, vh: 800 };
      clip = { x: 0, y: 0, width: v.vw, height: Math.min(v.vh, 900), scale: 0.4 };
    }
    const shot = await cdpSend(tabId, 'Page.captureScreenshot', {
      format: 'jpeg', quality: 55, clip, captureBeyondViewport: false,
    });
    if (!shot?.data) return null;
    return {
      data: 'data:image/jpeg;base64,' + shot.data,
      region: { x: Math.round(clip.x), y: Math.round(clip.y), width: Math.round(clip.width), height: Math.round(clip.height) },
      scale: clip.scale,
      cropped_to_element: !!(rect && rect.w > 0),
    };
  } catch {
    return null;
  }
}

function isAnomalous(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.ok === false) return 'action reported failure';
  if (result.verified === false) return 'no event reached the page';
  if (result.outcome === 'no_change') return 'submit produced no change';
  if (result.found === false) return 'element or text not found';
  if (result.changed && result.changed.no_visible_change) return 'nothing on the page changed';
  return null;
}

const OBSERVABLE = new Set([
  'click', 'fill', 'press_key', 'select_option', 'drag', 'triple_click',
  'double_click', 'click_xy', 'submit', 'set_date', 'set_combobox', 'hover', 'scroll',
]);

// Steps worth reproducing. Reads are excluded: replay repeats what changes the
// page, and re-running perception adds time without affecting the outcome.
const RECORDABLE = new Set([
  'navigate', 'click', 'fill', 'press_key', 'select_option', 'submit', 'drag',
  'set_date', 'set_combobox', 'double_click', 'triple_click', 'upload_file',
  'drop_file', 'wait', 'wait_idle', 'dismiss_overlays', 'scroll',
]);
const recording = new Map(); // port → { name, steps: [] }

async function recordStep(port, method, params, result) {
  const rec = recording.get(port);
  if (!rec || !RECORDABLE.has(method)) return;
  const step = { method, params: { ...params } };
  delete step.params.observe;
  if (params?.selector) {
    try {
      const tab = await getSessionTab(port);
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN', func: bmcpPortableTarget, args: [params.selector],
      });
      if (r?.result) step.target = r.result;
    } catch { /* selector may already be gone; the raw selector is kept as fallback */ }
  }
  if (result && typeof result === 'object') {
    step.expect = {};
    if (result.outcome) step.expect.outcome = result.outcome;
    if (result.value_after !== undefined) step.expect.filled = true;
    if (result.verified !== undefined) step.expect.verified = result.verified;
    if (result.url_after) step.expect.url = result.url_after;
    if (!Object.keys(step.expect).length) delete step.expect;
  }
  rec.steps.push(step);
}

async function dispatch(port, method, params) {
  const rec = recording.get(port);
  if (rec && RECORDABLE.has(method)) {
    const result = await dispatchInner(port, method, params);
    await recordStep(port, method, params, result).catch(() => {});
    return result;
  }
  return dispatchInner(port, method, params);
}

async function dispatchInner(port, method, params) {
  const wantsShot = params && (params.screenshot === 'anomaly' || params.screenshot === 'always');
  if (wantsShot && OBSERVABLE.has(method)) {
    const result = await dispatchObserved(port, method, params);
    const why = params.screenshot === 'always' ? 'requested' : isAnomalous(result);
    if (why && result && typeof result === 'object') {
      try {
        const tab = await getSessionTab(port);
        const shot = await captureAnomalyShot(tab.id, params.selector);
        if (shot) result.screenshot = { ...shot, reason: why };
      } catch { /* an image is a nice-to-have; never fail the action for it */ }
    }
    return result;
  }
  return dispatchObserved(port, method, params);
}

async function dispatchObserved(port, method, params) {
  if (!params || !params.observe || !OBSERVABLE.has(method)) {
    return dispatchCore(port, method, params);
  }
  let before = null, tabId = null;
  try {
    const t = await getSessionTab(port, true);
    tabId = t.id;
    before = await pageSignature(tabId);
  } catch { /* observation is best-effort and must never block the action */ }

  const result = await dispatchCore(port, method, params);

  if (before && tabId && result && typeof result === 'object' && !Array.isArray(result)) {
    await new Promise(r => setTimeout(r, Math.min(3000, params.observe_delay || 400)));
    const after = await pageSignature(tabId).catch(() => null);
    if (after) result.changed = diffSignature(before, after);
    else result.changed = { navigated_or_unreadable: true };
  }
  return result;
}

async function dispatchCore(port, method, params) {
  // Real input only reaches ACTIVE tabs (see INPUT_METHODS above). Activating here,
  // once, means every input tool gets trusted events instead of silently degrading.
  if (INPUT_METHODS.has(method)) {
    try { await getSessionTab(port, true); } catch {}
  }
  switch (method) {
    case 'navigate': {
      const session = getSession(port);
      let tab = await getSessionTab(port);

      // History navigation parity: url:"back" / "forward"
      const nav = String(params.url || '').toLowerCase();
      if (nav === 'back' || nav === 'forward') {
        try {
          if (nav === 'back') await chrome.tabs.goBack(tab.id);
          else await chrome.tabs.goForward(tab.id);
        } catch (e) {
          return { ok: false, error: `Cannot go ${nav}: ${e.message} (no entry in this tab's history)` };
        }
        await new Promise(r => setTimeout(r, 600));
        const t = await chrome.tabs.get(tab.id);
        return { ok: true, went: nav, title: t.title, url: t.url, tab_id: t.id };
      }

      // Always reuse the active tab — navigate in place, don't create new tabs
      // Only create new tab if explicitly requested via new_tab param
      if (params.new_tab) {
        tab = await chrome.tabs.create({ url: params.url, active: false });
        await addTabToSession(port, tab.id);
      } else {
        await chrome.tabs.update(tab.id, { url: params.url });
      }

      // Wait for load
      await new Promise(resolve => {
        const listener = (tabId, info) => {
          if (tabId === tab.id && info.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 15000);
      });

      // Set as active tab for this session
      session.activeTabId = tab.id;
      persistSessions();
      const updated = await chrome.tabs.get(tab.id);

      // Check for CAPTCHA after navigation
      const captcha = await detectCaptcha(tab.id);
      const result = { title: updated.title, url: updated.url, tab_id: tab.id, session: session.label };
      if (captcha && captcha.found) {
        result.captcha_detected = captcha.types.join(', ');
        result.hint = `CAPTCHA detected: ${captcha.types.join(', ')}. Use browser_solve_captcha to handle it.`;
      }
      return result;
    }

    case 'get_page_content': {
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot access chrome:// pages');
      const format = params.format || 'text';
      const maxChars = Math.max(1000, params.max_chars || 60000);
      // A tab showing Chrome's network-error page cannot be injected into. That is
      // a page STATE, not a tool failure, so report it as data instead of throwing.
      let res;
      try {
      [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        args: [format],
        func: (fmt) => {
          if (fmt === 'html') return document.documentElement.outerHTML;
          if (fmt !== 'article') return document.body.innerText;
          // Article mode: main content only — nav, headers, footers, sidebars,
          // cookie banners and script noise stripped. Ideal for reading pages.
          const pickRoot = () => {
            const cands = [
              document.querySelector('article'),
              document.querySelector('main'),
              document.querySelector('[role="main"]'),
              document.getElementById('content'),
              document.querySelector('.post-content, .article-body, .entry-content'),
            ].filter(Boolean);
            let best = null, bestLen = 0;
            for (const c of cands) {
              const len = (c.innerText || '').length;
              if (len > bestLen) { best = c; bestLen = len; }
            }
            // Require the candidate to hold a meaningful share of page text
            return (best && bestLen > 400) ? best : document.body;
          };
          const picked = pickRoot();
          // Readability-style extraction assumes a document. On a dashboard there is
          // no article to find, so it returns navigation and widget labels dressed up
          // as content. Compare what was kept against the whole page and against how
          // interactive the page is, and say when the result should not be trusted.
          const fullLen = (document.body.innerText || '').length;
          const controls = document.querySelectorAll('button, input, select, a[href]').length;
          const usedBody = picked === document.body;
          const root = picked.cloneNode(true);
          const STRIP = 'nav, header, footer, aside, script, style, noscript, iframe, form, ' +
            '[role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], ' +
            '[role="dialog"], [aria-hidden="true"], [class*="cookie" i], [class*="sidebar" i], ' +
            '[class*="related" i], [class*="share" i], [class*="comment" i], [id*="cookie" i]';
          root.querySelectorAll(STRIP).forEach(el => el.remove());
          // cloneNode loses layout, so innerText degrades to textContent — normalize whitespace
          const text = (root.innerText || root.textContent || '')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          const density = fullLen ? controls / (fullLen / 1000) : 0; // controls per 1k chars
          const low = usedBody || density > 12 || text.length < 250;
          return {
            text,
            confidence: low ? 'low' : 'high',
            ...(low ? {
              reason: usedBody
                ? 'no article container found, so this is the whole body with boilerplate stripped'
                : density > 12
                ? 'the page is control-dense and reads like an application rather than a document'
                : 'very little text survived extraction',
            } : {}),
          };
        },
      });
      } catch (e) {
        const msg = String(e?.message || e);
        if (/showing error page|Frame with ID|cannot be scripted|No frame with id/i.test(msg)) {
          const t = await chrome.tabs.get(tab.id).catch(() => null);
          return {
            content: '', url: t?.url || tab.url, title: t?.title || '', length: 0, format,
            error_page: true,
            note: 'The tab is displaying a browser error page (DNS failure, connection refused or similar), so it has no document to read. Check the URL or connectivity, then navigate again.',
          };
        }
        throw e;
      }
      // article mode returns a shape; text and html return a plain string.
      const raw = res?.result;
      let articleMeta = null;
      let content = '';
      if (raw && typeof raw === 'object' && typeof raw.text === 'string') {
        content = raw.text;
        articleMeta = { confidence: raw.confidence, ...(raw.reason ? { confidence_reason: raw.reason } : {}) };
      } else {
        content = raw ?? '';
      }
      const fullLength = content.length;
      if (content.length > maxChars) {
        content = content.slice(0, maxChars) +
          `\n\n[TRUNCATED: showing ${maxChars} of ${fullLength} chars — pass max_chars for more, or format:"article" to strip boilerplate]`;
      }
      return { content, url: tab.url, title: tab.title, length: fullLength, format, ...(articleMeta || {}) };
    }

    case 'screenshot': {
      // getSessionTab(…, true) is focus-NEUTRAL now: it un-minimizes + activates the tab
      // but does NOT steal window focus (FIX-1). Screenshots run constantly, so the common
      // path must never yank Chrome to the foreground.
      const tab = await getSessionTab(port, true);
      if (tab.url.startsWith('chrome://') || tab.url.startsWith('about:')) {
        throw new Error(`Cannot screenshot ${tab.url.split(':')[0]}: pages — navigate to a real page first`);
      }
      // Capture without stealing focus: CDP Page.captureScreenshot (default → fromSurface:false
      // retry) works for background/visible tabs; captureVisibleTab is the secondary.
      const tryCapture = async () => {
        try {
          await debuggerAttach(tab.id);
          try {
            const shot = await cdpSend(tab.id, 'Page.captureScreenshot', { format: 'png' });
            return { image: 'data:image/png;base64,' + shot.data };
          } catch {
            const shot = await cdpSend(tab.id, 'Page.captureScreenshot', {
              format: 'png', fromSurface: false, captureBeyondViewport: false,
            });
            return { image: 'data:image/png;base64,' + shot.data };
          }
        } catch {
          // CDP failed entirely — native tabs API (needs the tab visible in its window).
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
          return { image: dataUrl };
        }
      };

      // Attempt 1 — focus-neutral. Handles the vast majority (background-but-visible window).
      try {
        return await tryCapture();
      } catch (firstErr) {
        // Both methods failed → the window is genuinely OCCLUDED (covered by other windows),
        // so Chrome's compositor produced no frames. LAST RESORT ONLY: raise the window to
        // de-occlude it, capture, then RESTORE the user's previously-focused window. This
        // focus-steal happens ONLY in the rare covered case — never on a normal screenshot.
        const prev = await chrome.windows.getLastFocused().catch(() => null);
        try {
          await chrome.windows.update(tab.windowId, { focused: true, state: 'normal' });
          await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
          await new Promise(r => setTimeout(r, 250)); // let it composite
          return await tryCapture();
        } catch (secondErr) {
          throw new Error(
            `Screenshot failed after focus-neutral AND raised attempts. ` +
            `First: ${firstErr?.message || firstErr}. Raised: ${secondErr?.message || secondErr}. ` +
            `If both say "image readback failed" the GPU compositor is not producing frames — ` +
            `disable Chrome hardware acceleration (chrome://settings/system) as a last resort.`
          );
        } finally {
          // Give focus back to the user's previous Chrome window (best-effort; getLastFocused
          // only sees Chrome windows, so a non-Chrome IDE can't be re-focused programmatically).
          if (prev && prev.id != null && prev.id !== tab.windowId) {
            await chrome.windows.update(prev.id, { focused: true }).catch(() => {});
          }
        }
      }
    }

    case 'execute_script': {
      // v1.22.2 (DIAGNOSTIC): Try scripting paths but log all errors so we can see WHY they fail
      // v1.26: accept `script` as alias for `code` — the historic param-name mismatch caused
      // silent "unserializable"/undefined failures that read as "execute_script is broken".
      if (params.code == null && typeof params.script === 'string') params.code = params.script;
      if (typeof params.code !== 'string' || !params.code.trim()) {
        return { ok: false, error: 'Missing code. Pass a JavaScript EXPRESSION in `code` (e.g. an IIFE: (() => {...; return x;})()). `return ...` at top level is invalid — the handler wraps code in parentheses.' };
      }
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot execute scripts on chrome:// pages');

      const diag = { tried: [] };

      // v2.0 REPL semantics: accept full multi-statement code with top-level await.
      // Each scripting world tries (a) expression eval, (b) async-function-body wrap —
      // so `const r = await fetch(...); r.status` and top-level `return x` both work.
      const replFunc = (codeStr) => {
        const asErr = (e) => ({ __scriptingError: true, message: String(e?.message || e), name: e?.name });
        // Under `require-trusted-types-for 'script'` (Gmail, Workspace, banks) the
        // Function constructor rejects plain strings. Wrap only at the point of
        // construction: the policy returns a TrustedScript object, and applying it
        // to codeStr itself broke every string operation performed on the source.
        const trust = (src) => {
          try {
            if (window.trustedTypes && window.trustedTypes.createPolicy) {
              if (!window.__bmcpTT) {
                window.__bmcpTT = window.trustedTypes.createPolicy('bmcp-exec', {
                  createHTML: (s) => s, createScript: (s) => s, createScriptURL: (s) => s,
                });
              }
              if (window.__bmcpTT && window.__bmcpTT.createScript) return window.__bmcpTT.createScript(src);
            }
          } catch (e) { /* policy blocked; the debugger path still works */ }
          return src;
        };
        const mkFn = (src) => new Function(trust(src));
        const tryEval = (build) => {
          const fn = build();
          const v = fn();
          return (v && typeof v.then === 'function')
            ? v.then(x => ({ __ok: true, value: x }), asErr)  // async rejection → structured error, never unhandled
            : { __ok: true, value: v };
        };
        // REPL "completion value": for statement code, return the LAST expression.
        // "const a=6; const b=7; a*b" → rewrite tail to "return (a*b)". Only applied
        // when the tail doesn't start with a statement keyword; syntax errors fall
        // through to the plain-body variant.
        const withLastExprReturn = () => {
          const parts = codeStr.split(/;(?![^(]*\))/);
          while (parts.length && !parts[parts.length - 1].trim()) parts.pop();
          if (!parts.length) return null;
          const tail = parts.pop().trim();
          if (/^(const|let|var|if|for|while|do|return|function|class|throw|try|switch|break|continue|\})/.test(tail)) return null;
          return parts.join(';') + ';\nreturn (' + tail + '\n);';
        };
        try {
          return tryEval(() => mkFn('return (' + codeStr + '\n)'));
        } catch (e1) {
          if (e1?.name !== 'SyntaxError') return asErr(e1);
          try {
            // Await-containing single EXPRESSION ("await fetch(...)"): wrap so the
            // awaited value is RETURNED, not discarded as a statement.
            return tryEval(() => mkFn('return (async () => { return (' + codeStr + '\n); })()'));
          } catch (e1b) {
            if (e1b?.name !== 'SyntaxError') return asErr(e1b);
            const rewritten = withLastExprReturn();
            if (rewritten != null) {
              try {
                return tryEval(() => mkFn('return (async () => {\n' + rewritten + '\n})()'));
              } catch { /* fall through to plain body */ }
            }
            try {
              // Statement code / top-level return: async-body wrap
              return tryEval(() => mkFn('return (async () => {\n' + codeStr + '\n})()'));
            } catch (e2) {
              return asErr(e2);
            }
          }
        }
      };

      for (const world of ['ISOLATED', 'MAIN']) {
        try {
          const [result] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world,
            args: [params.code],
            func: replFunc,
          });
          const r = result?.result;
          diag.tried.push({ world, result_keys: r ? Object.keys(r) : null, r_type: typeof r });
          if (r && typeof r === 'object' && r.__ok) {
            return { result: r.value, method: 'scripting-' + world.toLowerCase() };
          }
          if (r && typeof r === 'object' && r.__scriptingError) {
            diag[world.toLowerCase() + '_error'] = r.message;
            // ISOLATED-world errors are often just page globals being invisible there —
            // always continue to MAIN. A MAIN-world runtime (non-CSP) error is REAL:
            // surface it instead of re-running side-effectful code in the debugger path.
            if (world === 'MAIN' &&
                !/unsafe-eval|Content Security Policy|Function constructor|EvalError/i.test(r.message) &&
                r.name !== 'EvalError' && r.name !== 'SyntaxError') {
              throw new Error(r.message + ' | scripting-diag: ' + JSON.stringify(diag));
            }
          }
        } catch (e) {
          const m = String(e?.message || e);
          if (m.includes('scripting-diag')) throw e;
          diag[world.toLowerCase() + '_throw'] = m;
        }
      }

      // Step 3: debugger fallback — the ONLY universal path for arbitrary STRING code
      // (both scripting worlds block `new Function`: ISOLATED via MV3 extension-CSP,
      // MAIN via the page's own unsafe-eval CSP). CDP Runtime.evaluate bypasses CSP.
      // FIX (2026-07-16): retry on an EMPTY/undefined CDP response. On some pages the
      // debugger auto-detaches mid-command and `chrome.debugger.sendCommand` RESOLVES
      // with `undefined` instead of rejecting, so cdpSend's throw-based retry never
      // fires and debuggerEval silently returned undefined → the caller saw a bare
      // `{method:"debugger"}` with no result. Also surface script exceptions + raw
      // diagnostics so a genuine failure is never mistaken for an empty success.
      let rawDbg, dbgErr = '';
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await debuggerAttach(tab.id);
          // replMode gives DevTools-console semantics: multi-statement code,
          // top-level await, and the last expression as the completion value.
          rawDbg = await cdpSend(tab.id, 'Runtime.evaluate', {
            expression: params.code,
            returnByValue: true,
            awaitPromise: true,
            replMode: true,
          });
          if (rawDbg && rawDbg.exceptionDetails) {
            const ex = rawDbg.exceptionDetails;
            await debuggerDetach(tab.id).catch(() => {});
            throw new Error('__SCRIPT_EX__' + (ex.exception?.description || ex.text || 'Script exception'));
          }
          if (rawDbg && rawDbg.result) {
            // replMode: `undefined` is a legitimate completion value (assignments,
            // void calls). Only a fully EMPTY CDP response means detach-mid-command.
            await debuggerDetach(tab.id).catch(() => {});
            return {
              result: rawDbg.result.type === 'undefined' ? null : rawDbg.result.value,
              method: 'debugger-repl',
              ...(rawDbg.result.type === 'undefined' ? { note: 'code completed; last statement had no value' } : {}),
            };
          }
          dbgErr = 'empty/undefined CDP response: ' + JSON.stringify(rawDbg);
        } catch (e) {
          const m = String(e?.message || e);
          if (m.startsWith('__SCRIPT_EX__')) {
            throw new Error(m.slice('__SCRIPT_EX__'.length) + ' | scripting-diag: ' + JSON.stringify(diag));
          }
          dbgErr = m;
          if (!/detach|attach|empty|gone|given id|not attached/i.test(m)) break;
        }
        await debuggerDetach(tab.id).catch(() => {});
        await new Promise(r => setTimeout(r, 200 + attempt * 200));
      }
      throw new Error(
        'execute_script failed on all paths. debugger: ' + dbgErr +
        ' | raw: ' + JSON.stringify(rawDbg) +
        ' | scripting-diag: ' + JSON.stringify(diag)
      );
    }

    case 'click': {
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot interact with chrome:// pages');

      // Wrap full click flow (incl. resolveElement) so debugger failures in EITHER
      // resolveElement (text-selectors use debuggerEval) OR debuggerClick trigger
      // the scripting-fallback. v1.21.2: previously only debuggerClick was wrapped,
      // leaving text-selector clicks unrecoverable when debugger was user-blocked.
      try {
        const el = await resolveElement(tab.id, params.selector);
        if (!el) return { ok: false, error: 'Element not found: ' + params.selector };

        // Primary path: debugger mouse events (isTrusted=true, works on React/Angular SPAs)
        const verdict = await debuggerClick(tab.id, el.x, el.y);
        if (!verdict.landed) {
          // Neither trusted nor synthetic dispatch reached a handler — say so
          // plainly instead of returning a success the caller would act on.
          const r = await scriptingClick(tab.id, params.selector);
          if (r.ok) return { ok: true, method: 'scripting-fallback', click_path: 'synthetic-fallback', verified: true, tag: r.tag };
          return { ok: false, verified: false, click_path: verdict.path, error: 'Click dispatched but NO event reached the page. The element may be covered by an overlay, inside a cross-origin iframe, or disabled. Try browser_dismiss_overlays, a different selector, or browser_click_xy with coordinates from a screenshot.' };
        }
        return { ok: true, method: el.method || 'debugger', tag: el.tag, text: el.text, click_path: verdict.path, verified: verdict.landed };
      } catch (e) {
        // Fallback: synthetic click via chrome.scripting for anti-automation sites
        // (Apple ASC etc.) OR user-blocked-debugger scenarios.
        //
        // MÅLT 29/7: betingelsen var kun /Debugger detached/, men den HYPPIGSTE fejl hedder
        // "Debugger attach failed after 3 attempts" (kastes l.298) — altså når Chrome nægter
        // at koble debuggeren på overhovedet. De to strenge ligner hinanden og betyder næsten
        // det samme, men regexet ramte kun den ene, så fallbacken fyrede aldrig i det tilfælde
        // den var skrevet til: "user-blocked-debugger scenarios" står ordret i kommentaren
        // ovenfor, og det var netop dét den ikke dækkede.
        //
        // Konsekvens i praksis: klikker brugeren Cancel på Chromes debugger-banner ÉN gang,
        // husker Chrome det på tværs af extension-reloads, og hvert eneste klik fejler
        // permanent — selvom scriptingClick ville have virket hele tiden. Den bruger `func:`
        // og ikke en kode-streng, så den rammes ikke af sidens CSP.
        //
        // Prisen ved fallbacken er at klikket mister isTrusted=true. Det tjekker de færreste
        // sider, og et klik der virker på 95% af nettet slår et klik der aldrig virker.
        // ANY debugger-channel failure now falls back — the old regex listed
        // specific phrasings and missed real ones ("Cannot access a
        // chrome-extension:// URL of different extension" from an orphaned
        // session), so the fallback never fired in exactly the cases it was
        // written for. Before re-clicking we ask the page whether the trusted
        // click already landed, so a mid-flight failure can't double-fire.
        let alreadyLanded = false;
        try {
          const [chk] = await chrome.scripting.executeScript({
            target: { tabId: tab.id }, world: 'MAIN',
            func: () => {
              const v = window.__bmcpClicked === true;
              try { delete window.__bmcpClicked; } catch {}
              return v;
            },
          });
          alreadyLanded = chk?.result === true;
        } catch {}
        if (alreadyLanded) {
          return { ok: true, method: 'debugger', click_path: 'trusted', verified: true, note: 'debugger errored after the click landed' };
        }
        const r = await scriptingClick(tab.id, params.selector);
        if (r.ok) {
          return { ok: true, method: 'scripting-fallback', click_path: 'synthetic-fallback', verified: true, tag: r.tag, note: 'debugger channel unavailable: ' + (e?.message || e) };
        }
        throw e;
      }
    }

    case 'fill': {
      const tab = await getSessionTab(port, true);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot interact with chrome:// pages');
      if (typeof params.value !== 'string') return { ok: false, error: 'value (string) required' };
      return await fillElementDeep(tab.id, params.selector, params.value);
    }

    case 'fill_legacy': {
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot interact with chrome:// pages');
      const parsed = parseSelector(params.selector);

      // Value feedback (v2.0): report previous + resulting value so the caller can
      // detect wrong-element fills and React-controlled reverts without a re-read.
      // Password fields are redacted to a length only.
      const readField = async () => {
        try {
          const [r] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            args: [parsed.type === 'ref' ? parsed.ref : (parsed.type === 'css' ? parsed.selector : null)],
            func: (sel) => {
              let el = null;
              if (sel && sel.startsWith('ref_')) el = window.__bmcpRefEls && window.__bmcpRefEls[sel];
              else if (sel) el = document.querySelector(sel);
              if (!el) return null;
              const isPw = (el.type || '').toLowerCase() === 'password';
              const v = ('value' in el) ? el.value : (el.textContent || '');
              return { value: isPw ? null : String(v).slice(0, 200), redacted: isPw, len: String(v).length };
            },
          });
          return r?.result || null;
        } catch { return null; }
      };
      const before = await readField();
      const describe = (f) => f == null ? undefined : (f.redacted ? `[redacted ${f.len} chars]` : f.value);

      // For text/ref selectors, click the element first then type
      if (parsed.type === 'text' || parsed.type === 'ref') {
        const el = await resolveElement(tab.id, params.selector);
        if (!el) return { ok: false, error: 'Element not found: ' + params.selector };
        const target = parsed.type === 'ref' ? parsed.ref : null;
        let method = 'debugger';
        try {
          await debuggerClick(tab.id, el.x, el.y);
          await new Promise(r => setTimeout(r, 80));
          // Element-scoped focus+clear (never touches neighbouring fields), then a
          // trusted insert so React/Angular validators see real input events.
          await focusAndClearElement(tab.id, target);
          await debuggerAttach(tab.id);
          try {
            await cdpSend(tab.id, 'Input.insertText', { text: params.value });
          } finally {
            await debuggerDetach(tab.id);
          }
        } catch { /* fall through to read-back check */ }
        let after = await readField();
        // CDP input events can be silently swallowed (e.g. another automation
        // extension holds the input channel). Never trust — verify by LENGTH
        // (value is hidden for password fields, but len is always reported),
        // then fall back to the native value-setter, which nothing can block.
        if (parsed.type === 'ref' && (!after || !after.len)) {
          const [fb] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            args: [parsed.ref, params.value],
            func: (refKey, val) => {
              const el = window.__bmcpRefEls && window.__bmcpRefEls[refKey];
              if (!el || !el.isConnected) return { ok: false, error: 'ref-stale' };
              el.focus();
              const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (setter && 'value' in el) setter.call(el, val); else if ('value' in el) el.value = val;
              else if (el.isContentEditable) el.textContent = val;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return { ok: true };
            },
          });
          if (fb?.result?.ok) { method = 'native-setter-fallback'; after = await readField(); }
        }
        return { ok: true, method, value_before: describe(before), value_after: describe(after) };
      }

      // Always use debugger for input/textarea — React/Angular/Vue need real keyboard events
      try {
        await debuggerFill(tab.id, parsed.selector, params.value);
        const after = await readField();
        return { ok: true, method: 'debugger', value_before: describe(before), value_after: describe(after) };
      } catch (e) {
        // Fallback to executeScript if debugger fails
        const scriptResult = await safeExecuteScript(tab.id, (sel, val) => {
          const el = document.querySelector(sel);
          if (!el) return { ok: false, error: 'Element not found: ' + sel };
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          el.focus();
          // Use nativeInputValueSetter to bypass React controlled input
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, val); else el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true };
        }, [parsed.selector, params.value]);
        if (!scriptResult.cspBlocked) return scriptResult.result;
        return { ok: false, error: e.message, method: 'debugger' };
      }
    }

    case 'set_date': {
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot interact with chrome:// pages');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(params.date)) {
        return { ok: false, error: 'date must be ISO format YYYY-MM-DD, got: ' + params.date };
      }

      const info = await getDateInputInfo(tab.id, params.selector);
      if (!info.found) return { ok: false, error: 'Element not found: ' + params.selector };

      const tried = [];
      const iso = params.date;

      // Path A: native <input type="date"> or <input type="datetime-local">
      if (info.tag === 'INPUT' && (info.inputType === 'date' || info.inputType === 'datetime-local')) {
        await setDateNative(tab.id, params.selector, iso);
        await new Promise(r => setTimeout(r, 200));
        const v = await readBackValue(tab.id, params.selector);
        tried.push({ path: 'native', value: v });
        if (v && v.startsWith(iso)) return { ok: true, method: 'native', value: v };
      }

      // Path B: masked text input — parse format and type via Input.insertText
      if (info.tag === 'INPUT' && !info.readOnly && !info.disabled) {
        const fmt = parsePlaceholderFormat(info.placeholder) || parsePlaceholderFormat(info.ariaLabel);
        if (fmt) {
          try {
            await setDateMaskedTyping(tab.id, params.selector, iso, fmt);
            await new Promise(r => setTimeout(r, 250));
            const v = await readBackValue(tab.id, params.selector);
            tried.push({ path: 'masked', format: fmt.order.join(fmt.sep), value: v });
            if (valueLooksLikeIso(v, iso)) return { ok: true, method: 'masked', value: v, format: fmt.order.join(fmt.sep) };
          } catch (e) {
            tried.push({ path: 'masked', error: e.message });
          }
        } else {
          tried.push({
            path: 'masked',
            skipped: true,
            reason: 'no-parseable-format',
            placeholder: info.placeholder,
            ariaLabel: info.ariaLabel,
          });
        }
      } else {
        tried.push({
          path: 'masked',
          skipped: true,
          reason: info.tag !== 'INPUT' ? 'not-input-element' : (info.readOnly ? 'readonly' : 'disabled'),
        });
      }

      // Path C: calendar-picker navigation
      if (!params.skip_picker) {
        const r = await setDatePicker(tab.id, params.selector, iso);
        await new Promise(r2 => setTimeout(r2, 200));
        const v = await readBackValue(tab.id, params.selector);
        tried.push({ path: 'picker', ...r, value: v });
        if (r.ok && valueLooksLikeIso(v, iso)) return { ok: true, method: 'picker', value: v, navAttempts: r.navAttempts };
      }

      const visibleErrors = await collectVisibleErrors(tab.id, params.selector);
      const finalValue = await readBackValue(tab.id, params.selector);
      return {
        ok: false,
        error: 'all-paths-failed',
        tried,
        current_value: finalValue,
        visible_errors: visibleErrors,
        input_info: info,
      };
    }

    case 'dismiss_overlays': {
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot interact with chrome:// pages');
      const scope = params.scope || 'non_critical';
      const maxPasses = params.max_passes ?? 3;
      const r = await dismissOverlays(tab.id, scope, maxPasses);
      return { ok: true, dismissed: r.dismissed, skipped: r.skipped, count: r.dismissed.length };
    }

    case 'set_combobox': {
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot interact with chrome:// pages');
      if (!params.selector) return { ok: false, error: 'selector required' };
      if (!params.values && !params.value) return { ok: false, error: 'value or values required' };
      const values = params.values || [params.value];
      const r = await setCombobox(tab.id, params.selector, values, {
        multi: !!params.multi,
        query_chars: params.query_chars,
      });
      const visibleErrors = r.ok ? [] : await collectVisibleErrors(tab.id, params.selector);
      return r.ok ? r : { ...r, visible_errors: visibleErrors };
    }

    case 'drop_file': {
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot interact with chrome:// pages');
      const files = Array.isArray(params.files) ? params.files : [params.files || params.file];
      if (!files[0]) return { ok: false, error: 'files or file required' };
      return await dropFileOnTarget(tab.id, params.selector || 'body', files);
    }

    case 'wait': {
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot interact with chrome:// pages');
      const timeout = params.timeout || 10000;
      const sel = params.selector;
      const requireVisible = params.visible !== false; // default: wait for VISIBLE
      const start = Date.now();
      // Visibility matters: pages routinely pre-render the success element hidden
      // (the-internet's dynamic_loading holds "Hello World!" in a display:none div
      // from first paint). Matching on mere presence returned instantly and the
      // caller then read the page mid-transition. Default is now visible-only.
      let sawHidden = false;
      while (Date.now() - start < timeout) {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          args: [sel, requireVisible],
          func: (sel, requireVisible) => {
            const isVisible = (el) => {
              if (!el || !el.isConnected) return false;
              const r = el.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) return false;
              const st = getComputedStyle(el);
              return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) !== 0;
            };
            let els = [];
            const tagText = sel.match(/^(\w+):text\((.+)\)$/);
            const isText = sel.startsWith('text=') || tagText;
            if (isText) {
              const needle = (tagText ? tagText[2] : sel.slice(5)).trim();
              const scope = tagText ? tagText[1] : '*';
              els = [...document.querySelectorAll(scope)]
                .filter(e => (e.textContent || '').trim().includes(needle))
                .filter(e => ![...e.children].some(c => (c.textContent || '').trim().includes(needle)));
            } else {
              try { els = [...document.querySelectorAll(sel)]; } catch { return { error: 'bad-selector' }; }
            }
            if (!els.length) return { present: false, visible: false };
            return { present: true, visible: els.some(isVisible) };
          },
        }).catch(() => [null]);
        const r = res?.result;
        if (r?.error === 'bad-selector') return { found: false, error: 'Invalid selector: ' + sel };
        if (r?.present) {
          if (!requireVisible || r.visible) return { found: true, visible: !!r.visible, waited_ms: Date.now() - start };
          sawHidden = true;
        }
        await new Promise(r2 => setTimeout(r2, 300));
      }
      return {
        found: false,
        waited_ms: Date.now() - start,
        ...(sawHidden ? { note: 'Element EXISTS but stayed hidden for the whole timeout. Pass visible:false to match presence only.' } : {}),
      };
    }

    case 'press_key': {
      // v1.22: activate tab so key-event lands in foreground (otherwise Chrome routes to active tab)
      const tab = await getSessionTab(port, true);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot interact with chrome:// pages');
      const key = params.key; // e.g. "Enter", "Tab", "Escape", "ArrowDown"
      const modifiers = (params.ctrl ? 2 : 0) | (params.alt ? 1 : 0) | (params.shift ? 8 : 0) | (params.meta ? 4 : 0);

      // v1.22: Chrome requires windowsVirtualKeyCode for navigation/system keys to trigger
      // scroll/form-submit behavior. Without these, key-event is dispatched but page doesn't react.
      const VK_CODES = {
        'Backspace': 8, 'Tab': 9, 'Enter': 13, 'Shift': 16, 'Control': 17, 'Alt': 18,
        'Escape': 27, 'Space': 32, ' ': 32,
        'PageUp': 33, 'PageDown': 34, 'End': 35, 'Home': 36,
        'ArrowLeft': 37, 'ArrowUp': 38, 'ArrowRight': 39, 'ArrowDown': 40,
        'Delete': 46,
      };
      const vkCode = VK_CODES[key];
      const vkParams = vkCode ? { windowsVirtualKeyCode: vkCode, nativeVirtualKeyCode: vkCode } : {};

      await debuggerAttach(tab.id);
      try {
        await cdpSend(tab.id, 'Input.dispatchKeyEvent', {
          type: 'keyDown',
          key,
          code: params.code || key,
          modifiers,
          text: key.length === 1 ? key : '',
          ...vkParams,
        });
        await cdpSend(tab.id, 'Input.dispatchKeyEvent', {
          type: 'keyUp',
          key,
          code: params.code || key,
          modifiers,
          ...vkParams,
        });
      } finally {
        await debuggerDetach(tab.id);
      }
      return { ok: true, key };
    }

    case 'scroll': {
      // v1.22: NO activate — CDP Input.dispatchMouseEvent goes via debugger directly to target,
      // doesn't need active tab. Re-activating on every scroll-call destabilizes debugger.
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot interact with chrome:// pages');
      // Scroll to element
      if (params.selector) {
        const el = await resolveElement(tab.id, params.selector);
        if (!el) return { ok: false, error: 'Element not found: ' + params.selector };
        return { ok: true, scrolled_to: params.selector };
      }
      // Scroll by pixels using CDP mouseWheel — split into smaller steps so IntersectionObservers fire.
      // FB/Twitter/IG only trigger lazy-load on continuous wheel events, not a single large delta.
      const dx = params.x || 0;
      const dy = params.y || 0;
      // Scripting fallback first-class: scrolling must not hard-fail just because
      // the debugger is unavailable — window.scrollBy works on almost every page.
      const scrollViaScripting = async () => {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN', args: [dx, dy],
          func: (x, y) => {
            const before = window.scrollY;
            window.scrollBy({ left: x, top: y, behavior: 'instant' });
            return { scrolled: window.scrollY - before, at: window.scrollY, max: document.documentElement.scrollHeight };
          },
        });
        return r?.result;
      };
      try {
        await debuggerAttach(tab.id);
        const STEP_SIZE = 300; // pixels per wheel-event (matches a typical mouse-wheel notch)
        const totalSteps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / STEP_SIZE));
        const stepX = dx / totalSteps;
        const stepY = dy / totalSteps;
        for (let i = 0; i < totalSteps; i++) {
          await cdpSend(tab.id, 'Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: 400, y: 300, deltaX: stepX, deltaY: stepY,
          });
          // Small delay between wheel-events so IntersectionObserver + lazy-load XHRs can fire
          if (i < totalSteps - 1) await new Promise(r => setTimeout(r, 80));
        }
        // After last wheel-event, give FB/Twitter/IG ~600ms to start lazy-load XHRs
        // before any subsequent commands run (caller often scrapes immediately after)
        await new Promise(r => setTimeout(r, 600));
      } catch (e) {
        const r = await scrollViaScripting().catch(() => null);
        if (r) return { ok: true, scrolled: { x: dx, y: dy }, position: r.at, method: 'scripting-fallback', fallback_reason: e.message };
        return { ok: false, error: 'Scroll failed on both the debugger and scripting paths: ' + (e?.message || e) };
      }
      return { ok: true, scrolled: { x: dx, y: dy }, method: 'mouseWheel-stepped' };
    }

    // ── v1.26 "superior" tools ──────────────────────────────────────────────
    // Secret-hygiene contract: copy/stats NEVER return clipboard/element content
    // to the MCP server — only lengths and shape booleans. Born from the 2026-07-27
    // Azure-secret night: the agent must be able to move a credential from page to
    // field without the value ever entering the LLM context or transcript.

    case 'copy_to_clipboard': {
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot interact with chrome:// pages');
      const parsed = parseSelector(params.selector);
      if (parsed.type === 'text') {
        return { ok: false, error: 'copy_to_clipboard requires a CSS selector (text= selectors not supported for value extraction)' };
      }
      const attr = params.attribute || null;
      const evalRes = await cdpSend(tab.id, 'Runtime.evaluate', {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(parsed.selector)});
          if (!el) return null;
          ${attr ? `return el.getAttribute(${JSON.stringify(attr)});`
                 : `return ('value' in el && el.value) ? el.value : (el.textContent || '').trim();`}
        })()`,
        returnByValue: true,
      });
      const value = evalRes?.result?.value;
      if (value == null) return { ok: false, error: 'Element not found or empty: ' + params.selector };
      const clip = await chrome.runtime.sendMessage({ type: 'bmcp_clipboard', op: 'write', text: String(value) });
      if (!clip?.ok) return { ok: false, error: 'clipboard write failed: ' + (clip?.error || 'unknown') };
      // NEVER return the value itself.
      return { ok: true, copied_chars: String(value).length, source: attr ? `attribute:${attr}` : 'value/text' };
    }

    case 'paste_from_clipboard': {
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot interact with chrome:// pages');
      const clip = await chrome.runtime.sendMessage({ type: 'bmcp_clipboard', op: 'read' });
      if (!clip?.ok) return { ok: false, error: 'clipboard read failed: ' + (clip?.error || 'unknown') };
      const text = params.trim === false ? clip.text : (clip.text || '').trim();
      if (!text) return { ok: false, error: 'clipboard is empty' };
      const parsed = parseSelector(params.selector);
      if (parsed.type === 'text') {
        const el = await resolveElement(tab.id, params.selector);
        if (!el) return { ok: false, error: 'Element not found: ' + params.selector };
        await debuggerClick(tab.id, el.x, el.y);
        await new Promise(r => setTimeout(r, 100));
        await debuggerType(tab.id, text);
      } else {
        await debuggerFill(tab.id, parsed.selector, text);
      }
      // NEVER return the pasted content.
      return { ok: true, pasted_chars: text.length };
    }

    case 'clipboard_stats': {
      const clip = await chrome.runtime.sendMessage({ type: 'bmcp_clipboard', op: 'read' });
      if (!clip?.ok) return { ok: false, error: 'clipboard read failed: ' + (clip?.error || 'unknown') };
      const t = clip.text || '';
      const trimmed = t.trim();
      return {
        ok: true,
        length: t.length,
        trimmed_length: trimmed.length,
        has_whitespace: /\s/.test(trimmed),
        looks_like_uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed),
        looks_like_url: /^https?:\/\//i.test(trimmed),
        // NEVER the content itself.
      };
    }

    case 'double_click': {
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot interact with chrome:// pages');
      const el = await resolveElement(tab.id, params.selector);
      if (!el) return { ok: false, error: 'Element not found: ' + params.selector };
      await debuggerAttach(tab.id);
      const { x, y } = el;
      await cdpSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await new Promise(r => setTimeout(r, 30));
      // Proper dblclick: two press/release pairs with escalating clickCount.
      await cdpSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await cdpSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      await new Promise(r => setTimeout(r, 40));
      await cdpSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 2 });
      await cdpSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 2 });
      return { ok: true, double_clicked: true, tag: el.tag, text: el.text };
    }

    case 'right_click': {
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot interact with chrome:// pages');
      const el = await resolveElement(tab.id, params.selector);
      if (!el) return { ok: false, error: 'Element not found: ' + params.selector };
      await debuggerAttach(tab.id);
      const { x, y } = el;
      await cdpSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await new Promise(r => setTimeout(r, 30));
      await cdpSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
      await cdpSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
      return { ok: true, right_clicked: true, tag: el.tag, text: el.text, note: 'contextmenu event fired; native Chrome menu does not open via CDP — page-level menus (OWA, web apps) do' };
    }

    case 'click_xy': {
      // Raw coordinate click — the escape hatch for custom widgets whose buttons
      // resist every selector strategy (Azure portal dialogs, KO-bound divs).
      // Coordinates come from the caller's own screenshot analysis.
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot interact with chrome:// pages');
      if (typeof params.x !== 'number' || typeof params.y !== 'number') {
        return { ok: false, error: 'x and y (numbers, CSS pixels in viewport) are required' };
      }
      const verdict = await debuggerClick(tab.id, params.x, params.y);
      return { ok: verdict.landed, clicked_at: { x: params.x, y: params.y }, click_path: verdict.path, verified: verdict.landed };
    }

    case 'submit': {
      // Click a submit control and REPORT WHAT ACTUALLY HAPPENED.
      // From a real transcript: click "Sign In" returned {ok:true} three times
      // across 11 minutes while the login never happened — the caller had no way
      // to tell "submitted", "rejected with errors", and "nothing happened" apart,
      // so it burned 20s waits and eventually asked the user to click it himself.
      const tab = await getSessionTab(port, true);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot interact with chrome:// pages');
      const timeout = Math.min(60000, params.timeout || 15000);

      const snap = async () => {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN',
          args: [params.expect_text || null, params.expect_gone || null],
          func: (expectText, expectGone) => {
            const vis = (el) => {
              const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false;
              const st = getComputedStyle(el);
              return st.visibility !== 'hidden' && st.display !== 'none';
            };
            const body = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
            const errs = [...document.querySelectorAll('[role="alert"], [aria-invalid="true"], .error, .invalid-feedback, .help-block, [class*="error" i]:not(input):not(select):not(textarea):not(form)')]
              .filter(vis).map(e => (e.textContent || '').trim().replace(/\s+/g, ' ')).filter(t => t && t.length < 200);
            const low = body.toLowerCase();
            return {
              url: location.href, title: document.title, len: body.length, sig: body.slice(0, 300),
              errors: [...new Set(errs)].slice(0, 8),
              hasExpect: expectText ? low.includes(String(expectText).toLowerCase()) : null,
              hasGone: expectGone ? low.includes(String(expectGone).toLowerCase()) : null,
              busy: !!document.querySelector('[aria-busy="true"], .spinner, [class*="spinner" i], [class*="loading" i]'),
            };
          },
        });
        return r?.result;
      };

      const before = await snap();
      if (!before) return { ok: false, error: 'Could not read page state (still loading?)' };

      // Locate the submit control if the caller did not name one.
      let selector = params.selector;
      if (!selector) {
        const [f] = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN',
          func: () => {
            if (!window.__bmcpRefEls) { window.__bmcpRefEls = {}; window.__bmcpRefSeq = 0; }
            const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
            const WORDS = /^(sign in|signin|log in|login|submit|continue|next|save|apply|send|confirm|pay|register|create account|finish|done|proceed)/i;
            const cands = [...document.querySelectorAll('button[type="submit"], input[type="submit"], button, [role="button"]')].filter(vis).filter(el => !el.disabled);
            const scored = cands.map(el => {
              const t = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim();
              let s = 0;
              if ((el.type || '') === 'submit') s += 40;
              if (WORDS.test(t)) s += 50;
              if (el.closest('form')) s += 15;
              return { el, t, s };
            }).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
            if (!scored.length) return null;
            const el = scored[0].el;
            const key = el.__bmcpRef && window.__bmcpRefEls[el.__bmcpRef] === el
              ? el.__bmcpRef : 'ref_' + (++window.__bmcpRefSeq);
            try { Object.defineProperty(el, '__bmcpRef', { value: key, configurable: true }); } catch {}
            window.__bmcpRefEls[key] = el;
            return { ref: key, text: scored[0].t.slice(0, 40) };
          },
        });
        if (!f?.result) return { ok: false, error: 'No submit control found — pass selector explicitly.' };
        selector = f.result.ref;
      }

      const clickRes = await dispatchCore(port, 'click', { selector });
      if (clickRes && clickRes.ok === false) {
        return { ok: false, outcome: 'click_failed', click: clickRes, error: clickRes.error };
      }

      // Poll for a REAL outcome instead of a blind fixed wait.
      const started = Date.now();
      let last = before;
      while (Date.now() - started < timeout) {
        await new Promise(r => setTimeout(r, 350));
        let now;
        try { now = await snap(); } catch { now = null; }
        if (!now) { // injection failed => almost certainly a navigation in flight
          await new Promise(r => setTimeout(r, 500));
          const t2 = await chrome.tabs.get(tab.id).catch(() => null);
          if (t2 && t2.url !== before.url) {
            return { ok: true, outcome: 'navigated', url_before: before.url, url_after: t2.url, waited_ms: Date.now() - started, click: clickRes };
          }
          continue;
        }
        last = now;
        if (now.url !== before.url) {
          return { ok: true, outcome: 'navigated', url_before: before.url, url_after: now.url, title: now.title, waited_ms: Date.now() - started, click: clickRes };
        }
        const newErrors = now.errors.filter(e => !before.errors.includes(e));
        if (newErrors.length) {
          return { ok: false, outcome: 'validation_error', errors: newErrors, url: now.url, waited_ms: Date.now() - started, click: clickRes,
            hint: 'The form was submitted and REJECTED. Fix these fields (browser_form_state shows which are invalid) and submit again.' };
        }
        if (params.expect_text && now.hasExpect && !before.hasExpect) {
          return { ok: true, outcome: 'expected_text', matched: params.expect_text, url: now.url, waited_ms: Date.now() - started, click: clickRes };
        }
        if (params.expect_gone && before.hasGone && !now.hasGone) {
          return { ok: true, outcome: 'expected_gone', url: now.url, waited_ms: Date.now() - started, click: clickRes };
        }
        if (!now.busy && now.sig !== before.sig && Math.abs(now.len - before.len) > Math.max(80, before.len * 0.12)) {
          return { ok: true, outcome: 'page_changed', url: now.url, waited_ms: Date.now() - started, click: clickRes,
            note: 'Content changed substantially but no navigation and no expected text — verify it is the state you wanted.' };
        }
      }
      return {
        ok: false, outcome: 'no_change', url: last.url, waited_ms: Date.now() - started, click: clickRes,
        page_errors: last.errors,
        hint: clickRes?.verified === false
          ? 'The click never reached the page (verified:false). The control may be covered by an overlay or in an iframe — try browser_dismiss_overlays, browser_list_frames, or browser_click_xy from a screenshot.'
          : 'The click landed but the page did not react within the timeout: the control may need a different trigger (press Enter in the field), the form may be blocked by hidden/invalid fields (check browser_form_state), or the request is slow (check browser_network_log).',
      };
    }

    case 'save': {
      // Two ways a page holds something worth keeping: it IS the artefact (a
      // submitted application, a confirmation receipt), or it links to one behind
      // the session's cookies (an export endpoint, an in-tab PDF). Printing and
      // credentialed fetching cover both, and the bytes come back for the caller
      // to write somewhere it can actually read them.
      const mode = params.mode || (params.url ? 'url' : 'pdf');
      const tab = await getSessionTab(port, true);

      if (mode === 'url') {
        if (!params.url) return { ok: false, error: 'url required for mode:"url"' };
        try {
          // Runs in the extension background, so the request carries the user's
          // cookies and is not subject to the page's CORS rules.
          const res = await fetch(params.url, { credentials: 'include' });
          const buf = await res.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          }
          return {
            ok: res.ok, status: res.status,
            content_type: res.headers.get('content-type') || null,
            bytes: bytes.length,
            data: btoa(bin),
            source_url: params.url,
          };
        } catch (e) {
          return { ok: false, error: `Fetch failed: ${e?.message || e}` };
        }
      }

      if (tab.url.startsWith('chrome://')) throw new Error('Cannot print chrome:// pages');

      // A tab showing a PDF is Chrome's viewer, not a document. Printing it
      // re-renders or comes back blank, so fetch the file the viewer loaded.
      const looksPdf = /\.pdf($|[?#])/i.test(tab.url) || await (async () => {
        try {
          const [r] = await chrome.scripting.executeScript({
            target: { tabId: tab.id }, world: 'MAIN',
            func: () => !!document.querySelector('embed[type="application/pdf"], object[type="application/pdf"]') ||
              document.contentType === 'application/pdf',
          });
          return r?.result === true;
        } catch { return false; }
      })();
      if (looksPdf && params.mode !== 'print') {
        try {
          const res = await fetch(tab.url, { credentials: 'include' });
          const bytes = new Uint8Array(await res.arrayBuffer());
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          return {
            ok: res.ok, status: res.status, content_type: res.headers.get('content-type') || 'application/pdf',
            bytes: bytes.length, data: btoa(bin), source_url: tab.url,
            note: 'This tab is displaying a PDF, so the original file was downloaded rather than the viewer being printed. Pass mode:"print" to print the viewer instead.',
          };
        } catch (e) {
          return { ok: false, error: `The tab holds a PDF but it could not be downloaded: ${e?.message || e}` };
        }
      }

      try {
        await debuggerAttach(tab.id);
        await cdpSend(tab.id, 'Page.enable', {});
        const r = await cdpSend(tab.id, 'Page.printToPDF', {
          printBackground: params.background !== false,
          landscape: !!params.landscape,
          scale: Math.min(2, Math.max(0.1, params.scale || 1)),
          preferCSSPageSize: true,
          ...(params.paper === 'a4' ? { paperWidth: 8.27, paperHeight: 11.69 } : {}),
        });
        if (!r?.data) return { ok: false, error: 'Chrome returned no PDF data for this page.' };
        return { ok: true, data: r.data, content_type: 'application/pdf', bytes: Math.round(r.data.length * 0.75), source_url: tab.url, title: tab.title };
      } catch (e) {
        return {
          ok: false,
          error: `Print failed: ${e?.message || e}`,
          hint: 'If the tab is displaying a PDF rather than a web page, pass its URL with mode:"url" to download the original file instead.',
        };
      }
    }

    case 'record': {
      const action = params.action || 'start';
      const store = await chrome.storage.local.get({ bmcpFlows: {} });
      const flows = store.bmcpFlows;

      if (action === 'list') {
        return {
          flows: Object.entries(flows).map(([name, f]) => ({
            name, steps: f.steps.length, start_url: f.start_url, saved: f.saved,
            fields: f.steps.filter(s => s.method === 'fill').map(s => s.target?.name || s.params?.selector),
          })),
          recording: recording.has(port) ? recording.get(port).name : null,
        };
      }
      if (action === 'show') {
        const f = flows[params.name];
        if (!f) return { ok: false, error: `No flow named ${params.name}` };
        return { name: params.name, ...f };
      }
      if (action === 'delete') {
        if (!flows[params.name]) return { ok: false, error: `No flow named ${params.name}` };
        delete flows[params.name];
        await chrome.storage.local.set({ bmcpFlows: flows });
        return { ok: true, deleted: params.name };
      }
      if (action === 'start') {
        if (!params.name) return { ok: false, error: 'name required' };
        const tab = await getSessionTab(port).catch(() => null);
        const extend = params.mode === 'extend';
        if (extend && !flows[params.name]) return { ok: false, error: `No flow named ${params.name} to extend.` };
        recording.set(port, {
          name: params.name, steps: [], start_url: tab?.url || null,
          extend, previous: extend ? flows[params.name].steps : null,
        });
        return {
          ok: true, recording: params.name,
          mode: extend ? 'extend' : 'new',
          note: extend
            ? 'Recording another pass. On stop, steps that appear in both passes stay required and steps that appear in only one become conditional, so the flow can cover a variation without treating it as a break.'
            : 'Actions that change the page are being recorded. Call again with action:"stop" to save.',
        };
      }
      if (action === 'stop') {
        const rec = recording.get(port);
        if (!rec) return { ok: false, error: 'Not recording' };
        recording.delete(port);
        if (!rec.steps.length) return { ok: false, error: 'Nothing was recorded — no page-changing actions ran.' };

        let steps = rec.steps;
        let merged = null;
        if (rec.extend && rec.previous) {
          // Align the two passes. A step seen both times is part of every run; a
          // step seen in only one is a branch that depends on the data, so it is
          // marked conditional and skipped at replay when its target is absent.
          const key = (s) => `${s.method}|${s.target?.name || s.params?.selector || ''}|${s.target?.tag || ''}`;
          const oldS = rec.previous, newS = rec.steps;
          const out = [];
          let i = 0, j = 0;
          while (i < oldS.length || j < newS.length) {
            if (i < oldS.length && j < newS.length && key(oldS[i]) === key(newS[j])) {
              out.push({ ...oldS[i], optional: oldS[i].optional === true ? undefined : oldS[i].optional });
              delete out[out.length - 1].optional;
              i++; j++;
              continue;
            }
            // A field the page marks required is part of every run by definition.
            // Demoting one to conditional produces the worst outcome available: a
            // replay that completes successfully with the form half empty.
            const mark = (st) => ({ ...st, optional: st.target?.required ? undefined : true });
            const oldAhead = j < newS.length ? oldS.slice(i).findIndex(s => key(s) === key(newS[j])) : -1;
            if (oldAhead > 0) { out.push(mark(oldS[i])); i++; continue; }
            if (j < newS.length) { out.push(mark(newS[j])); j++; continue; }
            if (i < oldS.length) { out.push(mark(oldS[i])); i++; continue; }
          }
          steps = out;
          const cond = steps.filter(s => s.optional).length;
          const ratio = steps.length ? cond / steps.length : 0;
          merged = {
            required: steps.length - cond,
            conditional: cond,
            alignment: ratio > 0.5 ? 'low' : ratio > 0.25 ? 'partial' : 'high',
            ...(ratio > 0.5 ? {
              warning: 'More than half the steps came out conditional, which usually means the two passes were different flows rather than variations of one — a portal that renames or reorders fields per record type does this. Replay would skip most steps and still report success. Re-record instead of extending.',
            } : {}),
          };
        }

        flows[rec.name] = {
          steps,
          start_url: flows[rec.name]?.start_url || rec.start_url,
          saved: new Date().toISOString(),
          passes: (flows[rec.name]?.passes || 0) + 1,
        };
        await chrome.storage.local.set({ bmcpFlows: flows });
        return {
          ok: true, saved: rec.name, steps: steps.length,
          ...(merged || {}),
          fields: steps.filter(s => s.method === 'fill').map(s => s.target?.name || s.params?.selector).filter(Boolean),
          note: merged
            ? 'Conditional steps run only when their target is present, so one flow covers both variations.'
            : 'Replay with browser_replay. Record another pass with mode:"extend" to teach the flow a variation.',
        };
      }
      return { ok: false, error: `Unknown action: ${action}` };
    }

    case 'replay': {
      const store = await chrome.storage.local.get({ bmcpFlows: {} });
      const flow = store.bmcpFlows[params.name];
      if (!flow) return { ok: false, error: `No flow named ${params.name}. List them with browser_record({action:"list"}).` };

      // Many rows in one call, with a persisted ledger so the run can be answered
      // for afterwards ("did row 130 go through?") and resumed after a crash.
      if (Array.isArray(params.rows) || params.resume) {
        const runsStore = await chrome.storage.local.get({ bmcpRuns: {} });
        const runs = runsStore.bmcpRuns;
        let runId, ledger;

        if (params.resume) {
          ledger = runs[params.resume];
          if (!ledger) return { ok: false, error: `No run named ${params.resume}. List them with browser_runs.` };
          runId = params.resume;
        } else {
          runId = 'run_' + Date.now().toString(36);
          ledger = {
            flow: params.name,
            started: new Date().toISOString(),
            rows: params.rows.slice(0, 500).map((row, i) => ({ index: i, row, status: 'pending' })),
          };
        }

        const persist = async () => {
          const s2 = await chrome.storage.local.get({ bmcpRuns: {} });
          s2.bmcpRuns[runId] = { ...ledger, updated: new Date().toISOString() };
          // Keep the ledger bounded; oldest runs fall off.
          const keys = Object.keys(s2.bmcpRuns);
          if (keys.length > 20) {
            keys.sort((a, b) => (s2.bmcpRuns[a].started || '').localeCompare(s2.bmcpRuns[b].started || ''));
            for (const k of keys.slice(0, keys.length - 20)) delete s2.bmcpRuns[k];
          }
          await chrome.storage.local.set({ bmcpRuns: s2.bmcpRuns });
        };

        // Not every divergence means the same thing, and treating them alike either
        // abandons a run over one bad record or ploughs 150 half-submissions into a
        // portal whose shape has changed.
        const classify = (d) => {
          if (!d) return null;
          if (d.reason === 'target-not-found') return 'structural';
          const a = d.actual || {};
          const blob = JSON.stringify(a);
          if (a.outcome === 'validation_error' || (a.errors && a.errors.length)) return 'row-level';
          if (a.outcome === 'no_change' || /timed out|timeout|no matching request/i.test(blob)) return 'transient';
          return 'structural';
        };

        const postsSeen = () => (networkLogs.get((getSession(port).activeTabId) || -1) || [])
          .filter(e => (e.method === 'POST' || e.method === 'PUT' || e.method === 'PATCH') &&
            // 3xx to a sign-in page, 401 and 403 all mean the write was refused.
            !(e.status >= 300 && e.status < 400) && e.status !== 401 && e.status !== 403)
          .length;

        await persist();
        let stopped = null;
        for (const entry of ledger.rows) {
          if (entry.status === 'done' || entry.status === 'skipped') continue;
          if (entry.status === 'in_progress' && !params.retry_committed) {
            // The worker stopped while this row was running — Chrome evicts an idle
            // service worker, and a long run is exactly that workload. Whether it
            // completed is unknown, so it is not silently repeated.
            entry.status = 'needs_review';
            entry.note = 'the run stopped while this row was in flight, so its outcome is unknown. Check the site, then mark it done or re-run with retry_committed:true.';
            await persist();
            continue;
          }
          // A row that failed after something was posted may already exist on the
          // other side. Re-running it blind is how a resume creates duplicates, so
          // it is held for review unless the caller says to retry it anyway.
          if (entry.possibly_committed && !params.retry_committed) {
            entry.status = 'needs_review';
            entry.note = 'held back: a request was sent before this row failed, so it may already have been recorded. Confirm on the site, then mark it done or re-run with retry_committed:true.';
            await persist();
            continue;
          }
          entry.status = 'in_progress';
          entry.started_at = new Date().toISOString();
          await persist();
          const postsBefore = postsSeen();
          let r = await dispatchCore(port, 'replay', { ...params, rows: undefined, resume: undefined, row: entry.row, verbose: false });
          let kind = r.ok ? null : classify(r.diverged_at);

          // A slow spinner or a blip is worth one more attempt; a rejected record
          // and a changed page are not.
          if (kind === 'transient') {
            entry.retried = true;
            r = await dispatchCore(port, 'replay', { ...params, rows: undefined, resume: undefined, row: entry.row, verbose: false });
            kind = r.ok ? null : classify(r.diverged_at);
            if (kind === 'transient') kind = 'row-level';
          }

          entry.at = new Date().toISOString();
          if (r.ok) {
            entry.status = 'done';
            // Scrape whatever the page calls the receipt, so the run can be audited
            // later without reopening the portal.
            try {
              const tab = await getSessionTab(port);
              const [c] = await chrome.scripting.executeScript({
                target: { tabId: tab.id }, world: 'MAIN',
                func: () => {
                  const t = (document.body?.innerText || '').replace(/\s+/g, ' ');
                  const m = t.match(/(confirmation|reference|application|receipt|order)\s*(?:id|number|no\.?|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,20})/i);
                  return m ? m[0].slice(0, 60) : null;
                },
              });
              if (c?.result) entry.confirmation = c.result;
            } catch {}
          } else {
            entry.status = kind === 'structural' ? 'failed' : 'skipped';
            entry.kind = kind;
            entry.diverged_at = r.diverged_at;
            entry.url = r.url;
            // Whether anything was committed decides rerun versus duplicate.
            const steps = r.steps_total || 0;
            entry.progress = `${r.steps_run || 0}/${steps}`;
            // Only uncertainty counts. A row the page rejected did send a request,
            // but the server answered no — flagging that as possibly committed would
            // hold back rows that plainly need re-running, and cry wolf on the flag
            // that exists to prevent duplicates.
            entry.possibly_committed = kind !== 'row-level' && postsSeen() > postsBefore;
          }
          await persist();

          if (kind === 'structural') {
            stopped = entry;
            break;
          }
        }

        const counts = ledger.rows.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
        const failures = ledger.rows.filter(r => r.status === 'skipped' || r.status === 'failed')
          .map(({ row, index, kind, diverged_at, progress, possibly_committed, url }) =>
            ({ row_index: index, row, kind, progress, possibly_committed, url, diverged_at }));

        return {
          ok: !stopped && !failures.length,
          run_id: runId,
          flow: params.name,
          rows_total: ledger.rows.length,
          ...counts,
          failures: failures.length ? failures : undefined,
          ...(stopped ? {
            paused_at_row: stopped.index,
            reason: 'structural divergence — the page no longer matches the recording, so the remaining rows would fail the same way',
            remaining: counts.pending || 0,
            hint: `The queue is kept. Inspect the page, fix the row or re-record the flow, then continue with browser_replay({name:"${params.name}", resume:"${runId}"}). The browser has been left on the failing page.`,
          } : {}),
          ...(failures.length && !stopped ? {
            hint: 'Rows listed in failures were skipped; each carries its data, how far it got, and whether anything may already have been submitted.',
          } : {}),
        };
      }

      const row = params.row || null;
      const results = [];
      let diverged = null;

      if (params.start_url !== false && flow.start_url) {
        await dispatchCore(port, 'navigate', { url: flow.start_url }).catch(() => {});
        // Recorded URLs carry session tokens — retURL, jsessionid, sap-client — that
        // go stale, landing on a sign-in or expired-session page that reads as an
        // ordinary page. The flow itself is the ground truth for whether this is the
        // right page: only when its first target is missing is it worth asking why.
        // Guessing from page text alone flags every legitimate login flow as stale.
        try {
          const firstStep = flow.steps.find(s => s.target && !s.optional);
          let onExpectedPage = true;
          if (firstStep) {
            const t0 = await getSessionTab(port);
            const [probe] = await chrome.scripting.executeScript({
              target: { tabId: t0.id }, world: 'MAIN', func: bmcpResolvePortable, args: [firstStep.target],
            }).catch(() => [null]);
            onExpectedPage = probe?.result?.found === true;
          }
          const t = await getSessionTab(port);
          const [chk] = onExpectedPage ? [null] : await chrome.scripting.executeScript({
            target: { tabId: t.id }, world: 'MAIN',
            func: () => {
              const text = (document.body?.innerText || '').slice(0, 3000).toLowerCase();
              const pw = !!document.querySelector('input[type="password"]');
              const signals = ['session has expired', 'session expired', 'please log in', 'please sign in',
                'sign in to continue', 'your session', 'log in to continue', 'authentication required'];
              const hit = signals.find(s => text.includes(s));
              return { pw, hit: hit || null, url: location.href, title: document.title };
            },
          }).catch(() => [null]);
          const c = chk?.result;
          if (c && (c.hit || c.pw)) {
            return {
              ok: false, flow: params.name, steps_run: 0, steps_total: flow.steps.length,
              diverged_at: { step: -1, reason: 'start-url-stale', landed_on: c.url, signal: c.hit || 'a password field on a login-looking URL' },
              hint: 'The recorded starting URL led to a sign-in or expired-session page rather than the flow. Its session token has gone stale. Sign in, then replay with start_url:false from the right page, or re-record the flow.',
            };
          }
        } catch { /* the check is advisory */ }
      }

      const SUBMITISH = /^(submit|save|continue|next|apply|pay|confirm|send|finish|create|book|place order|sign in|log in)\b/i;
      // What this run put into the page, so it can be checked against what the
      // page is showing before anything is committed.
      const expectations = {};
      const dryRun = params.dry_run === true;

      // Holding back steps whose label reads like a commit is a guess, and it is
      // wrong in both directions: a "Next" that saves server-side commits anyway,
      // while a "Submit" that only opens a confirmation modal commits nothing. So
      // during a dry run the guarantee is enforced at the network layer — anything
      // that is not a safe method is blocked outright and reported.
      const blocked = [];
      let dryGuard = null;
      if (dryRun) {
        const tabForGuard = await getSessionTab(port);
        dryGuard = { tabId: tabForGuard.id, handler: null };
        try {
          await debuggerAttach(dryGuard.tabId);
          dryGuard.handler = (source, method, evt) => {
            if (source.tabId !== dryGuard.tabId || method !== 'Fetch.requestPaused') return;
            const m = (evt.request?.method || 'GET').toUpperCase();
            const safe = m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
            if (safe) {
              chrome.debugger.sendCommand({ tabId: dryGuard.tabId }, 'Fetch.continueRequest', { requestId: evt.requestId }).catch(() => {});
            } else {
              blocked.push({ method: m, url: (evt.request?.url || '').slice(0, 200) });
              chrome.debugger.sendCommand({ tabId: dryGuard.tabId }, 'Fetch.failRequest', { requestId: evt.requestId, errorReason: 'Aborted' }).catch(() => {});
            }
          };
          chrome.debugger.onEvent.addListener(dryGuard.handler);
          await cdpSend(dryGuard.tabId, 'Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
        } catch (e) {
          if (dryGuard.handler) chrome.debugger.onEvent.removeListener(dryGuard.handler);
          dryGuard = null;
          return {
            ok: false, flow: params.name,
            error: `Could not arm the dry run: ${e?.message || e}. Without request blocking a dry run cannot promise it will not commit, so it was not started.`,
          };
        }
      }
      const disarm = async () => {
        if (!dryGuard) return;
        try { await cdpSend(dryGuard.tabId, 'Fetch.disable', {}); } catch {}
        if (dryGuard.handler) chrome.debugger.onEvent.removeListener(dryGuard.handler);
        dryGuard = null;
      };

      for (let i = 0; i < flow.steps.length; i++) {
        const step = flow.steps[i];
        const p = { ...step.params };

        // A dry run drives the form but commits nothing, so a batch can be checked
        // against real validation before anything is submitted for the first time.
        // Recorded clicks that look like a submit are held back too, since a click
        // is what commits on forms that were not recorded via browser_submit.
        if (dryRun && step.method === 'submit') {
          // Run the real submit path, including its own control detection — a dry
          // run that takes a different code path is not testing the thing that will
          // run for real. The network guard is what prevents the commit, so the
          // outcome it reports is expected to be a failure to progress.
          const out = await dispatchCore(port, 'submit', { ...p, timeout: Math.min(p.timeout || 6000, 6000) })
            .catch(e => ({ ok: false, error: e?.message }));
          results.push({
            step: i, method: 'submit', ok: true,
            dry: 'submitted with state-changing requests blocked',
            attempted: out?.outcome || (out?.error ? 'error: ' + out.error : 'unknown'),
          });
          continue;
        }

        // Re-point the step at whatever now matches its recorded identity.
        if (step.target) {
          const tab = await getSessionTab(port);
          const [r] = await chrome.scripting.executeScript({
            target: { tabId: tab.id }, world: 'MAIN', func: bmcpResolvePortable, args: [step.target],
          }).catch(() => [null]);
          let res = r?.result;
          if (!res?.found && step.optional) {
            // Frameworks render sections after the page has otherwise settled, so a
            // single look decides "branch not taken" for a step that was about to
            // exist. Re-check briefly before skipping.
            for (let attempt = 0; attempt < 6 && !res?.found; attempt++) {
              await new Promise(r2 => setTimeout(r2, 150));
              const [again] = await chrome.scripting.executeScript({
                target: { tabId: (await getSessionTab(port)).id }, world: 'MAIN',
                func: bmcpResolvePortable, args: [step.target],
              }).catch(() => [null]);
              res = again?.result;
            }
          }
          if (!res?.found) {
            if (step.optional) {
              results.push({ step: i, method: step.method, ok: true, skipped: 'condition not present' });
              continue;
            }
            diverged = { step: i, method: step.method, reason: 'target-not-found', looked_for: step.target };
            break;
          }
          p.selector = res.ref || res.css;
          if (res.ambiguous) p._ambiguous = res.ambiguous;
        }

        // Per-run values: a row key matching the field's name wins over the recorded one.
        if (step.method === 'fill' && row && step.target?.name) {
          const key = Object.keys(row).find(k => k.toLowerCase() === String(step.target.name).toLowerCase());
          if (key) { p.value = String(row[key]); expectations[step.target.name] = p.value; }
        }

        // A structurally perfect run can still submit the previous row's values if a
        // control never re-rendered. Check the page against the row before committing.
        if (step.method === 'submit' && params.verify !== false && Object.keys(expectations).length) {
          let v = null, verifyError = null;
          try { v = await dispatchCore(port, 'verify_data', { expect: expectations }); }
          catch (e) { verifyError = e?.message || String(e); }
          // A check that quietly does nothing when it fails is worse than no check,
          // because the run then reports success it never established.
          if (verifyError || (v && v.ok !== true && !v.mismatched)) {
            diverged = {
              step: i, method: step.method, reason: 'verification-unavailable',
              detail: verifyError || v?.error,
              note: 'Stopped before committing: the page could not be checked against this row, so there is no basis for saying the data is right.',
            };
            break;
          }
          if (v && v.ok === false && v.mismatched?.length) {
            diverged = {
              step: i, method: step.method, reason: 'data-mismatch',
              mismatched: v.mismatched,
              note: 'Stopped before committing: the page is not showing the values this row supplied.',
            };
            break;
          }
        }

        let out;
        try { out = await dispatchCore(port, step.method, p); }
        catch (e) { out = { ok: false, error: e?.message || String(e) }; }
        results.push({ step: i, method: step.method, ok: out?.ok !== false, value: p.value });

        // Escalate on divergence rather than ploughing on into a wrong page.
        const failed = out && typeof out === 'object' && (out.ok === false || out.found === false);
        const wrongOutcome = step.expect?.outcome && out?.outcome && out.outcome !== step.expect.outcome;
        if (failed || wrongOutcome) {
          diverged = {
            step: i, method: step.method,
            reason: wrongOutcome ? 'different-outcome' : 'step-failed',
            expected: step.expect || null,
            actual: out,
          };
          break;
        }
      }

      const tab = await getSessionTab(port).catch(() => null);

      // With nothing submitted, the useful answer is whether it WOULD have been
      // accepted — so read the validation state the form is now showing.
      await disarm();
      let validation;
      if (dryRun && !diverged && tab) {
        try {
          const fs = await dispatchCore(port, 'form_state', {});
          const missing = (fs.fields || []).filter(f => f.MISSING_REQUIRED).map(f => f.label);
          const invalid = (fs.fields || []).filter(f => f.invalid)
            .map(f => `${f.label}: ${f.validation_message || f.error_text || 'invalid'}`);
          validation = {
            would_submit: missing.length === 0 && invalid.length === 0 && !(fs.page_errors || []).length,
            missing_required: missing.length ? missing : undefined,
            invalid_fields: invalid.length ? invalid : undefined,
            page_errors: (fs.page_errors || []).length ? fs.page_errors : undefined,
          };
        } catch { /* validation is advisory */ }
      }

      return {
        ok: !diverged && (!validation || validation.would_submit !== false),
        flow: params.name,
        ...(dryRun ? {
          dry_run: true,
          committed: false,
          blocked_requests: blocked.length,
          ...(blocked.length ? { blocked: blocked.slice(0, 8) } : { note: 'No state-changing request was attempted, so this flow commits nothing before the steps that were run.' }),
        } : {}),
        ...(validation ? { validation } : {}),
        steps_run: results.length,
        steps_total: flow.steps.length,
        ...(Object.keys(expectations).length ? { verified_fields: Object.keys(expectations) } : {}),
        results: params.verbose ? results : undefined,
        url: tab?.url,
        ...(diverged ? {
          diverged_at: diverged,
          hint: 'The page no longer matches the recording at this step. Inspect with browser_form_state or browser_read_page, handle this case, then continue or re-record.',
        } : {}),
      };
    }

    case 'verify_data': {
      // Structural checks catch a missing field. They do not catch a row completing
      // with the previous row's values because a control never re-rendered — that
      // run looks perfect. This compares what the page is actually showing against
      // what it is supposed to show, in form fields and in rendered summary text.
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot read chrome:// pages');
      const expect = params.expect;
      if (!expect || typeof expect !== 'object' || !Object.keys(expect).length) {
        return { ok: false, error: 'expect required: an object of label to value, for example {"Email":"a@b.com"}' };
      }
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        args: [expect, params.selector || null, params.exact === true],
        func: (expect, rootSel, exact) => {
          const root = rootSel ? document.querySelector(rootSel) : document.body;
          if (!root) return { error: 'scope not found: ' + rootSel };
          const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
          const loose = (v) => norm(v).toLowerCase().replace(/[^a-z0-9]/g, '');
          const same = (a, b) => exact ? norm(a) === norm(b) : (loose(a) === loose(b) || (loose(b) && loose(a).includes(loose(b))));

          const labelOf = (el) => {
            const a = el.getAttribute && el.getAttribute('aria-label');
            if (a) return a;
            if (el.labels && el.labels[0]) return el.labels[0].textContent;
            if (el.placeholder) return el.placeholder;
            const w = el.closest && el.closest('label');
            if (w) return w.textContent;
            return el.name || el.id || '';
          };
          const controls = [...root.querySelectorAll('input, select, textarea')]
            .filter(el => el.type !== 'hidden');

          // Label/value pairs as a review page renders them.
          const pairs = [];
          for (const dl of root.querySelectorAll('dl')) {
            const dts = [...dl.querySelectorAll('dt')], dds = [...dl.querySelectorAll('dd')];
            dts.forEach((dt, i) => dds[i] && pairs.push([norm(dt.textContent), norm(dds[i].textContent)]));
          }
          for (const tr of root.querySelectorAll('tr')) {
            const cells = [...tr.children];
            if (cells.length === 2) pairs.push([norm(cells[0].textContent), norm(cells[1].textContent)]);
          }
          for (const el of root.querySelectorAll('*')) {
            if (el.children.length !== 0) continue;
            const t = norm(el.textContent);
            const m = /^(.{2,60}?)\s*[:：]\s*(.+)$/.exec(t);
            if (m) pairs.push([m[1], m[2]]);
          }

          const out = [];
          for (const [key, want] of Object.entries(expect)) {
            const ctl = controls.find(c => same(labelOf(c), key) || loose(labelOf(c)).includes(loose(key)));
            if (ctl) {
              const got = ctl.tagName === 'SELECT'
                ? (ctl.selectedOptions[0]?.text || '')
                : (ctl.type === 'checkbox' || ctl.type === 'radio' ? (ctl.checked ? 'true' : 'false') : ctl.value);
              out.push({ field: key, expected: norm(want), found: norm(got), source: 'form field', match: same(got, want) });
              continue;
            }
            const pair = pairs.find(([k]) => same(k, key) || loose(k).includes(loose(key)));
            if (pair) {
              out.push({ field: key, expected: norm(want), found: pair[1], source: 'summary text', match: same(pair[1], want) });
              continue;
            }
            // Last resort: is the value present anywhere at all?
            const anywhere = loose(root.innerText || '').includes(loose(want));
            out.push({
              field: key, expected: norm(want), found: null,
              source: anywhere ? 'value appears on the page but not against this label' : 'not found',
              match: false,
            });
          }
          return { checks: out };
        },
      });
      const r = res?.result;
      if (!r || r.error) return { ok: false, error: r?.error || 'Could not read the page' };
      const mismatched = r.checks.filter(c => !c.match);
      return {
        ok: mismatched.length === 0,
        checked: r.checks.length,
        matched: r.checks.length - mismatched.length,
        mismatched: mismatched.length ? mismatched : undefined,
        checks: params.verbose ? r.checks : undefined,
        ...(mismatched.length ? {
          hint: 'The page is not showing what it was given. A control that did not re-render keeps the previous value, which a structural check cannot see.',
        } : {}),
      };
    }

    case 'runs': {
      const store = await chrome.storage.local.get({ bmcpRuns: {} });
      const runs = store.bmcpRuns;
      if (params.id) {
        const r = runs[params.id];
        if (!r) return { ok: false, error: `No run named ${params.id}` };
        const rows = params.status ? r.rows.filter(x => x.status === params.status) : r.rows;
        return { ok: true, run_id: params.id, flow: r.flow, started: r.started, updated: r.updated, rows };
      }
      if (params.delete) {
        delete runs[params.delete];
        await chrome.storage.local.set({ bmcpRuns: runs });
        return { ok: true, deleted: params.delete };
      }
      return {
        ok: true,
        runs: Object.entries(runs).map(([id, r]) => ({
          run_id: id, flow: r.flow, started: r.started, updated: r.updated,
          total: r.rows.length,
          ...r.rows.reduce((a, x) => { a[x.status] = (a[x.status] || 0) + 1; return a; }, {}),
        })).sort((a, b) => (b.started || '').localeCompare(a.started || '')),
      };
    }

    case 'extract': {
      // Structured data without hand-written DOM code. Handles real tables and, for
      // card/list layouts, infers the repeated structure and lines the items up into
      // columns. Optionally follows pagination and merges the pages.
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot read chrome:// pages');
      const maxRows = Math.min(2000, params.max_rows || 200);
      const maxPages = params.paginate ? Math.min(50, params.max_pages || 10) : 1;

      const rows = [];
      let columns = null, source = null, pagesRead = 0, stoppedBecause = 'single-page', scopeNote = null;

      for (let page = 0; page < maxPages; page++) {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN',
          args: [params.selector || null, params.mode || 'auto', maxRows - rows.length],
          func: bmcpExtractOp,
        });
        let r = res?.result;
        // A scoped search that finds nothing is usually a mis-aimed selector — the
        // page often has several elements with that class. Retry across the whole
        // page and say that is what happened, rather than dead-ending.
        if (page === 0 && params.selector && (!r || r.error)) {
          const [wide] = await chrome.scripting.executeScript({
            target: { tabId: tab.id }, world: 'MAIN',
            args: [null, params.mode || 'auto', maxRows],
            func: bmcpExtractOp,
          });
          if (wide?.result && !wide.result.error) {
            r = wide.result;
            r.note = `Nothing extractable inside ${params.selector}; extracted from the whole page instead.`;
          }
        }
        if (!r || r.error) {
          if (page === 0) return { ok: false, error: r?.error || 'Nothing extractable found on this page.' };
          stoppedBecause = 'no-data-on-page';
          break;
        }
        if (r.note) scopeNote = r.note;
        pagesRead++;
        source = source || r.source;
        if (!columns) columns = r.columns;
        for (const row of r.rows) {
          if (rows.length >= maxRows) break;
          rows.push(row);
        }
        if (rows.length >= maxRows) { stoppedBecause = 'max_rows reached'; break; }
        if (page + 1 >= maxPages) { stoppedBecause = maxPages > 1 ? 'max_pages reached' : 'single-page'; break; }

        // Advance pagination
        const [nav] = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN',
          args: [params.next_selector || null],
          func: (nextSel) => {
            const vis = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
            const disabled = (el) => el.disabled || el.getAttribute('aria-disabled') === 'true' ||
              /(^|\s)(disabled)(\s|$)/.test(typeof el.className === 'string' ? el.className : '');
            let el = null;
            if (nextSel) { try { el = document.querySelector(nextSel); } catch (e) {} }
            if (!el) {
              // Real next controls rarely read exactly "next": they carry an arrow
              // ("Next →"), sit inside li.next, or only expose intent via rel/aria.
              const cands = [...document.querySelectorAll('a[rel="next"], [aria-label*="next" i], li.next > a, .pagination a, .pager a, nav a, button, a')].filter(vis);
              const isNext = (e) => {
                if (e.getAttribute('rel') === 'next') return true;
                if (/next/i.test(e.getAttribute('aria-label') || '')) return true;
                if (e.closest('li.next, .next, [class*="next" i]')) return true;
                const t = (e.textContent || '').trim();
                return /^next\b/i.test(t) || /^(›|»|→|>|>>)$/.test(t);
              };
              el = cands.find(isNext);
            }
            if (!el) return { done: true, why: 'no next control found' };
            if (disabled(el)) return { done: true, why: 'next control is disabled' };
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            el.click();
            return { done: false };
          },
        }).catch(() => [null]);
        if (!nav?.result || nav.result.done) { stoppedBecause = nav?.result?.why || 'pagination ended'; break; }
        await dispatchCore(port, 'wait_idle', { timeout: 8000, quiet_ms: 400 }).catch(() => {});
      }

      return {
        ok: true, source, columns, rows,
        row_count: rows.length,
        pages_read: pagesRead,
        stopped_because: stoppedBecause,
        ...(scopeNote ? { note: scopeNote } : {}),
        url: tab.url,
      };
    }

    case 'wait_idle': {
      // Blind fixed waits are the main time sink in long portal sessions: the caller
      // cannot know whether a page finished re-rendering, so it guesses a timeout and
      // pays it in full whether or not anything is still happening. This waits for the
      // page to actually settle — no in-flight requests, no DOM mutations, no visible
      // spinner — and returns as soon as that is true.
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot inspect chrome:// pages');
      const timeout = Math.min(120000, params.timeout || 15000);
      const quiet = Math.min(5000, params.quiet_ms || 600);
      const started = Date.now();

      // Watch DOM mutations and spinners from inside the page.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => {
          if (window.__bmcpIdleObs) { try { window.__bmcpIdleObs.disconnect(); } catch (e) {} }
          window.__bmcpLastMutation = Date.now();
          window.__bmcpIdleObs = new MutationObserver(() => { window.__bmcpLastMutation = Date.now(); });
          window.__bmcpIdleObs.observe(document.documentElement, {
            childList: true, subtree: true, attributes: true, characterData: true,
          });
        },
      }).catch(() => {});

      const inflight = () => {
        const buf = networkLogs.get(tab.id) || [];
        // Long-polls, aborted requests and connections the page never closes never
        // receive a response, so counting every status-less entry as in flight meant
        // a page with one of them could never be called settled and always burned
        // the full timeout.
        const now = Date.now();
        return buf.filter(e => e.status === undefined && !e.failed && (now - (e.t0 || 0)) < 10000).length;
      };

      let reason = 'timeout';
      let lastPending = inflight();
      let lastSpinner = null;
      while (Date.now() - started < timeout) {
        await new Promise(r => setTimeout(r, 150));
        const [probe] = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN',
          func: () => {
            const vis = (el) => {
              const r = el.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) return false;
              const st = getComputedStyle(el);
              return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) !== 0;
            };
            // Match on id as well as class: plenty of pages use id="loading" with no
            // class at all, and a spinner that is visibly running must never count
            // as settled just because nothing else is mutating.
            const SPIN = /(^|[^a-z])(load(ing|er)?|spin(ner)?|busy|progress|please[-_ ]?wait|skeleton|shimmer)([^a-z]|$)/i;
            const spinnerEl = [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"], [class], [id]')]
              .find(el => {
                if (el.getAttribute('aria-busy') === 'true' || el.getAttribute('role') === 'progressbar') return vis(el);
                const token = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''}`;
                return token.trim() && SPIN.test(token) && vis(el);
              });
            return {
              sinceMutation: Date.now() - (window.__bmcpLastMutation || 0),
              spinner: !!spinnerEl,
              spinner_hint: spinnerEl ? (spinnerEl.id || (typeof spinnerEl.className === 'string' ? spinnerEl.className : '')).slice(0, 40) : null,
              ready: document.readyState,
            };
          },
        }).catch(() => [null]);
        const p = probe?.result;
        if (!p) { reason = 'page-navigated'; break; }
        lastPending = inflight();
        lastSpinner = p.spinner_hint;
        if (p.ready === 'complete' && !p.spinner && lastPending === 0 && p.sinceMutation >= quiet) {
          reason = 'settled';
          break;
        }
      }

      await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => { try { window.__bmcpIdleObs && window.__bmcpIdleObs.disconnect(); } catch (e) {} },
      }).catch(() => {});

      const waited = Date.now() - started;
      return {
        ok: reason === 'settled' || reason === 'page-navigated',
        settled: reason === 'settled',
        reason,
        waited_ms: waited,
        pending_requests: lastPending,
        ...(lastSpinner ? { blocked_by: 'spinner: ' + lastSpinner } : {}),
        ...(reason === 'timeout' ? {
          hint: lastSpinner
            ? 'A loading indicator stayed visible for the whole timeout. The request behind it may have stalled; check browser_network_log.'
            : 'The page never went quiet. Something is polling or animating continuously; check browser_network_log, or act anyway if the content you need is already present.',
        } : {}),
      };
    }

    case 'network_log': {
      const tab = await getSessionTab(port);
      await debuggerAttach(tab.id).catch(() => {}); // ensures Network.enable ran
      const buf = networkLogs.get(tab.id) || [];
      const pat = params.url_pattern || '';
      // Other extensions' content scripts fetch their own assets through the page,
      // and those chrome-extension:// requests drowned the page's real traffic.
      // They are never what the caller means by "what did this page request".
      let out = buf.filter(e =>
        (params.include_extension_requests || !(e.url || '').startsWith('chrome-extension://')) &&
        (!pat || (e.url || '').includes(pat)) &&
        (!params.only_failed || e.failed || (e.status >= 400)));
      // Re-pull one response in full. A capped body is not valid JSON, so there has
      // to be a way back to the whole thing rather than only a shorter copy.
      if (params.request_id) {
        const entry = buf.find(e => e.id === params.request_id);
        if (!entry) return { ok: false, error: `No request ${params.request_id} in this tab's log.` };
        try {
          const r = await cdpSend(tab.id, 'Network.getResponseBody', { requestId: params.request_id });
          if (!r || r.body == null) return { ok: false, error: 'Chrome no longer holds this response body; re-issue the request.' };
          if (r.base64Encoded) return { ok: false, error: 'Response is binary; save it with browser_save mode:"url".' };
          const full = String(r.body);
          entry.body = full.length > NET_BODY_MAX ? full.slice(0, NET_BODY_MAX) : full;
          return { ok: true, request_id: params.request_id, url: entry.url, bytes: full.length, body: full };
        } catch (e) {
          return { ok: false, error: `Could not re-read the body: ${e?.message || e}. Chrome evicts response bodies after a while; re-issue the request.` };
        }
      }

      const total = out.length;
      const bodyChars = Math.min(200000, params.max_body_chars || 4000);
      out = out.slice(-(params.limit || 50)).map(({ started, t0, body, ...rest }) => {
        // Bodies are captured always but returned only when asked for, so the
        // default listing stays small.
        if (!params.include_body) {
          return body ? { ...rest, has_body: true, body_bytes: body.length } : rest;
        }
        if (!body) return rest;
        // Say plainly when the payload is not the whole thing: a cut JSON body will
        // not parse, and silently handing one back invites the caller to try.
        const cut = body.length > bodyChars;
        return {
          ...rest,
          body: cut ? body.slice(0, bodyChars) : body,
          ...(cut || rest.body_truncated ? {
            truncated: true,
            complete_bytes: rest.body_truncated || body.length,
            note: `Body is cut and will not parse as JSON. Re-read the whole response with browser_network_log({request_id:"${rest.id}"}).`,
          } : {}),
        };
      });
      if (params.clear) networkLogs.set(tab.id, []);
      return {
        requests: out, total_matched: total, buffered: buf.length,
        ...(params.include_body ? {} : { hint: 'Entries marked has_body carry a captured response; pass include_body:true to read them.' }),
        ...(buf.length === 0 ? { note: 'Empty — recording starts when the debugger attaches to a tab. Reload the page to capture its full load sequence.' } : {}),
      };
    }

    case 'drag': {
      // Real drag: press, move in steps (frameworks need intermediate moves), release.
      // Falls back to HTML5 drag-and-drop events for dropzones that listen for
      // dragstart/dragover/drop rather than raw mouse movement.
      const tab = await getSessionTab(port, true);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot interact with chrome:// pages');
      const from = params.from_selector ? await resolveElement(tab.id, params.from_selector)
        : (typeof params.from_x === 'number' ? { x: params.from_x, y: params.from_y } : null);
      const to = params.to_selector ? await resolveElement(tab.id, params.to_selector)
        : (typeof params.to_x === 'number' ? { x: params.to_x, y: params.to_y } : null);
      if (!from) return { ok: false, error: 'from_selector not found or from_x/from_y missing' };
      if (!to) return { ok: false, error: 'to_selector not found or to_x/to_y missing' };
      const steps = Math.max(2, Math.min(40, params.steps || 12));
      try {
        await debuggerAttach(tab.id);
        await cdpSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
        await cdpSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          await cdpSend(tab.id, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved', button: 'left', buttons: 1,
            x: Math.round(from.x + (to.x - from.x) * t),
            y: Math.round(from.y + (to.y - from.y) * t),
          });
          await new Promise(r => setTimeout(r, 16));
        }
        await cdpSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
        return { ok: true, method: 'trusted-mouse', from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } };
      } catch (e) {
        // HTML5 DnD fallback (sortable lists, upload dropzones)
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: 'MAIN',
          args: [from.x, from.y, to.x, to.y],
          func: (fx, fy, tx, ty) => {
            const src = document.elementFromPoint(fx, fy);
            const dst = document.elementFromPoint(tx, ty);
            if (!src || !dst) return { ok: false, error: 'endpoint element not found' };
            const dt = new DataTransfer();
            const mk = (type, el, x, y) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt }));
            mk('dragstart', src, fx, fy); mk('dragenter', dst, tx, ty);
            mk('dragover', dst, tx, ty); mk('drop', dst, tx, ty); mk('dragend', src, tx, ty);
            return { ok: true };
          },
        });
        return r?.result?.ok
          ? { ok: true, method: 'html5-dnd-fallback', note: 'trusted mouse drag failed: ' + (e?.message || e) }
          : { ok: false, error: 'both trusted drag and HTML5 DnD failed: ' + (e?.message || e) };
      }
    }

    case 'triple_click': {
      // Selects a whole line/paragraph — the reliable way to replace text in
      // rich editors before typing.
      const tab = await getSessionTab(port, true);
      const el = await resolveElement(tab.id, params.selector);
      if (!el) return { ok: false, error: 'Element not found: ' + params.selector };
      await debuggerAttach(tab.id);
      const { x, y } = el;
      await cdpSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      for (let n = 1; n <= 3; n++) {
        await cdpSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: n });
        await cdpSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: n });
        await new Promise(r => setTimeout(r, 30));
      }
      const [sel] = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => (window.getSelection?.().toString() || '').slice(0, 120),
      }).catch(() => [null]);
      return { ok: true, tag: el.tag, selected_text: sel?.result ?? null };
    }

    case 'resize_window': {
      const tab = await getSessionTab(port);
      const w = params.width, h = params.height;
      if (typeof w !== 'number' || typeof h !== 'number') return { ok: false, error: 'width and height (numbers) required' };
      const win = await chrome.windows.get(tab.windowId);
      if (win.state === 'maximized' || win.state === 'fullscreen') {
        await chrome.windows.update(tab.windowId, { state: 'normal' });
      }
      const updated = await chrome.windows.update(tab.windowId, { width: Math.round(w), height: Math.round(h) });
      const [vp] = await chrome.scripting.executeScript({
        target: { tabId: tab.id }, world: 'MAIN',
        func: () => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio }),
      }).catch(() => [null]);
      return {
        ok: true,
        window: { width: updated.width, height: updated.height, state: updated.state },
        viewport: vp?.result || null,
        note: 'Window (not viewport) size — the viewport is smaller by the browser chrome.',
      };
    }

    case 'reattach_debugger': {
      // FORCE-GRAB recovery: activate the tab (input only reaches active tabs),
      // clear every stale claim, re-attach, then PROVE it by dispatching a real
      // mouse event and checking whether the page actually received it.
      const tab = await getSessionTab(port, true);
      const before = await chrome.debugger.getTargets().then(
        ts => ts.find(t => t.tabId === tab.id)?.attached || false).catch(() => null);
      debuggerAttached.delete(tab.id);
      for (let i = 0; i < 3; i++) {
        try { await chrome.debugger.detach({ tabId: tab.id }); } catch {}
        await new Promise(r => setTimeout(r, 120));
      }
      let attachErr = null;
      try { await debuggerAttach(tab.id); } catch (e) { attachErr = e.message; }
      const after = await chrome.debugger.getTargets().then(
        ts => ts.find(t => t.tabId === tab.id)?.attached || false).catch(() => null);

      // Live proof: fire a trusted mouse move + click on a harmless spot and see
      // whether the page observed a trusted event. Reporting "reattached: true"
      // without this would be exactly the unverified claim this fork avoids.
      let trustedWorks = false;
      if (after && !tab.url.startsWith('chrome://') && !tab.url.startsWith('about:')) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id }, world: 'MAIN',
            func: () => {
              window.__bmcpProbe = false;
              const h = (e) => { if (e.isTrusted) window.__bmcpProbe = true; };
              window.addEventListener('mousemove', h, { capture: true, once: true });
            },
          });
          await cdpSend(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
          await new Promise(r => setTimeout(r, 120));
          const [chk] = await chrome.scripting.executeScript({
            target: { tabId: tab.id }, world: 'MAIN',
            func: () => { const v = window.__bmcpProbe === true; try { delete window.__bmcpProbe; } catch {} return v; },
          });
          trustedWorks = chk?.result === true;
        } catch {}
      }
      return {
        ok: after === true,
        tab_id: tab.id,
        was_attached: before,
        now_attached: after,
        trusted_input_verified: trustedWorks,
        ...(attachErr ? { attach_error: attachErr } : {}),
        hint: trustedWorks
          ? 'Debugger held and trusted input confirmed reaching the page.'
          : after
          ? 'Attached, but a trusted event did not reach the page. The tab must be the ACTIVE tab of its window for Chrome to route CDP input; clicks still work via the synthetic fallback.'
          : 'Could not attach — another debugger client (rival automation extension, or an open DevTools window) holds this tab. Close it, or keep using the synthetic fallback.',
      };
    }

    case 'hover': {
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot interact with chrome:// pages');
      const el = await resolveElement(tab.id, params.selector);
      if (!el) return { ok: false, error: 'Element not found: ' + params.selector };
      await debuggerAttach(tab.id);
      try {
        await cdpSend(tab.id, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: el.x, y: el.y,
        });
        // Hold hover for duration (default 500ms) so menus/tooltips appear
        await new Promise(r => setTimeout(r, params.duration || 500));
      } finally {
        await debuggerDetach(tab.id);
      }
      return { ok: true, tag: el.tag, text: el.text };
    }

    case 'select_option': {
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot interact with chrome:// pages');

      // Strategy: handle native <select> and custom dropdowns differently
      const isNativeSelect = await debuggerEval(tab.id, `
        (function() {
          const el = document.querySelector(${JSON.stringify(params.selector)});
          return el?.tagName === 'SELECT';
        })()
      `);

      if (isNativeSelect) {
        // Native <select> — set value directly
        await debuggerEval(tab.id, `
          (function() {
            const sel = document.querySelector(${JSON.stringify(params.selector)});
            const opt = Array.from(sel.options).find(o => o.text.includes(${JSON.stringify(params.option)}) || o.value === ${JSON.stringify(params.option)});
            if (opt) {
              sel.value = opt.value;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
              sel.dispatchEvent(new Event('input', { bubbles: true }));
            }
            return !!opt;
          })()
        `);
        return { ok: true, type: 'native_select' };
      }

      // Custom dropdown (Angular Material, React Select, etc.)
      // Step 1: Click the trigger to open
      const trigger = await resolveElement(tab.id, params.selector);
      if (!trigger) return { ok: false, error: 'Dropdown trigger not found: ' + params.selector };
      await debuggerClick(tab.id, trigger.x, trigger.y);

      // Step 2: Wait for options to appear
      await new Promise(r => setTimeout(r, params.wait || 300));

      // Step 3: Find and click the option by text
      const option = await resolveElement(tab.id, `text=${params.option}`);
      if (!option) return { ok: false, error: 'Option not found: ' + params.option };
      await debuggerClick(tab.id, option.x, option.y);

      return { ok: true, type: 'custom_dropdown', selected: params.option };
    }

    case 'handle_dialog': {
      // Auto-handle JS alert/confirm/prompt dialogs
      // Must be set up BEFORE the dialog appears
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot interact with chrome:// pages');
      const action = params.action || 'accept'; // accept, dismiss
      const promptText = params.text || '';

      await debuggerAttach(tab.id);
      try {
        // Enable page events to catch dialogs
        await cdpSend(tab.id, 'Page.enable', {});

        // Wait for dialog to appear (or handle existing one)
        const result = await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            chrome.debugger.onEvent.removeListener(listener);
            resolve({ ok: false, error: 'No dialog appeared within timeout' });
          }, params.timeout || 10000);

          const listener = (source, method, eventParams) => {
            if (source.tabId !== tab.id || method !== 'Page.javascriptDialogOpening') return;
            chrome.debugger.onEvent.removeListener(listener);
            clearTimeout(timeout);

            cdpSend(tab.id, 'Page.handleJavaScriptDialog', {
              accept: action === 'accept',
              promptText: promptText,
            }).then(() => {
              resolve({
                ok: true,
                dialog_type: eventParams.type,
                message: eventParams.message,
                action,
              });
            }).catch(e => resolve({ ok: false, error: e.message }));
          };
          chrome.debugger.onEvent.addListener(listener);
        });

        return result;
      } finally {
        await debuggerDetach(tab.id);
      }
    }

    case 'wait_for_network': {
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot interact with chrome:// pages');
      const urlPattern = params.url_pattern || '';
      const timeout = params.timeout || 15000;

      await debuggerAttach(tab.id);
      try {
        await cdpSend(tab.id, 'Network.enable', {});

        const result = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            chrome.debugger.onEvent.removeListener(listener);
            resolve({ ok: false, error: 'No matching request within timeout' });
          }, timeout);

          const listener = (source, method, eventParams) => {
            if (source.tabId !== tab.id) return;

            if (method === 'Network.responseReceived') {
              const url = eventParams.response?.url || '';
              const status = eventParams.response?.status;
              // Match by pattern (substring match) or return any if no pattern
              if (!urlPattern || url.includes(urlPattern)) {
                chrome.debugger.onEvent.removeListener(listener);
                clearTimeout(timer);
                // Try to get response body
                cdpSend(tab.id, 'Network.getResponseBody', {
                  requestId: eventParams.requestId,
                }).then(bodyResult => {
                  resolve({
                    ok: true,
                    url,
                    status,
                    method: eventParams.response?.requestHeaders?.[':method'] || 'GET',
                    body: bodyResult?.body?.substring(0, 5000) || null,
                  });
                }).catch(() => {
                  resolve({
                    ok: true,
                    url,
                    status,
                    method: eventParams.response?.requestHeaders?.[':method'] || 'GET',
                    body: null,
                  });
                });
              }
            }
          };
          chrome.debugger.onEvent.addListener(listener);
        });

        await cdpSend(tab.id, 'Network.disable', {});
        return result;
      } finally {
        await debuggerDetach(tab.id);
      }
    }

    case 'fetch': {
      // HTTP requests from background — NOT subject to CORS
      const options = {
        method: params.method || 'GET',
        headers: params.headers || {},
      };
      if (params.body) options.body = typeof params.body === 'string' ? params.body : JSON.stringify(params.body);
      try {
        const resp = await fetch(params.url, options);
        const text = await resp.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        return { ok: resp.ok, status: resp.status, body: json || text };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    case 'list_tabs': {
      const session = getSession(port);

      // all:true → every tab open in the browser, not just this session's, so the
      // model can see what the user already has open and adopt one deliberately.
      if (params.all) {
        const everything = await chrome.tabs.query({});
        const mine = session.tabIds;
        const grouped = {};
        for (const t of everything) {
          const entry = {
            id: t.id,
            url: t.url || t.pendingUrl || '',
            title: t.title || '',
            active: t.active,
            window_id: t.windowId,
            owner: mine.has(t.id) ? (session.adopted?.has(t.id) ? 'this-session (adopted)' : 'this-session') : 'user',
            attachable: !(t.url || '').startsWith('chrome://') && !(t.url || '').startsWith('chrome-extension://') && !(t.url || '').startsWith('edge://'),
          };
          (grouped[t.windowId] ||= []).push(entry);
        }
        const flat = Object.values(grouped).flat();
        return {
          tabs: flat,
          total: flat.length,
          windows: Object.keys(grouped).length,
          session: session.label,
          session_tabs: mine.size,
          hint: 'browser_attach_tab({tab_id}) adopts one of the "user" tabs into this session so every tool acts on it. Adopted tabs are never auto-closed. Tabs with attachable:false (chrome://, extension pages) cannot be automated.',
        };
      }

      // Default: only this session's tabs
      const tabs = [];
      for (const tabId of session.tabIds) {
        try {
          const tab = await chrome.tabs.get(tabId);
          tabs.push({ id: tab.id, url: tab.url, title: tab.title, active: tab.active, adopted: session.adopted?.has(tabId) || false });
        } catch {
          session.tabIds.delete(tabId);
        }
      }
      return { tabs, session: session.label, color: session.color };
    }

    case 'get_cookies': {
      const cookies = await chrome.cookies.getAll({ domain: params.domain });
      return { cookies: cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path })) };
    }

    case 'get_local_storage': {
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot access chrome:// pages');
      const scriptResult = await safeExecuteScript(tab.id, (key) => key ? localStorage.getItem(key) : JSON.stringify(Object.fromEntries(Object.entries(localStorage))), [params.key || null]);
      if (!scriptResult.cspBlocked) {
        return { value: scriptResult.result };
      }
      const expr = params.key
        ? `localStorage.getItem(${JSON.stringify(params.key)})`
        : `JSON.stringify(Object.fromEntries(Object.entries(localStorage)))`;
      const value = await debuggerEval(tab.id, expr);
      return { value, method: 'debugger' };
    }

    case 'set_cookies': {
      const results = [];
      const cookieList = Array.isArray(params.cookies) ? params.cookies : [params];
      for (const c of cookieList) {
        try {
          const cookie = await chrome.cookies.set({
            url: c.url || `https://${c.domain}`,
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || '/',
            secure: c.secure !== false,
            httpOnly: c.httpOnly || false,
            sameSite: c.sameSite || 'lax',
          });
          results.push({ ok: true, name: c.name });
        } catch (e) {
          results.push({ ok: false, name: c.name, error: e.message });
        }
      }
      return { results };
    }

    case 'set_local_storage': {
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot access chrome:// pages');
      const key = params.key;
      const val = params.value;
      const expr = `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(val)})`;
      try {
        const scriptResult = await safeExecuteScript(tab.id, (k, v) => { localStorage.setItem(k, v); return { ok: true }; }, [key, val]);
        if (!scriptResult.cspBlocked) return scriptResult.result;
      } catch {}
      await debuggerEval(tab.id, expr);
      return { ok: true, method: 'debugger' };
    }

    case 'console_logs': {
      // v2.0: the interceptor is installed at document_start by a registered
      // content script (console-capture.js), so the FULL console history since
      // page load is available — including errors logged before the first read,
      // uncaught exceptions, and unhandled promise rejections. The old design
      // installed the interceptor lazily on first read and missed all of that.
      const tab = await getSessionTab(port);
      const count = params.count || 50;
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        args: [count, params.pattern || null, !!params.only_errors, !!params.clear],
        func: (count, pattern, onlyErrors, clear) => {
          const buf = window.__mcpConsoleLogs || [];
          let re = null;
          if (pattern) { try { re = new RegExp(pattern, 'i'); } catch {} }
          let out = buf.filter(l =>
            (!onlyErrors || l.type === 'error' || l.type === 'exception') &&
            (!re || re.test(l.text)));
          const total = out.length;
          // Development builds repeat the same warning hundreds of times and bury
          // the one line that matters. Identical messages collapse to a single entry
          // with a count, so the signal survives the noise.
          const seen = new Map();
          for (const l of out) {
            const key = l.type + '|' + l.text;
            if (seen.has(key)) { const e = seen.get(key); e.repeats = (e.repeats || 1) + 1; e.ts = l.ts; }
            else seen.set(key, { ...l });
          }
          const collapsed = [...seen.values()];
          const deduped = total - collapsed.length;
          return {
            logs: collapsed.slice(-count),
            total_matched: total,
            unique: collapsed.length,
            ...(deduped > 0 ? { duplicates_collapsed: deduped } : {}),
            captured_since_load: !!window.__mcpConsoleLogs,
          };
        },
      });
      const r = res?.result || { logs: [], captured_since_load: false };
      if (!r.captured_since_load) {
        r.note = 'Interceptor not present on this page (loaded before the extension was updated, or a chrome:// page). Reload the page to capture from document_start.';
      }
      return r;
    }


    case 'select_frame': {
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot access chrome:// pages');
      const frameIndex = params.frame_index ?? 0;
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      if (!frames || frameIndex >= frames.length) {
        return { error: `Frame ${frameIndex} not found. Available: ${frames?.length || 0} frames`, frames: frames?.map((f, i) => ({ index: i, url: f.url })) };
      }
      const frameId = frames[frameIndex].frameId;
      const code = params.code || 'document.body.innerText.slice(0, 5000)';
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [frameId] },
        func: new Function('return (' + code + ')'),
        world: 'MAIN',
      });
      return { result: result.result, frame_url: frames[frameIndex].url };
    }

    case 'list_frames': {
      const tab = await getSessionTab(port);
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      return { frames: frames?.map((f, i) => ({ index: i, url: f.url, frame_id: f.frameId, parent_frame_id: f.parentFrameId })) || [] };
    }

    case 'get_new_tab': {
      // The remembered id can be stale (the popup closed, or the service worker
      // restarted and lost it). Fall back to the newest tab in the window that no
      // session owns — which is what "the tab that just opened" means in practice.
      const session = getSession(port);
      const owned = new Set([...sessions.values()].flatMap(s => [...s.tabIds]));
      let tab = null;
      if (lastCreatedTabId) tab = await chrome.tabs.get(lastCreatedTabId).catch(() => null);
      if (!tab) {
        const all = await chrome.tabs.query({});
        const candidates = all
          .filter(t => !owned.has(t.id) && !(t.url || '').startsWith('chrome://'))
          .sort((a, b) => b.id - a.id); // Chrome ids increase monotonically
        tab = candidates[0] || null;
      }
      if (!tab) {
        return { ok: false, error: 'No unclaimed tab found. List everything with browser_list_tabs({all:true}) and attach one with browser_attach_tab.' };
      }
      await addTabToSession(port, tab.id);
      session.activeTabId = tab.id;
      persistSessions();
      return { ok: true, id: tab.id, url: tab.url || tab.pendingUrl || '', title: tab.title, window_id: tab.windowId, matched: lastCreatedTabId === tab.id ? 'last-created' : 'newest-unclaimed' };
    }

    case 'attach_tab': {
      // Adopt one of the user's existing tabs into this session. Everything that
      // follows (click/fill/read_page/screenshot) then acts on it. The tab keeps
      // its cookies and login state — that is the point.
      const tabId = params.tab_id;
      if (typeof tabId !== 'number') {
        return { ok: false, error: 'tab_id (number) required — list candidates with browser_list_tabs({all:true})' };
      }
      let tab;
      try { tab = await chrome.tabs.get(tabId); } catch {
        return { ok: false, error: `No tab with id ${tabId}. Run browser_list_tabs({all:true}) for current ids (they change when tabs are reopened).` };
      }
      const url = tab.url || tab.pendingUrl || '';
      if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('edge://')) {
        return { ok: false, error: `Cannot automate ${url.split('/')[0]}// pages — Chrome blocks extension access to them.` };
      }
      const session = getSession(port);
      const already = session.tabIds.has(tabId);
      if (!already) {
        if (params.group === false) {
          session.tabIds.add(tabId); // leave the user's tab strip untouched
        } else {
          await addTabToSession(port, tabId);
        }
        session.adopted = session.adopted || new Set();
        session.adopted.add(tabId);
      }
      session.activeTabId = tabId;
      persistSessions();
      return {
        ok: true,
        attached: { id: tab.id, url, title: tab.title, window_id: tab.windowId },
        already_in_session: already,
        grouped: params.group !== false && !already,
        note: 'This is now the session\'s active tab. It will NOT be auto-closed or evicted; browser_detach_tab releases it without closing. Pass group:false to avoid moving it into the session tab group.',
      };
    }

    case 'detach_tab': {
      // Release a tab from the session WITHOUT closing it.
      const session = getSession(port);
      const tabId = params.tab_id;
      if (typeof tabId !== 'number') return { ok: false, error: 'tab_id (number) required' };
      if (!session.tabIds.has(tabId)) return { ok: false, error: `Tab ${tabId} is not in this session` };
      session.tabIds.delete(tabId);
      session.adopted?.delete(tabId);
      if (session.activeTabId === tabId) session.activeTabId = null;
      debuggerForceDetach(tabId);
      stickyTabs.delete(tabId);
      if (params.ungroup !== false) { try { await chrome.tabs.ungroup(tabId); } catch {} }
      persistSessions();
      return { ok: true, released: tabId, still_open: true, remaining: session.tabIds.size };
    }

    case 'switch_tab': {
      const session = getSession(port);
      if (!session.tabIds.has(params.tab_id)) {
        throw new Error(`Tab ${params.tab_id} does not belong to this session (${session.label})`);
      }
      const tab = await chrome.tabs.update(params.tab_id, { active: true });
      session.activeTabId = tab.id;
      persistSessions();
      return { id: tab.id, url: tab.url, title: tab.title };
    }

    case 'close_tab': {
      const session = getSession(port);
      const tabId = params.tab_id;
      if (!session.tabIds.has(tabId)) {
        throw new Error(`Tab ${tabId} does not belong to this session (${session.label})`);
      }
      // TEARDOWN-RACE FIX: remove from the session BEFORE chrome.tabs.remove, so the
      // onRemoved listener doesn't see it as the session's last tab and terminate the
      // MCP server mid-conversation. A COMMAND closing tabs is the client tidying up —
      // the session lives on (next navigate simply creates a fresh tab). Only the USER
      // closing the last session tab by hand should ever terminate the server.
      session.tabIds.delete(tabId);
      if (session.activeTabId === tabId) session.activeTabId = null;
      persistSessions();
      try {
        await chrome.tabs.remove(tabId);
      } catch (e) {
        return { ok: true, remaining: session.tabIds.size, note: 'tab was already closed' };
      }
      return { ok: true, remaining: session.tabIds.size };
    }

    case 'solve_captcha': {
      const tab = await getSessionTab(port);
      const action = params.action || 'detect';

      // ── Detect CAPTCHA on page ──
      if (action === 'detect') {
        const detection = await detectCaptcha(tab.id);
        return detection;
      }

      // Solving is deliberately not implemented: clicking through a CAPTCHA is a
      // terms-of-service problem for the site owner and an unreliable capability.
      // Detection is the honest part — it tells the caller to hand over to a human.
      if (action === 'click_checkbox' || action === 'click_grid') {
        return {
          ok: false,
          error: 'Solving CAPTCHAs is not supported. Tell the user a CAPTCHA is blocking the page and let them complete it in the browser, then continue.',
          detected: await detectCaptcha(tab.id),
        };
      }

      if (action === 'ask_human') {
        return { method: 'human', instructions: 'Call browser_ask_user with message: "A CAPTCHA needs to be solved. Please solve it in the browser and click Done when finished."' };
      }

      return { error: 'Unknown action: ' + action };
    }

    case 'upload_file': {
      const tab = await getSessionTab(port);
      const selector = params.selector || 'input[type="file"]';
      try {
        await debuggerAttach(tab.id);
        // Find the file input element
        const { result: nodeResult } = await cdpSend(tab.id, 'Runtime.evaluate', {
          expression: `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return JSON.stringify({ found: false, error: 'File input not found: ${selector}' });
            return JSON.stringify({ found: true, tag: el.tagName, type: el.type, accept: el.accept, multiple: el.multiple });
          })()`,
          returnByValue: true,
        });
        const info = JSON.parse(nodeResult.value);
        if (!info.found) {
          await debuggerDetach(tab.id);
          return info;
        }

        // Get the DOM node ID for the file input
        const { result: docResult } = await cdpSend(tab.id, 'DOM.getDocument', {});
        const { nodeId } = await cdpSend(tab.id, 'DOM.querySelector', {
          nodeId: docResult.root.nodeId,
          selector: selector,
        });

        if (!nodeId) {
          await debuggerDetach(tab.id);
          return { found: false, error: 'Could not get DOM node for file input' };
        }

        // Set files on the input using CDP
        const files = Array.isArray(params.files) ? params.files : [params.files || params.file];
        await cdpSend(tab.id, 'DOM.setFileInputFiles', {
          nodeId: nodeId,
          files: files,
        });

        await debuggerDetach(tab.id);
        return { ok: true, files: files, input: info };
      } catch (e) {
        try { await debuggerDetach(tab.id); } catch {}
        return { ok: false, error: e.message };
      }
    }

    // ── v2.0 tools: read_page, find, health, batch ──────────────────────────

    case 'read_page': {
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot read chrome:// pages');
      const filter = params.filter === 'all' ? 'all' : 'interactive';
      const maxChars = Math.max(2000, params.max_chars || 40000);
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        args: [filter, maxChars],
        func: (filter, maxChars) => {
          if (!window.__bmcpRefEls) { window.__bmcpRefEls = {}; window.__bmcpRefSeq = 0; }
          const refs = window.__bmcpRefEls;
          const assignRef = (el) => {
            if (el.__bmcpRef && refs[el.__bmcpRef] === el) return el.__bmcpRef;
            const key = 'ref_' + (++window.__bmcpRefSeq);
            try { Object.defineProperty(el, '__bmcpRef', { value: key, configurable: true }); } catch {}
            refs[key] = el;
            // Fingerprint so the ref can be re-identified if the framework swaps the node.
            try {
              if (!window.__bmcpRefMeta) window.__bmcpRefMeta = {};
              const nm = (e) => {
                const a = e.getAttribute && e.getAttribute('aria-label');
                if (a) return a.trim();
                if (e.labels && e.labels[0]) return e.labels[0].textContent.trim().replace(/\s+/g, ' ');
                if (e.placeholder) return e.placeholder.trim();
                const t = (e.textContent || '').trim().replace(/\s+/g, ' ');
                return t ? t.slice(0, 80) : (e.name || e.id || '');
              };
              // Anchor to the nearest labelled container. Position among identical
              // peers is not identity: inserting a row above shifts every index, and
              // re-identifying by index alone lands confidently on the wrong record.
              const anchorOf = (e) => {
                const fs = e.closest && e.closest('fieldset');
                if (fs) { const lg = fs.querySelector('legend'); if (lg && lg.textContent.trim()) return lg.textContent.trim().replace(/s+/g, ' ').slice(0, 60); }
                const sec = e.closest && e.closest('[aria-label], [role="row"], tr, [role="group"], section, li');
                if (sec) {
                  const al = sec.getAttribute && sec.getAttribute('aria-label');
                  if (al) return al.trim().slice(0, 60);
                  const cell = sec.querySelector && sec.querySelector('th, td, [role="rowheader"]');
                  if (cell && cell.textContent.trim()) return cell.textContent.trim().replace(/s+/g, ' ').slice(0, 60);
                }
                return null;
              };
              const myName = nm(el);
              const peers = [...document.querySelectorAll(el.tagName)].filter(p => nm(p) === myName);
              window.__bmcpRefMeta[key] = { tag: el.tagName, type: (el.type || '').toLowerCase(), name: myName, idx: Math.max(0, peers.indexOf(el)), anchor: anchorOf(el), peer_count: peers.length };
            } catch {}
            return key;
          };
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            if (el.closest('[aria-hidden="true"]')) return false;
            return true;
          };
          const accName = (el) => {
            const aria = el.getAttribute && el.getAttribute('aria-label');
            if (aria) return aria.trim();
            const lbl = el.getAttribute && el.getAttribute('aria-labelledby');
            if (lbl) {
              const t = lbl.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
              if (t) return t;
            }
            if (el.labels && el.labels[0]) { const t = el.labels[0].textContent.trim(); if (t) return t; }
            if (el.placeholder) return el.placeholder.trim();
            if (el.alt) return el.alt.trim();
            if (el.title) return el.title.trim();
            const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
            if (t) return t.slice(0, 80);
            if (el.value && (el.type || '') !== 'password') return String(el.value).slice(0, 40);
            return '';
          };
          const roleOf = (el) => {
            const r = el.getAttribute && el.getAttribute('role');
            if (r) return r;
            const tag = el.tagName.toLowerCase();
            if (tag === 'a') return el.href ? 'link' : 'a';
            if (tag === 'button' || tag === 'summary') return 'button';
            if (tag === 'select') return 'combobox';
            if (tag === 'textarea') return 'textbox';
            if (tag === 'input') {
              const t = (el.type || 'text').toLowerCase();
              return { checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', range: 'slider', file: 'file-input', date: 'date-input', search: 'searchbox' }[t] || 'textbox';
            }
            if (/^h[1-6]$/.test(tag)) return 'heading-' + tag[1];
            if (el.isContentEditable) return 'textbox';
            return tag;
          };
          const stateOf = (el) => {
            const bits = [];
            const tag = el.tagName.toLowerCase();
            if (tag === 'input' || tag === 'textarea') {
              const t = (el.type || 'text').toLowerCase();
              if (t === 'password') bits.push(el.value ? 'value=[redacted]' : 'empty');
              else if (t === 'checkbox' || t === 'radio') bits.push(el.checked ? 'checked' : 'unchecked');
              else { bits.push('type=' + t); if (el.value) bits.push('value=' + JSON.stringify(String(el.value).slice(0, 40))); }
            }
            if (tag === 'select') {
              const sel = el.selectedOptions[0];
              bits.push('selected=' + JSON.stringify(sel ? sel.text.slice(0, 40) : ''));
              bits.push(el.options.length + ' options');
            }
            if (tag === 'a' && el.href) bits.push('href=' + JSON.stringify(el.href.slice(0, 70)));
            if (el.disabled) bits.push('disabled');
            if (el.getAttribute('aria-expanded')) bits.push('expanded=' + el.getAttribute('aria-expanded'));
            return bits.length ? ' ' + bits.join(' ') : '';
          };
          const INTERACTIVE = 'a[href], button, input, select, textarea, summary, audio[controls], video[controls], ' +
            '[role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="option"], [role="checkbox"], ' +
            '[role="radio"], [role="switch"], [role="combobox"], [role="searchbox"], [role="textbox"], [role="slider"], ' +
            '[onclick], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
          const wanted = filter === 'all' ? INTERACTIVE + ', h1, h2, h3, h4, h5, h6, img[alt], [role="heading"]' : INTERACTIVE;
          const collect = (root, out) => {
            for (const el of root.querySelectorAll(wanted)) out.push(el);
            for (const el of root.querySelectorAll('*')) if (el.shadowRoot) collect(el.shadowRoot, out);
            return out;
          };
          const all = [...new Set(collect(document, []))];
          const lines = [];
          let hidden = 0;
          for (const el of all) {
            if (!visible(el)) { hidden++; continue; }
            const role = roleOf(el);
            const name = accName(el);
            if (/^h[1-6]$/.test(el.tagName.toLowerCase()) || role.startsWith('heading')) {
              lines.push(`\n## ${name}`);
              continue;
            }
            lines.push(`${role} ${JSON.stringify(name)}${stateOf(el)} [${assignRef(el)}]`);
          }
          let text = lines.join('\n');
          let truncated = false;
          if (text.length > maxChars) { text = text.slice(0, text.lastIndexOf('\n', maxChars)); truncated = true; }
          return {
            outline: text,
            elements: lines.length,
            hidden_skipped: hidden,
            truncated,
            viewport: { w: innerWidth, h: innerHeight, scrollY: Math.round(scrollY), pageHeight: document.documentElement.scrollHeight },
          };
        },
      });
      const r = res?.result;
      if (!r) throw new Error('read_page injection returned nothing (page may still be loading)');
      return { ...r, url: tab.url, title: tab.title, hint: 'Use refs directly as selectors: browser_click({selector:"ref_12"}), browser_fill({selector:"ref_7", value:"..."}). Refs reset on navigation.' };
    }

    case 'form_state': {
      // Born from a real 10-hour college-portal session: of 628 execute_script
      // calls, ~200 were hand-written DOM scrapes for things no tool exposed —
      // 82 just to list a <select>'s options, 42 for submit-button enabled state,
      // 21 for filled-vs-empty, 20 for validation errors. This returns all of it
      // in ONE call, with refs that click/fill accept directly.
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot read chrome:// pages');
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        args: [params.selector || null, Math.min(60, params.max_options || 25)],
        func: (rootSel, maxOpts) => {
          if (!window.__bmcpRefEls) { window.__bmcpRefEls = {}; window.__bmcpRefSeq = 0; }
          const refs = window.__bmcpRefEls;
          const ref = (el) => {
            if (el.__bmcpRef && refs[el.__bmcpRef] === el) return el.__bmcpRef;
            const k = 'ref_' + (++window.__bmcpRefSeq);
            try { Object.defineProperty(el, '__bmcpRef', { value: k, configurable: true }); } catch {}
            refs[k] = el;
            try {
              if (!window.__bmcpRefMeta) window.__bmcpRefMeta = {};
              const nm = (e) => {
                const a = e.getAttribute && e.getAttribute('aria-label');
                if (a) return a.trim();
                if (e.labels && e.labels[0]) return e.labels[0].textContent.trim().replace(/\s+/g, ' ');
                if (e.placeholder) return e.placeholder.trim();
                const t = (e.textContent || '').trim().replace(/\s+/g, ' ');
                return t ? t.slice(0, 80) : (e.name || e.id || '');
              };
              // Anchor to the nearest labelled container. Position among identical
              // peers is not identity: inserting a row above shifts every index, and
              // re-identifying by index alone lands confidently on the wrong record.
              const anchorOf = (e) => {
                const fs = e.closest && e.closest('fieldset');
                if (fs) { const lg = fs.querySelector('legend'); if (lg && lg.textContent.trim()) return lg.textContent.trim().replace(/s+/g, ' ').slice(0, 60); }
                const sec = e.closest && e.closest('[aria-label], [role="row"], tr, [role="group"], section, li');
                if (sec) {
                  const al = sec.getAttribute && sec.getAttribute('aria-label');
                  if (al) return al.trim().slice(0, 60);
                  const cell = sec.querySelector && sec.querySelector('th, td, [role="rowheader"]');
                  if (cell && cell.textContent.trim()) return cell.textContent.trim().replace(/s+/g, ' ').slice(0, 60);
                }
                return null;
              };
              const myName = nm(el);
              const peers = [...document.querySelectorAll(el.tagName)].filter(p => nm(p) === myName);
              window.__bmcpRefMeta[k] = { tag: el.tagName, type: (el.type || '').toLowerCase(), name: myName, idx: Math.max(0, peers.indexOf(el)), anchor: anchorOf(el), peer_count: peers.length };
            } catch {}
            return k;
          };
          const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const label = (el) => {
            const a = el.getAttribute('aria-label'); if (a) return a.trim();
            const lb = el.getAttribute('aria-labelledby');
            if (lb) { const t = lb.split(/\s+/).map(i => document.getElementById(i)?.textContent || '').join(' ').trim(); if (t) return t; }
            if (el.labels && el.labels[0]) return el.labels[0].textContent.trim().replace(/\s+/g, ' ');
            if (el.placeholder) return el.placeholder.trim();
            const wrap = el.closest('label'); if (wrap) return wrap.textContent.trim().replace(/\s+/g, ' ').slice(0, 60);
            return el.name || el.id || '';
          };
          const root = rootSel ? document.querySelector(rootSel) : document;
          if (!root) return { error: 'root selector not found: ' + rootSel };
          const controls = [...root.querySelectorAll('input, select, textarea, [contenteditable="true"]')]
            .filter(el => el.type !== 'hidden' && vis(el));
          const fields = [];
          let filled = 0, empty = 0, missingRequired = 0;
          for (const el of controls) {
            const type = (el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : (el.type || 'text')).toLowerCase();
            if (type === 'submit' || type === 'button' || type === 'reset') continue;
            const f = { ref: ref(el), label: label(el).slice(0, 70), type };
            if (el.name) f.name = el.name;
            const req = el.required || el.getAttribute('aria-required') === 'true';
            if (req) f.required = true;
            if (el.disabled) f.disabled = true;
            if (el.readOnly) f.readonly = true;
            let hasValue;
            if (type === 'checkbox' || type === 'radio') { f.checked = el.checked; hasValue = el.checked; }
            else if (type === 'select') {
              const sel = el.selectedOptions[0];
              f.selected = sel ? sel.text.trim().slice(0, 50) : '';
              hasValue = !!(el.value && el.value !== '' && !/^(please select|select|choose|--)/i.test(f.selected));
              // THE big one: the actual options, so no scrape is needed to pick one
              f.options = [...el.options].slice(0, maxOpts).map(o => o.text.trim().slice(0, 45)).filter(Boolean);
              if (el.options.length > maxOpts) f.options_truncated = el.options.length;
            } else if (type === 'password') { f.value = el.value ? `[${el.value.length} chars]` : ''; hasValue = !!el.value; }
            else if (type === 'file') { f.files = [...(el.files || [])].map(x => x.name); hasValue = f.files.length > 0; }
            else { const v = ('value' in el ? el.value : el.textContent) || ''; f.value = String(v).slice(0, 80); hasValue = !!String(v).trim(); }
            if (hasValue) filled++; else { empty++; if (req) { missingRequired++; f.MISSING_REQUIRED = true; } }
            const invalid = el.getAttribute('aria-invalid') === 'true' ||
              (el.willValidate && !el.checkValidity && false) ||
              (typeof el.checkValidity === 'function' && !el.checkValidity());
            if (invalid) {
              f.invalid = true;
              if (el.validationMessage) f.validation_message = el.validationMessage.slice(0, 90);
              const d = el.getAttribute('aria-describedby');
              if (d) { const t = d.split(/\s+/).map(i => document.getElementById(i)?.textContent || '').join(' ').trim(); if (t) f.error_text = t.slice(0, 90); }
            }
            fields.push(f);
          }
          // Submit / action buttons with their enabled state
          const buttons = [...root.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')]
            .filter(vis).slice(0, 25).map(el => ({
              ref: ref(el),
              text: (el.textContent || el.value || label(el)).trim().replace(/\s+/g, ' ').slice(0, 45),
              disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
              type: (el.type || 'button').toLowerCase(),
            })).filter(b => b.text);
          // Page-level errors and step/progress indicators
          const errors = [...document.querySelectorAll('[role="alert"], .error, .invalid-feedback, [class*="error" i]:not(input):not(select):not(textarea)')]
            .filter(vis).map(e => (e.textContent || '').trim().replace(/\s+/g, ' ')).filter(t => t && t.length < 200);
          const steps = [...document.querySelectorAll('[aria-current], .active[class*="step" i], [class*="step" i][class*="current" i], nav [aria-selected="true"]')]
            .filter(vis).map(e => (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)).filter(Boolean);
          return {
            fields, buttons,
            page_errors: [...new Set(errors)].slice(0, 10),
            current_step: [...new Set(steps)].slice(0, 5),
            summary: { total: fields.length, filled, empty, missing_required: missingRequired },
          };
        },
      });
      const r = res?.result;
      if (!r) throw new Error('form_state injection returned nothing (page may still be loading)');
      if (r.error) return { ok: false, error: r.error };
      return {
        ok: true, ...r, url: tab.url, title: tab.title,
        hint: 'Every field/button carries a ref usable directly: browser_fill({selector:"ref_7", value:"..."}), browser_select_option on a select ref. MISSING_REQUIRED marks required fields still empty.',
      };
    }

    case 'find': {
      const tab = await getSessionTab(port);
      if (tab.url.startsWith('chrome://')) throw new Error('Cannot search chrome:// pages');
      if (!params.query || !String(params.query).trim()) return { ok: false, error: 'query required' };
      const maxResults = Math.min(20, params.max_results || 10);
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        args: [String(params.query), maxResults],
        func: (query, maxResults) => {
          if (!window.__bmcpRefEls) { window.__bmcpRefEls = {}; window.__bmcpRefSeq = 0; }
          const refs = window.__bmcpRefEls;
          const assignRef = (el) => {
            if (el.__bmcpRef && refs[el.__bmcpRef] === el) return el.__bmcpRef;
            const key = 'ref_' + (++window.__bmcpRefSeq);
            try { Object.defineProperty(el, '__bmcpRef', { value: key, configurable: true }); } catch {}
            refs[key] = el;
            // Fingerprint so the ref can be re-identified if the framework swaps the node.
            try {
              if (!window.__bmcpRefMeta) window.__bmcpRefMeta = {};
              const nm = (e) => {
                const a = e.getAttribute && e.getAttribute('aria-label');
                if (a) return a.trim();
                if (e.labels && e.labels[0]) return e.labels[0].textContent.trim().replace(/\s+/g, ' ');
                if (e.placeholder) return e.placeholder.trim();
                const t = (e.textContent || '').trim().replace(/\s+/g, ' ');
                return t ? t.slice(0, 80) : (e.name || e.id || '');
              };
              // Anchor to the nearest labelled container. Position among identical
              // peers is not identity: inserting a row above shifts every index, and
              // re-identifying by index alone lands confidently on the wrong record.
              const anchorOf = (e) => {
                const fs = e.closest && e.closest('fieldset');
                if (fs) { const lg = fs.querySelector('legend'); if (lg && lg.textContent.trim()) return lg.textContent.trim().replace(/s+/g, ' ').slice(0, 60); }
                const sec = e.closest && e.closest('[aria-label], [role="row"], tr, [role="group"], section, li');
                if (sec) {
                  const al = sec.getAttribute && sec.getAttribute('aria-label');
                  if (al) return al.trim().slice(0, 60);
                  const cell = sec.querySelector && sec.querySelector('th, td, [role="rowheader"]');
                  if (cell && cell.textContent.trim()) return cell.textContent.trim().replace(/s+/g, ' ').slice(0, 60);
                }
                return null;
              };
              const myName = nm(el);
              const peers = [...document.querySelectorAll(el.tagName)].filter(p => nm(p) === myName);
              window.__bmcpRefMeta[key] = { tag: el.tagName, type: (el.type || '').toLowerCase(), name: myName, idx: Math.max(0, peers.indexOf(el)), anchor: anchorOf(el), peer_count: peers.length };
            } catch {}
            return key;
          };
          const accName = (el) => {
            const parts = [
              el.getAttribute && el.getAttribute('aria-label'),
              el.labels && el.labels[0] && el.labels[0].textContent,
              el.placeholder, el.alt, el.title,
              (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
            ];
            return (parts.find(p => p && String(p).trim()) || '').toString().trim();
          };
          const ROLE_HINTS = {
            button: ['button', '[role="button"]', 'input[type="submit"]', 'input[type="button"]'],
            link: ['a[href]', '[role="link"]'],
            input: ['input', 'textarea', '[contenteditable="true"]', 'select'],
            field: ['input', 'textarea', 'select'],
            textbox: ['input', 'textarea'],
            search: ['input[type="search"]', '[role="searchbox"]', 'input[placeholder*="search" i]', 'input[aria-label*="search" i]'],
            checkbox: ['input[type="checkbox"]', '[role="checkbox"]'],
            radio: ['input[type="radio"]', '[role="radio"]'],
            dropdown: ['select', '[role="combobox"]', '[aria-haspopup="listbox"]'],
            select: ['select', '[role="combobox"]'],
            tab: ['[role="tab"]'],
            menu: ['[role="menu"]', '[role="menuitem"]'],
            image: ['img'],
            heading: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', '[role="heading"]'],
            upload: ['input[type="file"]'],
            date: ['input[type="date"]', 'input[placeholder*="date" i]'],
          };
          // Intent synonyms: a query says what the user WANTS, the page says what
          // the designer CALLED it. "submit" must reach a button labelled
          // "Continue", "login" must reach "Sign in". Claude-in-Chrome solves this
          // by shipping the whole a11y tree to an LLM and asking; matching the
          // vocabulary locally gets most of that benefit with no round-trip.
          const SYN = {
            submit: ['submit', 'continue', 'next', 'save', 'send', 'confirm', 'apply', 'proceed', 'done', 'finish'],
            login: ['login', 'log in', 'sign in', 'signin', 'continue'],
            logout: ['logout', 'log out', 'sign out', 'signout'],
            search: ['search', 'find', 'query', 'lookup'],
            email: ['email', 'e-mail', 'mail', 'username', 'user name'],
            password: ['password', 'passcode', 'pwd'],
            cancel: ['cancel', 'close', 'dismiss', 'back', 'discard'],
            upload: ['upload', 'attach', 'choose file', 'browse', 'add file'],
            delete: ['delete', 'remove', 'trash', 'discard'],
            edit: ['edit', 'change', 'modify', 'update'],
            phone: ['phone', 'telephone', 'mobile', 'tel', 'contact number'],
            address: ['address', 'street', 'city', 'postal', 'zip'],
            accept: ['accept', 'agree', 'ok', 'yes', 'allow', 'consent'],
          };
          const qLower = query.toLowerCase().trim();
          let tokens = qLower.split(/\s+/).filter(t => t.length > 1);
          // Expand each token with its synonym family (a match on any counts)
          const expand = (t) => {
            for (const fam of Object.values(SYN)) if (fam.includes(t)) return fam;
            return [t];
          };
          // Cheap typo tolerance: <=1 edit INCLUDING transposition. Transpositions
          // ("passwrod", "feild") are the most common real typo, and a plain
          // Levenshtein walk scores them as 2 edits and rejects them — which is
          // exactly what happened the first time this shipped.
          const near = (a, b) => {
            if (Math.abs(a.length - b.length) > 1 || a[0] !== b[0] || a.length < 4) return false;
            let i = 0, j = 0, diff = 0;
            while (i < a.length && j < b.length) {
              if (a[i] === b[j]) { i++; j++; continue; }
              if (++diff > 1) return false;
              if (a.length === b.length) {
                if (a[i + 1] === b[j] && a[i] === b[j + 1]) { i += 2; j += 2; continue; } // swap
                i++; j++;
              } else if (a.length > b.length) i++;
              else j++;
            }
            return true;
          };
          const hintSelectors = [];
          tokens = tokens.filter(t => {
            const hint = ROLE_HINTS[t.replace(/s$/, '')] || ROLE_HINTS[t];
            if (hint) { hintSelectors.push(...hint); return false; }
            return true;
          });
          const textQuery = tokens.join(' ');
          const CANDIDATES = 'a[href], button, input, select, textarea, summary, label, img[alt], ' +
            'h1, h2, h3, h4, h5, h6, [role], [onclick], [contenteditable="true"], [aria-label], [tabindex]:not([tabindex="-1"])';
          const collect = (root, out) => {
            for (const el of root.querySelectorAll(CANDIDATES)) out.push(el);
            for (const el of root.querySelectorAll('*')) if (el.shadowRoot) collect(el.shadowRoot, out);
            return out;
          };
          const all = [...new Set(collect(document, []))];
          const scored = [];
          for (const el of all) {
            const r = el.getBoundingClientRect();
            const isVisible = r.width > 0 && r.height > 0;
            const name = accName(el).toLowerCase();
            let score = 0;
            const reasons = [];
            if (hintSelectors.length) {
              if (hintSelectors.some(s => { try { return el.matches(s); } catch { return false; } })) { score += 30; reasons.push('role-match'); }
              else if (!textQuery) continue;
            }
            if (textQuery && name) {
              if (name === textQuery) { score += 100; reasons.push('exact'); }
              else if (name.startsWith(textQuery)) { score += 60; reasons.push('starts-with'); }
              else if (name.includes(textQuery)) { score += 45; reasons.push('contains'); }
              else {
                let hit = 0, synHit = 0, fuzzyHit = 0;
                const nameWords = name.split(/[^a-z0-9]+/).filter(Boolean);
                for (const t of tokens) {
                  if (name.includes(t)) { hit++; continue; }
                  if (expand(t).some(s => s !== t && name.includes(s))) { synHit++; continue; }
                  if (nameWords.some(w => near(t, w))) fuzzyHit++;
                }
                const matched = hit + synHit + fuzzyHit;
                if (matched) {
                  score += Math.round((hit * 35 + synHit * 28 + fuzzyHit * 18) / tokens.length);
                  const bits = [];
                  if (hit) bits.push(`${hit} word${hit > 1 ? 's' : ''}`);
                  if (synHit) bits.push(`${synHit} synonym${synHit > 1 ? 's' : ''}`);
                  if (fuzzyHit) bits.push(`${fuzzyHit} fuzzy`);
                  reasons.push(bits.join('+'));
                }
              }
            } else if (textQuery && !name) {
              continue;
            }
            if (score <= 0) continue;
            if (isVisible) score += 10; else score -= 25;
            if (name.length > 150) score -= 15;
            scored.push({ el, score, reasons, name: accName(el), isVisible });
          }
          scored.sort((a, b) => b.score - a.score);
          // Innermost preference: drop an element whose higher-scored descendant is also matched
          const top = [];
          for (const s of scored) {
            if (top.length >= maxResults) break;
            if (top.some(t => s.el.contains(t.el))) continue;
            top.push(s);
          }
          // Enterprise wizards repeat the same label across steps and hidden panels.
          // A single confident answer there is a coin flip, so each match carries
          // the context needed to tell them apart, and near-ties are flagged.
          const context = (el) => {
            const bits = [];
            const sec = el.closest('section, form, [role="dialog"], [role="tabpanel"], fieldset, article, nav, header, footer, main, aside');
            if (sec) {
              const lbl = sec.getAttribute('aria-label') ||
                (sec.querySelector('legend, h1, h2, h3, [role="heading"]') || {}).textContent || '';
              const tag = sec.tagName.toLowerCase() + (sec.getAttribute('role') ? `[${sec.getAttribute('role')}]` : '');
              bits.push(lbl.trim() ? `in ${tag} "${lbl.trim().replace(/\s+/g, ' ').slice(0, 40)}"` : `in ${tag}`);
            }
            const r = el.getBoundingClientRect();
            const inView = r.top >= 0 && r.top < innerHeight;
            bits.push(inView ? `at y=${Math.round(r.top)}` : (r.top < 0 ? 'above viewport' : 'below viewport'));
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') bits.push('disabled');
            return bits.join(', ');
          };
          const matches = top.map(s => ({
            ref: assignRef(s.el),
            role: s.el.getAttribute('role') || s.el.tagName.toLowerCase(),
            name: s.name.slice(0, 100),
            score: s.score,
            match: s.reasons.join(','),
            visible: s.isVisible,
            where: context(s.el),
          }));
          const ambiguous = matches.length > 1 && (matches[0].score - matches[1].score) <= 10;
          return {
            total_candidates: scored.length,
            matches,
            ...(ambiguous ? {
              ambiguous: true,
              note: `Top ${matches.filter(m => m.score >= matches[0].score - 10).length} matches score within 10 points of each other. Use the where field to pick, or scope the search with browser_read_page on the right container.`,
            } : {}),
          };
        },
      });
      const r = res?.result;
      if (!r) throw new Error('find injection returned nothing (page may still be loading)');
      return { ...r, query: params.query, hint: r.matches.length ? 'Click/fill via ref: browser_click({selector:"' + r.matches[0].ref + '"})' : 'No matches — try different words, or browser_read_page for the full element outline.' };
    }

    case 'health': {
      const session = getSession(port);
      const tab = await getSessionTab(port);
      let debuggerAttachedReal = false;
      try {
        const targets = await chrome.debugger.getTargets();
        debuggerAttachedReal = !!targets.find(t => t.tabId === tab.id)?.attached;
      } catch {}
      let scriptingOk = false;
      try {
        const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => true });
        scriptingOk = r?.result === true;
      } catch {}
      return {
        ok: true,
        active_tab: { id: tab.id, url: tab.url, title: tab.title },
        session: { label: session.label, color: session.color, tabs: session.tabIds.size },
        debugger_attached: debuggerAttachedReal,
        scripting_works: scriptingOk,
        ready: scriptingOk,
        hint: !scriptingOk ? (!tab.url || tab.url.startsWith('about:') || tab.url.startsWith('chrome://')
                ? `Active tab is a blank placeholder (${tab.url || 'about:blank'}) — injection is impossible there by design, and this is NOT a fault. Navigate to a real page first.`
                : 'Scripting injection failing — tab may still be loading, or is a protected page.') :
              !debuggerAttachedReal ? 'Debugger not currently attached (attaches on demand for clicks/keys). If clicks fail with attach errors, another automation extension may be holding the debugger — disable it or use browser_reattach_debugger.' :
              'All channels operational.',
      };
    }

    case 'batch': {
      const actions = params.actions;
      if (!Array.isArray(actions) || !actions.length) {
        return { ok: false, error: 'actions array required: [{name:"navigate", params:{url:"..."}}, ...]' };
      }
      if (actions.length > 25) return { ok: false, error: 'Max 25 actions per batch' };
      const results = [];
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i] || {};
        const m = String(a.name || a.method || '').replace(/^browser_/, '');
        const p = a.params || a.input || {};
        if (!m) { results.push({ index: i, ok: false, error: 'missing action name' }); break; }
        if (m === 'batch') { results.push({ index: i, ok: false, error: 'batch cannot be nested' }); break; }
        if (m === 'ask_user' || m === 'solve_captcha') { results.push({ index: i, ok: false, error: m + ' not allowed inside batch (needs interactive timeout) — call it standalone' }); break; }
        try {
          const r = await dispatch(port, m, p);
          // found:false (wait) counts as failure: a chain that waited for something
          // that never appeared must not keep acting on the wrong page state.
          const failed = r && typeof r === 'object' && (r.ok === false || r.__error || r.error || r.found === false);
          results.push({ index: i, action: m, ok: !failed, result: r });
          if (failed) {
            results.push({ index: i + 1, note: `stopped: action ${i} (${m}) failed — ${results[i].result?.error || 'see result'}; ${actions.length - i - 1} action(s) skipped` });
            break;
          }
        } catch (e) {
          results.push({ index: i, action: m, ok: false, error: e?.message || String(e) });
          break;
        }
      }
      const completed = results.filter(r => r.ok).length;
      return { ok: completed === actions.length, completed, total: actions.length, results };
    }

    case 'reload_extension': {
      // MCP server signals that extension files were updated via npx
      // Reload after a short delay to allow response to be sent
      setTimeout(() => chrome.runtime.reload(), 500);
      return { ok: true, message: 'Extension reloading in 500ms' };
    }

    default:
      throw new Error('Unknown method: ' + method);
  }
}

// ── CAPTCHA Detection & Solving Helpers ─────────────────────────────────────

async function detectCaptcha(tabId) {
  try {
    await debuggerAttach(tabId);
    const { result } = await cdpSend(tabId, 'Runtime.evaluate', {
      expression: `(() => {
        const res = { found: false, types: [] };

        // reCAPTCHA v2 — checkbox iframe
        const recaptchaAnchor = document.querySelector('iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]');
        if (recaptchaAnchor) {
          res.found = true;
          res.types.push('recaptcha_v2_checkbox');
          const container = document.querySelector('.g-recaptcha');
          if (container) res.sitekey = container.getAttribute('data-sitekey');
        }

        // reCAPTCHA v2 — image challenge iframe
        const recaptchaChallenge = document.querySelector('iframe[src*="recaptcha/api2/bframe"], iframe[src*="recaptcha/enterprise/bframe"]');
        if (recaptchaChallenge) {
          res.found = true;
          if (!res.types.includes('recaptcha_v2_checkbox')) res.types.push('recaptcha_v2_image');
          res.types.push('recaptcha_v2_challenge_visible');
          // Get iframe dimensions for grid clicking
          const rect = recaptchaChallenge.getBoundingClientRect();
          res.challengeFrame = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }

        // reCAPTCHA v3 — invisible badge
        const recaptchaV3 = document.querySelector('.grecaptcha-badge');
        if (recaptchaV3 && !recaptchaAnchor) {
          res.found = true;
          res.types.push('recaptcha_v3_invisible');
          res.note = 'reCAPTCHA v3 is invisible and score-based. Real Chrome with Google login usually passes automatically. No action needed.';
        }

        // hCaptcha
        const hcaptcha = document.querySelector('iframe[src*="hcaptcha.com"], .h-captcha');
        if (hcaptcha) {
          res.found = true;
          res.types.push('hcaptcha');
          const container = document.querySelector('.h-captcha');
          if (container) res.sitekey = container.getAttribute('data-sitekey');
        }

        // Cloudflare Turnstile
        const turnstile = document.querySelector('iframe[src*="challenges.cloudflare.com"], .cf-turnstile');
        if (turnstile) {
          res.found = true;
          res.types.push('cloudflare_turnstile');
          const container = document.querySelector('.cf-turnstile');
          if (container) res.sitekey = container.getAttribute('data-sitekey');
        }

        // Cloudflare challenge page (5-second interstitial)
        if (document.title.includes('Just a moment') || document.querySelector('#challenge-running')) {
          res.found = true;
          res.types.push('cloudflare_challenge_page');
          res.note = 'Cloudflare challenge page. Wait 5-10 seconds — real Chrome usually passes automatically.';
        }

        // FunCaptcha / Arkose Labs
        const funcaptcha = document.querySelector('#FunCaptcha, iframe[src*="funcaptcha"], iframe[src*="arkoselabs"]');
        if (funcaptcha) {
          res.found = true;
          res.types.push('funcaptcha');
        }

        if (!res.found) res.note = 'No CAPTCHA detected on this page.';
        res.pageUrl = window.location.href;
        return JSON.stringify(res);
      })()`,
      returnByValue: true,
    });
    await debuggerDetach(tabId);
    return JSON.parse(result.value);
  } catch (e) {
    try { await debuggerDetach(tabId); } catch {}
    return { found: false, error: e.message };
  }
}



// ── Start ───────────────────────────────────────────────────────────────────
ensureOffscreen().catch(console.error);

chrome.runtime.onStartup.addListener(() => ensureOffscreen().catch(console.error));
chrome.runtime.onInstalled.addListener(() => ensureOffscreen().catch(console.error));

chrome.alarms.create('ensure-offscreen', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'ensure-offscreen') {
    ensureOffscreen().catch(console.error);
  }
});
