---
name: commit
description: Commit message formatting and guidelines
---

# Commit

Use this skill whenever the user asks you to create a git commit for the current work.

## Instructions

1. Review the current git state before committing:
   - `git status`
   - `git diff`
   - `git log -5`
2. Only stage files relevant to the requested change. Do not include unrelated
   untracked files, generated files, or likely-local artifacts.
3. Write the message in the format below.
4. Run `git status --short` after committing and confirm the result.

## Commit messages

They matter most for pull request titles and squash commits; follow them for
intermediate commits where practical.

```text
<past-tense summary, at most 80 characters>

<optional issue relationship>

<why this change was made>
```

- Start the summary with a past-tense verb that says what the change did:
  `Added`, `Fixed`, `Changed`, `Removed`, `Documented`, `Kept`, `Split`, and
  so on. Name the step in brackets when the change delivers one, as in
  `Added local bundle import to the manager (S5b)`. Do not add the pull
  request number; the squash merge does.
- Keep the second line blank.
- When an issue exists, use a supported relationship followed by its URL, such
  as `ref <issue URL>`, `fixes <issue URL>`, or `closes <issue URL>`. Never
  `refs ...` or `ref: ...`. Leave the line out when there is no issue.
- Explain the context in the body: why this change, why now, and why this
  approach. The diff already describes what changed. Wrap at 72 characters.
- When the change spans several files, end with a list of them, each saying
  what changed there and why (`- manager/src/compose.ts: ...`).
- Do not add `Co-Authored-By` or other attribution trailers.

## Important

- Do not push to remote unless the user explicitly asks
- Keep commits focused and avoid bundling unrelated changes
- If there are no relevant changes, do not create an empty commit
- If hooks fail, fix the issue and create a new commit. Never bypass hooks.
