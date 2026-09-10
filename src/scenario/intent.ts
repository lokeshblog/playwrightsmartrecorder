import type {
  DisabledState,
  LocatorContext,
  ScenarioContext,
  ScenarioIntent,
  ScenarioStep,
} from "../types.js";
import { generatedTestIdPrefix } from "../locator/candidates.js";
import { defaultConfig, smartConfigSchema } from "../config/schema.js";

const config = smartConfigSchema.parse(defaultConfig);
const genericExpression =
  /^locator\(["'](?:div|span|p|svg|a)["']\)(?:\.nth\(\d+\))?$/;
const iconPrefix =
  /^(?:plus|edit|trash|duplicate|add[- ]to[- ]folder|chevron[- ]right|cross)(?=[A-Z])/i;

function cleanName(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/\s+/g, " ").trim().replace(iconPrefix, "");
  return cleaned || undefined;
}

function routeHints(url: string): ScenarioStep["productHints"] {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const moduleIndex = parts.indexOf("module");
    const ceIndex = parts.indexOf("ce");
    const navModule =
      moduleIndex >= 0
        ? parts[moduleIndex + 1]
        : ceIndex >= 0
          ? "ce"
          : undefined;
    const feature =
      moduleIndex >= 0
        ? parts[moduleIndex + 2]
        : ceIndex >= 0
          ? parts[ceIndex + 1]
          : undefined;
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
  // CDP reports the deepest painted node. For an icon inside a disabled
  // anchor that is usually <svg>, while the actionable identity and disabled
  // contract live on the nearest semantic ancestor.
  const semanticAncestor = context.ancestors.find(
    (ancestor) =>
      ancestor.disabledState !== undefined ||
      (ancestor.role !== undefined && ancestor.accessibleName !== undefined),
  );
  const target =
    (["svg", "path", "span", "p"].includes(context.target.tag) ||
      (!context.target.role &&
        !context.target.accessibleName &&
        !context.target.attributes["data-testid"] &&
        !context.target.attributes["data-test"] &&
        !context.target.attributes["data-cy"] &&
        !context.target.attributes["data-qa"])) &&
    semanticAncestor
      ? semanticAncestor
      : context.target;
  const rawTestId =
    target.attributes["data-testid"] ??
    target.attributes["data-test"] ??
    target.attributes["data-cy"] ??
    target.attributes["data-qa"];
  const generatedPrefix = rawTestId
    ? generatedTestIdPrefix(rawTestId, config)
    : undefined;
  const testId = generatedPrefix ? undefined : rawTestId;
  const role = target.role;
  const name = cleanName(
    target.attributes["aria-label"] ?? target.accessibleName ?? target.text,
  );
  const scope = context.ancestors.some((ancestor) =>
    /\bbp3-menu\b/.test(ancestor.attributes.class ?? ""),
  )
    ? "bp3-menu"
    : undefined;
  const safeExpression =
    expression !== "page" && !genericExpression.test(expression)
      ? expression
      : undefined;
  return {
    ...(testId ? { testId } : {}),
    ...(generatedPrefix ? { nameHint: generatedPrefix } : {}),
    ...(role ? { role } : {}),
    ...(name ? { name } : {}),
    ...(target.tag ? { tagName: target.tag.toUpperCase() } : {}),
    ...(scope ? { scope } : {}),
    // CSS/XPath is retained only as repair evidence.
    ...(!testId && !(role && name) && safeExpression
      ? { expression: safeExpression }
      : {}),
  };
}

function valueKind(step: ScenarioStep): ScenarioStep["valueKind"] {
  if (step.action.type !== "fill") return undefined;
  if (step.action.value === "[REDACTED]")
    return { kind: "secret", unique: false, createsResource: false };
  if (!step.action.value) return undefined;
  const identity = [
    step.locatorContext?.target.accessibleName,
    step.locatorContext?.target.attributes.name,
    step.locatorContext?.target.attributes.placeholder,
  ]
    .filter(Boolean)
    .join(" ");
  if (!/\bname\b/i.test(identity))
    return { kind: "literal", unique: false, createsResource: false };
  const creationEvidence = [
    step.locatorContext?.pageHeading,
    step.locatorContext?.containerHtml?.slice(0, 2_000),
  ]
    .filter(Boolean)
    .join(" ");
  return {
    kind: /\d{4,}|[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(step.action.value)
      ? "unique"
      : "literal",
    unique: /\d{4,}|[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(step.action.value),
    createsResource: /\b(new|create|add)\b/i.test(creationEvidence),
  };
}

function disabledState(step: ScenarioStep): DisabledState | undefined {
  if (step.locatorContext?.target.disabledState)
    return step.locatorContext.target.disabledState;
  return step.locatorContext?.ancestors.find(
    (ancestor) => ancestor.disabledState !== undefined,
  )?.disabledState;
}

function restrictedSignals(
  state: DisabledState,
): NonNullable<NonNullable<ScenarioStep["expect"]>["signals"]> {
  return [
    ...(state.nativeDisabled ? (["native-disabled"] as const) : []),
    ...(state.hasDisabledAttribute ? (["disabled-attribute"] as const) : []),
    ...(state.ariaDisabled === "true" ? (["aria-disabled"] as const) : []),
    ...(state.blueprintDisabledClass ? (["bp3-disabled"] as const) : []),
  ];
}

function tooltipGroup(
  value: unknown,
): NonNullable<ScenarioStep["expect"]>["group"] {
  if (typeof value !== "string") return undefined;
  const lines = value
    .split(/\n|(?<=\.)\s+(?=[A-Z])/)
    .map((line) => line.trim())
    .filter(Boolean);
  const notAuthorized = lines.find((line) => /not authori[sz]ed/i.test(line));
  const missingPermission = lines.find((line) =>
    /missing.*permission|required permission|permission.*missing/i.test(line),
  );
  const permissionInScope = lines.find((line) =>
    /permission.*(?:account|organi[sz]ation|project).*scope/i.test(line),
  );
  if (!notAuthorized && !missingPermission && !permissionInScope)
    return undefined;
  return {
    ...(notAuthorized ? { notAuthorized } : {}),
    ...(missingPermission ? { missingPermission } : {}),
    ...(permissionInScope ? { permissionInScope } : {}),
  };
}

function expectation(
  step: ScenarioStep,
  state: DisabledState | undefined,
): ScenarioStep["expect"] {
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
  const restricted =
    assertion.matcher === "toBeDisabled" && state !== undefined
      ? !state.nativeDisabled
      : false;
  const value =
    assertion.expected ??
    cleanName(
      step.locatorContext?.target.accessibleName ??
        step.locatorContext?.target.text,
    );
  const group = tooltipGroup(value);
  return {
    kind,
    matcher: restricted ? "toBeRestricted" : assertion.matcher,
    ...(value === undefined ? {} : { value }),
    ...(step.locatorHint?.name ? { name: step.locatorHint.name } : {}),
    ...(restricted && state ? { signals: restrictedSignals(state) } : {}),
    ...(group ? { group } : {}),
  };
}

function mechanicsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      /\/(?:auth|login)(?:\/|$)/i.test(parsed.pathname) ||
      /\/ng\/account\/[^/]+\/?(?:main-dashboard|all)?\/?$/i.test(
        parsed.pathname,
      ) ||
      (parsed.pathname === "/" && parsed.hash === "#/")
    );
  } catch {
    return false;
  }
}

