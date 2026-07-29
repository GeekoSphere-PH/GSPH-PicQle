@AGENTS.md

# Git commit messages

This project tracks work in Jira and branches are named with the ticket id as a prefix (e.g. `GP-2-pickleball-que-app-strict-best-rating-mode` → ticket `GP-2`).

Format every commit message as:

```
[<jira_ticket_id_from_branch_name>] <commit message>; <commit message for a different change context>
```

- Extract the ticket id from the current branch name (the leading `<PROJECT>-<number>` segment).
- Separate distinct change contexts within the same commit with `;`.
- Keep it short, concise, and straightforward — no bullet lists, no body paragraphs.

Example: `[GP-2] strict rotation + best rating mode implementation; minor changes to UI`
