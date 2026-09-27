import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { contractFor, harnessIds, harnessPlan, resolvePlan, schemaFor, sha256, type ResolveOptions, type SkillPlan } from "./contract.ts";
import { loadHarnesses } from "./harness.ts";
import { HARNESS_IDS, type HarnessId } from "./mod.ts";
import { discoverProject, type Project } from "./project.ts";
import { resolveSetup } from "./setup.ts";

export type OutputFormat = "text" | "json";
export class IntrospectionError extends Error { constructor(message: string, readonly recovery: string) { super(message); } }
function fail(message: string, recovery: string): never { throw new IntrospectionError(message, `Recovery: ${recovery}`); }
function emit(value: unknown, format: OutputFormat, text: () => string) { console.log(format === "json" ? JSON.stringify(value, null, 2) : text()); }
function publicSkill(skill: SkillPlan, rendered: boolean) {
  const { sourceDir: _sourceDir, ...value } = skill;
  const supportFiles = value.supportFiles.map(({ sourcePath: _sourcePath, generatedBody: _generatedBody, relativePath: _relativePath, ...support }) => support);
  return rendered ? { ...value, supportFiles } : { ...value, supportFiles, body: undefined };
}
export function manifestCommand(project: Project, options: ResolveOptions & { harnesses?: HarnessId[] | undefined; format: OutputFormat }) {
  const plan = resolvePlan(project, options);
  const manifest = { schemaVersion: 1, ...contractFor(plan).manifest };
  emit(manifest, options.format, () => [
    ...Object.keys(manifest.setups).map((name) => `setup ${name}`),
    ...harnessIds(plan).map((id) => { const harness = harnessPlan(plan, id); return `${id}: ${harness.skills.length} skills, ${harness.commands.length} commands`; }),
  ].join("\n"));
}
export function schemaCommand(project: Project, options: ResolveOptions & { format: OutputFormat }) {
  const schema = schemaFor(project);
  emit({ schemaVersion: 1, schema }, options.format, () => ["schemaVersion: 1", `harnesses: ${Object.keys(schema.harnesses).join(", ")}`, `markup: ${schema.markup.join(", ")}`].join("\n"));
}
type ListedSkill = { status: "included"; origin: string } | { status: "omitted"; reason: string } | { status: "absent" };
function listedSkillEntry(plan: ReturnType<typeof resolvePlan>, id: HarnessId, name: string): readonly [HarnessId, ListedSkill] {
  const harness = harnessPlan(plan, id);
  const skill = harness.skills.find((entry) => entry.name === name);
  if (skill) return [id, { status: "included", origin: skill.origin }];
  const omission = harness.omittedSkills[name];
  return [id, omission ? { status: "omitted", reason: omission.message } : { status: "absent" }];
}
export function listCommand(project: Project, selector: "skills" | "harnesses" | "setups", options: ResolveOptions & { harnesses?: HarnessId[] | undefined; format: OutputFormat }) {
  if (selector === "setups") {
    const names = Object.keys(project.mod.setups).sort();
    emit({ schemaVersion: 1, setups: names }, options.format, () => names.join("\n"));
    return;
  }
  if (selector === "harnesses") {
    const facts = loadHarnesses();
    const ids = options.harnesses?.length ? [...new Set(options.harnesses)] : [...HARNESS_IDS];
    const harnesses = ids.map((id) => {
      const { name, ...profile } = facts[id];
      return { name, profile };
    });
    emit({ schemaVersion: 1, harnesses }, options.format, () => ids.join("\n"));
    return;
  }
  const plan = resolvePlan(project, options);
  const ids = harnessIds(plan);
  const names = [...new Set(ids.flatMap((id) => harnessPlan(plan, id).skills.map((skill) => skill.name)))].sort();
  const rows = names.map((name) => {
    const entries = ids.map((id) => listedSkillEntry(plan, id, name));
    return {
      value: { name, harnesses: Object.fromEntries(entries) },
      text: `${name}\t${entries.map(([id, entry]) => `${id}:${entry.status}`).join(" ")}`,
    };
  });
  emit({ schemaVersion: 1, skills: rows.map((row) => row.value) }, options.format, () => rows.map((row) => row.text).join("\n"));
}
export function setupShowCommand(project: Project, name: string, options: ResolveOptions & { format: OutputFormat }) {
  const setup = resolveSetup(project, name, options);
  emit({ schemaVersion: 1, setup }, options.format, () => [
    `${setup.name}: root=${setup.root} selection=${setup.selection.mode}`,
    ...setup.harnesses.map((harness) => `${harness.name}: ${Object.entries(harness.paths).map(([kind, path]) => `${kind}=${path}`).join(" ")}`),
    ...Object.entries(setup.files).map(([path, file]) => `${path}\t${file.harness}:${file.artifact}`),
  ].join("\n"));
}

