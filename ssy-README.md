# SecuritySaysYes (SSY) Branch Workflow

This repository contains a fork of `TryGhost/ghost-docker` with custom changes, maintained on the `securitysaysyes` branch.  
Upstream changes are mirrored in `main`, while all customizations live in `securitysaysyes`.

The GitHub Actions workflow is now merged into `main`, so `securitysaysyes` will be automatically rebased on upstream changes.

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

1. **Start from the latest upstream**

```bash
git switch main
git fetch upstream
git merge --ff-only upstream/main
git push origin main
```

2. **Create a feature branch from `securitysaysyes`**

```bash
git switch securitysaysyes
git pull origin securitysaysyes   # ensure local is up-to-date
git switch -c ssy-my-change       # create a new working branch
```

3. **Make your changes** (e.g., Docker compose tweaks, MariaDB scripts, etc.)

4. **Commit your changes**

```bash
git add …
git commit
```

5. **Push your feature branch**

```bash
git push -u origin ssy-my-change
```

6. **Open a PR** (optional)  
- Base: `securitysaysyes`  
- Compare: `ssy-my-change`  
- This triggers CI on your fork, checks your changes before merging them back into `securitysaysyes`.

---

## Updating `securitysaysyes` with Upstream Changes

1. **Automatic rebase via GitHub Actions**  
- The workflow in `main` will:  
  - Fetch the latest `main` (upstream mirror)  
  - Attempt to rebase `securitysaysyes`  
  - If the rebase succeeds, push updates automatically  
  - If the rebase fails, create a draft PR for manual conflict resolution  

2. **Manual rebase (if needed)**

```bash
git switch securitysaysyes
git fetch origin
git rebase main
# resolve any conflicts
git push --force origin securitysaysyes
```

> ⚠️ Only force-push to `securitysaysyes`. Never push to `main`.

---

## Adding New Databases (MariaDB)

1. Use the `./mysql-init` folder with scripts similar to the existing ones (if needed)

2. Set environment variables in `docker-compose.yml`:

```yaml
environment:
  MARIADB_ROOT_PASSWORD: <password>
  MARIADB_USER: ghost
  MARIADB_PASSWORD: <password>
  MARIADB_DATABASE: ghost
  MULTIPLE_DATABASES: ghost,activitypub,analytics
```

> This ensures MariaDB creates multiple databases on first container startup.

---

## Summary Workflow

```text
1. Update main ← upstream
2. 🧑🏼‍💻 Create feature branch from securitysaysyes
3. 🧑🏼‍💻 **Make changes + commit**
4. 🧑🏼‍💻 **Push feature branch + open PR (optional)**
5. Let GitHub Actions rebase securitysaysyes on main
6. Resolve conflicts if needed
```

> Following this keeps `securitysaysyes` clean, rebasing-friendly, and safe for future upstream updates.

---

## Notes

- Never commit directly to `main`.  
- Always branch from `securitysaysyes` for custom work.  
- Use draft PRs for CI/test verification before merging into `securitysaysyes`.  
- GitHub Actions on `main` automatically handles rebasing — manual intervention is only needed if conflicts occur.
