import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadHarnesses, type HarnessFacts, type HarnessInstallPaths } from "./harness.ts";
import { isScalar, parseDocument } from "yaml";
import { HARNESS_IDS, mapHarnesses, type HarnessId, type Omission, type Require, type Setup } from "./mod.ts";
import { resolveProjectPath, type Project } from "./project.ts";
import { cachedDependencyPaths } from "./deps.ts";

export type ExtraRoot = { origin: string; path: string };
export type ResolveOptions = {
  overrides?: Record<string, string> | undefined;
  extraRoots?: { skills?: ExtraRoot[] | undefined; commands?: ExtraRoot[] | undefined } | undefined;
  setup?: string | undefined;
  harnesses?: HarnessId[] | undefined;
};

type Source = { kind: string; origin?: string | null; path: string | null };
type Transformations = {
  fences: Array<{ kind: "fence"; mode: "include" | "exclude"; targets: HarnessId[]; outcome: "selected" | "omitted" }>;
  tokens: Array<{ kind: "token-substituted"; token: string; value: string }>;
  argSyntax: { kind: "arg-syntax-substituted"; from: "$@"; to: string } | null;
  command: string[];
};
export type SupportFilePlan = {
  source: { path: string | null };
  delivery: { kind: "file"; path: string };
  sha256: string;
  copied: "verbatim" | "generated";
  markup: boolean;
  sourcePath: string | null;
  generatedBody: string | null;
  relativePath: string;
};
export type SkillPlan = {
  name: string;
  description: string | null;
  origin: string;
  source: Source;
  delivery: { kind: "file"; path: string };
  sha256: string;
  frontmatter: FrontmatterPlan;
  transformations: Transformations;
  supportFiles: SupportFilePlan[];
  body: string;
  sourceDir: string;
};
export type CommandPlan = {
  name: string;
  source: Source;
  delivery: { kind: "file"; path: string };
  sha256: string;
  frontmatter: FrontmatterPlan;
  transformations: Transformations;
  body: string;
};
export type FrontmatterPlan = { source: string[]; retained: string[]; omitted: string[]; rendered: string[] };
export type HarnessPlan = {
  id: HarnessId;
  facts: HarnessFacts;
  profile: {
    argSyntax: string;
    installPaths: HarnessInstallPaths;
    commandMerge: "file" | "skill";
    exclusions: Record<string, { code: string; message: string }>;
    excludeCommands: string[];
    commandExclude: string[];
  };
  omittedSkills: Record<string, { code: string; message: string }>;
  skills: SkillPlan[];
  commands: CommandPlan[];
  rules: { source: Source; delivery: { kind: "file"; path: string } | null; sha256: string; body: string };
  assets: never[];
};
export type ProjectPlan = { project: Project; harnesses: Partial<Record<HarnessId, HarnessPlan>> };

type SkillEntry = { name: string; origin: string; root: string; sourceKind: "canonical" | "external" | "override" | "extra" };
type CommandEntry = { name: string; origin: string; root: string; sourceKind: "standalone" | "external" | "extra" };

export class ContractError extends Error {
  constructor(message: string, readonly recovery: string) { super(message); }
}
function fail(message: string, recovery: string): never { throw new ContractError(message, `Recovery: ${recovery}`); }
export function harnessIds(plan: ProjectPlan) { return HARNESS_IDS.filter((id) => plan.harnesses[id] !== undefined); }
export function harnessPlan(plan: ProjectPlan, id: HarnessId) {
  const harness = plan.harnesses[id];
  if (!harness) fail(`harness ${id} is not selected`, "Declare it in skill.mod, select it through a setup, or pass --harness.");
  return harness;
}
export function sha256(text: string | Buffer) { return createHash("sha256").update(text).digest("hex"); }
function sortedDirectoryNames(path: string) {
  return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}
