/**
 * When to give up on a connection.
 *
 * Pulled out on its own because it is the most dangerous decision in the
 * extension — getting it wrong drops every session at once — and because inside
 * offscreen.js it could only be checked by reading it. It already had one fault
 * that would have disconnected everybody every minute; that was caught by eye,
 * which is not a method. Here it can be tested.
 *
 * No chrome APIs, no timers, no clock. Given what is known about a connection,
 * should it be dropped.
 */
(function (root) {
  const UNANSWERED_LIMIT = 3;

  /**
   * @param {{everPonged?: boolean, unanswered?: number}} health
   * @returns {boolean}
   */
  function shouldDrop(health) {
    if (!health) return false;
    // A far end that has never answered a ping is not being judged on silence —
    // it may simply be an older server that does not know the message. Only a
    // connection that has demonstrated it can answer is expected to keep doing so.
    if (!health.everPonged) return false;
    return (health.unanswered || 0) >= UNANSWERED_LIMIT;
  }

  // The other destructive decision, kept beside this one for the same reason.
  // Replacing the offscreen document closes every session's connection at once, so
  // a watchdog that misjudges takes the bridge down far more reliably than the
  // wedge it is watching for. Its first version condemned on a single unanswered
  // ping, using a counter held in a variable — which a service worker loses on
  // eviction, so the count reset almost every tick and the caution was decorative.
  const MISS_LIMIT = 2;

  /**
   * @param {{answered: boolean, misses: number}} state  misses = consecutive
   *        unanswered checks BEFORE this one.
   * @returns {{replace: boolean, misses: number}} misses to persist.
   */
  function offscreenVerdict(state) {
    if (state.answered) return { replace: false, misses: 0 };
    const misses = (state.misses || 0) + 1;
    if (misses < MISS_LIMIT) return { replace: false, misses };
    return { replace: true, misses: 0 };
  }

  root.bmcpHeartbeatPolicy = { shouldDrop, UNANSWERED_LIMIT, offscreenVerdict, MISS_LIMIT };
})(typeof self !== 'undefined' ? self : globalThis);
