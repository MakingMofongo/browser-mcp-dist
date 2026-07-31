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
      ws.send(JSON.stringify({ type: 'ping' }));
      h.unanswered = (h.unanswered || 0) + 1;
      health.set(port, h);
    } catch {}
  }
}

function scanPorts() {
  for (let port = BASE_PORT; port <= MAX_PORT; port++) {
    const existing = connections.get(port);
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      continue;
    }
    tryConnect(port);
  }
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
    console.log(`[Offscreen] Connected to MCP server on port ${port} (${connections.size} total)`);
    // v2.0 hello handshake, two-phase so it can NEVER be skipped:
    // 1) immediate hello with synchronously available data (the server merges
    //    repeated hellos, so a partial one is never wrong, only incomplete);
    // 2) upgraded hello once the persisted identity arrives from the SW.
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || 'unknown';
    const chromeVer = (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || '?';
    try {
      ws.send(JSON.stringify({ type: 'hello', instance: { id: 'pending', label: `Chrome on ${platform}`, platform, chrome_version: chromeVer } }));
    } catch {}
    getInstanceInfo()
      .then(instance => { try { ws.send(JSON.stringify({ type: 'hello', instance })); } catch {} })
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
      try { ws.send(JSON.stringify({ type: 'pong' })); } catch {}
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
        ws.send(JSON.stringify({ id, error: result.__error }));
      } else {
        ws.send(JSON.stringify({ id, result }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ id, error: err.message || String(err) }));
    }
  };

  ws.onclose = () => {
    clearTimeout(connectTimeout);
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

// Listen for terminate signals from background.js (sent when last tab in a session closes)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'terminate_mcp_session' || typeof msg.port !== 'number') return;
  const ws = connections.get(msg.port);
  if (!ws) return;
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'terminate' }));
    }
  } catch {}
  try { ws.close(); } catch {}
  // ws.onclose handler removes from connections + notifies background
});

// Initial scan + frequent rescan for new servers
scanPorts();
setInterval(scanPorts, 2000);
setInterval(heartbeat, HEARTBEAT_MS);
