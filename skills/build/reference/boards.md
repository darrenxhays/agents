# Fetching a ticket

Identify the board from the link or id and fetch the item, its comments, and its linked items with whatever access this session has. Tool names below are examples that were current when written; if one is missing, find the capability with ToolSearch or the board's own discovery tool.

- **Jira** (`<site>.atlassian.net/browse/PROJ-123`, or `PROJ-123`), with the Atlassian MCP:
  - The issue and its issue-to-issue links: `getJiraIssue` with `view: "evidence"`. The ticket URL works as the `cloudId`; otherwise get it once from `getAccessibleAtlassianResources`.
  - Comments and web links (Confluence pages, external URLs): find the operations with `discover` (for example `listJiraIssueComments` and `listJiraIssueRemoteIssueLinks`) and run them with `executeRead`.
- **Azure DevOps** (`dev.azure.com/<org>/<project>/_workitems/edit/<id>` or `<org>.visualstudio.com/...`): an Azure DevOps MCP tool if one is connected, otherwise `az boards work-item show --id <id> --org https://dev.azure.com/<org>`.
- **GitHub issues** (`github.com/<owner>/<repo>/issues/<n>`): `gh issue view <url> --comments`.
- **Any other board** (for example Linear, Shortcut, Trello, or Asana): a connected MCP tool or CLI for it; find one with ToolSearch.

Use the title, description, acceptance criteria, comments, and linked items as the build request.