function isGenericUnresolved(step: ScenarioStep): boolean {
  if (
    step.locatorHint?.testId ||
    (step.locatorHint?.role && step.locatorHint.name)
  )
    return false;
  return (
    genericExpression.test(step.locator) ||
    (["div", "span", "p", "svg"].includes(
      step.locatorContext?.target.tag ?? "",
    ) &&
      !step.locatorContext?.target.accessibleName &&
      !step.locatorContext?.target.role)
  );
}

function isContainerWideAssertion(step: ScenarioStep): boolean {
  if (step.action.type !== "assert") return false;
  const target = step.locatorContext?.target;
  if (!target) return false;
  return (
    ["div", "section", "main", "ul", "ol"].includes(target.tag) &&
    (target.childElementCount ?? 0) > 1 &&
    (target.text?.length ?? 0) > 120
  );
}

function deriveIntent(
  step: ScenarioStep,
  state: DisabledState | undefined,
): string {
  const name =
    step.locatorHint?.name ??
    cleanName(step.locatorContext?.target.accessibleName) ??
    "control";
  if (step.action.assertion && state)
    return `Verify ${name} is restricted for read-only user`;
  if (
    step.action.type === "click" &&
    (name === "Options" || step.locatorHint?.testId === "menuItem")
  )
    return "Open list overflow menu";
  return step.businessStep
    .replace(/plus(?=[A-Z])/g, "")
    .replace(/editEdit/g, "Edit")
    .replace(/trashDelete/g, "Delete")
    .replace(/chevron-right/g, "");
}

