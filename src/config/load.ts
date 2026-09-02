import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig, smartConfigSchema } from "./schema.js";
import type { SmartConfig } from "../types.js";

const exists = async (file: string): Promise<boolean> =>
  access(file, constants.F_OK).then(
    () => true,
    () => false,
  );

export async function findRepositoryRoot(
  start = process.cwd(),
): Promise<string> {
  let current = path.resolve(start);
  while (true) {
    for (const marker of [
      ".git",
      "package.json",
      "pnpm-workspace.yaml",
      "yarn.lock",
    ]) {
      if (await exists(path.join(current, marker))) return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

export async function loadConfig(root: string): Promise<SmartConfig> {
  const configPath = path.join(root, ".codegen", "config.json");
  if (!(await exists(configPath)))
    return smartConfigSchema.parse(defaultConfig);
  const raw: unknown = JSON.parse(await readFile(configPath, "utf8"));
  return smartConfigSchema.parse(raw);
}

export async function initializeProject(
  root: string,
): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const targets: Array<{ path: string; content?: string; source?: string }> = [
    {
      path: path.join(root, ".codegen", "config.json"),
      content: `${JSON.stringify(defaultConfig, null, 2)}\n`,
    },
    {
      path: path.join(root, ".codegen", "locator-context.json"),
      content: "{}\n",
    },
    {
      path: path.join(root, ".codegen", "scenario-context.json"),
      content: "{}\n",
    },
    {
      path: path.join(
        root,
        ".cursor",
        "skills",
        "codegen-to-project",
        "SKILL.md",
      ),
      source: path.join(packageRoot, "skill", "codegen-to-project", "SKILL.md"),
    },
  ];

  for (const target of targets) {
    if (await exists(target.path)) {
      skipped.push(target.path);
      continue;
    }
    await mkdir(path.dirname(target.path), { recursive: true });
    const content =
      target.content ??
      (target.source ? await readFile(target.source, "utf8") : "");
    await writeFile(target.path, content, { flag: "wx" });
    created.push(target.path);
  }
  return { created, skipped };
}
