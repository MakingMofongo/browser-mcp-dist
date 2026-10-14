// Names this browser for the bridge: opened as the first page of a Chrome that a
// desktop launcher starts (chrome-extension://<id>/label.html?label=desktop%20:11).
//
// The label rides in the hello every MCP server receives, and a session working on
// that desktop routes its commands to the browser whose label names it. Without it,
// every Chrome on the box introduces itself as "Chrome on Linux" and a session has no
// way to tell the one on its own desktop from the others.
(async () => {
  const out = document.getElementById('out');
  const label = new URLSearchParams(location.search).get('label');
  if (!label || label.length > 80) { out.textContent = 'No label given.'; return; }
  await chrome.storage.local.set({ bmcpLabel: label });
  // The hello is sent when a socket opens, so open them again: replacing the
  // offscreen document reconnects every server with the new name.
  await chrome.runtime.sendMessage({ type: 'reconnect' }).catch(() => {});
  out.textContent = `This browser is now "${label}" to Browser MCP.`;
  setTimeout(() => { chrome.tabs.getCurrent((t) => t && chrome.tabs.remove(t.id)); }, 1500);
})();