function sortedMarkdown(path: string) {
  return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name).sort();
}
function ensureInsideProject(project: Project, raw: string, label: string) {
  const path = resolve(project.root, raw);
  const rel = relative(project.root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) fail(`${label} escapes the project root: ${raw}`, `Choose a path inside ${project.root}.`);
  if (!existsSync(path) || !lstatSync(path).isDirectory()) fail(`${label} is not an existing directory: ${raw}`, "Create the directory or correct the configured path.");
  const real = realpathSync(path);
  const realRel = relative(project.root, real);
  if (!realRel || realRel === ".." || realRel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) fail(`${label} resolves outside the project root: ${raw}`, "Do not use a symlink that escapes the project.");
  return real;
}
function resolveOverride(path: string, project: Project, label: string) {
  const selected = resolve(project.root, path);
  if (!existsSync(selected) || !lstatSync(selected).isDirectory()) fail(`${label} is not an existing directory: ${path}`, "Pass an existing content directory.");
  return realpathSync(selected);
}
function dependencyRoot(requirement: Require, project: Project, overrides: Record<string, string>) {
  if (overrides[requirement.name]) return { path: resolveOverride(overrides[requirement.name]!, project, `override ${requirement.name}`), kind: "override" as const };
  if (requirement.ref.startsWith("path:")) return { path: ensureInsideProject(project, requirement.ref.slice(5), `path dependency ${requirement.name}`), kind: "external" as const };
  fail(`dependency ${requirement.name} (${requirement.ref}) is not available locally`, `Pass --override ${requirement.name}=PATH during M2; locked dependencies use skillful fetch in M4.`);
}
function selectedBy(requirement: Require, name: string) {
  if (!requirement.mode) return true;
  return requirement.mode === "only" ? requirement.selectors.includes(name) : !requirement.selectors.includes(name);
}
function sourcePath(entry: SkillEntry, file: string) {
  return entry.sourceKind === "canonical" ? `skills/${entry.name}/${file}` : `external/${entry.origin}/${entry.name}/${file}`;
}
function skillSource(entry: SkillEntry): Source {
  return { kind: entry.sourceKind === "canonical" ? "canonical" : "external", origin: entry.sourceKind === "canonical" ? "canonical" : entry.origin, path: sourcePath(entry, "SKILL.md") };
}
function commandSource(entry: CommandEntry): Source {
  return entry.sourceKind === "standalone"
    ? { kind: "standalone", origin: "canonical", path: `commands/${entry.name}` }
    : { kind: "external", origin: entry.origin, path: `external/${entry.origin}/${entry.name}` };
}
function uniqueByName<T extends { name: string; origin: string }>(entries: T[], kind: string) {
  const grouped = new Map<string, T[]>();
  for (const entry of entries) grouped.set(entry.name, [...(grouped.get(entry.name) ?? []), entry]);
  const duplicates = [...grouped].filter(([, values]) => values.length > 1);
  if (duplicates.length) fail(`duplicate ${kind} names: ${duplicates.map(([name, values]) => `${name} (${values.map((value) => value.origin).join(", ")})`).join("; ")}`, `Use only/exclude or rename one conflicting ${kind}.`);
}

