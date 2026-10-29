import { swapTags } from './match.mjs';
import { run } from './proc.mjs';

// Azure DevOps REST, authenticated with the az CLI login (`az login`). No PAT, no az extension.
export const name = 'Azure DevOps';
const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798'; // Azure DevOps' Entra ID application
const tokens = new Map(); // org -> { value, expires }

/** Caches a token for `org`, as if az had just issued it: for the self-test, which never signs in. */
export const primeToken = (org, value) => tokens.set(org.replace(/\/+$/, ''), { value, expires: Date.now() + 3_600_000 });

// The org's Entra tenant often isn't az's default one,
// so ask the org which tenant it trusts and request the token for that tenant.
export async function tenantOf(rawOrg) {
  const probe = await fetch(`${rawOrg.replace(/\/+$/, '')}/_apis/connectionData`, { redirect: 'manual' });
  const tenant = probe.headers.get('x-vss-resourcetenant');
  return tenant && !/^0{8}-/.test(tenant) ? tenant : '';
}

async function bearer(org) {
  const cached = tokens.get(org);
  if (cached && cached.expires - Date.now() > 5 * 60_000) return cached.value;
  const tenant = await tenantOf(org);
  const tenantArgs = tenant ? ['--tenant', tenant] : [];
  let out;
  try {
    out = await run('az', ['account', 'get-access-token', '--resource', ADO_RESOURCE, ...tenantArgs, '-o', 'json']);
  } catch (e) {
    throw new Error(`${e.message}${tenant ? ` (try: az login --allow-no-subscriptions --tenant ${tenant})` : ''}`);
  }
  const j = JSON.parse(out);
  tokens.set(org, { value: j.accessToken, expires: j.expires_on ? j.expires_on * 1000 : Date.now() + 30 * 60_000 });
  return j.accessToken;
}

