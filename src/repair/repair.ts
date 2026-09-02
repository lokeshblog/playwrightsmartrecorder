import { readFile, writeFile } from "node:fs/promises";
import type { Page } from "playwright";
import { extractDomContext } from "../context/extract.js";
import { analyzeContext } from "../locator/analyze.js";
import { candidateToLocator } from "../locator/candidates.js";
import type { RepairResult, SmartConfig } from "../types.js";

export interface RepairOptions {
  hint?: string;
  file?: string;
  apply?: boolean;
}

export async function repairLocator(
  page: Page,
  originalExpression: string,
  config: SmartConfig,
  options: RepairOptions = {},
): Promise<RepairResult> {
  const normalized = originalExpression.trim().replace(/^page\./, "");
  let originalCount = 0;
  try {
    originalCount = await candidateToLocator(page, normalized).count();
  } catch {
    originalCount = 0;
  }
  if (originalCount === 1) {
    return {
      original: originalExpression,
      status: "working",
      originalMatchCount: 1,
      replacement: null,
      alternatives: [],
    };
  }

  let target =
    originalCount > 0 ? candidateToLocator(page, normalized).first() : null;
  if (!target && options.hint) {
    const exactText = page.getByText(options.hint, { exact: true });
    if ((await exactText.count()) > 0) target = exactText.first();
    else {
      const named = page.getByRole("button", {
        name: options.hint,
        exact: false,
      });
      if ((await named.count()) > 0) target = named.first();
    }
  }
  if (!target) {
    return {
      original: originalExpression,
      status: "failed",
      originalMatchCount: 0,
      replacement: null,
      alternatives: [],
    };
  }

  const raw = await extractDomContext(target, config);
  const analysis = await analyzeContext(page, raw, config);
  const result: RepairResult = {
    original: originalExpression,
    status: originalCount > 1 ? "ambiguous" : "failed",
    originalMatchCount: originalCount,
    replacement: analysis.recommended,
    alternatives: analysis.alternatives,
  };
  if (options.apply) {
    if (!options.file) throw new Error("--apply requires --file <test-file>");
    if (!analysis.recommended)
      throw new Error("No safe replacement met the configured threshold");
    const source = await readFile(options.file, "utf8");
    const replacement = analysis.recommended.locator.startsWith("page.")
      ? analysis.recommended.locator
      : `page.${analysis.recommended.locator}`;
    const variants = [originalExpression, normalized, `page.${normalized}`];
    const matched = variants.find((variant) => source.includes(variant));
    if (!matched)
      throw new Error(`Original locator was not found in ${options.file}`);
    const updated = source.replaceAll(matched, replacement);
    const replacements = source.split(matched).length - 1;
    await writeFile(options.file, updated);
    result.applied = { file: options.file, replacements };
  }
  return result;
}