function frontmatterEnd(lines: string[]) {
  if (lines[0] !== "---") return null;
  for (let index = 1; index < lines.length; index++) if (lines[index] === "---") return index;
  return null;
}
function topLevelKeyOf(line: string) { return line.match(/^([A-Za-z0-9][A-Za-z0-9_-]*):/)?.[1] ?? null; }
export function frontmatterKeys(text: string) {
  const lines = text.split("\n");
  const end = frontmatterEnd(lines);
  if (end === null) return [];
  return lines.slice(1, end).map(topLevelKeyOf).filter((key): key is string => key !== null);
}
function frontmatterValue(key: string, text: string) {
  const lines = text.split("\n");
  const end = frontmatterEnd(lines);
  if (end === null) return null;
  const source = lines.slice(1, end).join("\n");
  const document = parseDocument(source);
  if (document.errors.length) fail(`invalid YAML frontmatter: ${document.errors[0]!.message}`, "Fix the frontmatter and retry.");
  const node = document.get(key, true);
  return isScalar(node) ? node.value === null ? "" : String(node.value) : null;
}
function bodyOf(text: string) {
  const lines = text.split("\n");
  const end = frontmatterEnd(lines);
  return end === null ? text : lines.slice(end + 1).join("\n");
}
function filterFrontmatter(text: string, allowed: string[]) {
  const lines = text.split("\n");
  const end = frontmatterEnd(lines);
  if (end === null) return text;
  let retainedField = false;
  const kept = lines.slice(1, end).filter((line) => {
    const key = topLevelKeyOf(line);
    if (key !== null) {
      retainedField = allowed.includes(key);
      return retainedField;
    }
    if (line === "" || line.startsWith("#")) return true;
    return /^\s/.test(line) && retainedField;
  });
  return ["---", ...kept, "---", ...lines.slice(end + 1)].join("\n");
}
function frontmatterPlan(raw: string, rendered: string): FrontmatterPlan {
  const source = frontmatterKeys(raw);
  const result = frontmatterKeys(rendered);
  return { source, retained: source.filter((key) => result.includes(key)), omitted: source.filter((key) => !result.includes(key)), rendered: result };
}
function fenceMatch(line: string) { return line.match(/^\s*\{\{([#^])([a-z0-9 -]+)\}\}\s*$/); }
function canonicalHarness(name: string): HarnessId {
  if ((HARNESS_IDS as readonly string[]).includes(name)) return name as HarnessId;
  fail(`unknown harness ${name} in renderer fence`, `Use ${HARNESS_IDS.join(", ")}.`);
}
function fenceTransforms(id: HarnessId, text: string): Transformations["fences"] {
  return text.split("\n").flatMap((line) => {
    const match = fenceMatch(line);
    if (!match) return [];
    const targets = match[2]!.trim().split(/\s+/).map(canonicalHarness);
    const listed = targets.includes(id);
    const include = match[1] === "#";
    return [{ kind: "fence" as const, mode: include ? "include" as const : "exclude" as const, targets, outcome: ((include && listed) || (!include && !listed)) ? "selected" as const : "omitted" as const }];
  });
}
// Code blocks and spans show markup as written, so examples of fences, tokens and $@ survive rendering.
// Hiding it character-for-character keeps line numbers for error locations.
const CODE = /^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$|`[^`\n]+`/gm;
const HIDDEN_MARKUP: ReadonlyArray<readonly [string, string]> = [["{{", "\uE000"], ["}}", "\uE001"], ["$@", "\uE002"]];
function hideCodeMarkup(text: string) {
  return text.replace(CODE, (code) => HIDDEN_MARKUP.reduce((value, [markup, hidden]) => value.replaceAll(markup, hidden), code));
}
function showCodeMarkup(text: string) {
  return HIDDEN_MARKUP.reduce((value, [markup, hidden]) => value.replaceAll(hidden, markup), text);
}
function lineOf(text: string, needle: string) {
  const index = text.indexOf(needle);
  return index < 0 ? 1 : text.slice(0, index).split("\n").length;
}
function applyBlocks(id: HarnessId, text: string, source: string) {
  const out: string[] = [];
  let active = true;
  let inBlock = false;
  for (const [index, line] of text.split("\n").entries()) {
    const at = `${source}:${index + 1}`;
    const open = fenceMatch(line);
    if (open) {
      if (inBlock) fail(`${at}: nested renderer fences are not supported`, "Close the current fence with {{/}} before opening another.");
      const targets = open[2]!.trim().split(/\s+/).map(canonicalHarness);
      const listed = targets.includes(id);
      active = open[1] === "#" ? listed : !listed;
      inBlock = true;
      continue;
    }
    if (/^\s*\{\{\/\}\}\s*$/.test(line)) {
      if (!inBlock) fail(`${at}: stray {{/}} renderer fence`, "Remove the close marker or add its opening fence.");
      active = true;
      inBlock = false;
      continue;
    }
    if (active) out.push(line);
  }
  if (inBlock) fail(`${source}: unclosed {{#...}} or {{^...}} fence`, "Add {{/}} on its own line.");
  return out.join("\n");
}
function renderText(id: HarnessId, facts: HarnessFacts, tokens: Record<string, string>, text: string, source: string) {
  const hidden = hideCodeMarkup(text);
  let rendered = applyBlocks(id, hidden, source);
  for (const name of Object.keys(tokens).sort()) rendered = rendered.replaceAll(`{{${name}}}`, tokens[name]!);
  rendered = rendered.replaceAll("$@", facts.argSyntax);
  const leftover = rendered.match(/\{\{([A-Za-z0-9_.^#/ -]*)\}\}/s);
  if (leftover) {
    const marker = `{{${leftover[1]}}}`;
    const at = `${source}:${lineOf(hidden, marker)}`;
    const asWritten = "or put it in a code span or code block to show it as written";
    if (/^[#^/]/.test(leftover[1]!)) fail(`${at}: renderer fence ${marker} is not on a line of its own`, `Move the fence to its own line, ${asWritten}.`);
    const known = Object.keys(tokens).sort().join(", ");
    fail(`${at}: unknown token ${marker} for ${id}`, `Define it in skill.mod${known ? ` (known tokens: ${known})` : ""}, ${asWritten}.`);
  }
  return showCodeMarkup(rendered);
}
function transformations(id: HarnessId, facts: HarnessFacts, tokens: Record<string, string>, source: string): Transformations {
  const raw = hideCodeMarkup(source);
  return {
    fences: fenceTransforms(id, raw),
    tokens: Object.keys(tokens).sort().filter((name) => raw.includes(`{{${name}}}`)).map((name) => ({ kind: "token-substituted", token: name, value: tokens[name]! })),
    argSyntax: raw.includes("$@") ? { kind: "arg-syntax-substituted", from: "$@", to: facts.argSyntax } : null,
    command: [],
  };
}
function renderSkill(id: HarnessId, facts: HarnessFacts, tokens: Record<string, string>, raw: string, source: string) {
  return filterFrontmatter(renderText(id, facts, tokens, raw, source), facts.skillFrontmatter);
}
function renderCommand(id: HarnessId, facts: HarnessFacts, tokens: Record<string, string>, raw: string, source: string) {
  return filterFrontmatter(renderText(id, facts, tokens, raw, source), facts.commandFrontmatter);
}
function walkSupport(root: string, prefix = ""): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) return walkSupport(root, path);
    if (entry.isFile()) return [path];
    fail(`unsupported support file kind: ${join(root, path)}`, "Use regular files and directories in skill support content.");
  }).sort();
}
function supportFiles(entry: SkillEntry, deliveryRoot: string): SupportFilePlan[] {
  const dir = join(entry.root, entry.name);
  return walkSupport(dir).filter((path) => !["SKILL.md", "COMMAND.md", "SOURCE.md"].includes(path)).map((path) => {
    const content = readFileSync(join(dir, path));
    return { source: { path: sourcePath(entry, path) }, delivery: { kind: "file", path: `${deliveryRoot}/${path.replaceAll("\\", "/")}` }, sha256: sha256(content), copied: "verbatim", markup: content.includes(Buffer.from("{{")) || content.includes(Buffer.from("$@")), sourcePath: join(dir, path), generatedBody: null, relativePath: path };
  });
}
function omissionCode(omission: Omission) {
  // schemaVersion 1 established stable omission codes. Preserve them in later
  // manifests even though the generic model has no dedicated code field.
  if (omission.selector === "image-to-svg" && omission.reason === "Requires pi image conversion tools.") return "requires-pi-image-tools";
  if (omission.selector === "subagents" && omission.reason === "Requires the pi subagent extension.") return "pi-extension-only";
  return "project-omission";
}
function publicSkill(skill: SkillPlan) {
  const { sourceDir: _sourceDir, ...publicPlan } = skill;
  return {
    ...publicPlan,
    supportFiles: publicPlan.supportFiles.map(({ sourcePath: _sourcePath, generatedBody: _generatedBody, relativePath: _relativePath, ...support }) => support),
  };
}

function setupFor(project: Project, name: string): Setup {
  const setup = project.mod.setups[name];
  if (setup) return setup;
  const known = Object.keys(project.mod.setups).sort();
  fail(`unknown setup: ${name}`, `Choose one of: ${known.join(", ") || "none declared"}.`);
}

function resolveEntries(project: Project, options: ResolveOptions) {
  const overrides = options.overrides ?? {};
  const declared = new Set(project.mod.requires.map((requirement) => requirement.name));
  for (const name of Object.keys(overrides)) if (!declared.has(name)) fail(`override ${name} is not declared in skill.mod`, `Add a matching require or remove --override ${name}=PATH.`);
  const canonicalRoot = resolveProjectPath(project, project.mod.roots.skills, "directory");
  const skills: SkillEntry[] = sortedDirectoryNames(canonicalRoot).map((name) => ({ name, origin: "canonical", root: canonicalRoot, sourceKind: "canonical" }));
  for (const requirement of project.mod.requires) {
    const root = dependencyRoot(requirement, project, overrides);
    for (const name of sortedDirectoryNames(root.path).filter((candidate) => selectedBy(requirement, candidate))) skills.push({ name, origin: requirement.name, root: root.path, sourceKind: root.kind });
  }
  for (const extra of options.extraRoots?.skills ?? []) {
    if (!extra.origin) fail("extra skill root is missing an origin", "Give every extra root a stable provenance name.");
    const root = resolveOverride(extra.path, project, `extra skill root ${extra.origin}`);
    for (const name of sortedDirectoryNames(root)) skills.push({ name, origin: extra.origin, root, sourceKind: "extra" });
  }
  for (const entry of skills) if (!existsSync(join(entry.root, entry.name, "SKILL.md"))) fail(`skill ${entry.name} from ${entry.origin} has no SKILL.md`, `Add ${join(entry.root, entry.name, "SKILL.md")} or exclude the skill.`);
  uniqueByName(skills, "skill");
  const setup = options.setup ? setupFor(project, options.setup) : undefined;
  const knownSkills = new Set(skills.map((entry) => entry.name));
  for (const selector of setup?.selectors ?? []) if (!knownSkills.has(selector.name)) fail(`unknown skill ${selector.name} in setup ${setup!.name}`, "Use an exact skill name from `skillful list skills`.");
  const selectedSkills = setup?.mode === "only"
    ? skills.filter((entry) => setup.selectors.some((selector) => selector.name === entry.name))
    : setup?.mode === "omit"
      ? skills.filter((entry) => !setup.selectors.some((selector) => selector.name === entry.name))
      : skills;
  const selectedNames = new Set(selectedSkills.map((entry) => entry.name));
  const setupOmissions = Object.fromEntries(skills.filter((entry) => !selectedNames.has(entry.name)).map((entry) => {
    const selector = setup?.selectors.find((candidate) => candidate.name === entry.name);
    return [entry.name, { code: "setup-omission", message: selector?.reason ?? `Not selected by setup ${setup!.name}.` }];
  }));

  const commandRoot = resolveProjectPath(project, project.mod.roots.commands, "directory");
  const commands: CommandEntry[] = sortedMarkdown(commandRoot).map((name) => ({ name, origin: "canonical", root: commandRoot, sourceKind: "standalone" }));
  for (const extra of options.extraRoots?.commands ?? []) {
    if (!extra.origin) fail("extra command root is missing an origin", "Give every extra root a stable provenance name.");
    const root = resolveOverride(extra.path, project, `extra command root ${extra.origin}`);
    for (const name of sortedMarkdown(root)) commands.push({ name, origin: extra.origin, root, sourceKind: "extra" });
  }
  uniqueByName(commands, "command");
  return { skills: selectedSkills, commands, setupOmissions };
}

function buildHarness(project: Project, id: HarnessId, facts: HarnessFacts, installPaths: HarnessInstallPaths, entries: ReturnType<typeof resolveEntries>): HarnessPlan {
  const config = project.mod.harnesses[id];
  const tokens = config?.tokens ?? {};
  const omissions = config?.omissions ?? [];
  const omittedSkills = { ...entries.setupOmissions, ...Object.fromEntries(omissions.filter((item) => item.kind === "omit-skill").map((item) => [item.selector, { code: omissionCode(item), message: item.reason }])) };
  const omittedCommands = new Set(omissions.filter((item) => item.kind === "omit-command").flatMap((item) => [item.selector, item.selector.endsWith(".md") ? item.selector : `${item.selector}.md`]));
  const selectedEntries = entries.skills.filter((entry) => !omittedSkills[entry.name]);
  const selectedCommands = entries.commands.filter((entry) => !omittedCommands.has(entry.name));
  const attached = selectedEntries.find((entry) => entry.sourceKind === "canonical" && existsSync(join(entry.root, entry.name, "COMMAND.md")));
  if (attached) fail(`skills/${attached.name}/COMMAND.md is not supported`, "A command is a saved prompt, separate from any skill. Move it to commands/ under a name no skill uses, or delete it and invoke the skill directly.");
  const skillNames = new Set(selectedEntries.map((entry) => entry.name));
  const clashes = selectedCommands.map((entry) => entry.name.replace(/\.md$/, "")).filter((name) => skillNames.has(name));
  // Harnesses that deliver commands as skills, or register skills as commands, cannot hold both under one name.
  if (clashes.length) fail(`commands share a name with skills for ${id}: ${clashes.join(", ")}`, "Rename the command or omit one of them.");
  const commandsAsSkills = facts.commandMerge === "skill";
  const commandRoot = installPaths.commands;
  if (!commandsAsSkills && !commandRoot) fail(`harness ${id} has no command destination`, "Repair its bundled harness facts.");
  const agentSkillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  const commands: CommandPlan[] = commandsAsSkills ? [] : selectedCommands.map((entry) => {
    const raw = readFileSync(join(entry.root, entry.name), "utf8");
    const body = renderCommand(id, facts, tokens, raw, commandSource(entry).path!);
    return { name: entry.name, source: commandSource(entry), delivery: { kind: "file", path: `${commandRoot!}/${entry.name}` }, sha256: sha256(body), frontmatter: frontmatterPlan(raw, body), transformations: transformations(id, facts, tokens, raw), body };
  });
  uniqueByName(commands.map((command) => ({ name: command.name, origin: command.source.origin ?? command.source.kind })), `delivered command for ${id}`);

  const authoredSkills: SkillPlan[] = selectedEntries.map((entry) => {
    const raw = readFileSync(join(entry.root, entry.name, "SKILL.md"), "utf8");
    const body = renderSkill(id, facts, tokens, raw, sourcePath(entry, "SKILL.md"));
    if (facts.agentSkillNames && (entry.name.length > 64 || !agentSkillName.test(entry.name))) fail(`invalid Agent Skill name ${JSON.stringify(entry.name)} rendered for ${id}`, "Rename the skill using at most 64 lowercase letters, numbers, and single hyphens.");
    return {
      name: entry.name,
      description: frontmatterValue("description", body),
      origin: entry.origin,
      source: skillSource(entry),
      delivery: { kind: "file", path: `${installPaths.skills}/${entry.name}/SKILL.md` },
      sha256: sha256(body),
      frontmatter: frontmatterPlan(raw, body),
      transformations: transformations(id, facts, tokens, raw),
      supportFiles: supportFiles(entry, `${installPaths.skills}/${entry.name}`),
      body,
      sourceDir: join(entry.root, entry.name),
    };
  });

  // Without saved prompts, a command becomes a skill only the person can invoke.
  const syntheticSkills: SkillPlan[] = commandsAsSkills ? selectedCommands.map((entry) => {
    const name = entry.name.replace(/\.md$/, "");
    if (facts.agentSkillNames && (name.length > 64 || !agentSkillName.test(name))) fail(`invalid Agent Skill name ${JSON.stringify(name)} synthesized from command ${entry.name} for ${id}`, "Rename the command using at most 64 lowercase letters, numbers, and single hyphens.");
    const raw = readFileSync(join(entry.root, entry.name), "utf8");
    const rendered = renderText(id, facts, tokens, raw, commandSource(entry).path!);
    const description = frontmatterValue("description", rendered) ?? `Run the ${name} prompt when explicitly invoked.`;
    const hint = frontmatterValue("argument-hint", rendered);
    const extra = [
      ...(hint && facts.skillFrontmatter.includes("argument-hint") ? [`argument-hint: ${JSON.stringify(hint)}`] : []),
      ...Object.entries(facts.syntheticSkillFrontmatter ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}: ${typeof value === "boolean" ? value : JSON.stringify(value)}`),
    ];
    const body = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}${extra.length ? `\n${extra.join("\n")}` : ""}\n---\n\n${bodyOf(rendered).replace(/^\n/, "")}`;
    const commandTransforms = transformations(id, facts, tokens, raw);
    commandTransforms.command = ["command-synthesized-as-skill"];
    return {
      name,
      description,
      origin: entry.origin,
      source: commandSource(entry),
      delivery: { kind: "file", path: `${installPaths.skills}/${name}/SKILL.md` },
      sha256: sha256(body),
      frontmatter: frontmatterPlan(raw, body),
      transformations: commandTransforms,
      supportFiles: Object.entries(facts.syntheticSkillFiles ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([path, generatedBody]) => ({ source: { path: null }, delivery: { kind: "file", path: `${installPaths.skills}/${name}/${path}` }, sha256: sha256(generatedBody), copied: "generated", markup: false, sourcePath: null, generatedBody, relativePath: path })),
      body,
      sourceDir: entry.root,
    };
  }) : [];
  const skills = [...authoredSkills, ...syntheticSkills].sort((left, right) => left.name.localeCompare(right.name));

  const rulesPath = resolveProjectPath(project, project.mod.roots.rules, "file");
  const rulesRaw = readFileSync(rulesPath, "utf8");
  const rulesBody = renderText(id, facts, tokens, rulesRaw, project.mod.roots.rules);
  return {
    id,
    facts,
    profile: { argSyntax: facts.argSyntax, installPaths, commandMerge: facts.commandMerge, exclusions: omittedSkills, excludeCommands: [...omittedCommands].sort(), commandExclude: [] },
    omittedSkills,
    skills,
    commands,
    rules: { source: { kind: "canonical", path: "rules/global_agents.md" }, delivery: installPaths.rules ? { kind: "file", path: installPaths.rules } : null, sha256: sha256(rulesBody), body: rulesBody },
    assets: [],
  };
}

export function resolvePlan(project: Project, options: ResolveOptions = {}): ProjectPlan {
  const setup = options.setup ? setupFor(project, options.setup) : null;
  const selected = [...new Set(setup
    ? setup.harnesses.map((harness) => harness.id)
    : options.harnesses?.length
      ? options.harnesses
      : HARNESS_IDS.filter((id) => project.mod.harnesses[id] !== undefined))];
  if (!selected.length) fail("project selects no harnesses", "Declare a harness in skill.mod, select one through a setup, or pass --harness.");
  const facts = loadHarnesses();
  const entries = resolveEntries(project, { ...options, overrides: cachedDependencyPaths(project, options.overrides) });
  const scope = setup?.root ?? "home";
  const harnesses: ProjectPlan["harnesses"] = {};
  for (const id of selected) harnesses[id] = buildHarness(project, id, facts[id], facts[id].installPaths[scope], entries);
  return { project, harnesses };
}
export function schemaFor(project: Project) {
  const facts = loadHarnesses();
  return {
    markup: ["{{token}}", "{{#harness}}", "{{^harness}}", "{{/}}", "$@"],
    harnesses: mapHarnesses((id) => {
      const value = facts[id];
      return { argSyntax: value.argSyntax, tokens: project.mod.harnesses[id]?.tokens ?? {}, skillFrontmatter: value.skillFrontmatter, commandFrontmatter: value.commandFrontmatter, commandMerge: value.commandMerge, agentSkillNames: value.agentSkillNames === true };
    }),
  };
}
export function contractFor(plan: ProjectPlan) {
  return {
    schemaVersion: 1,
    schema: schemaFor(plan.project),
    manifest: {
      setups: Object.fromEntries(Object.values(plan.project.mod.setups).sort((a, b) => a.name.localeCompare(b.name)).map((setup) => [setup.name, {
        root: setup.root,
        selection: { mode: setup.mode ?? "all", skills: setup.selectors.map(({ name, reason }) => ({ name, ...(reason ? { reason } : {}) })) },
        harnesses: setup.harnesses.map((harness) => ({ name: harness.id, paths: harness.paths })),
      }])),
      harnesses: Object.fromEntries(harnessIds(plan).map((id) => {
        const harness = harnessPlan(plan, id);
        return [id, { profile: harness.profile, skills: harness.skills.map(publicSkill), omittedSkills: harness.omittedSkills, commands: harness.commands, rules: { source: harness.rules.source, delivery: harness.rules.delivery, sha256: harness.rules.sha256 }, assets: [] }];
      })),
    },
  };
}
