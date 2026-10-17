import { readToken } from './secrets.mjs';

// Jira Cloud REST, signed in with your Atlassian email and an API token from the OS credential store.
export const name = 'Jira';
let token = '';
let tokenFor = ''; // the email `token` belongs to
let me = null; // { accountId, displayName }
const boardIds = new Map(); // board name -> id

const siteOf = cfg => cfg.jira.site.replace(/\/+$/, '');

async function api(cfg, route, { method = 'GET', body } = {}) {
  if (!/^https:\/\/\S+$/.test(cfg.jira.site) || !cfg.jira.email) throw new Error('Jira is not set up: run prowl --setup, or fill in the Jira site and email in Config (3)');
  if (tokenFor !== cfg.jira.email) forgetToken();
  tokenFor = cfg.jira.email;
  token ||= readToken(cfg.jira.email);
  if (!token) throw new Error(`no Jira API token saved for ${cfg.jira.email}: run prowl --setup`);
  const res = await fetch(`${siteOf(cfg)}${route}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.jira.email}:${token}`).toString('base64')}`,
      Accept: 'application/json',
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status === 401) token = ''; // re-read next time, in case it was replaced
  if (!res.ok) {
    let why = text.slice(0, 200);
    try { const j = JSON.parse(text); why = [...(j.errorMessages || []), ...Object.values(j.errors || {})].join('; ') || why; } catch { /* not JSON */ }
    throw new Error(`Jira ${method} ${route.split('?')[0]}: ${res.status} ${res.status === 401 ? 'not signed in: the API token is wrong or expired (run prowl --setup)' : why}`);
  }
  return text ? JSON.parse(text) : null;
}

const enc = encodeURIComponent;

/** Drops the cached token and identity, after a new token is saved. */
export function forgetToken() {
  token = '';
  me = null;
}

/** Jira labels can't contain spaces, so a configured tag like "In Review" is written as In-Review. */
export const label = tag => tag.trim().replace(/\s+/g, '-');

export const boardLabel = b => b.board;
export const ticketUrl = (cfg, key) => `${siteOf(cfg)}/browse/${key}`;

/** Checks the sign-in; resolves with your Jira display name. */
export async function whoAmI(cfg) {
  me = await api(cfg, '/rest/api/3/myself');
  return me.displayName;
}

async function boardId(cfg, board) {
  if (/^\d+$/.test(board)) return board;
  if (!boardIds.has(board)) {
    const found = (await api(cfg, `/rest/agile/1.0/board?name=${enc(board)}&maxResults=50`)).values;
    const exact = found.filter(b => b.name.toLowerCase() === board.toLowerCase());
    if (exact.length !== 1) {
      const names = found.map(b => `${b.name} (${b.id})`).slice(0, 5).join(', ');
      throw new Error(exact.length ? `more than one board is named '${board}': use its id instead (${names})` : `no board named '${board}'${names ? `; similar: ${names}` : ''}`);
    }
    boardIds.set(board, String(exact[0].id));
  }
  return boardIds.get(board);
}

/**
 * Open issues on the board carrying the trigger label. Labels are matched loosely, so every open labelled
 * issue on the board is read and filtered here.
 */
export async function findTickets(cfg, board, isTrigger) {
  const id = await boardId(cfg, board.board);
  const jql = enc('labels is not EMPTY AND statusCategory != Done');
  const issues = [];
  // optimization-note: reads every open labelled issue on the board each poll; fine for a team board
  // (hundreds of issues). If boards get much bigger, list the site's labels and query the matching ones.
  for (let at = 0; at < 2000;) {
    const page = await api(cfg, `/rest/agile/1.0/board/${id}/issue?jql=${jql}&fields=summary,labels&startAt=${at}&maxResults=100`);
    issues.push(...page.issues);
    at += page.issues.length;
    if (!page.issues.length || at >= page.total) break;
  }
  const tickets = issues
    .filter(i => (i.fields.labels || []).some(isTrigger))
    .map(i => ({ key: i.key, title: i.fields.summary || '', url: ticketUrl(cfg, i.key), tags: i.fields.labels, ref: { site: siteOf(cfg), key: i.key } }));
  return { tickets, variants: [...new Set(tickets.flatMap(t => t.tags.filter(isTrigger)))] };
}

const editLabels = (cfg, key, remove, add) => api(cfg, `/rest/api/3/issue/${enc(key)}`, {
  method: 'PUT',
  // add/remove operations rather than a new list, so a label someone else adds at the same moment survives.
  body: { update: { labels: [...remove.map(l => ({ remove: l })), ...(add ? [{ add: label(add) }] : [])] } },
});

/**
 * The changelog entry that last removed one of `removed` from the labels: whoever made it claimed the ticket.
 * Two pollers can send the same claim (Jira has no conditional update), but only the first write changes
 * anything, so only it shows up here.
 */
export function claimEntry(histories, removed) {
  const gone = new Set(removed);
  return histories.filter(h => h.items.some(it => {
    if (it.field !== 'labels') return false;
    const from = (it.fromString || '').split(' ');
    const to = new Set((it.toString || '').split(' '));
    return from.some(l => gone.has(l) && !to.has(l));
  })).at(-1) || null;
}

/** Swaps the trigger label for the in-progress one; throws if another poller claimed the ticket first. */
export async function claim(cfg, ticket, drop, add) {
  const remove = ticket.tags.filter(drop);
  await editLabels(cfg, ticket.key, remove, add);
  if (!me) await whoAmI(cfg);
  const { total } = await api(cfg, `/rest/api/3/issue/${enc(ticket.key)}/changelog?maxResults=1`);
  const recent = await api(cfg, `/rest/api/3/issue/${enc(ticket.key)}/changelog?startAt=${Math.max(0, total - 20)}&maxResults=20`);
  const entry = claimEntry(recent.values, remove);
  if (entry && entry.author?.accountId !== me.accountId) {
    // Someone else's claim, or a person removed the trigger label by hand. In that case our in-progress
    // label is the only one: take it back off.
    const theirs = entry.items.some(it => it.field === 'labels' && (it.toString || '').split(' ').includes(label(add)));
    if (!theirs) await editLabels(cfg, ticket.key, [label(add)], '');
    throw new Error(`${entry.author?.displayName || 'someone else'} got there first`);
  }
}

/** Atlassian Document Format (a Jira description) as plain text. */
export function adfText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  if (['mention', 'emoji', 'status'].includes(node.type)) return node.attrs?.text || node.attrs?.shortName || '';
  if (['inlineCard', 'blockCard', 'embedCard'].includes(node.type)) return node.attrs?.url || '';
  const inner = (node.content || []).map(adfText).join('');
  if (node.type === 'listItem') return `- ${inner.trim()}\n`;
  if (['paragraph', 'heading', 'codeBlock', 'blockquote', 'tableRow', 'bulletList', 'orderedList'].includes(node.type)) return `${inner.trimEnd()}\n\n`;
  return node.type === 'tableCell' || node.type === 'tableHeader' ? `${inner.trim()} | ` : inner;
}

/** The issue's description, as plain text ('' if it has none). */
export async function ticketText(cfg, ticket) {
  const issue = await api(cfg, `/rest/api/3/issue/${enc(ticket.key)}?fields=description`);
  return adfText(issue.fields.description).replace(/\n{3,}/g, '\n\n').trim();
}

/** Replaces the labels Prowl owns (`drop`) with `add` ('' = none) on a ticket a review ran for. */
export async function retag(cfg, ref, drop, add) {
  const issue = await api(cfg, `/rest/api/3/issue/${enc(ref.key)}?fields=labels`);
  await editLabels(cfg, ref.key, (issue.fields.labels || []).filter(drop), add);
}
