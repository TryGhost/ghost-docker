# Keeping feat/ses-mail up to date with upstream

This branch (`feat/ses-mail`) is a fork of [TryGhost/ghost-docker](https://github.com/TryGhost/ghost-docker) with SES mail support added. Your config lives in `.env` (gitignored) and is never touched by git operations.

## Remotes

| Remote   | URL                                          |
|----------|----------------------------------------------|
| origin   | git@github.com:adamamyl/ghost-docker.git     |
| upstream | https://github.com/TryGhost/ghost-docker.git |

## Update procedure

```bash
# 1. Fetch latest from upstream
git fetch upstream

# 2. Merge into local main
git checkout main
git merge upstream/main -m "chore: merge upstream main"

# 3. Merge main into your branch
git checkout feat/ses-mail
git merge main

# 4. Push both to your fork
git push origin main feat/ses-mail
```

If step 3 produces a conflict in `compose.yml`, it will almost certainly be a dep bump on a line you haven't touched. Accept both changes (keep the updated image tag) and:

```bash
git add compose.yml
git commit
```

## Notes

- `.env` is gitignored — your SES credentials and Ghost config are never affected
- `trixy.sh` is untracked — also safe
- `main` tracks `origin/main` (not `origin/securitysaysyes` — that was a misconfiguration, now fixed)
- Upstream typically only bumps `ghost/traffic-analytics` image tags; actual structural changes are rare
