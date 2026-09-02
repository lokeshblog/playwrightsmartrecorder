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
}

export interface RejectedCandidate {
  locator: string;
  reason: string;
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
  pageUrl: string;
  action: ScenarioAction;
  locatorContext: LocatorContext | null;
  locator: string;
  code: string;
  confidence: Confidence | "unresolved";
  warning?: string | undefined;
  suggestions: string[];
  testCaseId: string;
  businessStep: string;
}

export interface ScenarioTestCase {
  id: string;
  name: string;
  stepIndexes: number[];
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
