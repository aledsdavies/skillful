import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { copyBasicFixture } from "./test-fixture.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const project = mkdtempSync(join(tmpdir(), "skillful-introspect-test-"));
  roots.push(project);
  copyBasicFixture(project);
  return project;
}
function run(project: string, ...args: string[]) { return Bun.spawnSync(["bun", join(import.meta.dir, "main.ts"), ...args, "--project", project], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", http_proxy: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9" } }); }
function stdout(result: ReturnType<typeof run>) { return new TextDecoder().decode(result.stdout); }
function stderr(result: ReturnType<typeof run>) { return new TextDecoder().decode(result.stderr); }
function json(result: ReturnType<typeof run>) { return JSON.parse(stdout(result)); }

describe("top-level introspection", () => {
  test("list, inspect, check, manifest, schema, and diff evaluate the project live", () => {
    const project = fixture();
    const listed = run(project, "list", "skills", "--format", "json");
    expect(listed.exitCode).toBe(0);
    expect(json(listed).skills.map((skill: { name: string }) => skill.name)).toContain("example");

    const listedHarnesses = run(project, "list", "harnesses");
    expect(listedHarnesses.exitCode).toBe(0);
    expect(stdout(listedHarnesses)).toBe("claude\ncodex\ncursor\ngrok\nopencode\npi\n");

    const inspected = run(project, "inspect", "example", "--harness", "pi", "--rendered", "--format", "json");
    expect(inspected.exitCode).toBe(0);
    expect(json(inspected).harnesses.pi.skill.body).toContain("This resource is rendered for Pi");

    const checked = run(project, "check", "--strict", "--format", "json");
    expect(checked.exitCode).toBe(0);
    expect(json(checked).ok).toBe(true);

    const manifest = json(run(project, "manifest", "--harness", "claude", "--format", "json"));
    expect(manifest.schemaVersion).toBe(1);
    expect(Object.keys(manifest.harnesses)).toEqual(["claude"]);
    expect(manifest.harnesses.claude.assets).toEqual([]);

    const schema = json(run(project, "schema", "--format", "json"));
    expect(schema.schemaVersion).toBe(1);
    expect(schema.schema.harnesses.opencode.commandMerge).toBe("file");
    expect(schema.schema.harnesses.codex.commandMerge).toBe("skill");
    expect(schema.schema.harnesses.cursor.commandMerge).toBe("skill");
    expect(schema.schema.harnesses.grok.commandMerge).toBe("file");
    expect(schema.schema.harnesses.codex.agentSkillNames).toBe(true);
    expect(schema.schema.harnesses.claude.agentSkillNames).toBe(false);

    const compared = json(run(project, "diff", "example", "--format", "json"));
    expect(compared.harnesses.claude.status).toBe("identical");
    expect(compared.harnesses.pi.status).toBe("changed");
  });
  test("public harness discovery works when the project selects no outputs", () => {
    const project = fixture();
    writeFileSync(join(project, "skill.mod"), `skillful 1

skills ./skills
commands ./commands
rules ./rules/global_agents.md
`);

    const listedHarnesses = run(project, "list", "harnesses");
    expect(listedHarnesses.exitCode).toBe(0);
    expect(stdout(listedHarnesses)).toBe("claude\ncodex\ncursor\ngrok\nopencode\npi\n");
    const codex = json(run(project, "list", "harnesses", "--format", "json")).harnesses.find((harness: { name: string }) => harness.name === "codex");
    expect(codex.profile.installPaths.project.skills).toBe(".agents/skills");
    expect(codex.profile.exclusions).toBeUndefined();
    expect(run(project, "schema").exitCode).toBe(0);

    for (const args of [["check", "--strict"], ["list", "skills"], ["manifest"]]) {
      const result = run(project, ...args);
      expect(result.exitCode).toBe(1);
      expect(stderr(result)).toContain("project selects no harnesses");
    }
  });


  test("JSON usage and runtime errors remain one parseable stdout document", () => {
    const project = fixture();
    const usage = run(project, "list", "unknown", "--format", "json");
    expect(usage.exitCode).toBe(2);
    expect(json(usage).error.code).toBe("usage");
    const runtime = run(project, "inspect", "missing", "--format", "json");
    expect(runtime.exitCode).toBe(1);
    expect(json(runtime).error.message).toContain("unknown skill");
  });

  test("diff --against materializes only an existing local Git object", () => {
    const project = fixture();
    for (const args of [["init"], ["config", "user.email", "test@example.invalid"], ["config", "user.name", "Test"], ["add", "."], ["commit", "-m", "fixture"]]) {
      const result = Bun.spawnSync(["git", "-C", project, ...args], { stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(0);
    }
    const skill = join(project, "skills", "example", "SKILL.md");
    writeFileSync(skill, `${readFileSync(skill, "utf8")}\nCurrent-only line.\n`);
    const result = run(project, "diff", "example", "--against", "HEAD", "--harness", "pi", "--format", "json");
    expect(result.exitCode).toBe(0);
    expect(json(result).harnesses.pi.status).toBe("changed");
    const missing = run(project, "diff", "example", "--against", "not-local", "--format", "json");
    expect(missing.exitCode).toBe(1);
    expect(json(missing).error.hint).toContain("Prepare the revision locally");
    expect(stderr(result)).not.toContain("http");
  });
});
