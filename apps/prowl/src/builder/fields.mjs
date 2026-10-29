// The Builder's rows in the Config view (src/tui.mjs draws them under the Builder's switch and the Shared section).
// Every row keeps its key in config.json.
import path from 'node:path';
import { CONFIG_DIR } from '../config.mjs';

const JIRA = c => c.taskBoard === 'jira';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const opens = 'enter opens it. Updates never overwrite your edits.';
const inFile = 'Edit them in the settings file: enter opens it.';

export const BUILDER_FIELDS = [
  { heading: 'Config files' },
  { file: path.join(CONFIG_DIR, 'work.md'), label: 'Build rules', help: `How build sessions investigate, plan, build and work through review feedback. Your projects' CLAUDE.md files win over it. ${opens}` },
  { heading: 'Tags', jira: { heading: 'Labels' } },
  { key: 'builder.tags.start', label: 'Start tag', type: 'text', help: 'Tickets carrying this tag, or a near-miss spelling of it, get built.', jira: { label: 'Start label', help: 'Issues carrying this label, or a near-miss spelling of it, get built. Spaces become dashes (Ready-to-Start).' } },
  { key: 'builder.tags.inProgress', label: 'In-progress tag', type: 'text', help: 'Set while Prowl builds a ticket or works on its feedback, and while it needs you.', jira: { label: 'In-progress label', help: 'Set while Prowl builds a ticket or works on its feedback. Spaces become dashes.' } },
  { key: 'builder.tags.done', label: 'Done tag', type: 'text', help: "Set once the PRs are open, and after each feedback round. By default it is the Reviewer's trigger tag, so the Reviewer picks the ticket up.", jira: { label: 'Done label', help: "Set once the PRs are open, and after each round. By default the Reviewer's trigger label. Spaces become dashes." } },
  { key: 'builder.tags.reviewing', label: 'Reviewing tag', type: 'text', help: "While a ticket carries this or the Done tag, a review is asked for or under way, so no feedback round starts. By default the Reviewer's in-progress tag.", jira: { label: 'Reviewing label' } },
  { key: 'builder.assignedToMe', label: 'Only my tickets', type: 'bool', help: 'on: only tickets assigned to you are built. off: any ticket with the Start tag on your boards.' },
  { heading: 'Build sessions' },
  { key: 'builder.maxConcurrent', label: 'Max parallel builds', type: 'int', min: 1, max: 10, help: 'Tickets built at once, counted from the claim until their PRs open, Needs you included. Feedback rounds are not counted.' },
  { key: 'builder.approvePlans', label: 'Approve plans', type: 'enum', values: ['auto', 'ask'], help: 'auto: Prowl approves a plan with no open questions; each open question goes to Needs you. ask: every plan waits in Needs you (enter with nothing typed approves it).' },
  { key: 'builder.command', label: 'Build command', type: 'text', empty: true, emptyShows: '(the bundled prowl-work skill)', help: "A slash command to build with instead of /prowl:prowl-work, given ticket.md. It builds only, and must keep the result contract. Feedback rounds always use prowl-work." },
  { key: 'builder.model', label: 'Build model', type: 'text', empty: true, emptyShows: '(same as Model)', help: 'Model for Builder sessions. Empty: the Reviewer\'s Model.' },
  { key: 'builder.effort', label: 'Build effort', type: 'enum', values: EFFORTS, help: 'Reasoning effort for Builder sessions. enter cycles.' },
  { key: 'builder.maxBudgetUsd', label: 'Spend cap per session ($)', type: 'int', min: 0, max: 100000, help: "Stops a session once all its turns have spent this much. It goes to Needs you and isn't retried. 0 = no cap." },
  { key: 'builder.maxTurns', label: 'Turn cap per turn', type: 'int', min: 0, max: 100000, help: "Stops a session turn after this many model turns (--max-turns). It goes to Needs you. 0 = no cap." },
  { key: 'builder.timeoutMinutes', label: 'Time limit per turn (min)', type: 'int', min: 0, max: 10080, help: 'Stops a session turn that runs longer than this. It goes to Needs you. 0 = no limit.' },
  { key: 'builder.ticketBudgetUsd', label: 'Spend cap per ticket ($)', type: 'int', min: 0, max: 100000, help: 'Every Builder session on one ticket, builds and rounds. At the cap the ticket goes to Needs you. 0 = no cap.' },
  { key: 'builder.dailyBudgetUsd', label: 'Spend cap per day ($)', type: 'int', min: 0, max: 100000, help: 'Builder sessions since midnight. At the cap a ticket due a turn goes to Needs you. 0 = no cap.' },
  { key: 'builder.mcpAllow', label: 'MCP tools allowed', type: 'list', help: `MCP tools a Builder session may use, by name or with * patterns. None by default: sessions start with no MCP servers. ${inFile}` },
  { heading: 'Repos and branches' },
  { key: 'builder.extraOwners', label: 'Other owners', type: 'list', help: `GitHub owners besides the GitHub org whose repos a session may ask for. ${inFile}` },
  { key: 'builder.maxRepos', label: 'Max repos per ticket', type: 'int', min: 1, max: 50, help: 'Repos a ticket may use. A session asking for more goes to Needs you.' },
  { key: 'builder.base', label: 'Base branches', type: 'list', help: `{ "<owner/name glob>": "<branch or branch glob>" }: the first match is the base, a glob taking the highest version (release/1.10 over release/1.9). Else the plan's base, else the default branch. ${inFile}` },
  { key: 'builder.branchTemplate', label: 'Branch names', type: 'text', help: '{id} is the ticket (123 on Azure DevOps, PROJ-123 on Jira), {slug} its title. A rebuild adds -2, -3, …' },
  { key: 'builder.protectedBranches', label: 'Branches never pushed', type: 'list', help: `Globs, e.g. release/*. Prowl never pushes to these, nor to a repo's default branch. ${inFile}` },
  { key: 'builder.protectedPaths', label: 'Paths that need a person', type: 'list', help: `Globs, e.g. .github/workflows/**. A push that changes one goes to Needs you. ${inFile}` },
  { key: 'builder.maxChangedLines', label: 'Max lines changed', type: 'int', min: 1, max: 1000000, help: 'A push that changes more lines than this goes to Needs you.' },
  { key: 'builder.draftPrs', label: 'Open drafts', type: 'bool', help: 'on: PRs open as drafts, which the Reviewer leaves alone until you mark them ready. off: ready for review.' },
  { heading: 'Follow-up' },
  { key: 'builder.followUp', label: 'Follow PRs', type: 'bool', help: 'on: after the PRs open, Prowl works through review feedback in rounds and flags READY TO MERGE. Merging stays with you.' },
  { key: 'builder.fixFrom', label: 'Fix comments from', type: 'enum', values: ['prowl', 'prowl+bots', 'everyone'], help: "Whose unresolved threads a round takes on: Prowl's own, Prowl's plus bots', or everyone's. Reviews requesting changes always count." },
  { key: 'builder.maxRounds', label: 'Rounds per ticket', type: 'int', min: 1, max: 20, help: 'Feedback rounds per ticket. Then it goes to Needs you.' },
  { key: 'builder.waitForChecksMinutes', label: 'Wait for CI (min)', type: 'int', min: 0, max: 1440, help: "After a round's push, how long to wait for the required checks before marking the ticket done. A failing check gets one more turn. 0 = don't wait." },
  { key: 'builder.notify', label: 'Desktop notifications', type: 'bool', help: 'on: a notification when PRs open, a ticket is ready to merge, or one needs you.' },
  { heading: 'Jira fields', when: JIRA },
  { key: 'jira.fields.acceptanceCriteria', label: 'Acceptance criteria field', type: 'text', empty: true, emptyShows: '(none)', when: JIRA, help: "The custom field id (e.g. customfield_10042) holding acceptance criteria, for ticket.md. Empty: no such section." },
  { key: 'jira.fields.reproSteps', label: 'Repro steps field', type: 'text', empty: true, emptyShows: '(none)', when: JIRA, help: 'The custom field id holding repro steps, for ticket.md. Empty: no such section.' },
];
