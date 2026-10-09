# AGENTS.md

Execution guidance for agents. Shared behavior belongs in human documentation.

## Start here

- [README](README.md): setup and validation commands.
- [Architecture](docs/architecture.md): current boundaries, state and recovery.
- [Operator guide](docs/install.md): supported commands and recovery steps.
- [Configuration](docs/configuration.md), [Caddy](docs/caddy.md) and
  [bundle v1](docs/bundle-v1.md): read the relevant contract before changing it.
- [Roadmap](docs/ghost-cli-replacement.md): remaining requirements. Do not add
  command stubs for unimplemented steps.

## Workflow

- Target pull requests at `next-docker`. `main` is the released layout and must
  not receive this branch before its migration and release gates are satisfied.
- Use pnpm with the versions pinned in each package; the manager requires Node
  26. Run the README's format, lint, type and test checks for affected packages.
- Validate Compose semantics with the real Compose parser. Fakes cannot prove
  interpolation, file merging, mounts or networking.
- End-to-end scenarios fail on unavailable prerequisites. Use
  `GD_E2E_ALLOW_SKIP=1` only deliberately, and report what skipped.
- Before committing, read [.agents/skills/commit/SKILL.md](.agents/skills/commit/SKILL.md).

## High-value constraints

- Keep the launcher limited to work that must happen before the image starts;
  preserve bash 3.2 and WSL2 support. The site mount must use its absolute host path.
- Use the shared dotenv encoder; never source env files or log their values.
- Use Compose's resolved configuration for effective images, mounts and project
  identity. Reuse the file inventory rather than maintaining another list.
- Never automatically load a pre-update backup after service startup was
  attempted: newer writes may exist even if startup failed.
- Keep native service clients and version-matched MySQL tools for bulk data.
- Keep image-only self-update and strict development formats; retain released-main
  migration and exact-version bundle import. See the linked contracts for details.
