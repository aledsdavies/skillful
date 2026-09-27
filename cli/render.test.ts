import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverProject } from "./project.ts";
import { commitStagedTree, renderProject, RenderOutputError } from "./render.ts";
import { contractFor, harnessPlan, resolvePlan } from "./contract.ts";
import { copyBasicFixture } from "./test-fixture.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "skillful-render-test-"));
  roots.push(root);
  const project = join(root, "project");
  copyBasicFixture(project);
  return { root, project, resolved: discoverProject({ project }) };
}
function text(path: string) { return readFileSync(path, "utf8"); }

describe("TypeScript renderer", () => {
  test("shares one plan across contract and rendered skills, commands, rules, and support files", () => {
    const { project, resolved } = fixture();
    const plan = resolvePlan(resolved);
    const contract = contractFor(plan);
    expect(contract.schemaVersion).toBe(1);
    expect(contract.manifest.harnesses.pi?.assets).toEqual([]);
    expect(contract.manifest.harnesses.pi?.skills.map((skill) => skill.name)).toContain("example");

    renderProject(resolved);
    const claude = text(join(project, "rendered", "claude", "skills", "example", "SKILL.md"));
    expect(claude).toContain("Claude Code");
    expect(claude).toContain("Claude keeps this line.");
    expect(claude).not.toContain("Other harnesses keep this line.");
    expect(claude).toContain("$ARGUMENTS");
    expect(existsSync(join(project, "rendered", "claude", "commands", "standalone.md"))).toBe(false);
    const claudePrompt = text(join(project, "rendered", "claude", "skills", "standalone", "SKILL.md"));
    expect(claudePrompt).toContain("disable-model-invocation: true");
    expect(claudePrompt).toContain("This command accepts: $ARGUMENTS");

    const pi = text(join(project, "rendered", "pi", "skills", "example", "SKILL.md"));
    expect(pi).toContain("Pi");
    expect(pi).toContain("Other harnesses keep this line.");
    expect(pi).not.toContain("Claude keeps this line.");
    expect(pi).toContain("Arguments: $@");
    expect(text(join(project, "rendered", "pi", "commands", "standalone.md"))).toContain("This command accepts: $@");
    expect(existsSync(join(project, "rendered", "pi", "commands", "example.md"))).toBe(false);
    expect(text(join(project, "rendered", "pi", "rules.md"))).toContain("This line demonstrates rules rendering.");
    expect(text(join(project, "rendered", "pi", "skills", "example", "references", "guide.md"))).toContain("copied without rendering");
  });

  test("renders only harnesses declared by the project by default", () => {
    const { project } = fixture();
    writeFileSync(join(project, "skill.mod"), `skillful 1

skills ./skills
commands ./commands
rules ./rules/global_agents.md

harness pi (
  token audience "Pi"
)
`);

    const plan = resolvePlan(discoverProject({ project }));
    const contract = contractFor(plan);
    renderProject(discoverProject({ project }));

    expect(Object.keys(plan.harnesses)).toEqual(["pi"]);
    expect(Object.keys(contract.manifest.harnesses)).toEqual(["pi"]);
    expect(contract.schema.harnesses.codex.commandMerge).toBe("skill");
    expect(existsSync(join(project, "rendered", "pi", "skills", "example", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, "rendered", "codex"))).toBe(false);
  });

  test("renders Codex skills, fences, and standalone commands as skills", () => {
    const { project, resolved } = fixture();

    renderProject(resolved, { harnesses: ["codex"] });

    const renderedSkill = text(join(project, "rendered", "codex", "skills", "example", "SKILL.md"));
    expect(renderedSkill).toContain("This resource is rendered for Codex");
    expect(renderedSkill).toContain("Codex keeps this line.");
    expect(renderedSkill).toContain("the user's request that invoked this skill");
    const standalone = text(join(project, "rendered", "codex", "skills", "standalone", "SKILL.md"));
    expect(standalone).toContain("name: standalone");
    expect(standalone).toContain("A standalone fixture command");
    expect(text(join(project, "rendered", "codex", "skills", "standalone", "agents", "openai.yaml"))).toContain("allow_implicit_invocation: false");
    expect(existsSync(join(project, "rendered", "codex", "commands", "standalone.md"))).toBe(false);
  });

  test("renders Cursor skills, fences, and standalone commands as manual skills", () => {
    const { project, resolved } = fixture();

    renderProject(resolved, { harnesses: ["cursor"] });

    const renderedSkill = text(join(project, "rendered", "cursor", "skills", "example", "SKILL.md"));
    expect(renderedSkill).toContain("This resource is rendered for Cursor");
    expect(renderedSkill).toContain("Cursor keeps this line.");
    expect(renderedSkill).toContain("the user's request that invoked this skill");
    const standalone = text(join(project, "rendered", "cursor", "skills", "standalone", "SKILL.md"));
    expect(standalone).toContain("disable-model-invocation: true");
    expect(standalone).toContain("A standalone fixture command");
    expect(existsSync(join(project, "rendered", "cursor", "commands", "standalone.md"))).toBe(false);
  });

  test("renders Grok skills, native commands, rules, and fences", () => {
    const { project, resolved } = fixture();

    renderProject(resolved, { harnesses: ["grok"] });

    const renderedSkill = text(join(project, "rendered", "grok", "skills", "example", "SKILL.md"));
    expect(renderedSkill).toContain("This resource is rendered for Grok");
    expect(renderedSkill).toContain("Grok keeps this line.");
    expect(existsSync(join(project, "rendered", "grok", "commands", "example.md"))).toBe(false);
    expect(text(join(project, "rendered", "grok", "commands", "standalone.md"))).toContain("This command accepts: $ARGUMENTS");
    expect(text(join(project, "rendered", "grok", "rules.md"))).toContain("# Shared rules");
  });

  test("refuses a command attached to a skill folder", () => {
    const { project } = fixture();
    writeFileSync(join(project, "skills", "example", "COMMAND.md"), "---\ndescription: Attached\n---\n\nRun it: $@\n");

    expect(() => renderProject(discoverProject({ project }), { harnesses: ["pi"] })).toThrow("skills/example/COMMAND.md is not supported");
  });

  test("refuses a command that shares its name with a skill", () => {
    const { project } = fixture();
    writeFileSync(join(project, "commands", "example.md"), "---\ndescription: Same name\n---\n\nRun it: $@\n");

    expect(() => renderProject(discoverProject({ project }), { harnesses: ["pi"] })).toThrow("commands share a name with skills for pi: example");
  });

  test("renders harness markup before parsing frontmatter", () => {
    const { project } = fixture();
    writeFileSync(join(project, "skills", "example", "SKILL.md"), `---
name: example
description: >-
  {{audience}} metadata so the fence is not the first field.
{{#claude}}
disable-model-invocation: true
{{/}}
{{#opencode}}
user-invocable: false
{{/}}
---

Body.
`);
    const resolved = discoverProject({ project });
    const plan = resolvePlan(resolved, { harnesses: ["claude", "opencode", "pi"] });
    expect(harnessPlan(plan, "claude").skills.find((skill) => skill.name === "example")?.description).toBe("Claude Code metadata so the fence is not the first field.");

    renderProject(resolved, { harnesses: ["claude", "opencode", "pi"] });

    const claude = text(join(project, "rendered", "claude", "skills", "example", "SKILL.md"));
    const opencode = text(join(project, "rendered", "opencode", "skills", "example", "SKILL.md"));
    expect(claude).toContain("disable-model-invocation: true");
    expect(opencode).not.toContain("disable-model-invocation");
    expect(existsSync(join(project, "rendered", "opencode", "commands", "example.md"))).toBe(false);
    expect(existsSync(join(project, "rendered", "pi", "commands", "example.md"))).toBe(false);
  });

  test("validates Agent Skill names only for selected harnesses", () => {
    const { project } = fixture();
    mkdirSync(join(project, "skills", "Upper"));
    writeFileSync(join(project, "skills", "Upper", "SKILL.md"), "---\nname: Upper\ndescription: Uppercase fixture\n---\n");
    writeFileSync(join(project, "skill.mod"), `${text(join(project, "skill.mod"))}
setup pi-only (
  only-skill Upper
  pi
)
`);
    const resolved = discoverProject({ project });

    expect(() => renderProject(resolved, { harnesses: ["cursor"] })).toThrow("invalid Agent Skill name");
    expect(() => renderProject(resolved, { harnesses: ["claude"] })).not.toThrow();
    expect(() => renderProject(resolved, { setup: "pi-only" })).not.toThrow();
  });

  test("converts multiline command descriptions into valid manual skills", () => {
    const { project } = fixture();
    writeFileSync(join(project, "commands", "multiline.md"), `---
description: >-
  Run the multiline command
  when explicitly invoked.
---

Do the work.
`);

    renderProject(discoverProject({ project }), { harnesses: ["cursor"] });

    const rendered = text(join(project, "rendered", "cursor", "skills", "multiline", "SKILL.md"));
    expect(rendered).toContain('description: "Run the multiline command when explicitly invoked."');
  });

  test("rejects command names that cannot become Agent Skill names", () => {
    const { project } = fixture();
    writeFileSync(join(project, "commands", "deploy_db.md"), "Deploy it.\n");

    expect(() => renderProject(discoverProject({ project }), { harnesses: ["cursor"] })).toThrow("invalid Agent Skill name");
  });
  test("renders only a named setup and removes harnesses outside it", () => {
    const { project, resolved } = fixture();
    renderProject(resolved);
    writeFileSync(join(project, "skill.mod"), `${text(join(project, "skill.mod"))}
setup personal (
  omit-skill hidden "Not here."
  pi
)
`);
    const selected = discoverProject({ project });
    const unmanaged = join(project, "rendered", "claude", "local.txt");
    writeFileSync(unmanaged, "mine");
    expect(() => renderProject(selected, { setup: "personal" })).toThrow("unmanaged files");
    expect(text(unmanaged)).toBe("mine");
    rmSync(unmanaged);
    const dry = renderProject(selected, { setup: "personal", dryRun: true });
    expect(dry.changes.some((change) => change.action === "delete" && change.path.startsWith("claude/"))).toBe(true);
    expect(existsSync(join(project, "rendered", "claude"))).toBe(true);

    renderProject(selected, { setup: "personal" });
    expect(existsSync(join(project, "rendered", "pi", "skills", "example", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, "rendered", "pi", "skills", "hidden", "SKILL.md"))).toBe(false);
    expect(existsSync(join(project, "rendered", "claude"))).toBe(false);
    expect(existsSync(join(project, "rendered", "opencode"))).toBe(false);
  });
  test("a targeted harness render preserves other managed outputs", () => {
    const { project, resolved } = fixture();
    renderProject(resolved);
    const claudeSkill = join(project, "rendered", "claude", "skills", "example", "SKILL.md");
    writeFileSync(claudeSkill, `${text(claudeSkill)}\nLocal edit.\n`);

    const dry = renderProject(resolved, { harnesses: ["pi"], dryRun: true });
    expect(dry.changes.some((change) => change.path.startsWith("claude/"))).toBe(false);

    renderProject(resolved, { harnesses: ["pi"] });
    expect(text(claudeSkill)).toEndWith("Local edit.\n");
    expect(existsSync(join(project, "rendered", "opencode", "skills", "example", "SKILL.md"))).toBe(true);
  });

  test("removes any retired managed harness render", () => {
    const { project, resolved } = fixture();
    renderProject(resolved);
    const rendered = join(project, "rendered");
    renameSync(join(rendered, "opencode"), join(rendered, "retired-harness"));
    const statePath = join(rendered, "retired-harness", ".skillful", "render.json");
    const state = JSON.parse(text(statePath)) as Record<string, unknown>;
    state.harness = "retired-harness";
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);

    const dry = renderProject(resolved, { dryRun: true });
    expect(dry.changes.some((change) => change.action === "delete" && change.path.startsWith("retired-harness/"))).toBe(true);
    renderProject(resolved);
    expect(existsSync(join(rendered, "retired-harness"))).toBe(false);
  });



  test("preserves multiline values of supported frontmatter fields", () => {
    const { project } = fixture();
    writeFileSync(join(project, "skills", "example", "SKILL.md"), `---
name: example
description: >-
  Use this skill when the description
  wraps across multiple lines.
metadata:
  owner: skillful
unsupported:
  nested: omitted
---

# Example
`);

    renderProject(discoverProject({ project }), { harnesses: ["pi"] });

    const rendered = text(join(project, "rendered", "pi", "skills", "example", "SKILL.md"));
    expect(rendered).toStartWith(`---
name: example
description: >-
  Use this skill when the description
  wraps across multiple lines.
metadata:
  owner: skillful
---`);
    expect(rendered).not.toContain("unsupported:");
    expect(rendered).not.toContain("nested: omitted");
  });

  test("rejects unresolved markup before touching an existing output", () => {
    const { project, resolved } = fixture();
    renderProject(resolved, { harnesses: ["pi"] });
    const before = text(join(project, "rendered", "pi", "skills", "example", "SKILL.md"));
    writeFileSync(join(project, "skills", "example", "SKILL.md"), "---\nname: example\n---\n{{missing}}\n");
    expect(() => renderProject(discoverProject({ project }), { harnesses: ["pi"] })).toThrow("skills/example/SKILL.md:4: unknown token {{missing}} for pi");
    expect(text(join(project, "rendered", "pi", "skills", "example", "SKILL.md"))).toBe(before);
  });

  test("shows markup inside code as written and substitutes it elsewhere", () => {
    const { project } = fixture();
    writeFileSync(join(project, "skills", "example", "SKILL.md"), [
      "---", "name: example", "description: Code example", "---", "",
      "Write a fence as `{{#claude}}` on its own line; `$@` marks the arguments.",
      "", "```text", "{{#pi}}", "echo $@", "{{/}}", "```", "",
      "Arguments: $@", "",
    ].join("\n"));

    renderProject(discoverProject({ project }), { harnesses: ["claude"] });

    const rendered = text(join(project, "rendered", "claude", "skills", "example", "SKILL.md"));
    expect(rendered).toContain("Write a fence as `{{#claude}}` on its own line; `$@` marks the arguments.");
    expect(rendered).toContain("```text\n{{#pi}}\necho $@\n{{/}}\n```");
    expect(rendered).toContain("Arguments: $ARGUMENTS");
  });

  test("names the file and line of markup it cannot render", () => {
    const cases = [
      ["An inline {{#pi}} fence.", "skills/example/SKILL.md:6: renderer fence {{#pi}} is not on a line of its own"],
      ["An {{unknown}} token.", "skills/example/SKILL.md:6: unknown token {{unknown}} for pi"],
    ] as const;
    for (const [line, error] of cases) {
      const { project } = fixture();
      writeFileSync(join(project, "skills", "example", "SKILL.md"), `---\nname: example\ndescription: Broken\n---\n\n${line}\n`);
      expect(() => renderProject(discoverProject({ project }), { harnesses: ["pi"] })).toThrow(error);
    }
  });

  test("dry-run writes nothing and managed rerenders remove stale support files", () => {
    const { project, resolved } = fixture();
    const dry = renderProject(resolved, { harnesses: ["pi"], dryRun: true });
    expect(dry.changes.length).toBeGreaterThan(0);
    expect(existsSync(join(project, "rendered"))).toBe(false);
    renderProject(resolved, { harnesses: ["pi"] });
    rmSync(join(project, "skills", "example", "references", "guide.md"));
    const result = renderProject(discoverProject({ project }), { harnesses: ["pi"] });
    expect(result.changes).toContainEqual({ path: "pi/skills/example/references/guide.md", action: "delete" });
    expect(existsSync(join(project, "rendered", "pi", "skills", "example", "references", "guide.md"))).toBe(false);
  });

  test("refuses unmanaged and edited output unless force is explicit", () => {
    const { project, resolved } = fixture();
    mkdirSync(join(project, "rendered"));
    writeFileSync(join(project, "rendered", "notes.txt"), "mine");
    expect(() => renderProject(resolved, { harnesses: ["pi"] })).toThrow("unmanaged");
    renderProject(resolved, { harnesses: ["pi"], force: true });
    const managed = join(project, "rendered", "pi", "skills", "example", "SKILL.md");
    writeFileSync(managed, "edited");
    expect(() => renderProject(resolved, { harnesses: ["pi"] })).toThrow("was modified");
    renderProject(resolved, { harnesses: ["pi"], force: true });
    expect(text(managed)).not.toBe("edited");
  });

  test("duplicate delivered names report both origins", () => {
    const { project } = fixture();
    const dep = join(project, "dep");
    mkdirSync(join(dep, "example"), { recursive: true });
    writeFileSync(join(dep, "example", "SKILL.md"), "---\nname: example\ndescription: duplicate\n---\n");
    writeFileSync(join(project, "skill.mod"), `${text(join(project, "skill.mod"))}\nrequire path:dep as dependency\n`);
    expect(() => resolvePlan(discoverProject({ project }))).toThrow("example (canonical, dependency)");
  });
});

