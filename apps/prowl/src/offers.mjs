// A paste of only tickets gets an offer before a quick review or quick build: tag them so the side picks them up from
// their board (adding the board when the side doesn't poll it yet), or go ahead quickly. Shared by both sides, each
// with its own tags; neither imports the other.
import { norm } from './match.mjs';

const has = (tags, tag) => tags.some(t => norm(t) === norm(tag));
/** True when boards `a` and `b` (as config.json holds them) are the same board. */
export const sameBoard = (a, b) => (a.board != null || b.board != null
  ? norm(a.board) === norm(b.board)
  : norm(a.project) === norm(b.project) && norm(a.team) === norm(b.team));

/**
 * The offer for `tickets` (as the tracker's lookup() read them), or null when one is closed, carries `busyTag` (the
 * side's in-progress tag: being worked on), or is on no board. { tickets: [{ key, title, ref, board, polled }], polled
 * (every board is one the side polls), boards (the labels of those it doesn't) }.
 */
export async function offerFor(app, tracker, tickets, busyTag) {
  if (!tickets.length) return null;
  const out = [];
  for (const t of tickets) {
    if (t.closed || has(t.tags || [], busyTag)) return null;
    const board = await tracker.boardOf(app.cfg, t).catch(() => null);
    if (!board) return null;
    out.push({ key: t.key, title: t.title, url: t.url, ref: t.ref, board, polled: app.boards().some(b => sameBoard(b, board)) });
  }
  const unpolled = out.filter(t => !t.polled).map(t => tracker.boardLabel(t.board));
  return { tickets: out, polled: !unpolled.length, boards: [...new Set(unpolled)] };
}

/**
 * Accepting an offer: each ticket read again, then the boards it needs added (with `addBoards`, written to config.json
 * once, after the reads), then `tag` added with the tracker's concurrency check. A ticket closed or carrying `busyTag`
 * since is left alone, and its board isn't added; one already carrying a tag `isTag` accepts isn't tagged again, but its
 * board is added. A dry run only logs. `deps`: { log(level, msg), saveConfig() }. Resolves with the keys tagged.
 */
export async function acceptOffer(app, tracker, offer, { tag, busyTag, isTag, addBoards, log, saveConfig }) {
  const cfg = app.cfg;
  const now = [];
  for (const t of offer.tickets) {
    const item = await tracker.readItem(cfg, t.ref);
    if (item.closed) { log('info', `${t.key}: left alone: it is closed now`); continue; }
    if (has(item.tags, busyTag)) { log('info', `${t.key}: left alone: it is '${busyTag}' now`); continue; }
    now.push({ ...t, item, tagged: item.tags.some(isTag) });
  }
  const boards = app.cfg[app.cfg.taskBoard].boards; // read now: config.json may have been re-read during the reads above
  const adding = addBoards ? now.filter(t => !t.polled && !boards.some(b => sameBoard(b, t.board))).map(t => t.board)
    .filter((b, i, all) => all.findIndex(x => sameBoard(x, b)) === i) : [];
  if (adding.length) {
    const names = adding.map(b => tracker.boardLabel(b)).join(', ');
    if (app.dryRun()) log('info', `would add ${names} to the boards (dry run)`);
    else {
      boards.push(...adding);
      saveConfig();
      log('ok', `added ${names} to the boards`);
    }
  }
  const tagged = [];
  for (const t of now) {
    if (t.tagged) { log('info', `${t.key}: already tagged '${tag}'; not tagged again`); continue; }
    if (app.dryRun()) { log('info', `${t.key}: would tag it '${tag}' (dry run)`); continue; }
    try {
      await tracker.claim(cfg, t.item, () => false, tag);
      tagged.push(t.key);
      log('ok', `${t.key}: tagged '${tag}'`);
    } catch (e) {
      log('warn', `${t.key}: not tagged: ${e.lost ? `it changed meanwhile (${e.message})` : e.message}`);
    }
  }
  return tagged;
}
