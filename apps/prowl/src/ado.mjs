import { swapTags } from './match.mjs';
import { run } from './proc.mjs';

// Azure DevOps REST, authenticated with the az CLI login (`az login`). No PAT, no az extension.
export const name = 'Azure DevOps';
const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798'; // Azure DevOps' Entra ID application
const tokens = new Map(); // org -> { value, expires }

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
const toItem = w => ({ id: w.id, rev: w.rev, title: w.fields['System.Title'] || '', tags: splitTags(w.fields['System.Tags']) });
const splitTags = field => String(field || '').split(';').map(t => t.trim()).filter(Boolean);

export const workItemUrl = (org, project, id) => `${org.replace(/\/+$/, '')}/${enc(project)}/_workitems/edit/${id}`;
export const boardLabel = b => `${b.project} / ${b.team}`;

/** Checks the sign-in by reading the org's identity for you. */
export async function whoAmI(cfg) {
  return (await api(cfg.ado.org, '_apis/connectionData')).authenticatedUser?.providerDisplayName || 'signed in';
}

/** Open work items on the board carrying a tag `isTrigger` accepts. */
export async function findTickets(cfg, board, isTrigger) {
  const { org } = cfg.ado;
  const [scope, tags] = await Promise.all([boardScope(org, board.project, board.team), projectTags(org, board.project)]);
  const variants = tags.filter(isTrigger);
  const items = variants.length ? await findTagged(org, board.project, scope, variants) : [];
  const tickets = items.map(item => ({
    key: `AB#${item.id}`, title: item.title, url: workItemUrl(org, board.project, item.id), tags: item.tags, rev: item.rev,
    ref: { org, project: board.project, id: item.id },
  }));
  return { tickets, variants };
}

/** The work item for a key (AB#123 or 123), for prowl --watch. */
export async function lookup(cfg, key) {
  const id = Number(String(key).replace(/^AB#/i, ''));
  if (!Number.isInteger(id) || id <= 0) throw new Error(`${key} isn't an Azure DevOps work item: use AB#123`);
  const { fields } = await api(cfg.ado.org, `_apis/wit/workitems/${id}?fields=System.Title,System.TeamProject&api-version=7.1`);
  const project = fields['System.TeamProject'];
  return { key: `AB#${id}`, title: fields['System.Title'] || '', url: workItemUrl(cfg.ado.org, project, id), ref: { org: cfg.ado.org, project, id } };
}

/** Swaps the trigger tag for the in-progress one; the revision check makes it fail if anyone got there first. */
export const claim = (cfg, ticket, drop, add) =>
  setTags(ticket.ref.org, ticket.ref.project, ticket.ref.id, ticket.rev, swapTags(ticket.tags, drop, add));

/** Replaces the tags Prowl owns (`drop`) with `add` ('' = none) on a ticket a review ran for. */
export async function retag(cfg, ref, drop, add) {
  const item = await getItem(ref.org, ref.project, ref.id);
  await setTags(ref.org, ref.project, ref.id, item.rev, swapTags(item.tags, drop, add));
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
async function findTagged(org, project, scope, tags) {
  const tree = scope.field === 'System.AreaPath';
  const onBoard = scope.values.map(v => `[${scope.field}] ${tree && v.includeChildren ? 'UNDER' : '='} ${wiqlString(v.value)}`).join(' OR ');
  const tagged = tags.map(t => `[System.Tags] CONTAINS ${wiqlString(t)}`).join(' OR ');
  const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND (${onBoard}) AND (${tagged}) AND [System.State] NOT IN ('Closed', 'Done', 'Removed')`;
  const ids = (await api(org, `${enc(project)}/_apis/wit/wiql?api-version=7.1`, { method: 'POST', body: { query } })).workItems.map(w => w.id);
  const items = [];
  for (let i = 0; i < ids.length; i += 200) {
    const page = await api(org, `${enc(project)}/_apis/wit/workitems?ids=${ids.slice(i, i + 200).join(',')}&fields=System.Title,System.Tags&api-version=7.1`);
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
  return toItem(await api(org, `${enc(project)}/_apis/wit/workitems/${id}?fields=System.Title,System.Tags&api-version=7.1`));
}

/**
 * Replaces a work item's tags. The /rev test makes ADO reject the write if anyone changed the item since
 * `rev` was read, so two teammates' pollers can never both claim the same ticket.
 */
async function setTags(org, project, id, rev, tags) {
  await api(org, `${enc(project)}/_apis/wit/workitems/${id}?api-version=7.1`, {
    method: 'PATCH',
    type: 'application/json-patch+json',
    // `replace`, not `add`: on System.Tags, `add` appends to the existing tags instead of replacing them.
    body: [{ op: 'test', path: '/rev', value: rev }, { op: 'replace', path: '/fields/System.Tags', value: tags.join('; ') }],
  });
}
