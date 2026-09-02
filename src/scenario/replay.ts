import type { Locator, Page } from "playwright";
import { candidateToLocator } from "../locator/candidates.js";
import type {
  ReplayFailureDecision,
  ReplayReport,
  ReplayStepResult,
  ScenarioAction,
  ScenarioContext,
  ScenarioStep,
} from "../types.js";
import { actionCode } from "./record.js";

export const DEFAULT_REPLAY_TIMEOUT_MS = 30_000;

export interface ReplayScenarioOptions {
  startAt?: number | undefined;
  testCaseId?: string | undefined;
  timeoutMs?: number | undefined;
  resetBeforeRun?: boolean | undefined;
  resetBeforeTestCase?: boolean | undefined;
  onStep?: (result: ReplayStepResult, step: ScenarioStep) => void;
  onFailure?: (
    result: ReplayStepResult,
    step: ScenarioStep,
  ) => Promise<ReplayFailureDecision>;
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function poll(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(
    lastError instanceof Error
      ? lastError.message
      : `Expectation was not satisfied within ${String(timeoutMs)}ms`,
  );
}

async function elementText(locator: Locator): Promise<string> {
  return (await locator.textContent())?.trim() ?? "";
}

async function accessibleReference(
  locator: Locator,
  attribute: "aria-describedby" | "aria-errormessage",
): Promise<string> {
  return locator.evaluate((element, name) => {
    const ids = (element.getAttribute(name) ?? "").split(/\s+/).filter(Boolean);
    return ids
      .map(
        (id) =>
          element.ownerDocument.getElementById(id)?.textContent?.trim() ?? "",
      )
      .filter(Boolean)
      .join(" ");
  }, attribute);
}

async function assertionMatches(
  locator: Locator,
  action: ScenarioAction,
): Promise<boolean> {
  const assertion = action.assertion;
  if (!assertion) throw new Error("Assertion details are missing");
  const expected = assertion.expected;
  let matched: boolean;
  switch (assertion.matcher) {
    case "toBeAttached":
      matched = (await locator.count()) > 0;
      break;
    case "toBeVisible":
      matched = await locator.isVisible();
      break;
    case "toBeHidden":
      matched = await locator.isHidden();
      break;
    case "toBeEnabled":
      matched = await locator.isEnabled();
      break;
    case "toBeDisabled":
      matched = await locator.isDisabled();
      break;
    case "toBeEditable":
      matched = await locator.isEditable();
      break;
    case "toBeEmpty":
      matched = await locator.evaluate((element) => {
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement
        )
          return element.value === "";
        return (element.textContent ?? "").trim() === "";
      });
      break;
    case "toBeFocused":
      matched = await locator.evaluate(
        (element) => element.ownerDocument.activeElement === element,
      );
      break;
    case "toBeChecked":
      matched = await locator.isChecked();
      break;
    case "toBeInViewport":
      matched = await locator.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return (
          box.width > 0 &&
          box.height > 0 &&
          box.bottom > 0 &&
          box.right > 0 &&
          box.top < window.innerHeight &&
          box.left < window.innerWidth
        );
      });
      break;
    case "toHaveAccessibleDescription":
      matched =
        (await accessibleReference(locator, "aria-describedby")) === expected;
      break;
    case "toHaveAccessibleErrorMessage":
      matched =
        (await accessibleReference(locator, "aria-errormessage")) === expected;
      break;
    case "toHaveAccessibleName":
      matched =
        (await locator.evaluate((element) => {
          const labelledBy = element.getAttribute("aria-labelledby");
          if (labelledBy)
            return labelledBy
              .split(/\s+/)
              .map(
                (id) =>
                  element.ownerDocument
                    .getElementById(id)
                    ?.textContent?.trim() ?? "",
              )
              .filter(Boolean)
              .join(" ");
          return (
            element.getAttribute("aria-label") ??
            element.textContent?.trim() ??
            ""
          );
        })) === expected;
      break;
    case "toHaveText":
      matched = Array.isArray(expected)
        ? JSON.stringify(
            (await locator.allTextContents()).map((value) => value.trim()),
          ) === JSON.stringify(expected)
        : (await elementText(locator)) === String(expected ?? "");
      break;
    case "toContainText":
      matched = (await elementText(locator)).includes(String(expected ?? ""));
      break;
    case "toHaveValue":
      matched = (await locator.inputValue()) === String(expected ?? "");
      break;
    case "toHaveValues":
      matched =
        JSON.stringify(
          await locator.evaluate((element) =>
            element instanceof HTMLSelectElement
              ? [...element.selectedOptions].map(({ value }) => value)
              : [],
          ),
        ) === JSON.stringify(expected ?? []);
      break;
    case "toHaveAttribute":
      matched =
        (await locator.getAttribute(assertion.attribute ?? "")) ===
        String(expected ?? "");
      break;
    case "toHaveClass":
      matched =
        (await locator.getAttribute("class"))?.trim() ===
        String(expected ?? "").trim();
      break;
    case "toHaveCSS":
      matched =
        (await locator.evaluate(
          (element, property) =>
            getComputedStyle(element).getPropertyValue(property),
          assertion.attribute ?? "",
        )) === String(expected ?? "");
      break;
    case "toHaveId":
      matched = (await locator.getAttribute("id")) === String(expected ?? "");
      break;
    case "toHaveJSProperty":
      matched =
        (await locator.evaluate(
          (element, property) =>
            (element as unknown as Record<string, unknown>)[property],
          assertion.attribute ?? "",
        )) === expected;
      break;
    case "toHaveRole":
      matched = (await locator.getAttribute("role")) === String(expected ?? "");
      break;
    case "toHaveCount":
      matched = (await locator.count()) === Number(expected);
      break;
    case "toHaveScreenshot":
      throw new Error(
        "toHaveScreenshot requires a repository snapshot baseline and cannot be replayed from recording data alone",
      );
  }
  return assertion.negated ? !matched : matched;
}

