# The released `main` layout

The stack files of the layout released on `main`, as of commit `9871293`, for
the tests of migration `0001-compose-profiles` (`manager/src/legacy.ts`). An
installation of it is a git clone of these with an untracked `.env` and
`caddy/Caddyfile`, copied from the examples and edited.

Refresh them from `main` if it changes before `next-docker` is merged into it:

```bash
git archive origin/main compose.yml compose.ipv6.yml .env.example caddy mysql-init \
  | tar -x -C tests/fixtures/released-main
```
