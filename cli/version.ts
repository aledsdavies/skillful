import packageJson from "../package.json" with { type: "json" };
import { revision, sourceHash } from "./build-identity.ts";

export function formatVersion(nextVersion: string, nextRevision: string | null, nextSourceHash: string | null) {
  const parts = [
    ...(nextRevision ? [`rev ${nextRevision}`] : []),
    ...(nextSourceHash ? [`source ${nextSourceHash}`] : []),
  ];
  return parts.length === 0 ? `skillful ${nextVersion}` : `skillful ${nextVersion} (${parts.join("; ")})`;
}

export function skillfulVersion() {
  return formatVersion(packageJson.version, revision, sourceHash);
}
