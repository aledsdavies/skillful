import claude from "../harnesses/claude.json";
import codex from "../harnesses/codex.json";
import cursor from "../harnesses/cursor.json";
import grok from "../harnesses/grok.json";
import opencode from "../harnesses/opencode.json";
import pi from "../harnesses/pi.json";
import { HARNESS_IDS, type HarnessId } from "./mod.ts";

export type HarnessInstallPaths = { skills: string; commands?: string; rules?: string };
export type HarnessFacts = {
  name: HarnessId;
  installPaths: Record<"home" | "project", HarnessInstallPaths>;
  argSyntax: string;
  skillFrontmatter: string[];
  commandFrontmatter: string[];
  commandMerge: "file" | "skill";
  agentSkillNames?: boolean;
  syntheticSkillFiles?: Record<string, string>;
  syntheticSkillFrontmatter?: Record<string, string | boolean>;
};
export class HarnessError extends Error { constructor(message: string, readonly recovery = `Choose one of: ${HARNESS_IDS.join(", ")}.`) { super(message); } }

const EMBEDDED_FACTS: ReadonlyArray<readonly [string, unknown]> = [
  ["claude.json", claude],
  ["codex.json", codex],
  ["cursor.json", cursor],
  ["grok.json", grok],
  ["opencode.json", opencode],
  ["pi.json", pi],
];
function validateInstallPaths(candidate: unknown, path: string, scope: "home" | "project", commandMerge: unknown): HarnessInstallPaths {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new HarnessError(`invalid harness facts ${path}: installPaths.${scope} must be an object`, "Repair the bundled harness JSON before using skillful.");
  const paths = candidate as Record<string, unknown>;
  if (typeof paths.skills !== "string" || (paths.commands !== undefined && typeof paths.commands !== "string") || (paths.rules !== undefined && typeof paths.rules !== "string")) throw new HarnessError(`invalid harness facts ${path}: installPaths.${scope} contains an invalid path`, "Repair the bundled harness JSON before using skillful.");
  if (commandMerge === "skill" ? paths.commands !== undefined : typeof paths.commands !== "string") throw new HarnessError(`invalid harness facts ${path}: installPaths.${scope}.commands does not match commandMerge`, "Use no commands path for skill delivery and a commands path for file delivery.");
  return paths as HarnessInstallPaths;
}
function validate(candidate: unknown, path: string): HarnessFacts {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new HarnessError(`invalid harness facts ${path}: expected an object`, "Repair the bundled harness JSON before using skillful.");
  const value = candidate as Record<string, unknown>;
  const name = value.name;
  if (typeof name !== "string" || !(HARNESS_IDS as readonly string[]).includes(name)) throw new HarnessError(`invalid harness facts ${path}: unknown name`, "Use one public harness identifier.");
  if (typeof value.argSyntax !== "string" || (value.commandMerge !== "file" && value.commandMerge !== "skill")) throw new HarnessError(`invalid harness facts ${path}: argSyntax or commandMerge is invalid`, "Repair the bundled harness JSON before using skillful.");
  const installPaths = value.installPaths;
  if (!installPaths || typeof installPaths !== "object" || Array.isArray(installPaths)) throw new HarnessError(`invalid harness facts ${path}: installPaths must be an object`, "Repair the bundled harness JSON before using skillful.");
  const profiles = installPaths as Record<string, unknown>;
  validateInstallPaths(profiles.home, path, "home", value.commandMerge);
  validateInstallPaths(profiles.project, path, "project", value.commandMerge);
  if (value.agentSkillNames !== undefined && typeof value.agentSkillNames !== "boolean") throw new HarnessError(`invalid harness facts ${path}: agentSkillNames must be a boolean`, "Repair the bundled harness JSON before using skillful.");
  const synthetic = value.syntheticSkillFiles;
  if (synthetic !== undefined && (!synthetic || typeof synthetic !== "object" || Array.isArray(synthetic) || Object.entries(synthetic).some(([file, body]) => !file || file.startsWith("/") || file.split("/").includes("..") || typeof body !== "string"))) throw new HarnessError(`invalid harness facts ${path}: syntheticSkillFiles is invalid`, "Use safe relative file names with string contents.");
  const syntheticFrontmatter = value.syntheticSkillFrontmatter;
  if (syntheticFrontmatter !== undefined && (!syntheticFrontmatter || typeof syntheticFrontmatter !== "object" || Array.isArray(syntheticFrontmatter) || Object.entries(syntheticFrontmatter).some(([key, field]) => !key || (typeof field !== "string" && typeof field !== "boolean")))) throw new HarnessError(`invalid harness facts ${path}: syntheticSkillFrontmatter is invalid`, "Use frontmatter names with string or boolean values.");
  for (const key of ["skillFrontmatter", "commandFrontmatter"]) if (!Array.isArray(value[key]) || !value[key]!.every((entry) => typeof entry === "string")) throw new HarnessError(`invalid harness facts ${path}: ${key} must be a string array`, "Repair the bundled harness JSON before using skillful.");
  return value as HarnessFacts;
}

export function loadHarnesses(): Record<HarnessId, HarnessFacts> {
  const result: Partial<Record<HarnessId, HarnessFacts>> = {};
  for (const [file, candidate] of EMBEDDED_FACTS) {
    const fact = validate(candidate, file);
    if (file !== `${fact.name}.json`) throw new HarnessError(`invalid harness facts ${file}: filename must match ${fact.name}.json`, "Rename the fact file or correct its name field.");
    if (result[fact.name]) throw new HarnessError(`duplicate harness facts for ${fact.name}`, "Keep one JSON fact file per public harness.");
    result[fact.name] = fact;
  }
  for (const name of HARNESS_IDS) if (!result[name]) throw new HarnessError(`missing harness facts for ${name}`, "Restore the bundled harness facts.");
  return result as Record<HarnessId, HarnessFacts>;
}

export function normalizeHarness(input: string): { name: HarnessId; warning?: string } {
  if (input === "opencode-v2") throw new HarnessError(
    "retired harness: opencode-v2",
    "Use opencode. Keep the retired layout with --path skills=.config/opencode-v2/skills --path commands=.config/opencode-v2/commands.",
  );
  if (!(HARNESS_IDS as readonly string[]).includes(input)) throw new HarnessError(`unknown harness: ${input}`);
  return { name: input as HarnessId };
}
