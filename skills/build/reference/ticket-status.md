# Moving the ticket

Applies when the request came from a Jira or Azure DevOps ticket.

- **Plan approved:** move it to the board's in-progress status.
- **PR opened:** move it to the board's review status, such as `In Review` or `Code Review`. If the workflow has no review status, leave it where it is.

Re-read the ticket's current status first, and leave it alone if it is already in the target status or past it (in review, done, closed, resolved, removed).

Pick the target from the statuses the ticket's own workflow allows, never a hardcoded name. Tool names are examples that were current when written; if one is missing, find the capability with the board's discovery tool.

- **Jira:** list the issue's transitions (with the Atlassian MCP: `discover` finds `listJiraIssueTransitions`, run with `executeRead`) and apply one with `transitionJiraIssue`. In progress is the transition whose target status category is In Progress (`indeterminate`), preferring one whose target is named `In Progress`; review is a target status in that category whose name says review. Match the status a transition leads to, not the transition's name.
- **Azure DevOps:** an Azure DevOps MCP tool if one is connected. Otherwise list the work item type's states with `az devops invoke --area wit --resource workItemTypeStates --route-parameters project=<project> type=<type> --org https://dev.azure.com/<org> --api-version 7.1` and set one with `az boards work-item update --id <id> --state "<state>" --org https://dev.azure.com/<org>`. In progress is the state in the `InProgress` category (for example `Active`, `Committed`, or `Doing`); review is an `InProgress` or `Resolved` state whose name says review.

If no status clearly fits, more than one does, or the move fails, leave the ticket where it is, tell the user why in one sentence, and carry on with the build. Tell the user each move you make: the ticket id, old status, and new status.
