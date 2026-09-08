export type Confidence = "high" | "medium" | "low";

export interface SmartConfig {
  maxAncestorDepth: number;
  semanticBoundaries: string[];
  preferredAttributes: string[];
  applicationAttributes: string[];
  avoidAttributes: string[];
  generatedValuePatterns: string[];
  minimumLocatorScore: number;
  requireUniqueLocator: boolean;
  nearbyElementLimit: number;
  maxContainerHtmlLength: number;
}

export interface ElementContext {
  tag: string;
  childElementCount?: number | undefined;
  text?: string | undefined;
  accessibleName?: string | undefined;
  role?: string | undefined;
  html?: string | undefined;
  attributes: Record<string, string>;
  disabledState?: DisabledState | undefined;
}

/** Cross-library evidence that a control is unavailable to the current user. */
export interface DisabledState {
  hasDisabledAttribute: boolean;
  ariaDisabled: "true" | null;
  nativeDisabled: boolean;
  blueprintDisabledClass: boolean;
  tabIndex: number | null;
  tagName: string;
  role: string | null;
}

export interface AncestorContext extends ElementContext {
  depth: number;
  boundary: boolean;
}

export interface SiblingContext extends ElementContext {
  relation: "previous" | "next" | "relevant";
}

export interface NearbyContext extends ElementContext {
  relationship: "label" | "heading" | "control" | "semantic";
}

export type CandidateKind =
  | "testId"
  | "applicationAttribute"
  | "role"
  | "label"
  | "id"
  | "placeholder"
  | "text"
  | "css"
  | "xpath"
  | "positional"
  | "scoped";

export interface LocatorCandidate {
  locator: string;
  kind: CandidateKind;
  score: number;
  matchCount: number;
  confidence: Confidence;
  evidence: string[];
  penalties: string[];
  generated?: boolean | undefined;
  /**
   * Whether the locator resolves to the element that was interacted with.
   * Analysis always sets it; it is optional so older contexts stay readable.
   */
  resolvesToTarget?: boolean | undefined;
}

export interface RejectedCandidate {
  locator: string;
  reason: string;
}

/** A locator offered for a step, with what is known for and against it. */
export interface LocatorSuggestion {
  locator: string;
  /** Heading it is offered under, for example "Recommended". */
  group: string;
  /** Short reason it is trustworthy or not, for example "matches 3 elements". */
  note: string;
}

export interface CodegenLocator {
  type: string;
  value: string;
  name?: string | undefined;
  expression: string;
}

export interface LocatorContext {
  version: "1.0";
  capturedAt: string;
  url: string;
  pageHeading?: string | undefined;
  codegenLocator: CodegenLocator;
  target: ElementContext;
  ancestors: AncestorContext[];
  siblings: SiblingContext[];
  nearby: NearbyContext[];
  matchingElements: { codegenLocatorCount: number };
  candidates: LocatorCandidate[];
  recommended: LocatorCandidate | null;
  alternatives: LocatorCandidate[];
  rejected: RejectedCandidate[];
  containerHtml?: string | undefined;
  containerHtmlTruncated?: boolean | undefined;
}

export interface RawDomContext {
  url: string;
  /** Primary visible page heading at capture time. */
  pageHeading?: string | undefined;
  target: ElementContext;
  ancestors: AncestorContext[];
  siblings: SiblingContext[];
  nearby: NearbyContext[];
  containerHtml?: string | undefined;
  containerHtmlTruncated?: boolean | undefined;
}

export type ScenarioActionType =
  | "click"
  | "doubleClick"
  | "hover"
  | "fill"
  | "selectOption"
  | "setInputFiles"
  | "check"
  | "uncheck"
  | "press"
  | "navigate"
  | "assert";

export type AssertionMatcher =
  | "toBeAttached"
  | "toBeVisible"
  | "toBeHidden"
  | "toBeEnabled"
  | "toBeDisabled"
  | "toBeEditable"
  | "toBeEmpty"
  | "toBeFocused"
  | "toBeChecked"
  | "toBeInViewport"
  | "toHaveAccessibleDescription"
  | "toHaveAccessibleErrorMessage"
  | "toHaveAccessibleName"
  | "toHaveText"
  | "toContainText"
  | "toHaveValue"
  | "toHaveValues"
  | "toHaveAttribute"
  | "toHaveClass"
  | "toHaveCSS"
  | "toHaveId"
  | "toHaveJSProperty"
  | "toHaveRole"
  | "toHaveScreenshot"
  | "toHaveCount";

export interface ScenarioAction {
  type: ScenarioActionType;
  value?: string | undefined;
  /** How a selectOption value is matched. Defaults to "value" when absent. */
  selectBy?: "value" | "label" | undefined;
  force?: boolean | undefined;
  assertion?: {
    matcher: AssertionMatcher;
    expected?: string | string[] | number | boolean | undefined;
    attribute?: string | undefined;
    negated?: boolean | undefined;
  };
}

