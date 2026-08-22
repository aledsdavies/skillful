#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { Argument, Command, CommanderError, Option } from "commander";
import { addDependency, fetchDependencies, updateDependencies } from "./deps.ts";
import { normalizeHarness } from "./harness.ts";
import {
  ADD_AFTER_HELP,
  CHECK_AFTER_HELP,
  DIFF_AFTER_HELP,
  FETCH_AFTER_HELP,
  FMT_AFTER_HELP,
  INIT_AFTER_HELP,
  INSPECT_AFTER_HELP,
  INSTALL_AFTER_HELP,
  RENDER_AFTER_HELP,
  ROOT_AFTER_HELP,
  SETUP_AFTER_HELP,
  SKILLS_AFTER_HELP,
  UPDATE_AFTER_HELP,
} from "./help.ts";
import { installProject, installSetup, removeSetup, type InstallPaths } from "./install.ts";
import { checkCommand, diffCommand, inspectCommand, listCommand, manifestCommand, schemaCommand, setupShowCommand, type OutputFormat } from "./introspect.ts";
import { formatText, type HarnessId } from "./mod.ts";
import { discoverProject, initProject } from "./project.ts";
import { renderProject } from "./render.ts";
import { renderSkillTopic, resolveSkillTopic, skillTree } from "./skills.ts";
import { skillfulVersion } from "./version.ts";
import { resolveSetup } from "./setup.ts";

function collect(value: string, previous: string[] = []) {
  return [...previous, value];
}
function one(values: string[] | undefined, flag: string) {
  if (!values?.length) return undefined;
  if (values.length > 1) throw new CliUsageError(`duplicate ${flag}`, `Use ${flag} once.`);
  return values[0];
}
function assignments(values: string[] | undefined, flag: string) {
  const result: Record<string, string> = {};
  for (const value of values ?? []) {
    const equals = value.indexOf("=");
    if (equals <= 0 || equals === value.length - 1) throw new CliUsageError(`${flag} expects name=path`, `Use ${flag} name=path.`);
    const name = value.slice(0, equals);
    if (result[name]) throw new CliUsageError(`duplicate ${flag} name ${name}`, `Pass each ${flag} name once.`);
    result[name] = value.slice(equals + 1);
  }
  return result;
}
function extraRoots(skills: string[] | undefined, commands: string[] | undefined) {
  const convert = (values: string[] | undefined, flag: string) => Object.entries(assignments(values, flag)).map(([origin, path]) => ({ origin, path }));
  return { skills: convert(skills, "--extra-skill-root"), commands: convert(commands, "--extra-command-root") };
}
function installPaths(values: string[] | undefined) {
  const parsed = assignments(values, "--path");
  const result: Partial<InstallPaths> = {};
  for (const [name, path] of Object.entries(parsed)) {
    if (name !== "skills" && name !== "commands" && name !== "rules") throw new CliUsageError(`unknown --path ${name}`, "Use --path skills=, --path commands=, or --path rules=.");
    result[name] = path;
  }
  return Object.keys(result).length ? result : undefined;
}
function harnesses(values: string[] | undefined) {
  const result: HarnessId[] = [];
  for (const value of values ?? []) {
    const normalized = normalizeHarness(value);
    if (normalized.warning) console.error(normalized.warning);
    if (result.includes(normalized.name)) throw new CliUsageError(`duplicate harness ${normalized.name}`, "Select each harness once.");
    result.push(normalized.name);
  }
  return result;
}
function printChanges(verb: string, target: string, changes: Array<{ action: "add" | "change" | "delete"; path: string }>) {
  const counts = { add: 0, change: 0, delete: 0 };
  for (const change of changes) counts[change.action]++;
  console.log(`${verb} ${target}: ${counts.add} add, ${counts.change} change, ${counts.delete} delete`);
  for (const change of changes) console.log(`${change.action.padEnd(6)} ${change.path}`);
}

