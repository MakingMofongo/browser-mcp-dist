/**
 * Offscreen Document — Persistent WebSocket bridge (multi-session)
 *
 * Scans port range 9876-9885 and maintains connections to ALL active
 * MCP servers. Each Claude Code session gets its own port automatically.
 * Passes port ID with every command so background.js can track tab ownership.
 *
 * Flow: MCP Server(s) ←(WS)→ this ←(chrome.runtime.sendMessage)→ Service Worker → Chrome APIs
 */

const BASE_PORT = 9876;
const MAX_PORT = 9895;
const connections = new Map(); // port → WebSocket

/**
 * Send, and say whether it went.
 *
 * try/catch around ws.send() does not do what it looks like it does. Sending on a
 * CLOSING or CLOSED socket does not throw — the data is discarded and Chrome logs
 * "WebSocket is already in CLOSING or CLOSED state" from inside its own
 * implementation, where no catch can reach it. Only CONNECTING throws. So every
 * guarded send in this file was catching the one case that cannot happen while
 * quietly dropping the one that does.
 *
 * For a ping that hardly matters. For a command result it matters a great deal: the
 * reply disappears, the server hears nothing, and the caller waits out its full
 * timeout for an answer that was already computed and thrown away.
 */
function socketState(ws) {
  if (!ws) return 'missing';
  return ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][ws.readyState] || String(ws.readyState);
}

function sendJson(ws, obj, what) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn(`[Offscreen] dropped ${what}: socket is ${socketState(ws)}`);
    return false;
  }
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch (e) {
    console.warn(`[Offscreen] could not send ${what}: ${e?.message || e}`);
    return false;
  }
}

// Stable identity for this browser installation. IMPORTANT: offscreen documents
// can only use chrome.runtime APIs — chrome.storage is NOT available here, so the
// persisted id/label come from the service worker via message. Everything has a
// fallback: hello must ALWAYS be sent, even if identity lookup fails.
let instanceCache = null;
async function getInstanceInfo() {
  if (instanceCache) return instanceCache;
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || 'unknown';
  const chromeVer = (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || '?';
  let id = null, label = null;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'bmcp_get_instance' });
    if (r) { id = r.id; label = r.label; }
  } catch {}
  instanceCache = {
    id: id || 'ephemeral-' + Math.random().toString(36).slice(2, 10),
    label: label || `Chrome on ${platform}`,
    platform,
    chrome_version: chromeVer,
  };
  return instanceCache;
}

// A socket in readyState OPEN is not a socket that works. When the far end goes
// away without a clean close — the machine sleeps, the network stack drops the
// connection, a process is killed in a way that sends no FIN — the browser never
// sees a close event and the socket stays OPEN indefinitely. scanPorts then skips
// it every two seconds for ever, the extension believes it is connected, the
// server sees nothing, and every command times out with nothing recovering. That
// is what four and a half hours of silence looks like from the inside.
//
// So each connection is asked to prove it. A ping goes out on a timer and the
// server answers; a connection that has stopped answering is closed, which lets
// the scan below replace it.
//
// The safety property that matters: a connection is only ever killed for silence
// once it has answered at least one ping. A server too old to know the message
// never answers, is never judged, and behaves exactly as it does today. This can
// close a connection it has proven dead, and no other kind.
const HEARTBEAT_MS = 15000;
const UNANSWERED_LIMIT = 3;
const health = new Map(); // port → { unanswered, everPonged }

function noteAlive(port) {
  const h = health.get(port) || {};
  h.unanswered = 0;
  health.set(port, h);
}