export interface ScenarioStep {
  index: number;
  timestamp: string;
  /** URL before the action. Kept as pageUrl for backward compatibility. */
  pageUrl: string;
  /** URL observed after this step and its resulting navigation. */
  urlAfter?: string | undefined;
  action: ScenarioAction;
  locatorContext: LocatorContext | null;
  locator: string;
  code: string;
  confidence: Confidence | "unresolved";
  warning?: string | undefined;
  suggestions: string[];
  /**
   * What the step touched, in plain language: tag, role, text, container and
   * neighbours. Carries the intent of a step whose locator needs repairing.
   */
  targetSummary?: string | undefined;
  /** Business intent suitable for test.step or a page method name. */
  intent?: string | undefined;
  /** Product ownership clues derived without assuming a repository layout. */
  productHints?: {
    navModule?: string | undefined;
    pageHeading?: string | undefined;
    feature?: string | undefined;
  };
  /** Structured locator evidence; expression is a last hint, not test code. */
  locatorHint?: {
    testId?: string | undefined;
    /** Stable part of an otherwise generated identifier; context, not selector. */
    nameHint?: string | undefined;
    role?: string | undefined;
    name?: string | undefined;
    tagName?: string | undefined;
    scope?: string | undefined;
    expression?: string | undefined;
  };
  /** Disabled/restricted evidence captured from the exact interacted element. */
  disabledState?: DisabledState | undefined;
  /** Setup/navigation mechanics the converter should normally omit. */
  skipInTest?: boolean | undefined;
  /** Data lifecycle hints for unique names and cleanup. */
  valueKind?: {
    kind?: "secret" | "unique" | "literal" | undefined;
    unique: boolean;
    createsResource: boolean;
  };
  /** Explicit outcome captured through assertion mode. */
  expect?: {
    kind: "heading" | "toast" | "row-visible" | "assertion";
    matcher: AssertionMatcher | "toBeRestricted";
    value?: string | string[] | number | boolean | undefined;
    name?: string | undefined;
    signals?: Array<
      | "disabled-attribute"
      | "aria-disabled"
      | "native-disabled"
      | "bp3-disabled"
    >;
    /** Structured lines from one RBAC tooltip, kept as one assertion group. */
    group?: {
      notAuthorized?: string | undefined;
      missingPermission?: string | undefined;
      permissionInScope?: string | undefined;
    };
  };
  testCaseId: string;
  businessStep: string;
}

export interface ScenarioTestCase {
  id: string;
  name: string;
  /** Optional work-item IDs entered by the recorder user. */
  jiraId?: string | undefined;
  zephyrId?: string | undefined;
  stepIndexes: number[];
}

/** Compact handoff consumed before the detailed scenario context. */
export interface ScenarioIntent {
  version: "1.0";
  name: string;
  startUrl: string;
  endUrl: string;
  productHints: {
    navModules: string[];
    pageHeadings: string[];
    features: string[];
  };
  testCases: Array<{
    id: string;
    name: string;
    jiraId?: string | undefined;
    zephyrId?: string | undefined;
    steps: Array<{
      index: number;
      startUrl: string;
      urlAfter: string;
      intent: string;
      action: ScenarioActionType;
      value?: string | undefined;
      locatorHint?: ScenarioStep["locatorHint"];
      disabledState?: ScenarioStep["disabledState"];
      productHints?: ScenarioStep["productHints"];
      skipInTest: boolean;
      valueKind?: ScenarioStep["valueKind"];
      expect?: ScenarioStep["expect"];
      confidence: ScenarioStep["confidence"];
      context?: string | undefined;
    }>;
  }>;
  unresolvedStepIndexes: number[];
}

export interface ScenarioContext {
  version: "1.0";
  name: string;
  capturedAt: string;
  startUrl: string;
  endUrl: string;
  steps: ScenarioStep[];
  testCases: ScenarioTestCase[];
  generatedCode: string[];
  warnings: string[];
}

export type ReplayStepStatus =
  "pending" | "running" | "passed" | "failed" | "skipped";

export interface ReplayStepResult {
  stepIndex: number;
  testCaseId: string;
  status: ReplayStepStatus;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  durationMs?: number | undefined;
  attempts: number;
  locator: string;
  error?: string | undefined;
}

export interface ReplayReport {
  version: "1.0";
  scenarioName: string;
  startedAt: string;
  finishedAt: string;
  status: "passed" | "failed" | "aborted";
  startUrl: string;
  results: ReplayStepResult[];
  repairedStepIndexes: number[];
  skippedStepIndexes: number[];
}

export type ReplayFailureDecision =
  | {
      action: "retry";
      locator?: string | undefined;
      /** Runtime-only action data. It is never written to the scenario/report. */
      value?: string | undefined;
    }
  | { action: "skip" }
  | { action: "abort" };

export interface RepairResult {
  original: string;
  status: "working" | "ambiguous" | "failed";
  originalMatchCount: number;
  replacement: LocatorCandidate | null;
  alternatives: LocatorCandidate[];
  applied?: { file: string; replacements: number };
}