class CliUsageError extends Error { constructor(message: string, readonly recovery: string) { super(message); } }
function hasRecovery(error: unknown): error is Error & { recovery: string } {
  return error instanceof Error && "recovery" in error && typeof error.recovery === "string";
}
function recoveryFor(error: unknown) {
  return hasRecovery(error) ? error.recovery : "Run `skillful --help` for supported commands.";
}
function printDomainError(error: unknown, json = false) {
  const message = error instanceof Error ? error.message : String(error);
  const recovery = recoveryFor(error).replace(/^Recovery:\s*/, "");
  const code = error instanceof CliUsageError ? "usage" : "runtime";
  if (json) console.log(JSON.stringify({ schemaVersion: 1, error: { code, message, hint: recovery } }));
  else console.error(`Error: ${message}\nRecovery: ${recovery}`);
  process.exitCode = error instanceof CliUsageError ? 2 : 1;
}
function internalRootOption(flags: string, description: string) { return new Option(flags, description).argParser(collect).hideHelp(); }
function addSourceOptions(command: Command, withHarness = true) {
  command.addOption(new Option("--project <directory>", "project directory").argParser(collect));
  command.addOption(internalRootOption("--source-root <directory>", "source workspace containing the project"));
  if (withHarness) command.addOption(new Option("--harness <harness>", "select a harness; repeatable").argParser(collect));
  command.addOption(new Option("--format <format>", "output format").choices(["text", "json"]).default("text", "text"));
  command.addOption(new Option("--override <name=path>", "satisfy a declared dependency locally; repeatable").argParser(collect));
  command.addOption(internalRootOption("--extra-skill-root <origin=path>", "internal named skill root"));
  command.addOption(internalRootOption("--extra-command-root <origin=path>", "internal named command root"));
  return command;
}
type SourceOptionValues = {
  project?: string[] | undefined;
  sourceRoot?: string[] | undefined;
  harness?: string[] | undefined;
  format: OutputFormat;
  override?: string[] | undefined;
  extraSkillRoot?: string[] | undefined;
  extraCommandRoot?: string[] | undefined;
};
function sourceArguments(options: SourceOptionValues) {
  return {
    project: discoverProject({ project: one(options.project, "--project"), sourceRoot: one(options.sourceRoot, "--source-root") }),
    harnesses: options.harness ? harnesses(options.harness) : undefined,
    format: options.format,
    overrides: assignments(options.override, "--override"),
    extraRoots: extraRoots(options.extraSkillRoot, options.extraCommandRoot),
  };
}