function intentConfidence(step: ScenarioStep): ScenarioStep["confidence"] {
  if (
    step.locatorHint?.testId ||
    (step.locatorHint?.role && step.locatorHint.name)
  )
    return "high";
  if (step.locatorHint?.name && step.productHints?.feature) return "medium";
  return step.confidence;
}

function compactContext(step: ScenarioStep): string | undefined {
  const facts = [
    step.locatorHint?.tagName
      ? `element ${step.locatorHint.tagName.toLowerCase()}`
      : undefined,
    step.locatorHint?.role ? `role ${step.locatorHint.role}` : undefined,
    step.locatorHint?.name ? `name "${step.locatorHint.name}"` : undefined,
    step.productHints?.pageHeading
      ? `on "${step.productHints.pageHeading}"`
      : undefined,
    step.locatorHint?.scope ? `inside ${step.locatorHint.scope}` : undefined,
    step.disabledState ? "restricted control" : undefined,
  ].filter((value): value is string => value !== undefined);
  return facts.length ? facts.join(", ") : undefined;
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
    const state = disabledState(step);
    step.productHints = {
      ...route,
      ...(pageHeading ? { pageHeading } : {}),
    };
    const hint = locatorHint(step.locatorContext, step.locator);
    if (hint) step.locatorHint = hint;
    if (state) step.disabledState = state;
    step.intent = deriveIntent(step, state);
    // Navigation rows are observed consequences, not user actions to paste.
    step.skipInTest =
      step.action.type === "navigate" ||
      mechanicsUrl(step.pageUrl) ||
      (step.action.type === "fill" &&
        (step.action.value === "[REDACTED]" ||
          /\b(email|password|sign\s*in)\b/i.test(
            [
              step.locatorHint?.name,
              step.locatorContext?.target.attributes.type,
            ].join(" "),
          ))) ||
      isGenericUnresolved(step) ||
      isContainerWideAssertion(step) ||
      /mode-selector-panel|nine.?dot|app launcher/i.test(
        [step.locator, step.targetSummary].join(" "),
      );
    const lifecycle = valueKind(step);
    if (lifecycle) step.valueKind = lifecycle;
    else delete step.valueKind;
    const expect = expectation(step, state);
    if (expect) step.expect = expect;
    else delete step.expect;
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

  // A navigation immediately following the click that caused it is evidence,
  // not a second page-object operation. Repeated identical tooltip assertions
  // likewise represent one outcome.
  const assertionKeys = new Set<string>();
  const recentHovers = new Map<string, number>();
  for (const [index, step] of scenario.steps.entries()) {
    const previous = scenario.steps[index - 1];
    if (step.action.type === "navigate" && previous?.urlAfter === step.pageUrl)
      step.skipInTest = true;
    if (step.action.type === "hover") {
      const hoverKey = JSON.stringify([
        step.testCaseId,
        step.locatorHint?.testId,
        step.locatorHint?.role,
        step.locatorHint?.name,
      ]);
      const previousHover = recentHovers.get(hoverKey);
      if (previousHover !== undefined && index - previousHover <= 4)
        step.skipInTest = true;
      else recentHovers.set(hoverKey, index);
    }
    if (!step.expect) continue;
    const key = JSON.stringify([
      step.testCaseId,
      step.locatorHint?.name,
      step.expect.matcher,
      step.expect.value,
    ]);
    if (assertionKeys.has(key)) step.skipInTest = true;
    else assertionKeys.add(key);
  }
  return scenario;
}

