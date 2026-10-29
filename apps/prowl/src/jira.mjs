import { randomBytes } from 'node:crypto';
import { readToken } from './secrets.mjs';

// Jira Cloud REST, signed in with your Atlassian email and an API token from the OS credential store.
export const name = 'Jira';
let token = '';
let tokenFor = ''; // the email `token` belongs to
const boardIds = new Map(); // board name -> id

const siteOf = cfg => cfg.jira.site.replace(/\/+$/, '');

async function api(cfg, route, { method = 'GET', body } = {}) {
  if (!/^https:\/\/\S+$/.test(cfg.jira.site) || !cfg.jira.email) throw new Error('Jira is not set up: run prowl --setup, or fill in the Jira site and email in Config (4)');
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

/** Drops the cached token, after a new token is saved. */
export function forgetToken() {
  token = '';
}

/** Jira labels can't contain spaces, so a configured tag like "In Review" is written as In-Review. */
export const label = tag => tag.trim().replace(/\s+/g, '-');

export const boardLabel = b => b.board;
export const ticketUrl = (cfg, key) => `${siteOf(cfg)}/browse/${key}`;

/** Checks the sign-in; resolves with your Jira display name. */
export async function whoAmI(cfg) {
  return (await api(cfg, '/rest/api/3/myself')).displayName;
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

const ticketOf = (cfg, issue) => ({
  key: issue.key, title: issue.fields.summary || '', url: ticketUrl(cfg, issue.key), tags: issue.fields.labels || [],
  assignee: issue.fields.assignee?.displayName || '', ref: { site: siteOf(cfg), key: issue.key },
});

/**
 * Open issues on the board carrying a label `isTrigger` accepts; with `assignedToMe`, only yours. Labels are matched
 * loosely, so every open labelled issue on the board is read and filtered here.
 */
export async function findTickets(cfg, board, isTrigger, { assignedToMe = false } = {}) {
  const id = await boardId(cfg, board.board);
  const jql = enc(`labels is not EMPTY AND statusCategory != Done${assignedToMe ? ' AND assignee = currentUser()' : ''}`);
  const issues = [];
  // optimization-note: reads every open labelled issue on the board each poll; fine for a team board
  // (hundreds of issues). If boards get much bigger, list the site's labels and query the matching ones.
  for (let at = 0; at < 2000;) {
    const page = await api(cfg, `/rest/agile/1.0/board/${id}/issue?jql=${jql}&fields=summary,labels,assignee&startAt=${at}&maxResults=100`);
    issues.push(...page.issues);
    at += page.issues.length;
    if (!page.issues.length || at >= page.total) break;
  }
  const tickets = issues.filter(i => (i.fields.labels || []).some(isTrigger)).map(i => ticketOf(cfg, i));
  return { tickets, variants: [...new Set(tickets.flatMap(t => t.tags.filter(isTrigger)))] };
}

// `add`: a label, a list of them, or ''.
const editLabels = (cfg, key, remove, add) => api(cfg, `/rest/api/3/issue/${enc(key)}`, {
  method: 'PUT',
  // add/remove operations rather than a new list, so a label someone else adds at the same moment survives.
  body: { update: { labels: [...remove.map(l => ({ remove: l })), ...[add].flat().filter(Boolean).map(l => ({ add: label(l) }))] } },
});

const CLAIM = /^prowl-claim-/; // the one-off label each claim adds; see claim()
export const claimWait = { ms: 2000 }; // how long a claim waits for a rival write to reach the changelog (the self-test sets 0)

/** True when the changelog entry added label `l`. */
export const addedLabel = (entry, l) => entry.items.some(it => it.field === 'labels'
  && (it.toString || '').split(' ').includes(l) && !(it.fromString || '').split(' ').includes(l));

/**
 * The changelog entry that last removed one of `removed` from the labels: whoever made it claimed the ticket.
 * Two pollers can send the same claim (Jira has no conditional update), but only the first write removes
 * the label, so only it shows up here.
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

/** The issue for a key (PROJ-123, used as typed), for prowl --work and --follow. */
export async function lookup(cfg, key) {
  if (!/^[A-Z][A-Z0-9_]*-\d+$/i.test(String(key).trim())) throw new Error(`${key} isn't a Jira issue key: use PROJ-123`);
  return readItem(cfg, { key: String(key).trim() });
}

/**
 * The changelog's length: the issue's revision. It only grows, unlike a timestamp, which would depend on the clocks
 * of Jira and of the machine Prowl runs on.
 */
const revision = async (cfg, key) => (await api(cfg, `/rest/api/3/issue/${enc(key)}/changelog?maxResults=1`)).total;

/** The issue now: its key, title, url, labels (as tags), rev (the changelog's length), assignee and ref. */
export async function readItem(cfg, ref) {
  const issue = await api(cfg, `/rest/api/3/issue/${enc(ref.key)}?fields=summary,labels,assignee`);
  return { ...ticketOf(cfg, issue), rev: await revision(cfg, issue.key) };
}

/**
 * Swaps the trigger label for the in-progress one; throws if another poller claimed the ticket first. The same write
 * adds a one-off prowl-claim-… label, which marks the winning changelog entry as ours: the author can't, as two
 * copies of Prowl can sign in as the same account. A later write still adds its own label, so it never looks like the winner.
 */
export async function claim(cfg, ticket, drop, add) {
  const remove = ticket.tags.filter(drop);
  const mine = `prowl-claim-${randomBytes(4).toString('hex')}`;
  await editLabels(cfg, ticket.key, remove, [add, mine]);
  try {
    await new Promise(r => setTimeout(r, claimWait.ms)); // two writes at the same moment: both are in the changelog by then
    const { total } = await api(cfg, `/rest/api/3/issue/${enc(ticket.key)}/changelog?maxResults=1`);
    const recent = await api(cfg, `/rest/api/3/issue/${enc(ticket.key)}/changelog?startAt=${Math.max(0, total - 20)}&maxResults=20`);
    const entry = claimEntry(recent.values, remove);
    if (entry && !addedLabel(entry, mine)) {
      // Another Prowl's claim, or a person removed the trigger label by hand. In that case our in-progress
      // label is the only one: take it back off.
      const theirs = entry.items.some(it => it.field === 'labels' && (it.toString || '').split(' ').includes(label(add)));
      if (!theirs) await editLabels(cfg, ticket.key, [label(add)], '');
      const by = entry.author?.displayName;
      const prowl = entry.items.some(it => it.field === 'labels' && (it.toString || '').split(' ').some(l => CLAIM.test(l)));
      throw new Error(prowl ? `another copy of Prowl${by ? ` (signed in as ${by})` : ''} got there first` : `${by || 'someone else'} got there first`);
    }
  } finally {
    await editLabels(cfg, ticket.key, [mine], '').catch(() => {}); // or retag() clears it when the review ends
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

/** Replaces the labels Prowl owns (`drop`) with `add` ('' = none); resolves with the issue's new revision. */
export async function retag(cfg, ref, drop, add) {
  const issue = await api(cfg, `/rest/api/3/issue/${enc(ref.key)}?fields=labels`);
  await editLabels(cfg, ref.key, (issue.fields.labels || []).filter(l => drop(l) || CLAIM.test(l)), add);
  return revision(cfg, ref.key);
}

/** True when the label changes in `histories` (oldest first) took a label `isTag` accepts off and then put one back on. */
export function readded(histories, isTag) {
  let removed = false;
  for (const h of histories) {
    for (const it of h.items.filter(x => x.field === 'labels')) {
      const [had, has] = [(it.fromString || '').split(' ').some(l => l && isTag(l)), (it.toString || '').split(' ').some(l => l && isTag(l))];
      if (had && !has) removed = true;
      else if (removed && has && !had) return true;
    }
  }
  return false;
}

/** True when someone took a label `isTag` accepts off the issue and put it back after changelog entry `since` (up to `upTo`). */
export async function tagsChangedSince(cfg, ref, since, upTo, isTag) {
  const entries = [];
  for (let at = since; upTo == null || at < upTo;) {
    const page = await api(cfg, `/rest/api/3/issue/${enc(ref.key)}/changelog?startAt=${at}&maxResults=100`);
    entries.push(...page.values);
    at += page.values.length;
    if (!page.values.length || at >= page.total) break;
  }
  return readded(upTo == null ? entries : entries.slice(0, upTo - since), isTag);
}

const textOf = v => (v && typeof v === 'object' ? adfText(v) : String(v ?? '')).replace(/\n{3,}/g, '\n\n').trim();
const summaryOf = (cfg, i) => ({
  key: i.key, title: i.fields?.summary || '', type: i.fields?.issuetype?.name || '', state: i.fields?.status?.name || '',
  description: textOf(i.fields?.description), url: ticketUrl(cfg, i.key),
});

/**
 * Everything the Builder writes into ticket.md: the issue's fields (with the optional acceptance criteria and repro
 * steps custom fields), comments, parent, sub-tasks, linked issues with their titles and descriptions, remote links
 * and attachment names.
 */
export async function workItem(cfg, ref) {
  const { acceptanceCriteria = '', reproSteps = '' } = cfg.jira.fields || {};
  const custom = [acceptanceCriteria, reproSteps].filter(Boolean);
  const issue = await api(cfg, `/rest/api/3/issue/${enc(ref.key)}?fields=${['summary', 'issuetype', 'status', 'labels', 'assignee', 'description', 'comment', 'parent', 'subtasks', 'issuelinks', 'attachment', ...custom].join(',')}`);
  const f = issue.fields;
  const remote = await api(cfg, `/rest/api/3/issue/${enc(ref.key)}/remotelink`).catch(() => []);
  const keys = [f.parent?.key, ...(f.subtasks || []).map(t => t.key), ...(f.issuelinks || []).map(l => (l.inwardIssue || l.outwardIssue)?.key)].filter(Boolean);
  const linked = new Map();
  for (const k of [...new Set(keys)]) {
    try { linked.set(k, summaryOf(cfg, await api(cfg, `/rest/api/3/issue/${enc(k)}?fields=summary,issuetype,status,description`))); } catch { /* no access: left out */ }
  }
  const one = k => linked.get(k) || null;
  return {
    key: issue.key, title: f.summary || '', url: ticketUrl(cfg, issue.key), type: f.issuetype?.name || '', state: f.status?.name || '',
    tags: f.labels || [], assignee: f.assignee?.displayName || '',
    description: textOf(f.description),
    acceptanceCriteria: acceptanceCriteria ? textOf(f[acceptanceCriteria]) : null, // null: no field configured, so no section
    reproSteps: reproSteps ? textOf(f[reproSteps]) : null,
    comments: (f.comment?.comments || []).map(c => ({ author: c.author?.displayName || '', at: c.created || '', text: textOf(c.body) })),
    parent: f.parent ? one(f.parent.key) : null,
    children: (f.subtasks || []).map(t => one(t.key)).filter(Boolean),
    related: (f.issuelinks || []).map(l => one((l.inwardIssue || l.outwardIssue)?.key)).filter(Boolean),
    links: (remote || []).map(r => ({ name: r.object?.title || 'Link', url: r.object?.url || '' })).filter(l => l.url),
    attachments: (f.attachment || []).map(a => a.filename),
  };
}