export function createProgram() {
  const program = new Command()
    .name("skillful")
    .description("Author agent skills once, render them per harness.")
    .version(skillfulVersion(), "-V, --version", "print version")
    .addHelpText("after", ROOT_AFTER_HELP)
    .helpCommand(false)
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({ outputError: () => {} });

  program.commandsGroup("Project:");
  program.command("init")
    .summary("Create a project scaffold: skill.mod, skills/, commands/, rules/")
    .description("Create a new skillful project: skill.mod plus skills/, commands/, and rules/ scaffolding.")
    .addHelpText("after", INIT_AFTER_HELP)
    .addOption(new Option("--dir <directory>", "destination directory").argParser(collect))
    .action((options: { dir?: string[] }) => {
      const result = initProject(one(options.dir, "--dir") ?? process.cwd());
      console.log(result.created ? `Initialized skillful project in ${result.root}` : `Skillful project already initialized in ${result.root}`);
    });

  program.command("fmt")
    .summary("Rewrite skill.mod canonically, or check it")
    .description("Canonicalize skill.mod, or check its format without writing.")
    .addHelpText("after", FMT_AFTER_HELP)
    .option("--check", "report noncanonical formatting without writing")
    .addOption(new Option("--project <directory>", "project directory").argParser(collect))
    .action((options: { check?: boolean; project?: string[] }) => {
      const resolved = discoverProject({ project: one(options.project, "--project") });
      const original = readFileSync(resolved.modPath, "utf8");
      const formatted = formatText(original, resolved.modPath);
      if (original === formatted) { console.log(`${resolved.modPath} is canonical`); return; }
      if (options.check) { console.error(`Error: ${resolved.modPath} is not canonical\n--- current\n+++ formatted\nRecovery: Run \`skillful fmt --project ${resolved.root}\` to rewrite it.`); process.exitCode = 1; return; }
      writeFileSync(resolved.modPath, formatted);
      console.log(`Formatted ${resolved.modPath}`);
    });

  program.command("add")
    .summary("Add or lock one dependency; resolve and fetch remote refs")
    .description("Add a new dependency, or lock one already declared in skill.mod, then fetch its exact tree.")
    .addHelpText("after", ADD_AFTER_HELP)
    .argument("<dependency>", "existing dependency name or github:, git:, or path: reference")
    .addOption(new Option("--name <name>", "dependency alias").argParser(collect))
    .addOption(new Option("--only <skill>", "include only this skill; repeatable").argParser(collect))
    .addOption(new Option("--exclude <skill>", "exclude this skill; repeatable").argParser(collect))
    .addOption(new Option("--project <directory>", "project directory").argParser(collect))
    .action(async (ref: string, options: { name?: string[]; only?: string[]; exclude?: string[]; project?: string[] }) => {
      const project = discoverProject({ project: one(options.project, "--project") });
      const result = await addDependency(project, ref, { name: one(options.name, "--name"), only: options.only, exclude: options.exclude });
      console.log(result.entry ? `Added ${result.requirement.name} at ${result.entry.rev}` : `Added local dependency ${result.requirement.name}`);
    });

  program.command("fetch")
    .summary("Fetch exact pins without changing skill.lock")
    .description("Fetch and verify selected or all existing pins without changing skill.lock.")
    .addHelpText("after", FETCH_AFTER_HELP)
    .argument("[names...]", "dependency names; default: all")
    .addOption(new Option("--project <directory>", "project directory").argParser(collect))
    .action(async (names: string[], options: { project?: string[] }) => {
      const project = discoverProject({ project: one(options.project, "--project") });
      const entries = await fetchDependencies(project, names);
      console.log(`Fetched ${entries.length} locked ${entries.length === 1 ? "dependency" : "dependencies"}`);
    });

  program.command("update")
    .summary("Resolve and fetch one or more declared dependencies")
    .description("Create or replace selected dependency pins from skill.mod; default: reconcile every remote dependency.")
    .addHelpText("after", UPDATE_AFTER_HELP)
    .argument("[names...]", "dependency names; default: all remotes")
    .addOption(new Option("--project <directory>", "project directory").argParser(collect))
    .action(async (names: string[], options: { project?: string[] }) => {
      const project = discoverProject({ project: one(options.project, "--project") });
      const entries = await updateDependencies(project, names);
      console.log(`Updated ${names.length || entries.length} locked ${names.length === 1 ? "dependency" : "dependencies"}`);
    });

  program.commandsGroup("Understand:");
  addSourceOptions(program.command("list")
    .summary("List delivered skills, harnesses, or setups")
    .description("List delivered skills, public harnesses, or named setups.")
    .addArgument(new Argument("<selector>", "skills, harnesses, or setups").choices(["skills", "harnesses", "setups"])))
    .action((selector: "skills" | "harnesses" | "setups", options: SourceOptionValues) => { const source = sourceArguments(options); listCommand(source.project, selector, source); });

  const setupCommand = program.command("setup")
    .summary("Show one named installation setup")
    .description("Inspect a named setup from skill.mod.")
    .addHelpText("after", SETUP_AFTER_HELP)
    .helpCommand(false);
  addSourceOptions(setupCommand.command("show")
    .description("Show resolved selection, harness paths, and projected files")
    .argument("<name>", "setup name"), false)
    .action((name: string, options: SourceOptionValues) => { const source = sourceArguments(options); setupShowCommand(source.project, name, source); });

  addSourceOptions(program.command("inspect")
    .summary("Explain one skill across harnesses")
    .description("Explain one skill across harnesses.")
    .addHelpText("after", INSPECT_AFTER_HELP)
    .argument("<skill>", "skill selector"))
    .option("--rendered", "include rendered bodies")
    .action((name: string, options: SourceOptionValues & { rendered?: boolean | undefined }) => { const source = sourceArguments(options); inspectCommand(source.project, name, { ...source, rendered: options.rendered }); });

  addSourceOptions(program.command("check")
    .summary("Validate the resolved project")
    .description("Validate the resolved project.")
    .addHelpText("after", CHECK_AFTER_HELP)
    .argument("[skills...]", "optional skill selectors"))
    .option("--strict", "promote warnings to failure")
    .action((names: string[], options: SourceOptionValues & { strict?: boolean | undefined }) => { const source = sourceArguments(options); checkCommand(source.project, names, { ...source, strict: options.strict }); });

  addSourceOptions(program.command("diff")
    .summary("Diff one skill across harnesses or against a local revision")
    .description("Compare one skill across harnesses or with a local revision.")
    .addHelpText("after", DIFF_AFTER_HELP)
    .argument("<skill>", "skill selector"))
    .addOption(new Option("--against <revision>", "local Git revision").argParser(collect))
    .action((name: string, options: SourceOptionValues & { against?: string[] }) => { const source = sourceArguments(options); diffCommand(source.project, name, { ...source, against: one(options.against, "--against") }); });

  addSourceOptions(program.command("manifest")
    .summary("Emit the resolved schemaVersion-1 manifest")
    .description("Emit the resolved schemaVersion-1 manifest."))
    .action((options: SourceOptionValues) => { const source = sourceArguments(options); manifestCommand(source.project, source); });

  addSourceOptions(program.command("schema")
    .summary("Describe harness facts and renderer markup")
    .description("Describe harness facts and renderer markup."), false)
    .action((options: SourceOptionValues) => { const source = sourceArguments(options); schemaCommand(source.project, source); });

  program.commandsGroup("Deliver:");
  program.command("render")
    .summary("Write a managed build tree; touches no harnesses")
    .description("Render a managed build tree without installing it.")
    .addHelpText("after", RENDER_AFTER_HELP)
    .argument("[setup]", "named setup; omit to render harnesses declared in skill.mod")
    .addOption(new Option("--harness <harness>", "render only this harness; repeatable").argParser(collect))
    .addOption(new Option("--out <directory>", "managed output directory (default: ./rendered)").argParser(collect))
    .addOption(new Option("--project <directory>", "project directory").argParser(collect))
    .addOption(internalRootOption("--source-root <directory>", "source workspace containing the project"))
    .option("--dry-run", "plan without changing the output")
    .option("--force", "replace listed unmanaged or edited output")
    .addOption(new Option("--override <name=path>", "satisfy a declared dependency from a local path; repeatable").argParser(collect))
    .addOption(internalRootOption("--extra-skill-root <origin=path>", "internal named skill root"))
    .addOption(internalRootOption("--extra-command-root <origin=path>", "internal named command root"))
    .action((setup: string | undefined, options: { harness?: string[]; out?: string[]; project?: string[]; sourceRoot?: string[]; dryRun?: boolean; force?: boolean; override?: string[]; extraSkillRoot?: string[]; extraCommandRoot?: string[] }) => {
      if (setup && options.harness?.length) throw new CliUsageError("render cannot mix a setup with --harness", "Choose one named setup or one-off harness selection.");
      const project = discoverProject({ project: one(options.project, "--project"), sourceRoot: one(options.sourceRoot, "--source-root") });
      const result = renderProject(project, {
        setup,
        harnesses: options.harness ? harnesses(options.harness) : undefined,
        out: one(options.out, "--out"),
        dryRun: options.dryRun,
        force: options.force,
        overrides: assignments(options.override, "--override"),
        extraRoots: extraRoots(options.extraSkillRoot, options.extraCommandRoot),
      });
      printChanges(options.dryRun ? "Would render" : "Rendered", result.out, result.changes);
    });

  program.command("install")
    .summary("Install a setup or one harness into a destination root")
    .description("Safely install a named setup or one public harness.")
    .addHelpText("after", INSTALL_AFTER_HELP)
    .argument("[setup]", "named setup")
    .option("--harness <harness>", "one-off harness to install")
    .addOption(new Option("--root <directory>", "destination root (default: setup root or current home)").argParser(collect))
    .addOption(new Option("--path <category=path>", "override one harness destination; repeatable").argParser(collect))
    .addOption(new Option("--project <directory>", "project directory").argParser(collect))
    .addOption(internalRootOption("--source-root <directory>", "source workspace containing the project"))
    .option("--dry-run", "plan without changing installed files or state")
    .option("--remove", "remove a named setup from its ownership receipt")
    .option("--force", "replace listed unmanaged or edited files when installing")
    .addOption(new Option("--override <name=path>", "satisfy a declared dependency from a local path; repeatable").argParser(collect))
    .addOption(internalRootOption("--extra-skill-root <origin=path>", "internal named skill root"))
    .addOption(internalRootOption("--extra-command-root <origin=path>", "internal named command root"))
    .action((setupName: string | undefined, options: { harness?: string; root?: string[]; path?: string[]; project?: string[]; sourceRoot?: string[]; dryRun?: boolean; remove?: boolean; force?: boolean; override?: string[]; extraSkillRoot?: string[]; extraCommandRoot?: string[] }) => {
      const project = discoverProject({ project: one(options.project, "--project"), sourceRoot: one(options.sourceRoot, "--source-root") });
      if (options.remove) {
        if (options.harness) throw new CliUsageError("install --remove cannot mix with --harness", "Pass the retired setup name instead.");
        if (options.path?.length) throw new CliUsageError("install --remove cannot mix with --path", "Removal uses destinations recorded in the receipt.");
        assignments(options.override, "--override");
        extraRoots(options.extraSkillRoot, options.extraCommandRoot);
        if (!setupName) throw new CliUsageError("install --remove needs a setup name", "Pass the exact retired setup name and its original --root if needed.");
        if (options.force) throw new CliUsageError("install --remove cannot mix with --force", "Restore changed owned files before removal; force never deletes them.");
        const result = removeSetup(project, setupName, { root: one(options.root, "--root"), dryRun: options.dryRun });
        printChanges(options.dryRun ? "Would remove from" : "Removed from", result.root, result.changes);
        return;
      }
      if (setupName && options.harness) throw new CliUsageError("install cannot mix a setup with --harness", "Choose one named setup or one-off harness.");
      if (setupName && options.path?.length) throw new CliUsageError("install cannot mix a setup with --path", "Declare setup path exceptions in skill.mod.");
      if (!setupName && !options.harness) throw new CliUsageError("install needs a setup name or --harness", `Choose one of: ${Object.keys(project.mod.setups).sort().join(", ") || "no setups declared"}; or pass --harness.`);
      const overrides = assignments(options.override, "--override");
      const extra = extraRoots(options.extraSkillRoot, options.extraCommandRoot);
      const common = { root: one(options.root, "--root"), dryRun: options.dryRun, force: options.force, overrides, extraRoots: extra };
      const result = setupName
        ? installSetup(project, resolveSetup(project, setupName, { overrides, extraRoots: extra }), common)
        : installProject(project, { ...common, harness: normalizeHarness(options.harness!).name, paths: installPaths(options.path) });
      printChanges(options.dryRun ? "Would install into" : "Installed into", result.root, result.changes);
    });

  program.commandsGroup("Guides:");
  const skills = program.command("skills")
    .summary("Print the agent topic map, or one guide")
    .description("Print the agent topic map, or load one guide. Topics are exact names from the tree.")
    .addHelpText("after", SKILLS_AFTER_HELP)
    .helpCommand(false);
  skills.command("tree")
    .description("Print the legal topic names")
    .action(() => { process.stdout.write(skillTree()); });
  skills.command("show")
    .description("Print one guide")
    .argument("<topic>", "exact topic name from skillful skills tree")
    .action((topic: string) => { process.stdout.write(renderSkillTopic(resolveSkillTopic(topic))); });
  return program;
}

export async function main(argv = Bun.argv.slice(2)) {
  const json = argv.some((value, index) => value === "--format" && argv[index + 1] === "json");
  try { await createProgram().parseAsync(argv, { from: "user" }); }
  catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0 || error.code === "commander.help") {
        process.exitCode = error.exitCode;
        return;
      }
      const message = error.message.replace(/^error:\s*/i, "");
      const hint = "Run `skillful --help` or `skillful <command> --help`.";
      if (json) console.log(JSON.stringify({ schemaVersion: 1, error: { code: "usage", message, hint } }));
      else console.error(`Error: ${message}\nRecovery: ${hint}`);
      process.exitCode = 2;
      return;
    }
    printDomainError(error, json);
  }
}

if (import.meta.main) main();
