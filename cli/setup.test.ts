import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contractFor, resolvePlan } from "./contract.ts";
import { installProject, installSetup, removeSetup } from "./install.ts";
import { discoverProject } from "./project.ts";
import { resolveSetup } from "./setup.ts";
import { copyBasicFixture } from "./test-fixture.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function projectWith(setups: string) {
  const root = mkdtempSync(join(tmpdir(), "skillful-setup-test-"));
  roots.push(root);
  copyBasicFixture(root);
  const path = join(root, "skill.mod");
  writeFileSync(path, `${readFileSync(path, "utf8").trimEnd()}\n\n${setups.trim()}\n`);
  return discoverProject({ project: root });
}

const declarations = `
setup personal (
  omit-skill hidden "Work only."
  pi claude
)

setup work-mac (
  root project
  pi

  claude (
    skills .claude2/skills
  )
)`;

describe("installation setups", () => {
  test("projects selected content into each harness destination", () => {
    const project = projectWith(declarations);
    const personal = resolveSetup(project, "personal");
    expect(personal.root).toBe("home");
    expect(personal.harnesses.map((harness) => harness.name)).toEqual(["pi", "claude"]);
    expect(contractFor(resolvePlan(project)).manifest.setups.personal?.root).toBe("home");
    expect(Object.keys(personal.files)).toContain(".pi/agent/skills/example/SKILL.md");
    expect(Object.keys(personal.files)).not.toContain(".pi/agent/skills/hidden/SKILL.md");

    const work = resolveSetup(project, "work-mac");
    expect(work.root).toBe("project");
    expect(work.files[".claude2/skills/example/SKILL.md"]?.harness).toBe("claude");
    expect(work.files[".pi/agent/skills/hidden/SKILL.md"]?.harness).toBe("pi");
  });

  test("uses project discovery paths for project-root setups", () => {
    const project = projectWith(`
setup local (
  root project
  codex grok opencode
)
`);

    const setup = resolveSetup(project, "local");
    expect(setup.harnesses).toEqual([
      { name: "codex", paths: { skills: ".agents/skills" } },
      { name: "grok", paths: { skills: ".grok/skills", commands: ".grok/commands" } },
      { name: "opencode", paths: { skills: ".opencode/skills", commands: ".opencode/commands" } },
    ]);
    expect(Object.keys(setup.files).some((path) => path.endsWith("AGENTS.md"))).toBe(false);
  });
  test("installs every setup harness and converges a changed harness list", () => {
    const project = projectWith(declarations);
    const home = join(project.root, "home");
    const state = join(project.root, "state");
    mkdirSync(home);
    mkdirSync(state);
    const setup = resolveSetup(project, "personal");
    const dry = installSetup(project, setup, { root: home, stateHome: state, dryRun: true });
    expect(existsSync(join(home, ".pi"))).toBe(false);
    const applied = installSetup(project, setup, { root: home, stateHome: state });
    expect(applied.changes).toEqual(dry.changes);
    expect(existsSync(join(home, ".pi", "agent", "skills", "example", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".claude", "skills", "example", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".pi", "agent", "skills", "hidden", "SKILL.md"))).toBe(false);
    expect(() => installProject(project, { harness: "pi", root: home, stateHome: state, force: true })).toThrow("another installation");

    const claudeSkill = join(home, ".claude", "skills", "example", "SKILL.md");
    const originalClaude = readFileSync(claudeSkill, "utf8");
    writeFileSync(claudeSkill, "edited");
    writeFileSync(project.modPath, readFileSync(project.modPath, "utf8").replace("  pi claude", "  pi"));
    const changedProject = discoverProject({ project: project.root });
    const changedSetup = resolveSetup(changedProject, "personal");
    expect(() => installSetup(changedProject, changedSetup, { root: home, stateHome: state })).toThrow("was modified");
    writeFileSync(claudeSkill, originalClaude);
    const changed = installSetup(changedProject, changedSetup, { root: home, stateHome: state });
    expect(changed.changes.some((change) => change.action === "delete" && change.path.startsWith(".claude/"))).toBe(true);
    expect(existsSync(join(home, ".claude", "skills", "example", "SKILL.md"))).toBe(false);
  });
  test("refuses overlapping destination regions before expanding files", () => {
    const project = projectWith(`
setup overlap (
  pi (
    skills shared
  )
  claude (
    skills shared/nested
  )
)`);
    expect(() => resolveSetup(project, "overlap")).toThrow("overlapping destinations");
  });

  test("adopts a physically overlapping retired OpenCode receipt", () => {
    const project = projectWith(`
setup legacy (
  opencode (
    skills .config/opencode-v2/skills
    commands .config/opencode-v2/commands
    rules .config/opencode-v2/AGENTS.md
  )
)`);
    const home = join(project.root, "home");
    const state = join(project.root, "state");
    mkdirSync(home);
    mkdirSync(state);
    const retired = installProject(project, {
      harness: "opencode",
      root: home,
      stateHome: state,
      paths: {
        skills: ".config/opencode-v2/skills",
        commands: ".config/opencode-v2/commands",
        rules: ".config/opencode-v2/AGENTS.md",
      },
    });
    const receipt = JSON.parse(readFileSync(retired.statePath, "utf8")) as Record<string, unknown>;
    receipt.harness = "opencode-v2";
    const retiredStatePath = retired.statePath.replace(`${join("opencode", "")}`, `${join("opencode-v2", "")}`);
    mkdirSync(join(retiredStatePath, ".."), { recursive: true });
    writeFileSync(retiredStatePath, `${JSON.stringify(receipt)}\n`);
    rmSync(retired.statePath);

    installSetup(project, resolveSetup(project, "legacy"), { root: home, stateHome: state });
    expect(existsSync(retiredStatePath)).toBe(false);
    expect(existsSync(join(home, ".config/opencode-v2/skills/example/SKILL.md"))).toBe(true);
  });


  test("uses the declared project root and keeps an override as a separate instance", () => {
    const project = projectWith(declarations);
    const state = join(project.root, "state");
    const otherRoot = join(project.root, "other-root");
    mkdirSync(state);
    mkdirSync(otherRoot);
    const setup = resolveSetup(project, "work-mac");
    const local = installSetup(project, setup, { stateHome: state });
    expect(existsSync(join(project.root, ".claude2", "skills", "example", "SKILL.md"))).toBe(true);
    const other = installSetup(project, setup, { root: otherRoot, stateHome: state });
    expect(other.statePath).not.toBe(local.statePath);
    expect(existsSync(join(otherRoot, ".claude2", "skills", "example", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project.root, ".claude2", "skills", "example", "SKILL.md"))).toBe(true);
  });
  test("retires a declared project-root setup without touching another receipt", () => {
    const project = projectWith(`
setup local (
  root project
  pi
)

setup sibling (
  opencode
)`);
    const state = join(project.root, "state");
    mkdirSync(state);
    const local = installSetup(project, resolveSetup(project, "local"), { stateHome: state });
    installSetup(project, resolveSetup(project, "sibling"), { root: project.root, stateHome: state });
    const unrelated = join(project.root, "notes.txt");
    writeFileSync(unrelated, "keep\n");

    const dry = removeSetup(project, "local", { stateHome: state, dryRun: true });
    expect(existsSync(local.statePath)).toBe(true);
    expect(existsSync(join(project.root, ".pi", "agent", "skills", "example", "SKILL.md"))).toBe(true);
    const applied = removeSetup(project, "local", { stateHome: state });
    expect(applied.changes).toEqual(dry.changes);
    expect(existsSync(local.statePath)).toBe(false);
    expect(existsSync(join(project.root, ".pi"))).toBe(false);
    expect(existsSync(join(project.root, ".config", "opencode", "skills", "example", "SKILL.md"))).toBe(true);
    expect(readFileSync(unrelated, "utf8")).toBe("keep\n");
  });
  test("requires an explicit root after a setup declaration is removed", () => {
    const project = projectWith(`setup local (\n  root project\n  pi\n)`);
    const state = join(project.root, "state");
    mkdirSync(state);
    installSetup(project, resolveSetup(project, "local"), { stateHome: state });
    writeFileSync(project.modPath, readFileSync(project.modPath, "utf8").replace(/\nsetup local \([\s\S]*?\n\)\n/, "\n"));
    const changed = discoverProject({ project: project.root });

    expect(() => removeSetup(changed, "local", { stateHome: state })).toThrow("--root is required");
    removeSetup(changed, "local", { root: project.root, stateHome: state });
  });

  test("retires a setup after its source path changes", () => {
    const original = projectWith(`setup local (\n  pi\n)`);
    const replacement = projectWith("");
    const home = join(original.root, "home");
    const state = join(original.root, "state");
    mkdirSync(home);
    mkdirSync(state);
    const installed = installSetup(original, resolveSetup(original, "local"), { root: home, stateHome: state });

    const removed = removeSetup(replacement, "local", { root: home, stateHome: state });

    expect(removed.statePath).toBe(installed.statePath);
    expect(existsSync(installed.statePath)).toBe(false);
    expect(existsSync(join(home, ".pi"))).toBe(false);
  });


  test.skipIf(process.platform === "win32")("refuses an escaping symlink and keeps the receipt", () => {
    const project = projectWith(`setup personal (\n  pi\n)`);
    const home = join(project.root, "home");
    const state = join(project.root, "state");
    mkdirSync(home);
    mkdirSync(state);
    const installed = installSetup(project, resolveSetup(project, "personal"), { root: home, stateHome: state });
    const skill = join(home, ".pi", "agent", "skills", "example", "SKILL.md");
    const outside = join(project.root, "outside.md");
    writeFileSync(outside, readFileSync(skill));
    rmSync(skill);
    symlinkSync(outside, skill);

    expect(() => removeSetup(project, "personal", { root: home, stateHome: state })).toThrow("symlink outside --root");
    expect(existsSync(installed.statePath)).toBe(true);
    expect(readFileSync(outside, "utf8")).toContain("# Example");
  });


  test("unknown names and overlapping destinations fail with recovery", () => {
    const project = projectWith(declarations);
    expect(() => resolveSetup(project, "missing")).toThrow("unknown setup");
    const unknownSkill = projectWith(`setup bad (\n  only-skill missing\n  pi\n)`);
    expect(() => resolveSetup(unknownSkill, "bad")).toThrow("unknown skill");
    const overlapping = projectWith(`
setup overlap (
  pi
  claude (
    skills .pi/agent/skills
  )
)`);
    expect(() => resolveSetup(overlapping, "overlap")).toThrow("overlapping destinations");
  });
});
