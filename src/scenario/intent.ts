import type {
  LocatorContext,
  ScenarioContext,
  ScenarioIntent,
  ScenarioStep,
} from "../types.js";

function routeHints(url: string): ScenarioStep["productHints"] {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const moduleIndex = parts.indexOf("module");
    const navModule = moduleIndex >= 0 ? parts[moduleIndex + 1] : undefined;
    const feature = moduleIndex >= 0 ? parts[moduleIndex + 2] : undefined;
    return {
      ...(navModule ? { navModule } : {}),
      ...(feature && feature !== "overview" ? { feature } : {}),
    };
  } catch {
    return {};
  }
}

function locatorHint(
  context: LocatorContext | null,
  expression: string,
): ScenarioStep["locatorHint"] {
  if (!context) return expression === "page" ? undefined : { expression };
  const testId =
    context.target.attributes["data-testid"] ??
    context.target.attributes["data-test"] ??
    context.target.attributes["data-qa"];
  const role = context.target.role;
  const name = context.target.accessibleName;
  return {
    ...(testId ? { testId } : {}),
    ...(role ? { role } : {}),
    ...(name ? { name } : {}),
    // CSS/XPath is retained only as repair evidence.
    ...(!testId && !(role && name) ? { expression } : {}),
  };
}

function valueKind(step: ScenarioStep): ScenarioStep["valueKind"] {
  if (!step.action.value || step.action.value === "[REDACTED]")
    return undefined;
  const identity = [
    step.locatorContext?.target.accessibleName,
    step.locatorContext?.target.attributes.name,
    step.locatorContext?.target.attributes.placeholder,
  ]
    .filter(Boolean)
    .join(" ");
  if (!/\bname\b/i.test(identity)) return undefined;
  const creationEvidence = [
    step.locatorContext?.pageHeading,
    step.locatorContext?.containerHtml?.slice(0, 2_000),
  ]
    .filter(Boolean)
    .join(" ");
  return {
    unique: /\d{4,}|[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(step.action.value),
    createsResource: /\b(new|create|add)\b/i.test(creationEvidence),
  };
}

function expectation(step: ScenarioStep): ScenarioStep["expect"] {
  const assertion = step.action.assertion;
  if (!assertion) return undefined;
  const role = step.locatorContext?.target.role;
  const context = step.locatorContext?.containerHtml?.slice(0, 1_000) ?? "";
  const kind =
    role === "heading"
      ? "heading"
      : /\b(role=["'](?:alert|status)["']|toast)\b/i.test(context)
        ? "toast"
        : /\b(tr|row)\b/i.test(context)
          ? "row-visible"
          : "assertion";
  return {
    kind,
    matcher: assertion.matcher,
    ...(assertion.expected === undefined ? {} : { value: assertion.expected }),
  };
}

/**
 * Adds conversion-oriented fields after recording, when each step's resulting
 * URL and neighbouring steps are known.
 */
export function enrichScenario(scenario: ScenarioContext): ScenarioContext {
  for (const [index, step] of scenario.steps.entries()) {
    const next = scenario.steps[index + 1];
    const urlAfter = next?.pageUrl ?? scenario.endUrl;
    const route = routeHints(urlAfter || step.pageUrl);
    const pageHeading = step.locatorContext?.pageHeading;
    step.urlAfter = urlAfter;
    step.intent = step.businessStep;
    step.productHints = {
      ...route,
      ...(pageHeading ? { pageHeading } : {}),
    };
    const hint = locatorHint(step.locatorContext, step.locator);
    if (hint) step.locatorHint = hint;
    // Navigation rows are observed consequences, not user actions to paste.
    step.skipInTest =
      step.action.type === "navigate" || /\/auth(?:\/|#|$)/i.test(step.pageUrl);
    const lifecycle = valueKind(step);
    if (lifecycle) step.valueKind = lifecycle;
    const expect = expectation(step);
    if (expect) step.expect = expect;
  }

  // The unnamed icon immediately before a module link is the app launcher.
  for (const [index, step] of scenario.steps.entries()) {
    const next = scenario.steps[index + 1];
    if (
      step.action.type === "click" &&
      step.locatorContext?.target.tag === "svg" &&
      !step.locatorContext.target.accessibleName &&
      next?.locatorContext?.target.attributes.href?.includes("/module/")
    )
      step.skipInTest = true;
  }
  return scenario;
}

/** Small, intent-first handoff for the conversion skill. */
export function scenarioToIntent(scenario: ScenarioContext): ScenarioIntent {
  const enriched = enrichScenario(scenario);
  const navModules = new Set<string>();
  const pageHeadings = new Set<string>();
  const features = new Set<string>();
  for (const step of enriched.steps) {
    if (step.productHints?.navModule)
      navModules.add(step.productHints.navModule);
    if (step.productHints?.pageHeading)
      pageHeadings.add(step.productHints.pageHeading);
    if (step.productHints?.feature) features.add(step.productHints.feature);
  }
  return {
    version: "1.0",
    name: enriched.name,
    startUrl: enriched.startUrl,
    endUrl: enriched.endUrl,
    productHints: {
      navModules: [...navModules],
      pageHeadings: [...pageHeadings],
      features: [...features],
    },
    testCases: enriched.testCases.map((testCase) => ({
      id: testCase.id,
      name: testCase.name,
      ...(testCase.jiraId ? { jiraId: testCase.jiraId } : {}),
      ...(testCase.zephyrId ? { zephyrId: testCase.zephyrId } : {}),
      steps: testCase.stepIndexes
        .map((stepIndex) =>
          enriched.steps.find(({ index }) => index === stepIndex),
        )
        .filter((step): step is ScenarioStep => step !== undefined)
        .map((step) => ({
          index: step.index,
          startUrl: step.pageUrl,
          urlAfter: step.urlAfter ?? step.pageUrl,
          intent: step.intent ?? step.businessStep,
          action: step.action.type,
          ...(step.action.value ? { value: step.action.value } : {}),
          ...(step.locatorHint ? { locatorHint: step.locatorHint } : {}),
          ...(step.productHints ? { productHints: step.productHints } : {}),
          skipInTest: step.skipInTest ?? false,
          ...(step.valueKind ? { valueKind: step.valueKind } : {}),
          ...(step.expect ? { expect: step.expect } : {}),
          confidence: step.confidence,
          ...(step.targetSummary ? { context: step.targetSummary } : {}),
        })),
    })),
    unresolvedStepIndexes: enriched.steps
      .filter(
        ({ confidence }) => confidence === "low" || confidence === "unresolved",
      )
      .map(({ index }) => index),
  };
}
