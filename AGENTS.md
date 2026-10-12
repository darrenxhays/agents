# Agent notes

## Prowl (`apps/prowl/`)

- **Bump the version with every change.** When you change anything under `apps/prowl/`, raise `version` in `apps/prowl/.claude-plugin/plugin.json` (semver: patch for fixes, minor for features, major for breaking changes). Installed copies update on launch only when the version on `main` is higher than theirs, so a change without a bump never reaches users, and a bump releases it as soon as it is pushed to `main`.
- **Keep the review skill app-only.** Don't add Prowl to `.claude-plugin/marketplace.json`; the app loads `skills/prowl-review` itself with `--plugin-dir`.
- Run `node apps/prowl/prowl.mjs --self-test` after changing it.
