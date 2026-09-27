# author

Write one `SKILL.md`. The frontmatter `name` and `description` are the load gate.
The body says how and when to use the skill — not a restatement of the files beside it.

Not `mod` (that declares the project). Not `render` (that emits harness files).

A skill folder is `skills/<name>/SKILL.md`, optional `references/` and scripts. The
model loads a skill when its description matches, and the person can invoke it too.

A command is a saved prompt the person runs by name: `commands/<name>.md`, separate
from any skill. Pi, OpenCode, and Grok receive it as a prompt or command file. Claude,
Codex, and Cursor have no saved prompts, so it becomes a skill only the person can
invoke. A command needs no `SKILL.md`; a skill folder cannot hold a `COMMAND.md`, and a
command cannot share a skill's name. Codex and Cursor require Agent Skill names for
skills and commands: at most 64 lowercase letters, numbers, and single hyphens.

`$@` is the argument placeholder; the renderer translates it per harness.

Harness-only lines use fences such as `{{#codex}}`, `{{#cursor}}`, `{{#grok}}`, and
their inverted forms, closed by `{{/}}`. Tokens come from `skill.mod`. `skillful
schema` lists harness facts and markup.

```bash
skillful fmt --check
skillful check --strict
skillful inspect <skill> --rendered
```

`skillful author` is not a command.
