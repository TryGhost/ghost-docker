# SecuritySaysYes (SSY) Branch Workflow

This repository contains a fork of `TryGhost/ghost-docker` with custom changes, maintained on the `securitysaysyes` branch.  

Upstream changes are mirrored in `main`, while all customizations live in `securitysaysyes`.

---

## Branch Diagram

```text
Upstream repository:
  upstream/main
        |
        v
Your fork:
  main --------------------------- (mirror of upstream/main + GitHub Actions)
        \
         \
          \-- securitysaysyes ----> [your custom MariaDB / tweaks]
                 ^
                 |
                 +-- Feature branches (e.g., ssy-my-change)
                 
Legend:
  -->  indicates branch flow / derived work
  |    vertical connection
  +--  side feature / action
```

---

## Branches

| Branch | Purpose |
|--------|---------|
| `main` | Mirror of the upstream repository. Contains GitHub Actions workflow. Never commit custom changes here. |
| `securitysaysyes` | Your customizations (e.g., MariaDB changes). Rebases on `main` automatically as upstream changes arrive. |
| Feature branches | Short-lived branches created from `securitysaysyes` for making specific changes safely. |

---

## Making Changes to `securitysaysyes`

### Start from the latest upstream

```bash
git switch main
git fetch upstream
git merge --ff-only upstream/main
git push origin main
```

### Create a feature branch from `securitysaysyes`

```bash
git switch securitysaysyes
git pull origin securitysaysyes

BRANCH_NAME="ssy-my-feature"  # replace with your branch name
git switch -c "$BRANCH_NAME"
git push -u origin "$BRANCH_NAME"
```

### Make your changes

Modify files (Docker compose tweaks, MariaDB scripts, etc.)

### Commit your changes

```bash
git add 
git commit -m "Describe your change here"
```

### Push your feature branch (if not already pushed)

```bash
git push origin "$BRANCH_NAME"
```

### Open a Pull Request (PR)

1. Go to your fork: [https://github.com/adamamyl/ghost-docker](https://github.com/adamamyl/ghost-docker)  
2. Click **Compare & pull request**  
3. Base repository: `adamamyl/ghost-docker`  
4. Base branch: `securitysaysyes`  
5. Compare branch: your feature branch (`$BRANCH_NAME`)  

> This ensures PRs target **your fork/securitysaysyes**, not upstream.

---

## Updating `securitysaysyes` with Upstream Changes

### Automatic rebase via GitHub Actions

- Workflow in `main` will fetch upstream, rebase `securitysaysyes`, push if successful, otherwise open a draft PR.

### Manual rebase (if needed)

```bash
git switch securitysaysyes
git fetch origin
git rebase main
# resolve any conflicts
git push --force origin securitysaysyes
```

> Only force-push to `securitysaysyes`. Never push to `main`.

---

## Adding New Databases (MariaDB)

1. Use `./mysql-init` for scripts.  
1. Set environment variables in `.env` (if needed):
1. Update MULTIPLE_DATABASES array: 

```yaml
environment:
  MARIADB_USER: ghost
  MARIADB_DATABASE: ghost
  MULTIPLE_DATABASES: ghost,activitypub,analytics
```

> This ensures MariaDB creates multiple databases on first container startup.

---

## Summary Workflow

1. Update main ← upstream
2. Create feature branch from securitysaysyes (git switch -c + git push -u)
3. Make changes + commit
4. Push feature branch
5. **Open PR targeting your fork/securitysaysyes**
6. Let GitHub Actions rebase securitysaysyes
7. Resolve conflicts if needed

---

## Notes

- Don't commit directly to `main` (except when needed).
- Always branch from `securitysaysyes`
- PRs target your fork/securitysaysyes
- Vanilla Git works — no custom aliases needed
