/**
 * Console capture — MAIN-world content script, document_start.
 *
 * Installs the console interceptor BEFORE any page script runs, so
 * browser_console_logs sees the page's full console history (the old
 * lazy-install-on-first-read approach missed everything logged before
 * the first read — usually the errors you actually came for).
 *
 * Also captures uncaught errors and unhandled promise rejections,
 * which never pass through console.* and were previously invisible.
 */
(() => {
  // Trusted Types shim. Sites with `require-trusted-types-for 'script'` (Gmail,
  // Google Workspace, many banks) reject any string assigned to innerHTML or
  // similar sinks, so injected helper code fails with
  // "This document requires 'TrustedHTML' assignment". Registering a pass-through
  // policy up front gives page-context code a legal way to build those values.
  // Only affects code that opts in via window.__bmcpTT — page behaviour is untouched.
  try {
    if (window.trustedTypes && window.trustedTypes.createPolicy && !window.__bmcpTT) {
      window.__bmcpTT = window.trustedTypes.createPolicy('bmcp', {
        createHTML: (s) => s,
        createScript: (s) => s,
        createScriptURL: (s) => s,
      });
    }
  } catch (e) { /* policy name taken or policies locked down — callers fall back */ }

  if (window.__mcpConsoleLogs) return; // already installed (SPA soft-nav, double-inject)
  const MAX = 500;
  const logs = [];
  Object.defineProperty(window, '__mcpConsoleLogs', {
    value: logs, writable: false, enumerable: false, configurable: true,
  });

  const push = (type, text) => {
    logs.push({ type, text: String(text).slice(0, 2000), ts: Date.now() });
    if (logs.length > MAX) logs.splice(0, logs.length - MAX);
  };

  const fmt = (a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  };

  for (const type of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[type].bind(console);
    console[type] = (...args) => {
      try { push(type, args.map(fmt).join(' ')); } catch {}
      return orig(...args);
    };
  }

  window.addEventListener('error', (e) => {
    push('exception', `${e.message} (${e.filename || '?'}:${e.lineno || '?'})`);
  }, true);

  window.addEventListener('unhandledrejection', (e) => {
    push('exception', 'Unhandled rejection: ' + fmt(e.reason));
  });
})();
