// The shell around the two sides: re-reads config.json when it changes and every poll interval, ticks each side once a
// second and polls each side that's on. One side's error is logged on that side and never stops the other.

/**
 * `sides`: the Reviewer and the Builder. `deps`: { log(side, level, msg, key), reload() (re-reads config.json into
 * app.cfg; throws on a bad file), changed() (true when config.json isn't as this process last read or wrote it),
 * now() (the clock, for the self-test) }.
 */
export function createShell(app, sides, { log, reload, changed = () => false, now = Date.now }) {
  let nextReload = 0;
  const on = s => app.sideOn(s.name);

  async function poll(s) {
    s.polling = true;
    try {
      await s.poll();
    } catch (e) {
      s.lastError = e.message;
      log(s.name, 'error', e.message, 'poll');
    } finally {
      s.polling = false;
      s.lastPoll = now(); // when the last poll finished, for the Boards card beside Hoot
      s.nextPoll = now() + app.cfg.pollSeconds * 1000;
    }
  }

  function refresh() {
    try { reload(); } catch (e) { log('prowl', 'error', `${e.message} (keeping the previous config)`, 'config'); }
    nextReload = now() + app.cfg.pollSeconds * 1000;
  }

  /** Once a second. */
  function tick() {
    for (const s of sides) {
      try { s.tick(); } catch (e) { log(s.name, 'error', e.message, `tick:${e.message}`); }
    }
    const due = s => on(s) && !s.paused && !s.polling && now() >= s.nextPoll;
    // With both sides off, the file is still re-read, so a switch turned on there is picked up. And as soon as it
    // changes: a change made in Config writes every setting, so an edit to the file must be read before the next one.
    if (sides.some(due) || now() >= nextReload || changed()) refresh();
    for (const s of sides.filter(due)) poll(s);
    if (!sides.some(on) && log('prowl', 'info', 'Both sides are off: Prowl is idle. Turn one on with e, or in config.json.', 'idle')) app.hoot?.("Both sides are off, so I'm resting. Press e to turn one on.");
    if (sides.some(on)) app.forget?.('prowl', 'idle');
  }

  /** --once: one poll of each side that's on. */
  async function pollOnce() {
    refresh();
    for (const s of sides.filter(on)) await poll(s);
  }

  return { tick, pollOnce, poll };
}