type Inspection =
  | { status: "included"; skill: ReturnType<typeof publicSkill> }
  | { status: "omitted"; omission: { code: string; message: string } }
  | { status: "absent" };
function inspectionEntry(plan: ReturnType<typeof resolvePlan>, id: HarnessId, name: string, rendered: boolean): readonly [HarnessId, Inspection] {
  const harness = harnessPlan(plan, id);
  const skill = harness.skills.find((entry) => entry.name === name);
  if (skill) return [id, { status: "included", skill: publicSkill(skill, rendered) }];
  const omission = harness.omittedSkills[name];
  return [id, omission ? { status: "omitted", omission } : { status: "absent" }];
}
export function inspectCommand(project: Project, name: string, options: ResolveOptions & { harnesses?: HarnessId[] | undefined; rendered?: boolean | undefined; format: OutputFormat }) {
  const plan = resolvePlan(project, options);
  const ids = harnessIds(plan);
  const entries = ids.map((id) => inspectionEntry(plan, id, name, Boolean(options.rendered)));
  const harnesses = Object.fromEntries(entries);
  if (entries.every(([, entry]) => entry.status === "absent")) fail(`unknown skill: ${name}`, "Run `skillful list skills` to see available selectors.");
  emit({ schemaVersion: 1, name, harnesses }, options.format, () => entries.map(([id, entry]) => {
    if (entry.status !== "included") return `${id}: ${entry.status}`;
    return `${id}: included (${entry.skill.origin})${options.rendered ? `\n${entry.skill.body}` : ""}`;
  }).join("\n\n"));
}
export function checkCommand(project: Project, names: string[], options: ResolveOptions & { harnesses?: HarnessId[] | undefined; strict?: boolean | undefined; format: OutputFormat }) {
  const plan = resolvePlan(project, options);
  const ids = harnessIds(plan);
  const known = new Set(ids.flatMap((id) => harnessPlan(plan, id).skills.map((skill) => skill.name)));
  for (const name of names) if (!known.has(name)) fail(`unknown skill: ${name}`, "Run `skillful list skills` to see available selectors.");
  const selected = names.length ? new Set(names) : null;
  const warnings: Array<{ code: string; harness: HarnessId; skill?: string; message: string }> = [];
  for (const id of ids) {
    const harness = harnessPlan(plan, id);
    for (const skill of harness.skills) if ((!selected || selected.has(skill.name)) && !skill.body.trim()) warnings.push({ code: "empty-skill", harness: id, skill: skill.name, message: "rendered skill body is empty" });
    for (const command of harness.commands) if (!command.body.trim()) warnings.push({ code: "empty-command", harness: id, message: `${command.name} renders empty` });
  }
  const ok = warnings.length === 0 || !options.strict;
  emit({ schemaVersion: 1, ok, strict: Boolean(options.strict), warnings }, options.format, () => warnings.length ? warnings.map((warning) => `${warning.harness}: ${warning.message}`).join("\n") : "OK");
  if (!ok) process.exitCode = 1;
}
function git(cwd: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always" } });
  if (result.exitCode !== 0) {
    const detail = new TextDecoder().decode(result.stderr).trim();
    fail(`local Git command failed: git ${args.join(" ")}`, `${detail ? `${detail}. ` : ""}Prepare the revision locally and retry; skillful never fetches during diff.`);
  }
  return result.stdout;
}
function historicalProject(project: Project, revision: string) {
  const repo = new TextDecoder().decode(git(project.root, ["rev-parse", "--show-toplevel"])).trim();
  git(repo, ["cat-file", "-e", `${revision}^{commit}`]);
  const archive = git(repo, ["archive", "--format=tar", revision]);
  const temp = mkdtempSync(join(tmpdir(), "skillful-diff-"));
  const archivePath = join(temp, ".skillful-archive.tar");
  writeFileSync(archivePath, Buffer.from(archive));
  const extract = Bun.spawnSync(["tar", "-xf", archivePath, "-C", temp], { stdout: "pipe", stderr: "pipe" });
  unlinkSync(archivePath);
  if (extract.exitCode !== 0) {
    const detail = new TextDecoder().decode(extract.stderr).trim();
    rmSync(temp, { recursive: true, force: true });
    fail(`cannot materialize local revision ${revision}`, `${detail ? `${detail}. ` : ""}Ensure tar is available and the revision is committed locally.`);
  }
  const relativeProject = relative(repo, project.root);
  try { return { temp, project: discoverProject({ project: join(temp, relativeProject) }) }; }
  catch { rmSync(temp, { recursive: true, force: true }); fail(`revision ${revision} has no current skill.mod project at ${relativeProject || "."}`, "Choose a TypeScript-era revision containing skill.mod; legacy contract fallbacks are intentionally unsupported."); }
}
function lineDiff(before: string, after: string) {
  if (before === after) return "";
  const left = before.split("\n"); const right = after.split("\n");
  return ["--- before", "+++ after", ...left.map((line) => `-${line}`), ...right.map((line) => `+${line}`)].join("\n");
}
export function diffCommand(project: Project, name: string, options: ResolveOptions & { against?: string | undefined; harnesses?: HarnessId[] | undefined; format: OutputFormat }) {
  const current = resolvePlan(project, options);
  const ids = harnessIds(current);
  let historical: ReturnType<typeof historicalProject> | undefined;
  try {
    const previous = options.against ? (historical = historicalProject(project, options.against)).project : null;
    const oldPlan = previous ? resolvePlan(previous, { ...options, harnesses: ids }) : null;
    const comparisons = Object.fromEntries(ids.map((id) => {
      const currentSkill = harnessPlan(current, id).skills.find((skill) => skill.name === name);
      const beforeSkill = oldPlan ? harnessPlan(oldPlan, id).skills.find((skill) => skill.name === name) : undefined;
      const before = beforeSkill?.body ?? (options.against ? null : harnessPlan(current, ids[0]!).skills.find((skill) => skill.name === name)?.body ?? null);
      const after = currentSkill?.body ?? null;
      return [id, { status: before === after ? "identical" : before === null ? "added" : after === null ? "removed" : "changed", beforeSha256: before === null ? null : sha256(before), afterSha256: after === null ? null : sha256(after), diff: before === null || after === null ? null : lineDiff(before, after) }];
    }));
    if (Object.values(comparisons).every((entry) => entry.beforeSha256 === null && entry.afterSha256 === null)) fail(`unknown skill: ${name}`, "Run `skillful list skills` to see available selectors.");
    emit({ schemaVersion: 1, name, against: options.against ?? null, harnesses: comparisons }, options.format, () => ids.map((id) => `${id}: ${comparisons[id]!.status}${comparisons[id]!.diff ? `\n${comparisons[id]!.diff}` : ""}`).join("\n\n"));
  } finally { if (historical) rmSync(historical.temp, { recursive: true, force: true }); }
}
