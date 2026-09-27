export const ROOT_AFTER_HELP = `
Skillful authors skills, commands, and rules once and renders them per harness
(claude, codex, cursor, grok, opencode, pi). Git is the package manager for other
people's skill trees: github:, git:, and path: references.

Use skillful when one tree must serve several harnesses, or when you compose
another tree with your own. Plain files are enough for a single harness.

A command is a saved prompt the person runs by name, separate from any skill:
a prompt or command file where the harness has them, otherwise a skill only the
person can invoke. See: skillful skills show author.

Only install writes live harness destinations. add and update resolve revisions;
fetch retrieves exact pins. check, inspect, render, and install never resolve.

Getting oriented
  skillful skills tree
  skillful skills show core
  skillful <command> --help

Common commands
  skillful init --dir DIR
  skillful add github:owner/repo
  skillful list skills
  skillful list setups
  skillful inspect <skill>
  skillful render --dry-run
  skillful install work-mac --dry-run

Output defaults to text. Prefer --format json on source commands for automation.
Per-command details: skillful <command> --help. Longer guides: skillful skills show <topic>.
`;

export const INIT_AFTER_HELP = `
Idempotent: re-running in an existing scaffold reports that and changes nothing.

Examples:
  skillful init --dir ./agent

Afterward:
  skillful fmt --check
  skillful skills show author
`;

export const FMT_AFTER_HELP = `
Use --check in CI or before a review. Omit it to rewrite skill.mod in place.

Examples:
  skillful fmt --check
  skillful fmt --project DIR

Afterward:
  skillful check --strict
`;

export const ADD_AFTER_HELP = `
Use add to bring in a new tree or lock a require already declared in skill.mod.
For an existing require, pass its name; skill.mod supplies the ref, alias, and
--only / --exclude choices. Explicit matching details are also accepted.

New GitHub refs default to @HEAD, the repository's default branch. Without --name, the repository or subdirectory
name is used. Omit selectors to include the whole tree.

Examples:
  skillful add agent-browser
  skillful add github:owner/repo
  skillful add github:owner/repo@tag --name alias --only skill-name
  skillful add path:../shared

Afterward:
  skillful check --strict
  skillful render --dry-run
`;

export const FETCH_AFTER_HELP = `
Never changes skill.lock. Named fetches are independent of unrelated project
readiness. Use update to create or move a pin.

Examples:
  skillful fetch
  skillful fetch alias
`;

export const UPDATE_AFTER_HELP = `
Uses declarations in skill.mod and never edits them. A named update creates or
replaces that dependency's pin without requiring unrelated pins. With no names,
update resolves every remote dependency before replacing the lock atomically.

Examples:
  skillful update
  skillful update alias
`;

export const RENDER_AFTER_HELP = `
Default rendering reconciles only harnesses declared in skill.mod. A named setup
reconciles its exact set; --harness updates only the named outputs and preserves
other managed renders. Live harness destinations are install.

Examples:
  skillful render --dry-run
  skillful render work-mac
  skillful render --harness pi --out ./rendered

Afterward:
  skillful install work-mac --dry-run
`;

export const INSTALL_AFTER_HELP = `
The only command that writes live harness destinations. Records exclusive
ownership, refuses unmanaged or edited collisions, and removes only unchanged
stale files. Named setups select home or project paths from their declared root.
One-off --harness installs always use home paths; --root only relocates them. Use
--path for a nonstandard layout. --remove retires a named setup from its receipt;
pass --root after deleting its declaration. Valid source overrides are ignored
during removal because destination ownership comes only from the receipt. Removal
rejects --force because changed owned files always block. An OpenCode install at
retired opencode-v2 paths adopts that receipt safely.

Examples:
  skillful install work-mac --dry-run
  skillful install old-work --remove --dry-run
  skillful install --harness pi --root DIR
  skillful install --harness opencode --path skills=.config/opencode-v2/skills --path commands=.config/opencode-v2/commands
`;

export const SETUP_AFTER_HELP = `
A setup declares selected skills, harness outputs, root kind, and path exceptions
in skill.mod. Its root selects each harness's home or project paths. Showing one
is read-only.

Examples:
  skillful list setups
  skillful setup show work-mac
  skillful render work-mac
  skillful install work-mac --dry-run
`;

export const INSPECT_AFTER_HELP = `
Without --rendered this is the authored view. --rendered is per harness.

Examples:
  skillful inspect <skill>
  skillful inspect <skill> --rendered
`;

export const CHECK_AFTER_HELP = `
Read-only. --strict promotes warnings to failure.

Examples:
  skillful check
  skillful check --strict
`;

export const DIFF_AFTER_HELP = `
--against materializes only a revision already in the local Git object database.

Examples:
  skillful diff <skill>
  skillful diff <skill> --against HEAD
`;

export const SKILLS_AFTER_HELP = `
Topics are exact names from the tree. There is no synonym table.

Examples:
  skillful skills tree
  skillful skills show core
  skillful skills show author
`;