describe("render tree commit recovery", () => {
  test("restores the previous tree when installing the staged tree fails", () => {
    const root = mkdtempSync(join(tmpdir(), "skillful-commit-test-"));
    roots.push(root);
    const target = join(root, "rendered");
    const stage = join(root, "stage");
    mkdirSync(target); mkdirSync(stage);
    writeFileSync(join(target, "old"), "old");
    writeFileSync(join(stage, "new"), "new");
    let renames = 0;
    expect(() => commitStagedTree(stage, target, {
      renameSync(from, to) { renames++; if (renames === 2) throw new Error("injected install failure"); return renameSync(from, to); },
      rmSync,
    })).toThrow("injected install failure");
    expect(text(join(target, "old"))).toBe("old");
    expect(existsSync(join(target, "new"))).toBe(false);
  });

  test("retains recoverable paths when restoration also fails", () => {
    const root = mkdtempSync(join(tmpdir(), "skillful-commit-test-"));
    roots.push(root);
    const target = join(root, "rendered");
    const stage = join(root, "stage");
    mkdirSync(target); mkdirSync(stage);
    let renames = 0;
    expect(() => commitStagedTree(stage, target, {
      renameSync() { renames++; if (renames >= 2) throw new Error(`failure ${renames}`); },
      rmSync,
    })).toThrow(RenderOutputError);
    expect(existsSync(stage)).toBe(true);
  });
});
