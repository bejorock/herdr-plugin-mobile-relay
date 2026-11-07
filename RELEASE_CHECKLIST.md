# Lean baseline verification

- Preserve and push the previous implementation branch/tag before pruning.
- Run `bun install`, `bun run typecheck`, `bun test ./bridge`, and `bash scripts/check-version.sh`.
- Verify removed UI/ACP/push/preferences/update routes return 404.
- Verify public snapshots omit native transcript references and application notification fields.
- Check loopback-only binding, remote identity gates, device write policy and terminal-stream regression tests.
- Do not claim native agent restore or replacement HTTP transcript/event coverage from unit tests: those public APIs are not part of this baseline.
- Before deployment, migrate `.env` from `COLLIE_*` to `HERDR_RELAY_*`, remove only old relay-owned agent hook references, and preserve Herdr integrations/private data.
- Keep `main`/running installation unchanged until the lean branch is reviewed. A linked checkout must not be restarted while it is being pruned.
- Future release/deployment should pin an explicit reviewed ref. Do not use the updater as a deployment acceptance test.