// Counts unanswered pings rather than measuring elapsed time, and the difference
// is not academic. This document is permanently hidden, and Chrome throttles
// timers in hidden documents — as far down as once a minute. A rule like "closed
// if nothing has arrived for fifty seconds" then fires on every healthy
// connection the moment the interval slips past fifty, because the gap it is
// measuring is its own. It would have disconnected everything, once a minute,
// for ever: precisely the fault it was written to cure.
//
// A count cannot slip. Three pings sent with nothing coming back means nothing is
// there, whether they went out over forty-five seconds or three minutes.
function heartbeat() {
  for (const [port, ws] of connections) {
    if (!ws || ws.readyState !== WebSocket.OPEN) continue;
    const h = health.get(port) || {};
    if (self.bmcpHeartbeatPolicy.shouldDrop(h)) {
      console.warn(`[Offscreen] port ${port} ignored ${h.unanswered} pings; closing so it can be replaced`);
      try { ws.close(); } catch {}
      connections.delete(port);
      health.delete(port);
      continue;
    }
    try {
      if (!sendJson(ws, { type: 'ping' }, 'heartbeat ping')) continue;
      h.unanswered = (h.unanswered || 0) + 1;
      health.set(port, h);
    } catch {}
  }
}

// How many scans to skip before retrying a port that refused. Ports with no server
// are the common case — the range is 20 wide and a machine usually runs a handful of
// sessions — so retrying every one of them on every scan meant opening around
// fourteen doomed sockets every couple of seconds, for ever.
//
// Each one allocates a WebSocket, arms a timeout, fails, and logs. That is a
// constant load on a document Chrome is already throttling for being hidden, and it
// is the same document the watchdog then judges for being slow to answer a ping. The
// scan was making the page look dead and getting it replaced, which dropped every
// session's connection at once.
//
// A port that refused a moment ago is very unlikely to have a server a moment later,
// so back off: retry a quiet port roughly every half minute instead of constantly. A
// new server is still found well inside the time it takes anyone to notice.
// Backoff is measured in TIME, never in scans.
//
// Counting scans was wrong the moment the scan interval was not what it says on the
// tin. This document is hidden, Chrome throttles hidden documents, and a "15 scan"
// wait at one scan a minute is a quarter of an hour — so a session whose server
// started inside a backed-off window sat disconnected while the extension served
// every other port perfectly. The popup said four connected and one session said the
// bridge was down, and both were telling the truth.
//
// A wall-clock deadline cannot be stretched by throttling. Ten seconds at most for a
// port that has never answered, which is cheap enough to be invisible and short
// enough that nobody waits for a new session.
const MAX_RETRY_MS = 10_000;
const nextAttempt = new Map();        // port → earliest time to try again

function scanPorts() {
  const now = Date.now();
  for (let port = BASE_PORT; port <= MAX_PORT; port++) {
    const existing = connections.get(port);
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      nextAttempt.delete(port);
      continue;
    }
    if ((nextAttempt.get(port) || 0) > now) continue;
    tryConnect(port);
  }
}

function noteConnectFailed(port) {
  nextAttempt.set(port, Date.now() + MAX_RETRY_MS);
}

function noteConnectSucceeded(port) {
  nextAttempt.delete(port);
}