/**
 * Lists every handoff invariant the intent breaks. Collecting instead of
 * throwing keeps a long recording usable: the artifact is still written and the
 * caller decides whether the problems are fatal.
 */
export function scenarioIntentProblems(intent: ScenarioIntent): string[] {
  const problems: string[] = [];
  for (const testCase of intent.testCases) {
    for (const step of testCase.steps) {
      if (step.skipInTest) continue;
      if (!step.startUrl && !step.urlAfter)
        problems.push(`step ${step.index}: missing URL context`);
      if (
        step.locatorHint?.expression &&
        genericExpression.test(step.locatorHint.expression)
      )
        problems.push(`step ${step.index}: generic locator expression`);
      if (
        step.locatorHint?.name &&
        /(?:plus|edit|trash|chevron-right)(?=[A-Z])/i.test(
          step.locatorHint.name,
        )
      )
        problems.push(`step ${step.index}: icon-contaminated name`);
      if (
        step.locatorHint?.testId &&
        generatedTestIdPrefix(step.locatorHint.testId, config)
      )
        problems.push(`step ${step.index}: generated test id`);
      if (
        step.expect?.matcher === "toBeDisabled" &&
        step.disabledState &&
        !step.disabledState.nativeDisabled
      )
        problems.push(`step ${step.index}: non-native toBeDisabled`);
      if (
        /\/(?:module\/ce|ce)\//.test(step.startUrl) &&
        step.productHints?.navModule !== "ce"
      )
        problems.push(`step ${step.index}: missing CE product hint`);
      if (step.confidence === "unresolved")
        problems.push(`step ${step.index}: unresolved workflow step`);
    }
  }
  return problems;
}

/** Enforces the compact handoff invariants. Used where a bad export must fail. */
export function validateScenarioIntent(intent: ScenarioIntent): void {
  const problems = scenarioIntentProblems(intent);
  if (problems.length)
    throw new Error(`Invalid scenario intent:\n- ${problems.join("\n- ")}`);
}

/** Small, intent-first handoff for the conversion skill. */
export function scenarioToIntent(scenario: ScenarioContext): ScenarioIntent {
  const enriched = enrichScenario(scenario);
  const navModules = new Set<string>();
  const pageHeadings = new Set<string>();
  const features = new Set<string>();
  for (const step of enriched.steps) {
    if (step.skipInTest) continue;
    if (step.productHints?.navModule)
      navModules.add(step.productHints.navModule);
    if (step.productHints?.pageHeading)
      pageHeadings.add(step.productHints.pageHeading);
    if (step.productHints?.feature) features.add(step.productHints.feature);
  }
  const primaryModule = [...navModules][0];
  const primaryFeature = [...features][0];
  const intentName = [primaryModule?.toUpperCase(), primaryFeature]
    .filter(Boolean)
    .join(" ")
    .replace(/-/g, " ");
  const intent: ScenarioIntent = {
    version: "1.4",
    name: intentName || enriched.name,
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
      ...(testCase.conversionInstructions
        ? { conversionInstructions: testCase.conversionInstructions }
        : {}),
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
          ...(step.disabledState ? { disabledState: step.disabledState } : {}),
          ...(step.productHints ? { productHints: step.productHints } : {}),
          skipInTest: step.skipInTest ?? false,
          ...(step.valueKind ? { valueKind: step.valueKind } : {}),
          ...(step.expect ? { expect: step.expect } : {}),
          confidence: intentConfidence(step),
          ...(compactContext(step) ? { context: compactContext(step) } : {}),
        })),
    })),
    unresolvedStepIndexes: enriched.steps
      .filter(
        (step) =>
          !step.skipInTest &&
          (intentConfidence(step) === "low" ||
            intentConfidence(step) === "unresolved"),
      )
      .map(({ index }) => index),
  };
  return intent;
}
