# Release Checklist

This checklist prepares the `rad.herdr-mobile-relay` fork for publication as **v1.0.0**.

## Completed in this repository

- [x] Fork-safe plugin identity is `rad.herdr-mobile-relay`.
- [x] Plugin/service/state/config naming is isolated from upstream `rad.herdr-mobile-relay`.
- [x] Version metadata and changelog are aligned at `1.0.0`.
- [x] README, ACP API, ACP operations guide, architecture, and Pi event-bridge documentation are updated.
- [x] Typecheck, unit tests, web tests, production web build, and whitespace checks pass.
- [x] Pi and Claude core ACP paths have disposable local live validation.
- [x] Claude image/live-semantic-hook code is implemented and automated-tested; its final live smoke test remains deferred until Claude cloud quota is available.

## Before pushing a release

- [ ] Review the staged diff and this checklist.
- [ ] When Claude quota is available, run the deferred disposable live test for private-path image prompting plus `MessageDisplay`, tool lifecycle, and `Stop` updates.
- [ ] Confirm the target GitHub remote is `https://github.com/bejorock/herdr-plugin-mobile-relay.git`.
- [ ] Push the release commit to `main`.
- [ ] Create and push annotated tag `v1.0.0`.
- [ ] Create the GitHub release, marking ACP explicitly **experimental**.

## Post-publish smoke test

From a clean test host or a disposable plugin config directory:

```bash
herdr plugin install bejorock/herdr-plugin-mobile-relay --ref v1.0.0 --yes
config_dir="$(herdr plugin config-dir rad.herdr-mobile-relay)"
install -m 600 .env.example "$config_dir/.env"
# Set COLLIE_TRUSTED_USER and, for ACP, COLLIE_ACP=on.
herdr plugin action invoke start --plugin rad.herdr-mobile-relay
herdr plugin action invoke status --plugin rad.herdr-mobile-relay
herdr plugin action invoke hooks-status --plugin rad.herdr-mobile-relay
```

Verify:

- relay remains loopback-only;
- ACP is off until `COLLIE_ACP=on`;
- hook installation is explicit and preserves unrelated configuration;
- Tailscale Serve is private; never use Funnel;
- a trusted remote client can reach the normal control API and `/acp` after ACP is enabled.
