import type { Frame, Page } from "playwright";
import {
  asCodegenLocator,
  candidateToLocator,
  generateCandidates,
} from "./candidates.js";
import { resolvesToActionTarget } from "./identity.js";
import { scoreCandidate } from "./score.js";
import type { LocatorContext, RawDomContext, SmartConfig } from "../types.js";

export interface AnalyzeOptions {
  /** CSS selector identifying the exact element that was interacted with. */
  targetSelector?: string | undefined;
}

export async function analyzeContext(
  page: Page | Frame,
  raw: RawDomContext,
  config: SmartConfig,
  options: AnalyzeOptions = {},
): Promise<LocatorContext> {
  const generated = generateCandidates(raw, config);
  const candidates = await Promise.all(
    generated.candidates.map(async (candidate) => {
      let count = 0;
      let resolvesToTarget = true;
      try {
        const locator = candidateToLocator(page, candidate.locator);
        count = await locator.count();
        if (options.targetSelector && count > 0)
          resolvesToTarget = await locator.evaluateAll(
            resolvesToActionTarget,
            options.targetSelector,
          );
      } catch {
        count = 0;
      }
      const scored = scoreCandidate(candidate, count, config);
      if (resolvesToTarget) return { ...scored, resolvesToTarget: true };
      return {
        ...scored,
        score: Math.max(0, scored.score - 60),
        confidence: "low" as const,
        penalties: [...scored.penalties, "resolves to a different element"],
        resolvesToTarget: false,
      };
    }),
  );
  candidates.sort(
    (left, right) =>
      right.score - left.score || left.locator.localeCompare(right.locator),
  );
  const recommended =
    candidates.find(
      ({ matchCount, score, resolvesToTarget }) =>
        (resolvesToTarget ?? true) &&
        (!config.requireUniqueLocator || matchCount === 1) &&
        score >= config.minimumLocatorScore,
    ) ?? null;
  const codegenSource =
    candidates.find(({ kind }) => kind === "role") ??
    candidates.find(({ kind }) => kind === "text") ??
    candidates[0];
  const codegenLocator = codegenSource
    ? asCodegenLocator(codegenSource)
    : {
        type: "locator",
        value: raw.target.tag,
        expression: `locator("${raw.target.tag}")`,
      };
  const codegenMatch =
    codegenSource?.matchCount ?? (await page.locator(raw.target.tag).count());

  return {
    version: "1.0",
    capturedAt: new Date().toISOString(),
    url: raw.url,
    ...(raw.pageHeading ? { pageHeading: raw.pageHeading } : {}),
    codegenLocator,
    target: raw.target,
    ancestors: raw.ancestors,
    siblings: raw.siblings,
    nearby: raw.nearby,
    matchingElements: { codegenLocatorCount: codegenMatch },
    candidates,
    recommended,
    alternatives: candidates
      .filter((candidate) => candidate !== recommended)
      .slice(0, 5),
    rejected: generated.rejected,
    ...(raw.containerHtml ? { containerHtml: raw.containerHtml } : {}),
    ...(raw.containerHtmlTruncated !== undefined
      ? { containerHtmlTruncated: raw.containerHtmlTruncated }
      : {}),
  };
}
