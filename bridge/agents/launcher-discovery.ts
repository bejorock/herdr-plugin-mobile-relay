import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
/** Inspect fixed names in owner-attested launch PATH. Never execute probes or disclose paths. */
export async function executableEvidence(kind: "pi" | "claude", path: string[]): Promise<"available" | "unavailable" | "unknown"> {
  let uncertain = false;
  for (const directory of path) {
    try {
      const file = join(directory, kind);
      if (!(await stat(file)).isFile()) continue;
      await access(file, constants.X_OK); return "available";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(code ?? "")) uncertain = true;
      // Inaccessible PATH directories may hide a launcher; do not assert absence.
      if (["EACCES", "EPERM"].includes(code ?? "")) uncertain = true;
    }
  }
  return uncertain ? "unknown" : "unavailable";
}
