// The Config view's rows (src/tui.mjs draws them): every setting of the app, for both sides, in sections. Every row
// keeps its key in config.json.
// { heading } starts a section: drawn above the rows that follow it, never selected. { switch } rows turn a side on or
// off. { file } rows open one of the user's config files in its default app. 'boards' stands for the board rows. Jira
// calls tags labels: `jira` replaces the label and help shown when it is the task board.
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_MODELS, CHECKS_PATH, CONFIG_DIR, CONFIG_PATH, EFFORTS, MODEL_SHORT_NAMES, MODELS, modelValid } from './config.mjs';

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const https = v => /^https:\/\/\S+$/.test(v) || 'must be an https:// URL';
export const ADO = c => c.taskBoard === 'ado';
export const JIRA = c => c.taskBoard === 'jira';
const opens = 'enter opens it. Updates never overwrite your edits.';
const inFile = 'Edit them in the settings file: enter opens it.';
const capped = "It fails with the cap named and isn't retried, so a runaway review isn't paid for twice.";

const sameAsLabel = 'The same name as the GitHub label, so a ticket and a PR read alike.';
const jiraForm = 'Written without colons and with dashes for spaces (prowl-in-review).';

export const CONFIG_FIELDS = [
  { heading: 'Prowl' },
  { switch: 'reviewer', label: 'Reviewer', help: 'Reviews labelled PRs and the PRs of tagged tickets. enter turns it on or off, at once. Off: nothing new is claimed or started, and running reviews finish.' },
  { switch: 'builder', label: 'Builder', help: 'Builds tickets tagged to start, opens their PRs and follows them through review. Its tab shows once it is on. enter turns it on or off, at once. Off: nothing new is claimed or started, and running sessions finish.' },
  { key: 'pollSeconds', label: 'Poll interval (sec)', type: 'int', min: 30, max: 86400, help: 'How often GitHub and the boards are checked. r polls the side in view now.' },
  { key: 'dryRun', label: 'Dry run', type: 'bool', help: 'Log what would be reviewed or built, without changing tags or starting sessions.' },

  { heading: 'Upkeep and display' },
  { key: 'autoUpdate', label: 'Auto-update', type: 'bool', help: 'Install a newer Prowl release before launching. It waits while sessions from an earlier launch are still running.' },
  { key: 'logRetentionDays', label: 'Keep logs (days)', type: 'int', min: 0, max: 3650, help: 'Session logs older than this are deleted, and poller.log rolls over to poller.log.1 past 5 MB. Reports are always kept. 0 = keep everything.' },
  { key: 'hoot', label: 'Hoot', type: 'bool', help: 'on: Hoot the owl sits at the top of the screen (in a window 27 rows or taller) and says what Prowl is doing. off: no owl, and the Boards and Needs you cards take the full width of his strip.' },
  { key: 'notifyVia', label: 'Notify via', type: 'enum', values: ['auto', 'desktop', 'bell'], help: "How Prowl's notifications (the Builder's Notifications) reach you. auto: a desktop notification where one works (macOS, Windows, WSL through Windows, Linux with notify-send), else the terminal bell. desktop: only a desktop notification. bell: only the terminal bell, which your terminal shows its own way. enter lists them." },
  { key: 'mouse', label: 'Mouse', type: 'bool', help: "on: click tabs, rows, links and the buttons at the bottom, and see what a click would do light up under the pointer; click a selected row for what enter does; drag over text to copy it; the wheel scrolls the text under it, and elsewhere moves the selection. off: the mouse is your terminal's: its own selection, copy and scrolling, and its own way of opening links." },

  { heading: 'Boards' },
  { key: 'taskBoard', label: 'Task board', type: 'enum', values: ['ado', 'jira'], names: { ado: 'Azure DevOps', jira: 'Jira' }, help: 'Where tickets are watched, for both sides: Azure DevOps or Jira Cloud. enter lists them. Each keeps its own boards.' },
  { key: 'ado.org', label: 'Azure DevOps org', type: 'text', when: ADO, help: 'Organization URL, e.g. https://dev.azure.com/your-org. Signed in with az login.', valid: https },
  { key: 'jira.site', label: 'Jira site', type: 'text', when: JIRA, help: 'Your Jira Cloud URL, e.g. https://yourcompany.atlassian.net.', valid: v => https(v) === true ? true : 'must be an https:// URL, e.g. https://yourcompany.atlassian.net' },
  { key: 'jira.email', label: 'Jira email', type: 'text', when: JIRA, help: 'The email you sign in to Atlassian with.', valid: v => /^[^\s@"\\]+@[^\s@"\\]+$/.test(v) || 'must be an email address' },
  { key: 'jira.token', label: 'Jira API token', type: 'secret', when: JIRA, help: 'Create one at id.atlassian.com > Security > API tokens. Kept in your OS credential store, never in the config file.' },
  'boards',

  { heading: 'Jira fields' },
  { key: 'jira.fields.acceptanceCriteria', label: 'Acceptance criteria field', type: 'text', empty: true, emptyShows: '(none)', when: JIRA, help: "The Jira custom field id (e.g. customfield_10042) holding acceptance criteria, for the Builder's ticket.md. Empty: no such section." },
  { key: 'jira.fields.reproSteps', label: 'Repro steps field', type: 'text', empty: true, emptyShows: '(none)', when: JIRA, help: "The Jira custom field id holding repro steps, for the Builder's ticket.md. Empty: no such section." },

  { heading: 'GitHub and projects' },
  { key: 'githubOwner', label: 'GitHub org', type: 'text', help: 'Open PRs whose title or description mentions the ticket (AB#123 or PROJ-123) are searched for here; a tagged review takes those whose title names it alone. The Builder works in its repos.' },
  { key: 'workDir', label: 'Projects directory', type: 'text', help: 'Sessions run here and load its CLAUDE.md, e.g. your projects root. Repos not cloned here are cloned before use; worktrees go in its .prowl-worktrees folder.', valid: v => isDir(v) || 'folder not found' },

  // In the order a ticket meets them: built, then reviewed. The Builder hands off by setting the review trigger tag.
  { heading: 'Tags and labels', jira: { heading: 'Labels' } },
  { rule: 'Build tags', jira: { rule: 'Build labels' } },
  { key: 'builder.tags.start', label: 'Build start tag', type: 'text', tag: true, readonly: true, help: 'Tickets carrying this tag, or a near-miss spelling of it, get built by the Builder.',
    jira: { label: 'Build start label', help: `Issues carrying this label, or a near-miss spelling of it, get built by the Builder. ${jiraForm}` } },
  { key: 'builder.tags.inProgress', label: 'Build in-progress tag', type: 'text', tag: true, readonly: true, help: `Set while the Builder builds a ticket or works on its feedback, and while it needs you. ${sameAsLabel}`,
    jira: { label: 'Build in-progress label', help: `Set while the Builder builds a ticket or works on its feedback, and while it needs you. ${sameAsLabel} ${jiraForm}` } },

  { rule: 'Review tags', jira: { rule: 'Review labels' } },
  { key: 'tags.trigger', label: 'Review trigger tag', type: 'text', tag: true, readonly: true, help: `Tickets carrying this tag, or a near-miss spelling of it, get reviewed. The Builder sets it once its PRs are open, and after each feedback round. ${sameAsLabel}`,
    jira: { label: 'Review trigger label', help: `Issues carrying this label, or a near-miss spelling of it, get reviewed. The Builder sets it once its PRs are open, and after each feedback round. ${sameAsLabel} ${jiraForm}` } },
  { key: 'tags.inProgress', label: 'Review in-progress tag', type: 'text', tag: true, readonly: true, help: `Set when a review starts. While a ticket carries it or the trigger tag, the Builder starts no feedback round. ${sameAsLabel} Colour it yellow in board settings > Cards > Tag colors.`,
    jira: { label: 'Review in-progress label', help: `Set when a review starts. While an issue carries it or the trigger label, the Builder starts no feedback round. ${sameAsLabel} ${jiraForm}` } },
  { key: 'tags.approved', label: 'Review approved tag', type: 'text', tag: true, readonly: true, help: `Set when a review finishes with every PR approved. Re-add the trigger tag to ask for a re-review. ${sameAsLabel}`,
    jira: { label: 'Review approved label', help: `Set when a review finishes with every PR approved. Written as prowl-approved. Re-add the trigger label to ask for a re-review. ${sameAsLabel}` } },
  { key: 'tags.changes', label: 'Review changes tag', type: 'text', tag: true, readonly: true, help: `Set when a review finishes with at least one PR not approved. The Builder then works through the feedback; re-add the trigger tag to ask for a re-review. ${sameAsLabel}`,
    jira: { label: 'Review changes label', help: `Set when a review finishes with at least one PR not approved. The Builder then works through the feedback; re-add the trigger label to ask for a re-review. Written as prowl-changes-requested. ${sameAsLabel}` } },
  { rule: 'GitHub labels' },
  { key: 'reviewLabel', label: 'Review label', type: 'text', empty: true, emptyShows: "(the Review trigger tag's name)", readonly: true, help: "The GitHub label that asks for a review of a PR. The Reviewer polls for it when GitHub reviews is on. A waiting quick review uses it for its next round, and a quick build without a ticket puts it on its PRs when it hands them on. Matched exactly, ignoring case. Empty: the Review trigger tag's name." },
  { key: 'labels.inReview', label: 'In review label', type: 'text', readonly: true, help: 'Set on each PR while a review of it runs.' },
  { key: 'labels.approved', label: 'Approved label', type: 'text', readonly: true, help: 'Set on a PR when its review ends with nothing blocking it.' },
  { key: 'labels.changes', label: 'Changes requested label', type: 'text', readonly: true, help: 'Set on a PR when its review ends with a finding that blocks it.' },
  { key: 'labels.building', label: 'Building label', type: 'text', readonly: true, help: 'Set on the PRs of a quick build without a ticket while the Builder works on them.' },
  { key: 'tagMatchMaxTypos', label: 'Tag typo tolerance', type: 'int', min: 0, max: 3, help: 'Typos (wrong, missing, extra or swapped letters) still treated as the review trigger or build start tag. Case, spaces and punctuation are always ignored. 0 = exact.',
    jira: { label: 'Label typo tolerance', help: 'Typos (wrong, missing, extra or swapped letters) still treated as the review trigger or build start label. Case, spaces and punctuation are always ignored. 0 = exact.' } },

  { heading: 'All sessions' },
  { key: 'claude.permissionMode', label: 'Permission mode', type: 'enum', values: ['auto', 'bypassPermissions'], help: 'For review and build sessions. auto lets a safety classifier block risky actions. bypassPermissions lets sessions run anything: not recommended, they read text written by other people.' },
  { key: 'allowMemoryWrites', label: 'Use memory', type: 'bool', help: "on: sessions use Claude Code's auto-memory like any session, and can add what they did to your memory files. off: they run with auto-memory off, so they neither read nor write it." },
  { key: 'caffeinate', label: 'Keep Mac awake', type: 'bool', when: () => process.platform === 'darwin', help: "on: the Mac doesn't idle-sleep while a session runs (caffeinate), since sleep stalls it and stretches it out. Closing the lid still sleeps it." },

  { heading: 'GitHub reviews' },
  { key: 'githubReviews', label: 'GitHub reviews', type: 'bool', help: 'Poll GitHub for open PRs carrying the Review label, even with no boards configured. Board reviews also label their PRs through the review.' },

  { heading: 'Quick reviews and builds' },
  { key: 'quickLabels', label: 'Quick reviews: GitHub labels', type: 'bool', help: "on: a quick review (n) labels its PRs 'prowl: in review', then 'prowl: approved' or 'prowl: changes requested', and waits: it re-reviews once every PR it didn't approve is labelled 'prowl: review' (with all approved, once one is labelled so and has new commits). Running shows the waits; s stops one. off: no labels, and a quick review runs once." },
  { key: 'quickName', label: 'Quick names', type: 'enum', values: ['auto', 'ask', 'number'], help: 'How a quick review or quick build without exactly one ticket is named. auto: a short model call names it from the paste. ask: you type the name after the paste. number: QUICK#n only. One ticket: always the ticket. enter lists them.' },
  { key: 'builder.quickBranchTemplate', label: 'Quick build branch names', type: 'text', help: 'For a quick build without a ticket: {slug} is its name. A clash adds -2, -3, …' },

  { heading: 'Models and efforts' },
  { rule: 'Review sessions' },
  { key: 'claude.model', label: 'Reviewer model', type: 'enum', values: [...MODELS, ...Object.keys(MODEL_SHORT_NAMES)], names: MODEL_SHORT_NAMES, other: true, valid: modelValid,
    help: "Model for review sessions, and for build sessions while the Builder's Model is empty. enter lists them: each current model's full ID, then the names Claude Code takes for the latest of each. Other… takes a name the list doesn't have, typed." },
  { key: 'claude.effort', label: 'Reviewer effort', type: 'enum', values: EFFORTS, help: 'Reasoning effort for review sessions. enter lists them.' },
  { key: 'claude.orchestratorModel', label: 'Orchestrator model', type: 'enum', values: ['', ...MODELS], empty: true, emptyShows: 'same as Reviewer model', help: "Model for the review session itself, which orchestrates: it reads the PRs, writes the brief and each PR's spec, routes findings to verifiers and writes the report. It runs many turns, so it is a large part of a review's cost. Same as Reviewer model: the session and its reviewers run on Reviewer model. Set to another, the session runs on it and each reviewer is launched on Reviewer model by its short name, so Reviewer model must then be sonnet, opus, haiku or fable, or one of the full IDs this list offers; with any other (an older ID, one with a suffix, another provider's name) the Log warns and the session stays on Reviewer model. What the session does itself moves with it: mapping a large batch, and checking a Low or Nit finding whose defect is plain from its quote. Verifier settings left on Claude Code default follow Reviewer model and effort. enter lists them; another model id can go in the settings file." },
  { key: 'claude.orchestratorEffort', label: 'Orchestrator effort', type: 'enum', values: ['', ...EFFORTS], empty: true, emptyShows: 'same as Reviewer effort', help: 'Reasoning effort for the review session itself (see Orchestrator model). Same as Reviewer effort: nothing changes. Set to another, each reviewer is launched at Reviewer effort. enter lists them.' },
  { rule: 'Verifiers' },
  { key: 'claude.verifierModel', label: 'Verifier model', type: 'enum', values: [...AGENT_MODELS, ''], empty: true, emptyShows: 'Claude Code default', help: "Model for the subagents that check each finding before it's posted. Claude Code default: no model is set for them, so they run on the review session's model unless your Claude Code settings name a default subagent model. A finding no reviewer investigated is always checked by a verifier launched as reviewers are. enter lists them." },
  { key: 'claude.verifierEffort', label: 'Verifier effort', type: 'enum', values: [...EFFORTS, ''], empty: true, emptyShows: 'Claude Code default', help: "Reasoning effort for the verifier subagents. Claude Code default: none is set for them, and they run at Claude Code's usual effort for subagents. enter lists them." },
  { rule: 'Small re-reviews' },
  { key: 'smallReReviewModel', label: 'Small re-review model', type: 'enum', values: AGENT_MODELS, help: 'Model for the reviewer of a small delta re-review (Small re-review lines). Pick one smaller than Model, or there is nothing to save. Its effort is Small re-review effort. enter lists them.' },
  { key: 'smallReReviewEffort', label: 'Small re-review effort', type: 'enum', values: [...EFFORTS, ''], empty: true, emptyShows: 'Same as the reviewers', help: "Reasoning effort for the reviewer of a small delta re-review. Same as the reviewers: it runs at the effort every other reviewer does. A small fix still has to be checked for new problems, so don't set it lower than you'd trust. enter lists them." },
  { rule: 'Builder' },
  { key: 'builder.model', label: 'Model', type: 'enum', values: ['', ...MODELS, ...Object.keys(MODEL_SHORT_NAMES)], names: { '': "(the Reviewer's Model)", ...MODEL_SHORT_NAMES }, empty: true, emptyShows: "(the Reviewer's Model)", other: true, valid: v => v === '' || modelValid(v),
    help: "Model for build sessions. enter lists them: the Reviewer's Model, each current model's full ID, then the names for the latest of each. Other… takes a name the list doesn't have, typed." },
  { key: 'builder.effort', label: 'Effort', type: 'enum', values: EFFORTS, help: 'Reasoning effort for build sessions. enter lists them.' },

  { heading: 'Caps' },
  { rule: 'Reviewer' },
  { key: 'claude.maxBudgetUsd', label: 'Spend cap per review ($)', type: 'int', min: 0, max: 100000, help: `Stops a review once it has spent this much. ${capped} 0 = no cap.` },
  { key: 'claude.maxTurns', label: 'Turn cap per review', type: 'int', min: 0, max: 100000, help: `Stops a review after this many turns. ${capped} 0 = no cap.` },
  { key: 'reviewTimeoutMinutes', label: 'Time cap per review (min)', type: 'int', min: 0, max: 10080, help: `Stops a review that runs longer than this, counted from when its session starts (Prowl's own setup isn't counted). ${capped} 0 = no cap.` },
  { key: 'maxReviewRounds', label: 'Max review rounds', type: 'int', min: 0, max: 100, help: "Reviews per ticket, counting your teammates' Prowls' reviews too (from the hand-over notes they leave on the PRs). Once a ticket has had this many, Prowl leaves it tagged and unclaimed for a person, and History flags it with ⚑ round cap reached. A PR no review has covered yet is still reviewed. 0 = no cap." },
  { key: 'maxConcurrentReviews', label: 'Max parallel reviews', type: 'int', min: 1, max: 10, help: "Extra tickets stay tagged until a slot frees, so a teammate's poller can take them." },
  { rule: 'Builder' },
  { key: 'builder.maxBudgetUsd', label: 'Spend cap per session ($)', type: 'int', min: 0, max: 100000, help: "Stops a session once all its turns have spent this much. It goes to Needs you and isn't retried. 0 = no cap." },
  { key: 'builder.ticketBudgetUsd', label: 'Spend cap per ticket ($)', type: 'int', min: 0, max: 100000, help: 'Every build session on one ticket, builds and rounds. At the cap the ticket goes to Needs you. 0 = no cap.' },
  { key: 'builder.dailyBudgetUsd', label: 'Spend cap per day ($)', type: 'int', min: 0, max: 100000, help: 'Build sessions since midnight. At the cap a ticket due a turn goes to Needs you. 0 = no cap.' },
  { key: 'builder.maxTurns', label: 'Turn cap per session turn', type: 'int', min: 0, max: 100000, help: 'Stops a session turn (the build, or one feedback round) after this many model turns (--max-turns). It goes to Needs you. 0 = no cap.' },
  { key: 'builder.timeoutMinutes', label: 'Time cap per session turn (min)', type: 'int', min: 0, max: 10080, help: 'Stops a session turn (the build, or one feedback round) that runs longer than this. It goes to Needs you. 0 = no cap.' },
  { key: 'builder.maxRounds', label: 'Max feedback rounds', type: 'int', min: 1, max: 20, help: 'Feedback rounds per ticket. Then it goes to Needs you.' },
  { key: 'builder.maxConcurrent', label: 'Max parallel builds', type: 'int', min: 1, max: 10, help: 'Tickets built at once, counted from the claim until their PRs open, Needs you included. Feedback rounds are not counted.' },
  { key: 'builder.maxChangedLines', label: 'Max lines per push', type: 'int', min: 1, max: 1000000, help: 'A push that changes more lines than this goes to Needs you.' },

  { heading: 'Files' },
  { rule: 'Settings file' },
  { file: CONFIG_PATH, label: 'Settings file', help: `Every setting on this page, as JSON, each with a comment saying what it does. ${opens}` },
  { rule: 'Reviewer' },
  { file: path.join(CONFIG_DIR, 'review.md'), label: 'Review rules', help: `Reviewer stance, what reviewers look for, severity definitions, and the verdict each severity gives. Applies from the next review. ${opens}` },
  { file: path.join(CONFIG_DIR, 'output.md'), label: 'Output templates', help: `How everything posted on GitHub looks: review-started and review-finished comments, banner, review body, details file, comments, replies (the Builder's too), approvals-off comment. ${opens}` },
  { rule: 'Builder' },
  { file: path.join(CONFIG_DIR, 'build.md'), label: 'Build rules', help: `How build sessions investigate, plan, build and work through review feedback. Your projects' CLAUDE.md files win over it. ${opens}` },
  { file: CHECKS_PATH, label: 'Checks', help: 'Commands Prowl runs in a worktree, per repo: the Builder before it pushes, and the Reviewer before a review (Build and test before reviews). The file has commented examples to copy. Nothing matches: no checks. Never overwritten once edited. enter opens it.' },

  { heading: 'Reviewer · Sessions' },
  { key: 'ticketContext', label: 'Ticket text in reviews', type: 'bool', help: "on: the ticket's description (and, on Azure DevOps, its acceptance criteria) is added to the review's brief, so reviewers know the goal without signing in to the tracker. Up to about 6 KB." },
  { key: 'reviewPrep', label: 'Prepare PRs before reviews', type: 'bool', help: "on: before a review's session starts, Prowl fetches each PR's head, checks it out in a worktree outside the Projects Directory (your clones' checkouts are never touched) and writes its diff, facts and comments to files, so reviewers read real code from disk. The worktrees are removed when the review ends. off: the session fetches everything itself." },
  { key: 'reviewChecks', label: 'Build and test before reviews', type: 'bool', help: 'on: before a review, Prowl runs checks.json\'s steps for each PR (its review block, or its run commands) in a worktree of the repo, reruns a failed step at the merge base, and gives the review the results. A repo checks.json doesn\'t match, or marks "review": false, isn\'t built.' },

  { heading: 'Reviewer · Verdicts and rounds' },
  { key: 'reviewOwnPrs', label: 'Review my own PRs', type: 'bool', help: "off: a ticket with any PR you authored is left for a teammate. on: it is reviewed like any other; GitHub won't let you approve or request changes on your own PR, so those get a comment review with the verdict." },
  { key: 'approvals', label: 'Approve PRs', type: 'bool', help: 'on: a PR with no blocking findings gets a GitHub approval. off: Prowl comments that it found no blocking issues, and a human approves (text in Output templates); History flags those PRs with ⚑ until someone approves them.' },
  { key: 'requestChanges', label: 'Request changes', type: 'bool', help: "on: a PR with blocking findings gets a GitHub Request changes review, which blocks merging until the same reviewer approves or someone dismisses it. off: the same review, findings and verdict, posted as a comment, so the PR isn't held up when whoever's Prowl reviewed it is away. Requests already on a PR stay until dismissed." },
  { key: 'reReviewScope', label: 'Re-review scope', type: 'enum', values: ['full', 'delta'], help: "full: a re-review reads each PR whole, with the whole last report. delta: only the commits since the last review, plus its still-open findings; the rest of the PR is context. enter lists them." },
  { key: 'smallReReviewLines', label: 'Small re-review (lines)', type: 'int', min: 0, max: 100000, help: "Delta re-reviews only. A PR whose commits since the last review change at most this many lines (added plus deleted, in the PR's own files) gets its reviewer on Small re-review model; a larger one, or one force-pushed since, gets Model as usual. Decided per PR. 0 = off." },
  { key: 'parkHumanOnly', label: 'Park human-only findings', type: 'bool', help: "on: an earlier finding that only a person can settle outside the code (a CI pipeline, tracker or permissions config, a product decision) is parked: it gets no further reply, is listed under Parked in the details file, and doesn't count toward the verdict. off: it counts, and holds the verdict, until it is fixed. A thread a person answered (declined it, accepted the risk, deferred it to a ticket) is parked either way, and stays parked until the code is fixed or someone disputes the answer." },

  { heading: 'Builder · Sessions' },
  { key: 'builder.assignedToMe', label: 'Only my tickets', type: 'bool', help: 'on: only tickets assigned to you are built. off: any ticket with the build start tag on your boards.' },
  { key: 'builder.approvePlans', label: 'Approve plans', type: 'enum', values: ['auto', 'ask'], help: 'auto: Prowl approves a plan with no open questions; each open question goes to Needs you. ask: every plan waits in Needs you (enter with nothing typed approves it).' },
  { key: 'builder.mcpAllow', label: 'MCP tools allowed', type: 'list', help: `MCP tools a build session may use, by name or with * patterns. None by default: sessions start with no MCP servers. ${inFile}` },

  { heading: 'Builder · Repos' },
  { key: 'builder.extraOwners', label: 'Other GitHub owners', type: 'list', help: `GitHub owners besides the GitHub org whose repos a session may ask for. ${inFile}` },
  { key: 'builder.maxRepos', label: 'Max repos per ticket', type: 'int', min: 1, max: 50, help: 'Repos a ticket may use. A session asking for more goes to Needs you.' },
  { key: 'builder.base', label: 'Base branches', type: 'list', help: `{ "<owner/name glob>": "<branch or branch glob>" }: the first match is the base, a glob taking the highest version (release/1.10 over release/1.9). Else the plan's base, else the default branch. ${inFile}` },

  { heading: 'Builder · Branches' },
  { key: 'builder.branchTemplate', label: 'Branch names', type: 'text', help: '{id} is the ticket (123 on Azure DevOps, PROJ-123 on Jira), {slug} its title. A rebuild adds -2, -3, …' },
  { key: 'builder.protectedBranches', label: 'Protected branches', type: 'list', help: `Globs, e.g. release/*. Prowl never pushes to these, nor to a repo's default branch. ${inFile}` },

  { heading: 'Builder · Pushes and PRs' },
  { key: 'builder.protectedPaths', label: 'Protected paths', type: 'list', help: `Globs, e.g. .github/workflows/**. A push that changes one goes to Needs you. ${inFile}` },
  { key: 'builder.draftPrs', label: 'Open PRs as drafts', type: 'bool', help: 'on: PRs open as drafts, which the Reviewer leaves alone until you mark them ready. off: ready for review.' },
  { key: 'builder.requestReview', label: 'Tag for review when done', type: 'bool', help: "When PRs open and after each feedback round, tag the ticket for review. A ticketless build puts the Review label on its PRs when quickLabels is on. Turning this off only clears the build marker." },

  { heading: 'Builder · Pick-up' },
  { key: 'builder.pickup.drafts', label: 'Pick up drafts', type: 'bool', help: "on: when the Builder claims a ticket, your draft PRs for it count as work started: continued, and given fix rounds. off: drafts are left alone, as they are by the Reviewer." },
  { key: 'builder.pickup.branches', label: 'Pick up branches', type: 'bool', help: "on: your pushed branches with no PR, named with the ticket's number (feature/12345-x, fix/AB12345; not 123456) or linked on the ticket, count as work started: continued, and a PR opened. Only branches with your commits ahead of the base, on GitHub." },
  { key: 'builder.pickup.checks', label: 'Fix failing checks', type: 'bool', help: "on: a picked-up PR whose required checks fail gets a fix round first, with the failed job's log. Only at pick-up." },
  { key: 'builder.pickup.conflicts', label: 'Fix conflicts', type: 'bool', help: 'on: a picked-up PR that conflicts with its base gets a fix round first, which merges the base in (never a rebase). Only at pick-up; while GitHub is still working it out, the next poll reads it again.' },

  { heading: 'Builder · Follow-up' },
  { key: 'builder.followUp', label: 'Follow PRs', type: 'bool', help: 'on: after the PRs open, Prowl works through review feedback in rounds and flags READY TO MERGE. Merging stays with you.' },
  { key: 'builder.fixFrom', label: 'Fix comments from', type: 'enum', values: ['prowl', 'prowl+bots', 'everyone'], help: "Whose unresolved threads a round takes on: Prowl's own, Prowl's plus bots', or everyone's. Reviews requesting changes always count." },
  { key: 'builder.waitForChecksMinutes', label: 'Wait for CI (min)', type: 'int', min: 0, max: 1440, help: "After a round's push, how long to wait for the required checks before marking the ticket done. A failing check gets one more turn. 0 = don't wait." },
  { key: 'builder.notify', label: 'Notifications', type: 'bool', help: 'on: a notification when PRs open, a ticket is ready to merge, or one needs you, sent as Notify via says.' },
];
