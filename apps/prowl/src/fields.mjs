// The Config view's rows (src/tui.mjs draws them): every setting of the app, for both sides, in sections. Every row
// keeps its key in config.json.
// { heading } starts a section: drawn above the rows that follow it, never selected. { switch } rows turn a side on or
// off. { file } rows open one of the user's config files in its default app. 'boards' stands for the board rows. Jira
// calls tags labels: `jira` replaces the label and help shown when it is the task board.
import fs from 'node:fs';
import path from 'node:path';
import { CHECKS_PATH, CONFIG_DIR, CONFIG_PATH, EFFORTS, MODELS } from './config.mjs';

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const https = v => /^https:\/\/\S+$/.test(v) || 'must be an https:// URL';
export const ADO = c => c.taskBoard === 'ado';
export const JIRA = c => c.taskBoard === 'jira';
const opens = 'enter opens it. Updates never overwrite your edits.';
const inFile = 'Edit them in the settings file: enter opens it.';
const capped = "It fails with the cap named and isn't retried, so a runaway review isn't paid for twice.";

export const CONFIG_FIELDS = [
  { heading: 'Prowl' },
  { file: CONFIG_PATH, label: 'Settings file', help: `Every setting on this page, as JSON, each with a comment saying what it does. ${opens}` },
  { switch: 'reviewer', label: 'Reviewer', help: 'Reviews the PRs of tickets tagged for review. enter turns it on or off, at once. Off: nothing new is claimed or started, and running reviews finish.' },
  { switch: 'builder', label: 'Builder', help: 'Builds tickets tagged to start, opens their PRs and follows them through review. Its tab shows once it is on. enter turns it on or off, at once. Off: nothing new is claimed or started, and running sessions finish.' },
  { key: 'pollSeconds', label: 'Poll interval (sec)', type: 'int', min: 30, max: 86400, help: 'How often the boards are checked, and config.json re-read. r polls the side in view now.' },
  { key: 'dryRun', label: 'Dry run', type: 'bool', help: 'Log what would be reviewed or built, without changing tags or starting sessions.' },

  { heading: 'Upkeep and display' },
  { key: 'autoUpdate', label: 'Auto-update', type: 'bool', help: 'Install a newer Prowl release before launching. It waits while sessions from an earlier launch are still running.' },
  { key: 'logRetentionDays', label: 'Keep logs (days)', type: 'int', min: 0, max: 3650, help: 'Session logs older than this are deleted, and poller.log rolls over to poller.log.1 past 5 MB. Reports are always kept. 0 = keep everything.' },
  { key: 'hoot', label: 'Hoot', type: 'bool', help: 'on: Hoot the owl walks along the top of the screen (in a window 27 rows or taller) and says what Prowl is doing. off: no owl, and the Boards and Needs you cards take the full width of his strip.' },

  { heading: 'Boards' },
  { key: 'taskBoard', label: 'Task board', type: 'enum', values: ['ado', 'jira'], names: { ado: 'Azure DevOps', jira: 'Jira' }, help: 'Where tickets are watched, for both sides: Azure DevOps or Jira Cloud. enter switches. Each keeps its own boards.' },
  { key: 'ado.org', label: 'Azure DevOps org', type: 'text', when: ADO, help: 'Organization URL, e.g. https://dev.azure.com/your-org. Signed in with az login.', valid: https },
  { key: 'jira.site', label: 'Jira site', type: 'text', when: JIRA, help: 'Your Jira Cloud URL, e.g. https://yourcompany.atlassian.net.', valid: v => https(v) === true ? true : 'must be an https:// URL, e.g. https://yourcompany.atlassian.net' },
  { key: 'jira.email', label: 'Jira email', type: 'text', when: JIRA, help: 'The email you sign in to Atlassian with.', valid: v => /^[^\s@"\\]+@[^\s@"\\]+$/.test(v) || 'must be an email address' },
  { key: 'jira.token', label: 'Jira API token', type: 'secret', when: JIRA, help: 'Create one at id.atlassian.com > Security > API tokens. Kept in your OS credential store, never in the config file.' },
  'boards',

  { heading: 'Jira fields' },
  { key: 'jira.fields.acceptanceCriteria', label: 'Acceptance criteria field', type: 'text', empty: true, emptyShows: '(none)', when: JIRA, help: "The Jira custom field id (e.g. customfield_10042) holding acceptance criteria, for the Builder's ticket.md. Empty: no such section." },
  { key: 'jira.fields.reproSteps', label: 'Repro steps field', type: 'text', empty: true, emptyShows: '(none)', when: JIRA, help: "The Jira custom field id holding repro steps, for the Builder's ticket.md. Empty: no such section." },

  { heading: 'GitHub and projects' },
  { key: 'githubOwner', label: 'GitHub org', type: 'text', help: 'Open PRs whose title or description mentions the ticket (AB#123 or PROJ-123) are searched for here, and the Builder works in its repos.' },
  { key: 'workDir', label: 'Projects directory', type: 'text', help: 'Sessions run here and load its CLAUDE.md, e.g. your projects root. Repos not cloned here are cloned before use; worktrees go in its .prowl-worktrees folder.', valid: v => isDir(v) || 'folder not found' },

  // In the order a ticket meets them: built, then reviewed. The Builder hands off by setting the review trigger tag.
  { heading: 'Build tags', jira: { heading: 'Build labels' } },
  { key: 'builder.tags.start', label: 'Build start tag', type: 'text', help: 'Tickets carrying this tag, or a near-miss spelling of it, get built by the Builder.',
    jira: { label: 'Build start label', help: 'Issues carrying this label, or a near-miss spelling of it, get built by the Builder. Spaces become dashes (Ready-to-Start).' } },
  { key: 'builder.tags.inProgress', label: 'Build in-progress tag', type: 'text', help: 'Set while the Builder builds a ticket or works on its feedback, and while it needs you.',
    jira: { label: 'Build in-progress label', help: 'Set while the Builder builds a ticket or works on its feedback, and while it needs you. Spaces become dashes.' } },

  { heading: 'Review tags', jira: { heading: 'Review labels' } },
  { key: 'tags.trigger', label: 'Review trigger tag', type: 'text', help: 'Tickets carrying this tag, or a near-miss spelling of it, get reviewed. The Builder sets it once its PRs are open, and after each feedback round.',
    jira: { label: 'Review trigger label', help: 'Issues carrying this label, or a near-miss spelling of it, get reviewed. The Builder sets it once its PRs are open, and after each feedback round. Spaces become dashes.' } },
  { key: 'tags.inProgress', label: 'Review in-progress tag', type: 'text', help: "Set when a review starts. While a ticket carries it or the trigger tag, the Builder starts no feedback round. Colour it yellow in board settings > Cards > Tag colors.",
    jira: { label: 'Review in-progress label', help: 'Set when a review starts. While an issue carries it or the trigger label, the Builder starts no feedback round. Spaces become dashes (In-Review).' } },
  { key: 'tags.done', label: 'Review done tag', type: 'text', help: 'Set when a review finishes. Re-add the trigger tag to ask for a re-review.',
    jira: { label: 'Review done label', help: 'Set when a review finishes. Spaces become dashes. Re-add the trigger label to ask for a re-review.' } },
  { key: 'tagMatchMaxTypos', label: 'Tag typo tolerance', type: 'int', min: 0, max: 3, help: 'Typos (wrong, missing, extra or swapped letters) still treated as the review trigger or build start tag. Case, spaces and punctuation are always ignored. 0 = exact.',
    jira: { label: 'Label typo tolerance', help: 'Typos (wrong, missing, extra or swapped letters) still treated as the review trigger or build start label. Case, spaces and punctuation are always ignored. 0 = exact.' } },

  { heading: 'All sessions' },
  { key: 'claude.permissionMode', label: 'Permission mode', type: 'enum', values: ['auto', 'bypassPermissions'], help: 'For review and build sessions. auto lets a safety classifier block risky actions. bypassPermissions lets sessions run anything: not recommended, they read text written by other people.' },
  { key: 'allowMemoryWrites', label: 'Use memory', type: 'bool', help: "on: sessions use Claude Code's auto-memory like any session, and can add what they did to your memory files. off: they run with auto-memory off, so they neither read nor write it." },
  { key: 'caffeinate', label: 'Keep Mac awake', type: 'bool', when: () => process.platform === 'darwin', help: "on: the Mac doesn't idle-sleep while a session runs (caffeinate), since sleep stalls it and stretches it out. Closing the lid still sleeps it." },

  { heading: 'Quick reviews and builds' },
  { key: 'quickLabels', label: 'Quick reviews: GitHub labels', type: 'bool', help: "on: a quick review (n) labels its PRs In Review, then Reviewed, and waits: it re-reviews once every PR it didn't approve is labelled Ready for Review (with all approved, once one is labelled so and has new commits). Running shows the waits; s stops one. off: no labels, and a quick review runs once." },
  { key: 'quickName', label: 'Quick names', type: 'enum', values: ['auto', 'ask', 'number'], help: 'How a quick review or quick build without exactly one ticket is named. auto: a short model call names it from the paste. ask: you type the name after the paste. number: QUICK#n only. One ticket: always the ticket. enter cycles.' },
  { key: 'builder.quickBranchTemplate', label: 'Quick build branch names', type: 'text', help: 'For a quick build without a ticket: {slug} is its name. A clash adds -2, -3, …' },

  { heading: 'Reviewer · Files' },
  { file: path.join(CONFIG_DIR, 'review.md'), label: 'Review rules', help: `Reviewer stance, what reviewers look for, severity definitions, and the verdict each severity gives. Applies from the next review. ${opens}` },
  { file: path.join(CONFIG_DIR, 'output.md'), label: 'Output templates', help: `How everything posted on GitHub looks: review-started comment, banner, review body, details file, comments, replies (the Builder's too), approvals-off comment. ${opens}` },

  { heading: 'Reviewer · Sessions' },
  { key: 'maxConcurrentReviews', label: 'Max parallel reviews', type: 'int', min: 1, max: 10, help: "Extra tickets stay tagged until a slot frees, so a teammate's poller can take them." },
  { key: 'claude.model', label: 'Model', type: 'enum', values: MODELS, help: `Model for review sessions, and for build sessions while the Builder's Model is empty. enter cycles; another model id can go in the settings file.` },
  { key: 'claude.effort', label: 'Effort', type: 'enum', values: EFFORTS, help: 'Reasoning effort for review sessions. enter cycles.' },
  { key: 'ticketContext', label: 'Ticket text in reviews', type: 'bool', help: "on: the ticket's description (and, on Azure DevOps, its acceptance criteria) is added to the review's brief, so reviewers know the goal without signing in to the tracker. Up to about 6 KB." },

  { heading: 'Reviewer · Caps' },
  { key: 'claude.maxBudgetUsd', label: 'Spend cap per review ($)', type: 'int', min: 0, max: 100000, help: `Stops a review once it has spent this much. ${capped} 0 = no cap.` },
  { key: 'claude.maxTurns', label: 'Turn cap per review', type: 'int', min: 0, max: 100000, help: `Stops a review after this many turns. ${capped} 0 = no cap.` },
  { key: 'reviewTimeoutMinutes', label: 'Time cap per review (min)', type: 'int', min: 0, max: 10080, help: `Stops a review that runs longer than this, counted from its start. ${capped} 0 = no cap.` },

  { heading: 'Reviewer · Verdicts and rounds' },
  { key: 'reviewOwnPrs', label: 'Review my own PRs', type: 'bool', help: "off: a ticket with any PR you authored is left for a teammate. on: it is reviewed like any other; GitHub won't let you approve or request changes on your own PR, so those get a comment review with the verdict." },
  { key: 'approvals', label: 'Approve PRs', type: 'bool', help: 'on: a PR with no blocking findings gets a GitHub approval. off: Prowl comments that it found no blocking issues, and a human approves (text in Output templates); History flags those PRs with ⚑ until someone approves them.' },
  { key: 'maxReviewRounds', label: 'Max review rounds', type: 'int', min: 0, max: 100, help: 'Reviews per ticket. Once a ticket has had this many, Prowl leaves it tagged and unclaimed for a person, and History flags it with ⚑ round cap reached. A PR no review has covered yet is still reviewed. 0 = no cap.' },
  { key: 'reReviewScope', label: 'Re-review scope', type: 'enum', values: ['full', 'delta'], help: "full: a re-review reads each PR whole, with the whole last report. delta: only the commits since the last review, plus its still-open findings; the rest of the PR is context. enter switches." },
  { key: 'parkHumanOnly', label: 'Park human-only findings', type: 'bool', help: "on: a re-review parks an earlier finding that only a person can fix outside the code (a CI pipeline, tracker or permissions config, a product decision). It isn't re-posted, is listed under Parked in the details file, and doesn't hold up the verdict." },

  { heading: 'Builder · Files' },
  { file: path.join(CONFIG_DIR, 'build.md'), label: 'Build rules', help: `How build sessions investigate, plan, build and work through review feedback. Your projects' CLAUDE.md files win over it. ${opens}` },
  { file: CHECKS_PATH, label: 'Checks before push', help: 'Commands the Builder runs in a worktree before it pushes, per repo. The file has commented examples (a linter, pytest) to copy. Nothing matches: no checks. Never overwritten once edited. enter opens it.' },

  { heading: 'Builder · Sessions' },
  { key: 'builder.assignedToMe', label: 'Only my tickets', type: 'bool', help: 'on: only tickets assigned to you are built. off: any ticket with the build start tag on your boards.' },
  { key: 'builder.maxConcurrent', label: 'Max parallel builds', type: 'int', min: 1, max: 10, help: 'Tickets built at once, counted from the claim until their PRs open, Needs you included. Feedback rounds are not counted.' },
  { key: 'builder.approvePlans', label: 'Approve plans', type: 'enum', values: ['auto', 'ask'], help: 'auto: Prowl approves a plan with no open questions; each open question goes to Needs you. ask: every plan waits in Needs you (enter with nothing typed approves it).' },
  { key: 'builder.model', label: 'Model', type: 'enum', values: ['', ...MODELS], empty: true, emptyShows: "(the Reviewer's Model)", help: "Model for build sessions, or the Reviewer's Model. enter cycles; another model id can go in the settings file." },
  { key: 'builder.effort', label: 'Effort', type: 'enum', values: EFFORTS, help: 'Reasoning effort for build sessions. enter cycles.' },
  { key: 'builder.mcpAllow', label: 'MCP tools allowed', type: 'list', help: `MCP tools a build session may use, by name or with * patterns. None by default: sessions start with no MCP servers. ${inFile}` },

  { heading: 'Builder · Caps' },
  { key: 'builder.maxBudgetUsd', label: 'Spend cap per session ($)', type: 'int', min: 0, max: 100000, help: "Stops a session once all its turns have spent this much. It goes to Needs you and isn't retried. 0 = no cap." },
  { key: 'builder.ticketBudgetUsd', label: 'Spend cap per ticket ($)', type: 'int', min: 0, max: 100000, help: 'Every build session on one ticket, builds and rounds. At the cap the ticket goes to Needs you. 0 = no cap.' },
  { key: 'builder.dailyBudgetUsd', label: 'Spend cap per day ($)', type: 'int', min: 0, max: 100000, help: 'Build sessions since midnight. At the cap a ticket due a turn goes to Needs you. 0 = no cap.' },
  { key: 'builder.maxTurns', label: 'Turn cap per session turn', type: 'int', min: 0, max: 100000, help: 'Stops a session turn (the build, or one feedback round) after this many model turns (--max-turns). It goes to Needs you. 0 = no cap.' },
  { key: 'builder.timeoutMinutes', label: 'Time cap per session turn (min)', type: 'int', min: 0, max: 10080, help: 'Stops a session turn (the build, or one feedback round) that runs longer than this. It goes to Needs you. 0 = no cap.' },

  { heading: 'Builder · Repos' },
  { key: 'builder.extraOwners', label: 'Other GitHub owners', type: 'list', help: `GitHub owners besides the GitHub org whose repos a session may ask for. ${inFile}` },
  { key: 'builder.maxRepos', label: 'Max repos per ticket', type: 'int', min: 1, max: 50, help: 'Repos a ticket may use. A session asking for more goes to Needs you.' },
  { key: 'builder.base', label: 'Base branches', type: 'list', help: `{ "<owner/name glob>": "<branch or branch glob>" }: the first match is the base, a glob taking the highest version (release/1.10 over release/1.9). Else the plan's base, else the default branch. ${inFile}` },

  { heading: 'Builder · Branches' },
  { key: 'builder.branchTemplate', label: 'Branch names', type: 'text', help: '{id} is the ticket (123 on Azure DevOps, PROJ-123 on Jira), {slug} its title. A rebuild adds -2, -3, …' },
  { key: 'builder.protectedBranches', label: 'Protected branches', type: 'list', help: `Globs, e.g. release/*. Prowl never pushes to these, nor to a repo's default branch. ${inFile}` },

  { heading: 'Builder · Pushes and PRs' },
  { key: 'builder.protectedPaths', label: 'Protected paths', type: 'list', help: `Globs, e.g. .github/workflows/**. A push that changes one goes to Needs you. ${inFile}` },
  { key: 'builder.maxChangedLines', label: 'Max lines per push', type: 'int', min: 1, max: 1000000, help: 'A push that changes more lines than this goes to Needs you.' },
  { key: 'builder.draftPrs', label: 'Open PRs as drafts', type: 'bool', help: 'on: PRs open as drafts, which the Reviewer leaves alone until you mark them ready. off: ready for review.' },
  { key: 'builder.requestReview', label: 'Tag for review when done', type: 'bool', help: "on: once the PRs open, and after each feedback round, In Development is swapped for the Review trigger tag, so the Reviewer reviews them. off: In Development just comes off, and asking for a review is up to you." },

  { heading: 'Builder · Pick-up' },
  { key: 'builder.pickup.drafts', label: 'Pick up drafts', type: 'bool', help: "on: when the Builder claims a ticket, your draft PRs for it count as work started: continued, and given fix rounds. off: drafts are left alone, as they are by the Reviewer." },
  { key: 'builder.pickup.branches', label: 'Pick up branches', type: 'bool', help: "on: your pushed branches with no PR, named with the ticket's number (feature/12345-x, fix/AB12345; not 123456) or linked on the ticket, count as work started: continued, and a PR opened. Only branches with your commits ahead of the base, on GitHub." },
  { key: 'builder.pickup.checks', label: 'Fix failing checks', type: 'bool', help: "on: a picked-up PR whose required checks fail gets a fix round first, with the failed job's log. Only at pick-up." },
  { key: 'builder.pickup.conflicts', label: 'Fix conflicts', type: 'bool', help: 'on: a picked-up PR that conflicts with its base gets a fix round first, which merges the base in (never a rebase). Only at pick-up; while GitHub is still working it out, the next poll reads it again.' },

  { heading: 'Builder · Follow-up' },
  { key: 'builder.followUp', label: 'Follow PRs', type: 'bool', help: 'on: after the PRs open, Prowl works through review feedback in rounds and flags READY TO MERGE. Merging stays with you.' },
  { key: 'builder.fixFrom', label: 'Fix comments from', type: 'enum', values: ['prowl', 'prowl+bots', 'everyone'], help: "Whose unresolved threads a round takes on: Prowl's own, Prowl's plus bots', or everyone's. Reviews requesting changes always count." },
  { key: 'builder.maxRounds', label: 'Max feedback rounds', type: 'int', min: 1, max: 20, help: 'Feedback rounds per ticket. Then it goes to Needs you.' },
  { key: 'builder.waitForChecksMinutes', label: 'Wait for CI (min)', type: 'int', min: 0, max: 1440, help: "After a round's push, how long to wait for the required checks before marking the ticket done. A failing check gets one more turn. 0 = don't wait." },
  { key: 'builder.notify', label: 'Desktop notifications', type: 'bool', help: 'on: a notification when PRs open, a ticket is ready to merge, or one needs you.' },
];
