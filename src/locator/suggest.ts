import type {
  LocatorContext,
  LocatorSuggestion,
  SmartConfig,
} from "../types.js";

/**
 * Locator offers for one step, best first.
 *
 * A step only needs help when nothing resolved cleanly, so offering just the
 * unique matches is exactly the case where the list comes back empty. An
 * ambiguous or rejected locator is still the right thing to start editing
 * from, as long as the offer says what is wrong with it.
 */
export function suggestLocators(
  context: LocatorContext,
  config: SmartConfig,
): LocatorSuggestion[] {
  const offers: LocatorSuggestion[] = [];
  const { recommended } = context;
  if (recommended)
    offers.push({
      locator: recommended.locator,
      group: "Recommended",
      note: `${recommended.confidence} confidence · ${recommended.evidence.join(", ") || recommended.kind}`,
    });
  const unique: LocatorSuggestion[] = [];
  const ambiguous: LocatorSuggestion[] = [];
  const positional: LocatorSuggestion[] = [];
  const elsewhere: LocatorSuggestion[] = [];
  for (const candidate of context.candidates) {
    if (candidate.matchCount === 0) continue;
    const note = candidate.evidence.join(", ") || candidate.kind;
    if (candidate.resolvesToTarget === false)
      elsewhere.push({
        locator: candidate.locator,
        group: "Matches a different element",
        note: "verify before using",
      });
    else if (candidate.kind === "positional" || candidate.kind === "xpath")
      // Unique today, but only until the page order or nesting changes.
      positional.push({
        locator: candidate.locator,
        group: "Position based, last resort",
        note: `${note} · breaks when the page changes`,
      });
    else if (candidate.matchCount === 1)
      unique.push({
        locator: candidate.locator,
        group: "Unique match",
        note: `${candidate.confidence} confidence · ${note}`,
      });
    else
      ambiguous.push({
        locator: candidate.locator,
        // Ambiguity is repaired by scoping, not by rewriting the locator.
        group: "Matches several elements",
        note: `matches ${String(candidate.matchCount)} elements${config.requireUniqueLocator ? " · scope it to one" : ""}`,
      });
  }
  const rejected = context.rejected.map(({ locator, reason }) => ({
    locator,
    group: "Rejected by analysis",
    note: reason,
  }));
  const seen = new Set<string>();
  return [
    ...offers,
    ...unique,
    ...ambiguous,
    ...positional,
    ...rejected,
    ...elsewhere,
  ]
    .filter(({ locator }) => {
      if (seen.has(locator)) return false;
      seen.add(locator);
      return true;
    })
    .slice(0, 15);
}
