import type {
  CandidateKind,
  Confidence,
  LocatorCandidate,
  SmartConfig,
} from "../types.js";

const baseline: Record<CandidateKind, number> = {
  testId: 100,
  applicationAttribute: 95,
  role: 90,
  label: 88,
  id: 85,
  scoped: 84,
  placeholder: 75,
  text: 65,
  css: 55,
  xpath: 35,
  positional: 15,
};

export function scoreCandidate(
  candidate: Pick<LocatorCandidate, "locator" | "kind" | "evidence">,
  matchCount: number,
  config: SmartConfig,
): LocatorCandidate {
  let score = baseline[candidate.kind];
  const evidence = [...candidate.evidence];
  const penalties: string[] = [];

  if (matchCount === 1) {
    score += 10;
    evidence.push("exactly one matching element");
  } else if (matchCount === 0) {
    score -= 60;
    penalties.push("matches no elements");
  } else {
    score -= Math.min(45, 15 + matchCount * 3);
    penalties.push(`matches ${matchCount} elements`);
  }
  if (candidate.kind === "scoped") {
    score += 6;
    evidence.push("stable parent scope");
  }
  if (/nth\(|nth-child|nth-of-type/.test(candidate.locator)) {
    score -= 50;
    penalties.push("positional dependency");
  }
  if (/^locator\("(\.|[a-z]+\.)/.test(candidate.locator)) {
    score -= 12;
    penalties.push("class-dependent CSS");
  }

  score = Math.max(0, Math.min(110, score));
  const eligible = matchCount === 1 || !config.requireUniqueLocator;
  const confidence: Confidence =
    eligible && score >= 90
      ? "high"
      : eligible && score >= config.minimumLocatorScore
        ? "medium"
        : "low";
  return { ...candidate, score, matchCount, confidence, evidence, penalties };
}
