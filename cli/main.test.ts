import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheKey } from "./nar.ts";

const dirs: string[] = [];
const temp = () => { const dir = join(tmpdir(), `skillful-main-${crypto.randomUUID()}`); mkdirSync(dir); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const run = (cwd: string, ...args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "main.ts"), ...args], { cwd, stdout: "pipe", stderr: "pipe" });
const runIn = (cwd: string, home: string, ...args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "main.ts"), ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: home, XDG_STATE_HOME: join(home, ".state") } });
const output = (result: ReturnType<typeof run>) => ({ stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) });

describe("project CLI", () => {
  test("root help orients humans and agents without a Nix story", () => {
    const result = run(temp(), "--help");
    const { stdout } = output(result);
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("Author agent skills once, render them per harness.");
    expect(stdout).toContain("skillful skills tree");
    expect(stdout).toContain("skillful <command> --help");
    expect(stdout).toContain("init [options]");
    expect(stdout).toContain("render [options]");
    expect(stdout).toContain("install [options]");
    expect(stdout.toLowerCase()).not.toContain("nix");
    expect(stdout).toContain("--version");

    const formatHelp = run(temp(), "list", "--help");
    expect(formatHelp.exitCode).toBe(0);
    expect(output(formatHelp).stdout).toContain("default: text");
    expect(output(formatHelp).stdout).not.toContain('default: "text"');
  });

  test("prints the package version without discovering a project", () => {
    const result = run(temp(), "--version");
    expect(result.exitCode).toBe(0);
    expect(output(result).stdout).toBe("skillful 0.1.0\n");
    expect(output(result).stderr).toBe("");
  });
  test("no-args help orients without treating help as a usage error", () => {
    const result = run(temp());
    const { stdout, stderr } = output(result);
    expect(result.exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Author agent skills once, render them per harness.");
    expect(stderr).toContain("skillful skills tree");
    expect(stderr).not.toContain("(outputHelp)");
    expect(stderr).not.toContain("Error:");
  });

  test("skills help is not a synonym command", () => {
    const listed = run(temp(), "skills", "--help");
    expect(listed.exitCode).toBe(0);
    expect(output(listed).stdout).toContain("skillful skills tree");
    expect(output(listed).stdout).not.toContain("help [command]");

    const synonym = run(temp(), "skills", "help");
    const { stdout, stderr } = output(synonym);
    expect(synonym.exitCode).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toBe("Error: unknown command 'help'\nRecovery: Run `skillful --help` or `skillful <command> --help`.\n");
  });

  test("skills tree lists legal topic names and show loads that topic", () => {
    const tree = run(temp(), "skills", "tree");
    expect(tree.exitCode).toBe(0);
    const treeText = output(tree).stdout;
    expect(treeText).toContain("core");
    expect(treeText).toContain("author");
    expect(treeText).toContain("mod");
    expect(treeText).toContain("deps");
    expect(treeText).toContain("inspect");
    expect(treeText).toContain("render");
    expect(treeText).toContain("setup");
    expect(treeText).toContain("skillful skills show <topic>");
    expect(treeText.toLowerCase()).not.toContain("nix");

    const shown = run(temp(), "skills", "show", "core");
    expect(shown.exitCode).toBe(0);
    const shownText = output(shown).stdout;
    expect(shownText).toContain("skillful guides › core");
    expect(shownText).toContain("next (`skillful skills show <topic>`):");
    expect(shownText).toContain("  author");
    expect(shownText.toLowerCase()).not.toContain("nix");

    const miss = run(temp(), "skills", "show", "lock");
    expect(miss.exitCode).toBe(1);
    expect(output(miss).stderr).toContain("unknown guide topic");
    expect(output(miss).stderr).toContain("skillful skills tree");
    expect(output(miss).stderr).toContain("author");
  });

  test("add help leads with inferred dependency choices", () => {
    const result = run(temp(), "add", "--help");
    const { stdout } = output(result);
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("skillful add agent-browser");
    expect(stdout).toContain("default to @HEAD");
    expect(stdout).not.toContain("(default: [])");
    expect(stdout.toLowerCase()).not.toContain("nix");
  });

  test("install help documents custom paths and rejects unknown categories", () => {
    const help = run(temp(), "install", "--help");
    expect(help.exitCode).toBe(0);
    expect(output(help).stdout).toContain("--path");
    expect(output(help).stdout).toContain("--remove");
    expect(output(help).stdout).toContain("skills=.config/opencode-v2/skills");
    expect(output(help).stdout).toContain("source overrides are ignored");
    expect(output(help).stdout.toLowerCase()).not.toContain("nix");

    const root = temp();
    expect(run(root, "init").exitCode).toBe(0);
    const unknown = run(root, "install", "--harness", "opencode", "--path", "tools=.config/tools");
    expect(unknown.exitCode).toBe(2);
    expect(output(unknown).stderr).toContain("unknown --path tools");
    const missing = run(root, "install");
    expect(missing.exitCode).toBe(2);
    expect(output(missing).stderr).toContain("setup name or --harness");
    const removeMissing = run(root, "install", "--remove");
    expect(removeMissing.exitCode).toBe(2);
    expect(output(removeMissing).stderr).toContain("needs a setup name");
    expect(run(root, "install", "old", "--remove", "--harness", "pi").exitCode).toBe(2);
    expect(run(root, "install", "old", "--remove", "--path", "skills=.old").exitCode).toBe(2);
    const malformedOverride = run(root, "install", "old", "--remove", "--override", "typo");
    expect(malformedOverride.exitCode).toBe(2);
    expect(output(malformedOverride).stderr).toContain("expects name=path");
    const duplicateOverride = run(root, "install", "old", "--remove", "--override", "dep=one", "--override", "dep=two");
    expect(duplicateOverride.exitCode).toBe(2);
    expect(output(duplicateOverride).stderr).toContain("duplicate --override name");

  });
  test("lists, shows, renders, installs, and removes a named setup", () => {
    const root = temp();
    const project = join(root, "project");
    const home = join(root, "home");
    mkdirSync(home);
    expect(run(root, "init", "--dir", project).exitCode).toBe(0);
    const mod = join(project, "skill.mod");
    writeFileSync(mod, `${readFileSync(mod, "utf8").trimEnd()}

setup personal (
  omit-skill hidden "Not personal."
  pi claude
)

setup work-mac (
  pi

  claude (
    skills .claude2/skills
    commands .claude2/commands
  )
)
`);

    const listed = runIn(root, home, "list", "setups", "--project", project);
    expect(listed.exitCode).toBe(0);
    expect(output(listed).stdout).toBe("personal\nwork-mac\n");
    const shown = runIn(root, home, "setup", "show", "work-mac", "--project", project, "--format", "json");
    expect(shown.exitCode).toBe(0);
    const shownValue = JSON.parse(output(shown).stdout) as { setup: { harnesses: Array<{ name: string }>; files: Record<string, { harness: string }> } };
    expect(shownValue.setup.harnesses.map((harness) => harness.name)).toEqual(["pi", "claude"]);
    expect(shownValue.setup.files[".claude2/skills/example/SKILL.md"]?.harness).toBe("claude");

    expect(runIn(root, home, "install", "personal", "--project", project, "--root", home).exitCode).toBe(0);
    const installedSkill = join(home, ".pi", "agent", "skills", "example", "SKILL.md");
    expect(existsSync(installedSkill)).toBe(true);
    expect(existsSync(join(home, ".pi", "agent", "skills", "hidden", "SKILL.md"))).toBe(false);

    writeFileSync(mod, readFileSync(mod, "utf8").replace(/\nsetup personal \([\s\S]*?\n\)\n/, "\n"));
    const forcedRemoval = runIn(root, home, "install", "personal", "--remove", "--force", "--project", project, "--root", home);
    expect(forcedRemoval.exitCode).toBe(2);
    expect(output(forcedRemoval).stderr).toContain("cannot mix with --force");
    expect(runIn(root, home, "install", "personal", "--remove", "--override", "wrapper-source=../source", "--project", project, "--root", home).exitCode).toBe(0);
    expect(existsSync(installedSkill)).toBe(false);

    expect(runIn(root, home, "render", "work-mac", "--project", project).exitCode).toBe(0);
    expect(existsSync(join(project, "rendered", "claude", "skills", "example", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, "rendered", "opencode"))).toBe(false);
    expect(runIn(root, home, "install", "work-mac", "--harness", "pi", "--project", project).exitCode).toBe(2);
  });


  test("init then fmt --check is a Bun-only journey", () => {
    const root = temp();
    expect(run(root, "init").exitCode).toBe(0);
    const mod = join(root, "skill.mod");
    writeFileSync(mod, "skillful 1\nharness pi (\n token x \"one\"\n omit-skill b \"b\"\n omit-command a \"a\"\n)\n");
    const changed = run(root, "fmt", "--check");
    expect(changed.exitCode).toBe(1);
    expect(output(changed).stderr).toContain("not canonical");
    expect(run(root, "fmt").exitCode).toBe(0);
    expect(run(root, "fmt", "--check").exitCode).toBe(0);
    expect(readFileSync(mod, "utf8")).toContain("omit-command a");
  });

  test("unknown command options are usage errors", () => {
    const root = temp();
    const unknown = run(root, "fmt", "--harness", "pi");
    expect(unknown.exitCode).toBe(2);
    expect(output(unknown).stderr).toBe("Error: unknown option '--harness'\nRecovery: Run `skillful --help` or `skillful <command> --help`.\n");

    const excess = run(root, "manifest", "extra", "args");
    expect(excess.exitCode).toBe(2);
    expect(output(excess).stderr).toBe("Error: too many arguments for 'manifest'. Expected 0 arguments but got 2: extra, args.\nRecovery: Run `skillful --help` or `skillful <command> --help`.\n");

    const json = run(root, "list", "skills", "--format", "json", "--nope");
    expect(json.exitCode).toBe(2);
    expect(output(json).stdout).toBe(`${JSON.stringify({ schemaVersion: 1, error: { code: "usage", message: "unknown option '--nope'", hint: "Run `skillful --help` or `skillful <command> --help`." } })}\n`);
    expect(output(json).stderr).toBe("");
  });

  test.skipIf(process.platform === "win32")("runtime failures without a recovery hint remain structured JSON errors", () => {
    const root = temp();
    const project = join(root, "project");
    const cache = join(root, "cache");
    cpSync(join(import.meta.dir, "..", "tests", "fixtures", "locked-project"), project, { recursive: true });
    const hash = readFileSync(join(project, "skill.lock"), "utf8").match(/sha256-[A-Za-z0-9+/]{43}=/)?.[0];
    if (!hash) throw new Error("locked fixture lost its NAR hash");
    const cacheEntry = join(cache, "skillful", cacheKey(hash));
    mkdirSync(cacheEntry, { recursive: true });
    const unsupported = join(cacheEntry, "unsupported");
    const fifo = Bun.spawnSync(["mkfifo", unsupported], { stdout: "pipe", stderr: "pipe" });
    if (fifo.exitCode !== 0) throw new Error(`cannot create FIFO fixture: ${new TextDecoder().decode(fifo.stderr)}`);

    const result = Bun.spawnSync(["bun", join(import.meta.dir, "main.ts"), "manifest", "--project", project, "--format", "json"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, XDG_CACHE_HOME: cache },
    });
    const actual = output(result);
    expect(result.exitCode).toBe(1);
    expect(actual.stdout).toBe(`${JSON.stringify({ schemaVersion: 1, error: { code: "runtime", message: `unsupported filesystem kind for NAR: ${unsupported}`, hint: "Run `skillful --help` for supported commands." } })}\n`);
    expect(actual.stderr).toBe("");
  });
});
