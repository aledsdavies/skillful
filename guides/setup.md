# setup

A setup names the skill selection, harness outputs, root kind, and path exceptions
for one machine. Skillful never chooses a setup from the hostname.

```text
setup personal (
  omit-skill company-database "Work only."
  pi claude
)

setup work-mac (
  pi

  claude (
    skills .claude2/skills
  )
)
```

Omit `root` to use each harness's home paths. `root project` selects its project
paths; `--root DIR` relocates the selected profile when applying. Bare harness
names use those conventional paths. A harness block contains only exceptions.

Codex, Cursor, Grok, and OpenCode project profiles do not claim `AGENTS.md`.
Assign `rules AGENTS.md` explicitly to one harness when the project needs it.
One-off `install --harness` always uses home paths, with `--root` as relocation.

Use repeated `only-skill <name>` or repeated `omit-skill <name> <reason>`, never
both. Selection names are exact. Omitting a skill also removes its support files
from every output in the setup. Omit a command with `omit-command` in a harness block.

```bash
skillful list setups
skillful setup show work-mac
skillful render work-mac
skillful install work-mac --dry-run
skillful install work-mac
skillful install old-work --remove --dry-run
skillful install old-work --remove
```

`render` is a managed build tree. Only `install` writes live destinations. Use
`install --harness` for a one-off harness instead of a declared machine setup.
Use `install <name> --remove` to retire an instance from its ownership receipt.
After deleting its declaration, pass the exact original `--root`. Valid source
overrides are ignored during removal; destinations come only from the receipt.
Removal rejects `--force` and deletes only unchanged owned files.

`skillful skills show mod` · `skillful skills show render`
