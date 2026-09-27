import command from "../templates/basic/commands/standalone.md" with { type: "text" };
import readme from "../templates/basic/README.md" with { type: "text" };
import rules from "../templates/basic/rules/global_agents.md" with { type: "text" };
import manifest from "../templates/basic/skill.mod" with { type: "text" };
import exampleGuide from "../templates/basic/skills/example/references/guide.md" with { type: "text" };
import exampleSkill from "../templates/basic/skills/example/SKILL.md" with { type: "text" };
import hiddenSkill from "../templates/basic/skills/hidden/SKILL.md" with { type: "text" };

export const BASIC_SCAFFOLD: Readonly<Record<string, string>> = Object.freeze({
  "commands/standalone.md": command,
  "README.md": readme,
  "rules/global_agents.md": rules,
  "skill.mod": manifest,
  "skills/example/references/guide.md": exampleGuide,
  "skills/example/SKILL.md": exampleSkill,
  "skills/hidden/SKILL.md": hiddenSkill,
});