async function executeStep(
  page: Page,
  step: ScenarioStep,
  timeoutMs: number,
  runtimeValue?: string,
): Promise<void> {
  const action =
    runtimeValue === undefined
      ? step.action
      : { ...step.action, value: runtimeValue };
  if (action.type === "navigate") {
    await page.goto(action.value ?? step.pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    return;
  }
  // Recording stores the originating frame URL in pageUrl. Resolve the same
  // frame during replay, while falling back to the main page when a frame was
  // replaced or its URL is not stable.
  const scope =
    page.frames().find((frame) => frame.url() === step.pageUrl) ?? page;
  const locator = candidateToLocator(scope, step.locator);
  switch (action.type) {
    case "click":
      await locator.click({
        ...(action.force === undefined ? {} : { force: action.force }),
        timeout: timeoutMs,
      });
      break;
    case "doubleClick":
      await locator.dblclick({ timeout: timeoutMs });
      break;
    case "hover":
      await locator.hover({ timeout: timeoutMs });
      break;
    case "fill":
      if (action.value === "[REDACTED]")
        throw new Error(
          "Protected input was redacted; provide test data in the generated repository test",
        );
      await locator.fill(action.value ?? "", { timeout: timeoutMs });
      break;
    case "selectOption":
      await locator.selectOption(action.value ?? "", { timeout: timeoutMs });
      break;
    case "setInputFiles":
      if (runtimeValue === undefined)
        throw new Error(
          "Recorded file names are not safe replay paths; provide a file path in Custom action data",
        );
      await locator.setInputFiles(
        runtimeValue
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        { timeout: timeoutMs },
      );
      break;
    case "check":
      await locator.check({ timeout: timeoutMs });
      break;
    case "uncheck":
      await locator.uncheck({ timeout: timeoutMs });
      break;
    case "press":
      await locator.press(action.value ?? "Enter", { timeout: timeoutMs });
      break;
    case "assert":
      await poll(() => assertionMatches(locator, action), timeoutMs);
      break;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function replayScenario(
  page: Page,
  scenario: ScenarioContext,
  options: ReplayScenarioOptions = {},
): Promise<{ scenario: ScenarioContext; report: ReplayReport }> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REPLAY_TIMEOUT_MS;
  const startedAt = new Date().toISOString();
  const results: ReplayStepResult[] = [];
  const repaired = new Set<number>();
  const skipped = new Set<number>();
  let aborted = false;

  const allTests =
    scenario.testCases.length > 0
      ? scenario.testCases
      : [
          {
            id: "test-1",
            name: "Test 1",
            stepIndexes: scenario.steps.map(({ index }) => index),
          },
        ];
  const orderedTests = options.testCaseId
    ? allTests.filter(({ id }) => id === options.testCaseId)
    : allTests;
  if (options.testCaseId && orderedTests.length === 0)
    throw new Error(`Testcase not found: ${options.testCaseId}`);
  if (
    options.resetBeforeRun &&
    scenario.startUrl &&
    scenario.startUrl !== "about:blank"
  )
    await page.goto(scenario.startUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
  for (const [testOffset, testCase] of orderedTests.entries()) {
    if (
      (options.resetBeforeTestCase ?? true) &&
      testOffset > 0 &&
      scenario.startUrl &&
      scenario.startUrl !== "about:blank"
    )
      await page.goto(scenario.startUrl, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });

    for (const stepIndex of testCase.stepIndexes) {
      if (stepIndex < (options.startAt ?? 1)) continue;
      const step = scenario.steps.find(({ index }) => index === stepIndex);
      if (!step) continue;
      const result: ReplayStepResult = {
        stepIndex: step.index,
        testCaseId: step.testCaseId,
        status: "running",
        startedAt: new Date().toISOString(),
        attempts: 0,
        locator: step.locator,
      };
      results.push(result);
      options.onStep?.(result, step);

      let runtimeValue: string | undefined;
      for (;;) {
        result.attempts += 1;
        try {
          await executeStep(page, step, timeoutMs, runtimeValue);
          result.status = "passed";
          delete result.error;
          break;
        } catch (error) {
          result.status = "failed";
          result.error = message(error);
          options.onStep?.(result, step);
          if (!options.onFailure) break;
          const decision = await options.onFailure(result, step);
          if (decision.action === "abort") {
            aborted = true;
            break;
          }
          if (decision.action === "skip") {
            result.status = "skipped";
            skipped.add(step.index);
            break;
          }
          if (decision.locator) {
            const expression = decision.locator.trim().replace(/^page\./, "");
            const scope =
              page.frames().find((frame) => frame.url() === step.pageUrl) ??
              page;
            candidateToLocator(scope, expression);
            step.locator = expression;
            step.code = actionCode(step.action, expression);
            step.confidence = "medium";
            step.warning = "Locator repaired during replay.";
            if (!step.suggestions.includes(expression))
              step.suggestions.unshift(expression);
            result.locator = expression;
            repaired.add(step.index);
          }
          if (decision.value !== undefined) runtimeValue = decision.value;
          result.status = "running";
          options.onStep?.(result, step);
        }
      }
      const finished = Date.now();
      result.finishedAt = new Date(finished).toISOString();
      result.durationMs =
        finished - new Date(result.startedAt ?? startedAt).getTime();
      options.onStep?.(result, step);
      if (aborted || result.status === "failed") break;
    }
    if (aborted || results.at(-1)?.status === "failed") break;
  }

  scenario.generatedCode = scenario.testCases.flatMap((testCase) => [
    `// ${testCase.name}`,
    ...testCase.stepIndexes
      .map((index) => scenario.steps.find((step) => step.index === index)?.code)
      .filter((code): code is string => Boolean(code)),
  ]);
  const failed = results.some(({ status }) => status === "failed");
  const report: ReplayReport = {
    version: "1.0",
    scenarioName: scenario.name,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: aborted ? "aborted" : failed ? "failed" : "passed",
    startUrl: scenario.startUrl,
    results,
    repairedStepIndexes: [...repaired],
    skippedStepIndexes: [...skipped],
  };
  return { scenario, report };
}