function tryConnect(port) {
  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch {
    return;
  }

  const connectTimeout = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) ws.close();
  }, 2000);

  ws.onopen = () => {
    clearTimeout(connectTimeout);
    connections.set(port, ws);
    noteAlive(port);
    noteConnectSucceeded(port);
    console.log(`[Offscreen] Connected to MCP server on port ${port} (${connections.size} total)`);
    // v2.0 hello handshake, two-phase so it can NEVER be skipped:
    // 1) immediate hello with synchronously available data (the server merges
    //    repeated hellos, so a partial one is never wrong, only incomplete);
    // 2) upgraded hello once the persisted identity arrives from the SW.
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || 'unknown';
    const chromeVer = (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || '?';
    sendJson(ws, { type: 'hello', instance: { id: 'pending', label: `Chrome on ${platform}`, platform, chrome_version: chromeVer } }, 'opening hello');
    getInstanceInfo()
      .then(instance => { sendJson(ws, { type: 'hello', instance }, 'identity hello'); })
      .catch(() => {});
    updateStatus();
  };

  ws.onmessage = async (event) => {
    let cmd;
    try { cmd = JSON.parse(event.data); } catch { return; }
    // Anything arriving proves the connection carries data, which is the only
    // evidence that counts. A pong additionally proves the server understands the
    // heartbeat, which is what makes it fair to judge this connection on silence.
    noteAlive(port);
    if (cmd.type === 'pong') {
      const h = health.get(port) || {};
      h.everPonged = true;
      h.unanswered = 0;
      health.set(port, h);
      return;
    }
    // The server checks this end the same way this end checks the server. Not
    // answering would have it hang up on a connection that was working perfectly.
    if (cmd.type === 'ping') {
      sendJson(ws, { type: 'pong' }, 'pong');
      return;
    }
    const { id, method, params } = cmd;

    try {
      // Include port so background.js knows which session owns this command
      const result = await chrome.runtime.sendMessage({
        type: 'mcp_command',
        port,
        method,
        params: params || {},
      });

      if (result && result.__error) {
        sendJson(ws, { id, error: result.__error }, `error reply for command ${id}`);
      } else {
        sendJson(ws, { id, result }, `result for command ${id}`);
      }
    } catch (err) {
      sendJson(ws, { id, error: err.message || String(err) }, `error reply for command ${id}`);
    }
  };

  ws.onclose = () => {
    clearTimeout(connectTimeout);
    // Closed without ever having opened: there is no server on this port, so back
    // off before trying it again.
    if (connections.get(port) !== ws) noteConnectFailed(port);
    if (connections.get(port) === ws) {
      connections.delete(port);
      health.delete(port);
      console.log(`[Offscreen] Disconnected from port ${port} (${connections.size} remaining)`);
      updateStatus();
      // Notify background to release tabs for this session
      chrome.runtime.sendMessage({ type: 'session_disconnect', port }).catch(() => {});
    }
  };

  ws.onerror = () => {
    clearTimeout(connectTimeout);
    ws.close();
  };
}

function updateStatus() {
  const count = connections.size;
  chrome.runtime.sendMessage({
    type: 'ws_status',
    connected: count > 0,
    count,
    ports: [...connections.keys()],
  }).catch(() => {});
}

// Answers the watchdog. A document whose script has died stops replying, which is
// the difference between existing and working — and the only way the service
// worker can tell that it needs replacing rather than left alone.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'bmcp_offscreen_ping') return;
  sendResponse({ alive: true, ports: [...connections.keys()] });
  return true;
});

// Read a local file on the service worker's behalf.
//
// An MV3 service worker cannot fetch a file:// URL at all, even when the extension
// has been granted access to file URLs — the scheme is simply unavailable there. An
// offscreen document is an ordinary extension page, where the grant does apply, so
// the read happens here and the bytes go back as base64.
//
// This exists so a file can be attached to an upload field when the Chrome debugger
// is held by another client, which is the usual state on a machine running more than
// one automation extension.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'bmcp_read_file' || typeof msg.url !== 'string') return;
  (async () => {
    try {
      // XMLHttpRequest, not fetch. The Fetch API does not support the file: scheme in
      // any Chrome context and rejects with a bare "Failed to fetch", which reads as a
      // permissions problem and is not one — file access was granted and it still
      // failed. XHR does support it, given that grant.
      const buf = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', msg.url, true);
        xhr.responseType = 'arraybuffer';
        xhr.onload = () => (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300))
          ? resolve(xhr.response)
          : reject(new Error(`HTTP ${xhr.status}`));
        xhr.onerror = () => reject(new Error('could not be read — check that "Allow access to file URLs" is on for this extension'));
        xhr.send();
      });
      const bytes = new Uint8Array(buf);
      // Chunked: String.fromCharCode over a whole multi-megabyte file overflows the
      // argument stack, which would fail on exactly the large documents this is for.
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      sendResponse({ ok: true, b64: btoa(binary), bytes: bytes.length });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true; // keeps the channel open for the async reply
});

// Listen for terminate signals from background.js (sent when last tab in a session closes)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'terminate_mcp_session' || typeof msg.port !== 'number') return;
  const ws = connections.get(msg.port);
  if (!ws) return;
  try {
    if (ws.readyState === WebSocket.OPEN) {
      sendJson(ws, { type: 'terminate' }, 'terminate notice');
    }
  } catch {}
  try { ws.close(); } catch {}
  // ws.onclose handler removes from connections + notifies background
});

// Initial scan + frequent rescan for new servers
scanPorts();
setInterval(scanPorts, 2000);
setInterval(heartbeat, HEARTBEAT_MS);
