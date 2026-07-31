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

  // Confirmation references are frequently shown in a toast that removes itself
  // after a few seconds, so anything that looks for one once the step has finished
  // finds nothing exactly where a record of it matters most. Watching from
  // document_start also survives the navigation that usually precedes the toast,
  // which an observer installed per step does not.
  if (!window.__bmcpConfirmations) {
    window.__bmcpConfirmations = [];
    const RE = /(?:[Cc]onfirmation|[Rr]eference|[Aa]pplication|[Rr]eceipt|[Oo]rder|[Tt]racking)\s*(?:[Ii][Dd]|[Nn]umber|[Nn]o\.?|#)?\s*[:#]\s*([A-Z0-9][A-Z0-9-]{3,24})/;
    const note = (node) => {
      try {
        const t = (node.innerText || node.textContent || '').replace(/\s+/g, ' ');
        if (!t || t.length > 400) return;
        const m = RE.exec(t);
        if (m && !window.__bmcpConfirmations.includes(m[0])) {
          window.__bmcpConfirmations.push(m[0].slice(0, 80));
          if (window.__bmcpConfirmations.length > 20) window.__bmcpConfirmations.shift();
        }
      } catch (e) {}
    };
    const start = () => {
      if (document.body) note(document.body);
      new MutationObserver((muts) => {
        for (const mu of muts) for (const n of mu.addedNodes) if (n.nodeType === 1) note(n);
      }).observe(document.documentElement, { childList: true, subtree: true });
    };
    if (document.documentElement) start();
    else document.addEventListener('readystatechange', start, { once: true });
  }

  // What the page told the server, recorded here rather than through the debugger.
  // The point of watching requests is to know what a click actually committed —
  // which row was deleted, whether Submit went out when Save Draft was meant — and
  // the debugger is not always attached when a click happens, because a window
  // that cannot take real input is driven by script instead. Method and address
  // only: no bodies, no headers, nothing that could carry a credential.
  if (!window.__bmcpRequests) {
    // A form post navigates, and the record would die with the document — losing
    // precisely the request worth keeping. Mutating ones are carried across in
    // sessionStorage, which is already scoped to this tab and this origin.
    const CARRY = '__bmcpCarriedRequests';
    let carried = [];
    try { carried = JSON.parse(sessionStorage.getItem(CARRY) || '[]'); } catch (e) {}
    const reqs = Array.isArray(carried) ? carried.slice(-50) : [];
    window.__bmcpRequests = reqs;
    let seq = reqs.length ? reqs[reqs.length - 1].n : 0;
    const note = (method, url, extra) => {
      try {
        const m = String(method || 'GET').toUpperCase();
        const u = String(url || '');
        // Same-page assets are noise; this exists to show what was committed.
        if (/\.(png|jpe?g|gif|svg|webp|woff2?|ttf|css|js|ico|map)(\?|$)/i.test(u)) return;
        reqs.push({ n: ++seq, method: m, url: u.slice(0, 300), ts: Date.now(), ...extra });
        if (reqs.length > 300) reqs.splice(0, reqs.length - 300);
        // Only the ones that change something are worth carrying, and only those
        // pay the cost of writing to storage.
        if (/^(POST|PUT|PATCH|DELETE)$/.test(m)) {
          try {
            const keep = reqs.filter(q => /^(POST|PUT|PATCH|DELETE)$/.test(q.method)).slice(-50);
            sessionStorage.setItem(CARRY, JSON.stringify(keep));
          } catch (e) {}
        }
        return reqs[reqs.length - 1];
      } catch (e) { return null; }
    };

    const origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        let url = '', method = 'GET';
        try {
          url = typeof input === 'string' ? input : (input && input.url) || '';
          method = (init && init.method) || (input && input.method) || 'GET';
        } catch (e) {}
        const rec = note(method, url);
        const p = origFetch.apply(this, arguments);
        try { p.then((r) => { if (rec) rec.status = r.status; }, () => { if (rec) rec.failed = true; }); } catch (e) {}
        return p;
      };
    }

    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const open = XHR.prototype.open, sendFn = XHR.prototype.send;
      XHR.prototype.open = function (m, u) { this.__bmcpM = m; this.__bmcpU = u; return open.apply(this, arguments); };
      XHR.prototype.send = function () {
        const rec = note(this.__bmcpM, this.__bmcpU);
        try {
          this.addEventListener('loadend', () => { if (rec) rec.status = this.status; });
        } catch (e) {}
        return sendFn.apply(this, arguments);
      };
    }

    if (navigator.sendBeacon) {
      const beacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function (url) { note('POST', url, { beacon: true }); return beacon.apply(this, arguments); };
    }

    // A form that posts normally never goes through fetch or XHR, and is the most
    // consequential request a page makes.
    document.addEventListener('submit', (e) => {
      try {
        const f = e.target;
        if (f && f.tagName === 'FORM') note(f.method || 'GET', f.action || location.href, { form: true });
      } catch (err) {}
    }, true);
  }

  // Real input arriving at a tab a run is working in. Someone clicking into the
  // page at 2am to see how it is going lands a keystroke in the row being filled,
  // and the run has no idea it did not do that itself.
  //
  // isTrusted cannot tell us apart from a person: input dispatched through the
  // debugger is trusted too. So everything trusted is recorded with its time, and
  // whoever asks decides — a run knows when its own steps were executing, and
  // anything landing outside those moments was not it.
  if (!window.__bmcpUserInput) {
    const seen = [];
    window.__bmcpUserInput = seen;
    const note = (e) => {
      try {
        if (!e.isTrusted) return;
        seen.push({ t: Date.now(), type: e.type });
        if (seen.length > 60) seen.splice(0, seen.length - 60);
      } catch (err) {}
    };
    for (const type of ['pointerdown', 'keydown', 'wheel']) {
      document.addEventListener(type, note, true);
    }
  }

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