async function api(rawOrg, route, { method = 'GET', body, type = 'application/json' } = {}) {
  const org = rawOrg.replace(/\/+$/, '');
  const res = await fetch(`${org}/${route}`, {
    method,
    redirect: 'manual', // ADO redirects unauthorised calls to a sign-in page
    headers: { Authorization: `Bearer ${await bearer(org)}`, Accept: 'application/json', ...(body && { 'Content-Type': type }) },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  const signIn = res.status === 401 || res.status === 203 || (res.status >= 300 && res.status < 400);
  if (signIn) tokens.delete(org);
  if (!res.ok || signIn || !(res.headers.get('content-type') || '').includes('json')) {
    let why = text.slice(0, 200);
    try { why = JSON.parse(text).message || why; } catch { /* not JSON */ }
    throw new Error(`ADO ${method} ${route.split('?')[0]}: ${res.status} ${signIn ? 'not signed in (run az login)' : why}`);
  }
  return JSON.parse(text);
}

const enc = encodeURIComponent;
const wiqlString = s => `'${String(s).replace(/'/g, "''")}'`;
const toItem = w => ({ id: w.id, rev: w.rev, title: w.fields['System.Title'] || '', tags: splitTags(w.fields['System.Tags']), assignee: person(w.fields['System.AssignedTo']) });
const person = p => (typeof p === 'string' ? p : p?.displayName || p?.uniqueName || '');
const ITEM_FIELDS = 'System.Title,System.Tags,System.AssignedTo,System.TeamProject';
const splitTags = field => String(field || '').split(';').map(t => t.trim()).filter(Boolean);

export const workItemUrl = (org, project, id) => `${org.replace(/\/+$/, '')}/${enc(project)}/_workitems/edit/${id}`;
export const boardLabel = b => `${b.project} / ${b.team}`;

/** Checks the sign-in by reading the org's identity for you. */
export async function whoAmI(cfg) {
  return (await api(cfg.ado.org, '_apis/connectionData')).authenticatedUser?.providerDisplayName || 'signed in';
}

const ticketOf = (org, project, item) => ({
  key: `AB#${item.id}`, title: item.title, url: workItemUrl(org, project, item.id), tags: item.tags, rev: item.rev, assignee: item.assignee,
  ref: { org, project, id: item.id },
});

/** Open work items on the board carrying a tag `isTrigger` accepts; with `assignedToMe`, only yours. */
export async function findTickets(cfg, board, isTrigger, { assignedToMe = false } = {}) {
  const { org } = cfg.ado;
  const [scope, tags] = await Promise.all([boardScope(org, board.project, board.team), projectTags(org, board.project)]);
  const variants = tags.filter(isTrigger);
  const items = variants.length ? await findTagged(org, board.project, scope, variants, assignedToMe) : [];
  return { tickets: items.map(item => ticketOf(org, board.project, item)), variants };
}

/** The work item for a key (AB#123 or 123), for prowl --work and --follow. */
export async function lookup(cfg, key) {
  if (!cfg.ado.org) throw new Error('Azure DevOps is not set up: run prowl --setup');
  const id = Number(String(key).trim().replace(/^AB#/i, ''));
  if (!Number.isInteger(id) || id <= 0) throw new Error(`${key} isn't an Azure DevOps work item: use AB#123`);
  const w = await api(cfg.ado.org, `_apis/wit/workitems/${id}?fields=${ITEM_FIELDS}&api-version=7.1`);
  return ticketOf(cfg.ado.org, w.fields['System.TeamProject'], toItem(w));
}

/** The work item now: its key, title, url, tags, rev, assignee and ref. */
export async function readItem(cfg, ref) {
  return ticketOf(ref.org, ref.project, await getItem(ref.org, ref.project, ref.id));
}

/** Swaps the trigger tag for the in-progress one; the revision check makes it fail if anyone got there first. */
export const claim = (cfg, ticket, drop, add) =>
  setTags(ticket.ref.org, ticket.ref.project, ticket.ref.id, ticket.rev, swapTags(ticket.tags, drop, add));

/** Replaces the tags Prowl owns (`drop`) with `add` ('' = none); resolves with the work item's new revision. */
export async function retag(cfg, ref, drop, add) {
  const item = await getItem(ref.org, ref.project, ref.id);
  return setTags(ref.org, ref.project, ref.id, item.rev, swapTags(item.tags, drop, add));
}

/** True when the tag changes in `updates` (oldest first) took a tag `isTag` accepts off and then put one back on. */
export function readded(updates, isTag) {
  let removed = false;
  for (const u of updates) {
    const t = u.fields?.['System.Tags'];
    if (!t) continue;
    const [had, has] = [splitTags(t.oldValue).some(isTag), splitTags(t.newValue).some(isTag)];
    if (had && !has) removed = true;
    else if (removed && has && !had) return true;
  }
  return false;
}

/** True when someone took a tag `isTag` accepts off the work item and put it back after revision `since` (up to `upTo`). */
export async function tagsChangedSince(cfg, ref, since, upTo, isTag) {
  const updates = [];
  for (let skip = 0; ; skip += 200) {
    const page = (await api(ref.org, `${enc(ref.project)}/_apis/wit/workItems/${ref.id}/updates?$top=200&$skip=${skip}&api-version=7.1`)).value;
    updates.push(...page);
    if (page.length < 200) break;
  }
  return readded(updates.filter(u => u.rev > since && (upTo == null || u.rev <= upTo)), isTag);
}

/** The field and values that define a team's board, e.g. System.AreaPath UNDER 'My Project\My Team'. */
async function boardScope(org, project, team) {
  const r = await api(org, `${enc(project)}/${enc(team)}/_apis/work/teamsettings/teamfieldvalues?api-version=7.1`);
  if (!r.values?.length) throw new Error(`team '${team}' has no area paths`);
  return { field: r.field.referenceName, values: r.values };
}

/** Every tag name in the project: the candidates for typo-tolerant matching. */
async function projectTags(org, project) {
  return (await api(org, `${enc(project)}/_apis/wit/tags?api-version=7.1-preview.1`)).value.map(t => t.name);
}

/** Open work items on the board that carry any of `tags`. */
async function findTagged(org, project, scope, tags, assignedToMe) {
  const tree = scope.field === 'System.AreaPath';
  const onBoard = scope.values.map(v => `[${scope.field}] ${tree && v.includeChildren ? 'UNDER' : '='} ${wiqlString(v.value)}`).join(' OR ');
  const tagged = tags.map(t => `[System.Tags] CONTAINS ${wiqlString(t)}`).join(' OR ');
  const mine = assignedToMe ? ' AND [System.AssignedTo] = @Me' : '';
  const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND (${onBoard}) AND (${tagged})${mine} AND [System.State] NOT IN ('Closed', 'Done', 'Removed')`;
  const ids = (await api(org, `${enc(project)}/_apis/wit/wiql?api-version=7.1`, { method: 'POST', body: { query } })).workItems.map(w => w.id);
  const items = [];
  for (let i = 0; i < ids.length; i += 200) {
    const page = await api(org, `${enc(project)}/_apis/wit/workitems?ids=${ids.slice(i, i + 200).join(',')}&fields=${ITEM_FIELDS}&api-version=7.1`);
    items.push(...page.value.map(toItem));
  }
  return items;
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const entity = (m, e) => {
  const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : e[0] === '#' ? Number(e.slice(1)) : NaN;
  return n <= 0x10ffff ? String.fromCodePoint(n) : ENTITIES[e.toLowerCase()] ?? m;
};
/** A work item's rich-text field as plain text: block tags become line breaks, list items "- ", entities decoded. */
export const htmlText = html => String(html)
  .replace(/<(br|\/p|\/div|\/h[1-6]|\/tr|\/ul|\/ol)\b[^>]*>/gi, '\n')
  .replace(/<li\b[^>]*>/gi, '\n- ')
  .replace(/<[^>]*>/g, '')
  .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, entity)
  .replace(/[ \t]+\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

/** The work item's description and acceptance criteria, as plain text ('' if it has neither). */
export async function ticketText(cfg, ticket) {
  const { org, project, id } = ticket.ref;
  // All fields, not a list: naming a field the org's process doesn't have (Basic has no acceptance criteria) fails the call.
  const { fields } = await api(org, `${enc(project)}/_apis/wit/workitems/${id}?api-version=7.1`);
  return [['Description', fields['System.Description']], ['Acceptance criteria', fields['Microsoft.VSTS.Common.AcceptanceCriteria']]]
    .map(([name, html]) => [name, htmlText(html || '')]).filter(([, text]) => text)
    .map(([name, text]) => `${name}:\n${text}`).join('\n\n');
}

async function getItem(org, project, id) {
  return toItem(await api(org, `${enc(project)}/_apis/wit/workitems/${id}?fields=${ITEM_FIELDS}&api-version=7.1`));
}

const LINKED = { 'System.LinkTypes.Hierarchy-Reverse': 'parent', 'System.LinkTypes.Hierarchy-Forward': 'children' }; // any other work item link is related
const idOf = url => Number(/\/workItems\/(\d+)$/i.exec(url || '')?.[1]);

/**
 * Everything the Builder writes into ticket.md: the work item's fields, comments, and relations (parent, children,
 * related items with their titles and descriptions, artifact links and hyperlinks, attachment names).
 */
export async function workItem(cfg, ref) {
  const { org, project, id } = ref;
  // All fields, not a list: naming a field the org's process doesn't have (Basic has no acceptance criteria) fails the call.
  const w = await api(org, `${enc(project)}/_apis/wit/workitems/${id}?$expand=relations&api-version=7.1`);
  const comments = (await api(org, `${enc(project)}/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.4`)).comments || [];
  const rels = w.relations || [];
  const linkedIds = [...new Set(rels.map(r => idOf(r.url)).filter(Boolean))];
  const linked = new Map();
  for (let i = 0; i < linkedIds.length; i += 200) {
    const page = await api(org, `_apis/wit/workitems?ids=${linkedIds.slice(i, i + 200).join(',')}&fields=System.Title,System.Description,System.WorkItemType,System.State,System.TeamProject&api-version=7.1&errorPolicy=omit`);
    for (const x of page.value.filter(Boolean)) {
      linked.set(x.id, { key: `AB#${x.id}`, title: x.fields['System.Title'] || '', type: x.fields['System.WorkItemType'] || '', state: x.fields['System.State'] || '',
        description: htmlText(x.fields['System.Description'] || ''), url: workItemUrl(org, x.fields['System.TeamProject'] || project, x.id) });
    }
  }
  const items = kind => rels.filter(r => idOf(r.url) && (LINKED[r.rel] || 'related') === kind).map(r => linked.get(idOf(r.url))).filter(Boolean);
  const f = w.fields;
  return {
    key: `AB#${id}`, title: f['System.Title'] || '', url: workItemUrl(org, project, id), type: f['System.WorkItemType'] || '', state: f['System.State'] || '',
    tags: splitTags(f['System.Tags']), assignee: person(f['System.AssignedTo']),
    description: htmlText(f['System.Description'] || ''),
    acceptanceCriteria: htmlText(f['Microsoft.VSTS.Common.AcceptanceCriteria'] || ''),
    reproSteps: htmlText(f['Microsoft.VSTS.TCM.ReproSteps'] || ''),
    comments: comments.map(c => ({ author: person(c.createdBy), at: c.createdDate || '', text: htmlText(c.text || '') })),
    parent: items('parent')[0] || null, children: items('children'), related: items('related'),
    links: rels.filter(r => r.rel === 'ArtifactLink' || r.rel === 'Hyperlink').map(r => ({ name: r.attributes?.name || (r.rel === 'Hyperlink' ? 'Link' : 'Artifact'), url: r.url })),
    attachments: rels.filter(r => r.rel === 'AttachedFile').map(r => r.attributes?.name || 'attachment'),
  };
}

/**
 * Replaces a work item's tags. The /rev test makes ADO reject the write if anyone changed the item since
 * `rev` was read, so two teammates' pollers can never both claim the same ticket.
 */
async function setTags(org, project, id, rev, tags) {
  return (await api(org, `${enc(project)}/_apis/wit/workitems/${id}?api-version=7.1`, {
    method: 'PATCH',
    type: 'application/json-patch+json',
    // `replace`, not `add`: on System.Tags, `add` appends to the existing tags instead of replacing them.
    body: [{ op: 'test', path: '/rev', value: rev }, { op: 'replace', path: '/fields/System.Tags', value: tags.join('; ') }],
  })).rev;
}
