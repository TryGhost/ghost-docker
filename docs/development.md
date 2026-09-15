# Development tools

Use Node 22.18 or later on the 22.x line, or Node 24+. These are developer/test
requirements; site operators still use the shell dispatcher and Docker.

```sh
npm ci --ignore-scripts
npm run format
npm run format:check
npm run lint
npm run typecheck
npm test
```

The dependencies are pinned in `package-lock.json`. CI runs the formatting, lint
and type checks before the helper suite. Docker integration tests skip without a
working daemon; the opt-in restore drills are described in `docs/recovery.md`.

Formatting uses Ghost's oxfmt version and conventions: two spaces for JavaScript
and TypeScript, single quotes, and no embedded-language formatting. The formatter
covers the manager, tests, the legacy JavaScript helper and tooling configuration;
fixture data is excluded. Shell files retain their existing four-space style and
ShellCheck validation. Oxlint checks correctness and requires braces around control
flow so dense one-line conditions do not return.

The manager is strict TypeScript with explicit checkpoint, journal, ownership,
Docker response and subprocess types. Its local `package.json` selects ESM; the
repository root keeps CommonJS for the legacy `.js` helper. Tests remain `.mjs`
and import the manager's `.ts` modules directly.

Node strips erasable types at runtime; it does **not** type-check the program.
`npm run typecheck` runs TypeScript with `noEmit`, `erasableSyntaxOnly`,
`verbatimModuleSyntax` and `allowImportingTsExtensions`. Use type-only imports and
explicit `.ts` extensions, and avoid enums, parameter properties, decorators,
path aliases or other constructs that require transformation. Runtime JSON and
checkpoint integrity checks still apply; TypeScript types are not input validation.

The manager Dockerfile copies the TypeScript source and its ESM package metadata,
then runs `node /opt/manager/main.ts`. It does not install the formatter, linter,
compiler, or any npm runtime dependencies. The pinned Node image is tested by the
same local, production HTTPS and ActivityPub restore drills as the recovery code.
