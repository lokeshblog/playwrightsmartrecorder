import type { Frame, Page } from "playwright";
import { createElementPicker } from "../capture/cdp-picker.js";
import { extractDomContext } from "../context/extract.js";
import { analyzeContext } from "../locator/analyze.js";
import { candidateToLocator } from "../locator/candidates.js";
import { resolvesToActionTarget } from "../locator/identity.js";
import { suggestLocators } from "../locator/suggest.js";
import { createRecorderControl, type RecorderControl } from "./control.js";
import { describeTarget, summarizeTarget } from "./describe.js";
import { enrichScenario } from "./intent.js";
import { prettyFormatHtml } from "../ui/format-html.js";
import type {
  AssertionMatcher,
  LocatorSuggestion,
  ScenarioAction,
  ScenarioContext,
  ScenarioStep,
  SmartConfig,
} from "../types.js";

const actionMarker = "data-pw-codegen-smart-action";

interface RecordedEvent {
  id: string;
  action: ScenarioAction;
}

interface RecordResponse {
  stepIndex: number;
  unresolved: boolean;
  suggestions: string[];
  /** Every locator on offer, annotated, for the manual-locator prompt. */
  offers?: LocatorSuggestion[];
  /** Human-readable target, shown when asking the user for a locator. */
  description?: string;
  /** What the element is, so the prompt explains the step it belongs to. */
  targetFacts?: string[];
  /** Sanitized HTML of the nearest semantic container. */
  containerHtml?: string;
  containerHtmlTruncated?: boolean;
}

interface RecordingTestCase {
  id: string;
  name: string;
  jiraId?: string;
  zephyrId?: string;
  steps: ScenarioStep[];
}

interface StepSummary {
  index: number;
  testCase: string;
  businessStep: string;
  confidence: string;
}

interface PanelUpdate {
  message: string;
  steps: StepSummary[];
  activeTestCase: string;
  jiraId?: string;
  zephyrId?: string;
}

/** Panel state owned by Node so it survives page navigations and applies in every frame. */
interface RecorderSettings {
  mode: string;
  negate: boolean;
  ask: boolean;
  active: boolean;
}

export interface RecordScenarioOptions {
  name?: string;
  onStep?: (step: ScenarioStep) => void;
  onStepRemoved?: (step: ScenarioStep) => void;
  onTestCase?: (name: string) => void;
}

function expectationCode(action: ScenarioAction, target: string): string {
  const assertion = action.assertion;
  if (!assertion) return `// TODO: assertion details missing for ${target}`;
  const expected =
    assertion.expected === undefined
      ? ""
      : `, ${JSON.stringify(assertion.expected)}`;
  const receiver = `expect(${target})${assertion.negated ? ".not" : ""}`;
  if (
    ["toHaveAttribute", "toHaveCSS", "toHaveJSProperty"].includes(
      assertion.matcher,
    )
  )
    return `await ${receiver}.${assertion.matcher}(${JSON.stringify(assertion.attribute ?? "")}${expected});`;
  return `await ${receiver}.${assertion.matcher}(${expected.slice(2)});`;
}

export function actionCode(action: ScenarioAction, locator: string): string {
  if (action.type === "navigate")
    return `await page.goto(${JSON.stringify(action.value ?? "")});`;
  const target = `page.${locator}`;
  switch (action.type) {
    case "click":
      return `await ${target}.click(${action.force ? "{ force: true }" : ""});`;
    case "doubleClick":
      return `await ${target}.dblclick();`;
    case "hover":
      return `await ${target}.hover();`;
    case "fill":
      return `await ${target}.fill(${JSON.stringify(action.value ?? "")});`;
    case "selectOption":
      return `await ${target}.selectOption(${
        action.selectBy === "label"
          ? `{ label: ${JSON.stringify(action.value ?? "")} }`
          : JSON.stringify(action.value ?? "")
      });`;
    case "setInputFiles": {
      const files = (action.value ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      return `await ${target}.setInputFiles(${JSON.stringify(files.length === 1 ? files[0] : files)});`;
    }
    case "check":
      return `await ${target}.check();`;
    case "uncheck":
      return `await ${target}.uncheck();`;
    case "press":
      return `await ${target}.press(${JSON.stringify(action.value ?? "Enter")});`;
    case "assert":
      return expectationCode(action, target);
  }
}

function businessStep(action: ScenarioAction, description: string): string {
  switch (action.type) {
    case "click":
      return `${action.force ? "Force click" : "Click"} ${description}`;
    case "doubleClick":
      return `Double click ${description}`;
    case "hover":
      return `Hover over ${description}`;
    case "fill":
      return `Enter ${action.value === "[REDACTED]" ? "a protected value" : JSON.stringify(action.value ?? "")} in ${description}`;
    case "selectOption":
      return `Select ${JSON.stringify(action.value ?? "")} from ${description}`;
    case "setInputFiles":
      return `Upload ${action.value ?? "file"} using ${description}`;
    case "check":
      return `Check ${description}`;
    case "uncheck":
      return `Uncheck ${description}`;
    case "press":
      return `Press ${action.value ?? "Enter"} on ${description}`;
    case "navigate":
      return `Navigate to ${action.value ?? description}`;
    case "assert": {
      const assertion = action.assertion;
      if (!assertion) return `Verify ${description} matches the expectation`;
      const expected =
        assertion.expected === undefined
          ? ""
          : ` ${JSON.stringify(assertion.expected)}`;
      return `Verify ${description} ${assertion.negated ? "not." : ""}${assertion.matcher}${expected}`;
    }
  }
}

export async function recordScenario(
  page: Page,
  config: SmartConfig,
  options: RecordScenarioOptions = {},
): Promise<ScenarioContext> {
  const capturedAt = new Date().toISOString();
  const startUrl = page.url();
  const steps: ScenarioStep[] = [];
  const testCases: RecordingTestCase[] = [
    { id: "test-1", name: "Test 1", steps: [] },
  ];
  const warnings: string[] = [];
  let activeTestCase = testCases[0]!;
  let resolveStop: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  let queue = Promise.resolve();
  let lastElementId: string | undefined;
  const eventFrames = new Map<number, { frame: Frame; markerId: string }>();
  const externalHandlers: {
    weakLocator?: (
      frame: Frame,
      response: RecordResponse,
      action: ScenarioAction,
    ) => Promise<void>;
    syncSettings?: () => void;
  } = {};

  const reindex = (): void => {
    steps.forEach((step, index) => {
      step.index = index + 1;
    });
  };
  const nameOf = (testCaseId: string): string =>
    testCases.find(({ id }) => id === testCaseId)?.name ?? "";
  const summarize = (): StepSummary[] =>
    steps.map((step) => ({
      index: step.index,
      testCase: nameOf(step.testCaseId),
      businessStep: step.businessStep,
      confidence: step.confidence,
    }));
  const panelUpdate = (message: string): PanelUpdate => ({
    message,
    steps: summarize(),
    activeTestCase: activeTestCase.name,
    ...(activeTestCase.jiraId ? { jiraId: activeTestCase.jiraId } : {}),
    ...(activeTestCase.zephyrId ? { zephyrId: activeTestCase.zephyrId } : {}),
  });
  const addNavigationStep = (url: string): void => {
    if (!url || url === "about:blank") return;
    const previous = steps.at(-1);
    if (previous?.action.type === "navigate" && previous.action.value === url)
      return;
    const action: ScenarioAction = { type: "navigate", value: url };
    const step: ScenarioStep = {
      index: steps.length + 1,
      timestamp: new Date().toISOString(),
      pageUrl: url,
      action,
      locatorContext: null,
      locator: "page",
      code: actionCode(action, "page"),
      confidence: "high",
      suggestions: [],
      testCaseId: activeTestCase.id,
      businessStep: businessStep(action, url),
    };
    steps.push(step);
    activeTestCase.steps.push(step);
    options.onStep?.(step);
  };
  addNavigationStep(startUrl);
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    queue = queue.then(() => addNavigationStep(frame.url()));
  });

  await page.exposeBinding(
    "__pwCodegenSmartRecord",
    ({ frame }, payload: unknown): Promise<RecordResponse> => {
      const event = payload as RecordedEvent;
      let response: RecordResponse = {
        stepIndex: steps.length + 1,
        unresolved: true,
        suggestions: [],
      };
      const processing = queue.then(async () => {
        const target = frame.locator(`[${actionMarker}="${event.id}"]`).first();
        let locatorContext = null;
        let warning: string | undefined;
        try {
          const raw = await extractDomContext(target, config);
          locatorContext = await analyzeContext(frame, raw, config, {
            targetSelector: `[${actionMarker}="${event.id}"]`,
          });
        } catch (error) {
          warning =
            error instanceof Error
              ? `Context capture failed: ${error.message}`
              : "Context capture failed";
        }
        const offers = locatorContext
          ? suggestLocators(locatorContext, config)
          : [];
        const suggestions = offers.map(({ locator }) => locator);
        const fallback =
          locatorContext?.recommended ??
          locatorContext?.candidates.find(
            ({ matchCount, resolvesToTarget }) =>
              resolvesToTarget !== false &&
              matchCount > 0 &&
              (!config.requireUniqueLocator || matchCount === 1),
          );
        const locator =
          fallback?.locator ??
          `locator("${locatorContext?.target.tag ?? "unknown"}")`;
        const isResolved = Boolean(locatorContext?.recommended);
        if (!isResolved) {
          warning ??=
            "No locator met the configured recommendation threshold; review the fallback or provide a manual locator.";
          warnings.push(`Step ${steps.length + 1}: ${warning}`);
        }
        const describe = locatorContext
          ? describeTarget(locatorContext)
          : locator;
        const facts = locatorContext ? summarizeTarget(locatorContext) : [];
        const targetSummary = facts.join(" · ");
        const hints: Pick<
          RecordResponse,
          | "description"
          | "offers"
          | "targetFacts"
          | "containerHtml"
          | "containerHtmlTruncated"
        > = {
          description: describe,
          offers,
          targetFacts: facts,
          ...(locatorContext?.containerHtml
            ? { containerHtml: locatorContext.containerHtml }
            : {}),
          ...(locatorContext?.containerHtmlTruncated !== undefined
            ? {
                containerHtmlTruncated: locatorContext.containerHtmlTruncated,
              }
            : {}),
        };
        const previous = steps.at(-1);
        if (
          event.action.type === "fill" &&
          previous?.action.type === "fill" &&
          lastElementId === event.id
        ) {
          previous.action = event.action;
          previous.locatorContext = locatorContext;
          previous.locator = locator;
          previous.code = actionCode(event.action, locator);
          previous.confidence = fallback?.confidence ?? "unresolved";
          previous.timestamp = new Date().toISOString();
          previous.suggestions = suggestions;
          if (targetSummary) previous.targetSummary = targetSummary;
          previous.businessStep = businessStep(event.action, describe);
          response = {
            stepIndex: previous.index,
            unresolved: !isResolved,
            suggestions,
            ...hints,
          };
          return;
        }
        const step: ScenarioStep = {
          index: steps.length + 1,
          timestamp: new Date().toISOString(),
          pageUrl: frame.url(),
          action: event.action,
          locatorContext,
          locator,
          code: actionCode(event.action, locator),
          confidence: fallback?.confidence ?? "unresolved",
          ...(warning ? { warning } : {}),
          suggestions,
          ...(targetSummary ? { targetSummary } : {}),
          testCaseId: activeTestCase.id,
          businessStep: businessStep(event.action, describe),
        };
        steps.push(step);
        activeTestCase.steps.push(step);
        lastElementId = event.id;
        eventFrames.set(step.index, { frame, markerId: event.id });
        options.onStep?.(step);
        response = {
          stepIndex: step.index,
          unresolved: !isResolved,
          suggestions,
          ...hints,
        };
      });
      queue = processing;
      return processing.then(async () => {
        await externalHandlers.weakLocator?.(frame, response, event.action);
        return response;
      });
    },
  );

  await page.exposeBinding(
    "__pwCodegenSmartManualLocator",
    async (_source, payload: unknown) => {
      const { stepIndex, locator } = payload as {
        stepIndex: number;
        locator: string;
      };
      await queue;
      const step = steps.find(({ index }) => index === stepIndex);
      const source = eventFrames.get(stepIndex);
      if (!step || !source)
        return { accepted: false, message: "Step not found" };
      const expression = locator.trim().replace(/^page\./, "");
      try {
        const count = await candidateToLocator(
          source.frame,
          expression,
        ).count();
        if (count !== 1)
          return {
            accepted: false,
            message: `Locator matched ${count} elements; exactly one is required`,
          };
        const resolvesToTarget = await candidateToLocator(
          source.frame,
          expression,
        ).evaluateAll(
          resolvesToActionTarget,
          `[${actionMarker}="${source.markerId}"]`,
        );
        if (!resolvesToTarget)
          return {
            accepted: false,
            message: "Locator matched a different element",
          };
        step.locator = expression;
        step.code = actionCode(step.action, expression);
        step.confidence = "medium";
        step.warning = "Manual locator supplied by the recorder user.";
        if (!step.suggestions.includes(expression))
          step.suggestions.unshift(expression);
        return { accepted: true, message: "Manual locator accepted" };
      } catch (error) {
        return {
          accepted: false,
          message: error instanceof Error ? error.message : "Invalid locator",
        };
      }
    },
  );

  const removeStep = (step: ScenarioStep): void => {
    const owner = testCases.find(({ id }) => id === step.testCaseId);
    const ownerIndex = owner?.steps.indexOf(step) ?? -1;
    if (owner && ownerIndex >= 0) owner.steps.splice(ownerIndex, 1);
    const index = steps.indexOf(step);
    if (index >= 0) steps.splice(index, 1);
    eventFrames.delete(step.index);
    reindex();
    options.onStepRemoved?.(step);
  };

  const settings: RecorderSettings = {
    mode: "auto",
    negate: false,
    ask: false,
    active: true,
  };
  await page.exposeBinding(
    "__pwCodegenSmartSettings",
    (_source, patch: unknown) => {
      Object.assign(settings, (patch ?? {}) as Partial<RecorderSettings>);
      externalHandlers.syncSettings?.();
      return settings;
    },
  );
  await page.exposeBinding("__pwCodegenSmartSteps", async () => {
    await queue;
    return panelUpdate("");
  });
  await page.exposeBinding("__pwCodegenSmartNewTest", async () => {
    await queue;
    const number = testCases.length + 1;
    activeTestCase = {
      id: `test-${number}`,
      name: `Test ${number}`,
      steps: [],
    };
    testCases.push(activeTestCase);
    lastElementId = undefined;
    options.onTestCase?.(activeTestCase.name);
    return panelUpdate(`Recording ${activeTestCase.name}`);
  });
  await page.exposeBinding(
    "__pwCodegenSmartDeleteStep",
    async (_source, payload: unknown) => {
      await queue;
      const { index } = payload as { index: number };
      const step = steps.find((candidate) => candidate.index === index);
      if (!step) return panelUpdate("Step not found");
      removeStep(step);
      return panelUpdate(`Deleted step ${String(index)}`);
    },
  );
  await page.exposeBinding("__pwCodegenSmartDeleteLine", async () => {
    await queue;
    const removed = activeTestCase.steps.at(-1);
    if (!removed) return panelUpdate("No line to delete");
    removeStep(removed);
    return panelUpdate(`Deleted: ${removed.businessStep}`);
  });
  await page.exposeBinding("__pwCodegenSmartDeleteTest", async () => {
    await queue;
    if (testCases.length === 1) {
      for (const step of [...activeTestCase.steps]) removeStep(step);
      return panelUpdate(`Cleared ${activeTestCase.name}`);
    }
    const removed = activeTestCase;
    for (const step of [...removed.steps]) removeStep(step);
    testCases.splice(testCases.indexOf(removed), 1);
    activeTestCase = testCases.at(-1)!;
    options.onTestCase?.(activeTestCase.name);
    return panelUpdate(
      `Deleted ${removed.name}; recording ${activeTestCase.name}`,
    );
  });
  await page.exposeBinding("__pwCodegenSmartStop", () => {
    settings.active = false;
    resolveStop?.();
  });

  const installRecorder = (): void => {
    const state = window as unknown as Record<string, unknown>;
    if (state.__pwCodegenSmartRecorder) return;
    state.__pwCodegenSmartRecorder = true;
    let sequence = 0;
    let mode = "auto";
    let negateAssertion = false;
    let askOnWeakLocator = false;
    let recorderActive = true;
    /** Panel renderers, assigned once the controls exist in the top frame. */
    let renderMode: ((value: string) => void) | undefined;
    let renderToggles: ((negate: boolean, ask: boolean) => void) | undefined;
    const settingsBinding = (
      window as unknown as Record<
        string,
        (patch: Partial<RecorderSettings>) => Promise<RecorderSettings>
      >
    ).__pwCodegenSmartSettings;
    const pushSettings = (patch: Partial<RecorderSettings>): void => {
      void settingsBinding?.(patch);
    };
    const applySettings = (next: RecorderSettings): void => {
      mode = next.mode;
      negateAssertion = next.negate;
      // Weak-locator prompts are rendered in the external controller.
      askOnWeakLocator = false;
      recorderActive = next.active;
      renderMode?.(next.mode);
      renderToggles?.(next.negate, next.ask);
    };
    state.__pwCodegenSmartApplySettings = applySettings;
    const pullSettings = (): void => {
      void settingsBinding?.({}).then(applySettings);
    };
    const setMode = (value: string): void => {
      mode = value;
      renderMode?.(value);
      pushSettings({ mode: value });
    };
    const record = (
      window as unknown as Record<
        string,
        (payload: RecordedEvent) => Promise<RecordResponse>
      >
    ).__pwCodegenSmartRecord;
    const manual = (
      window as unknown as Record<
        string,
        (payload: {
          stepIndex: number;
          locator: string;
        }) => Promise<{ accepted: boolean; message: string }>
      >
    ).__pwCodegenSmartManualLocator;
    const emptyUpdate: PanelUpdate = {
      message: "",
      steps: [],
      activeTestCase: "Test 1",
    };
    const call = (name: string): Promise<PanelUpdate> =>
      (window as unknown as Record<string, () => Promise<PanelUpdate>>)[
        name
      ]?.() ?? Promise.resolve(emptyUpdate);
    const deleteStep = (index: number): Promise<PanelUpdate> =>
      (
        window as unknown as Record<
          string,
          (payload: { index: number }) => Promise<PanelUpdate>
        >
      ).__pwCodegenSmartDeleteStep?.({ index }) ?? Promise.resolve(emptyUpdate);
    let refreshPanel: ((update: PanelUpdate) => void) | undefined;
    const syncPanel = (): void => {
      if (refreshPanel) void call("__pwCodegenSmartSteps").then(refreshPanel);
    };
    const mark = (element: Element): string => {
      const existing = element.getAttribute("data-pw-codegen-smart-action");
      if (existing) return existing;
      sequence += 1;
      const id = `${Date.now()}-${sequence}`;
      element.setAttribute("data-pw-codegen-smart-action", id);
      return id;
    };
    /**
     * Playwright dismisses native dialogs automatically when the harness has no
     * dialog listener, so every prompt is rendered as in-page DOM instead.
     */
    interface AskOptions {
      title: string;
      message?: string;
      value?: string;
      label?: string;
      error?: string;
      suggestions?: string[];
      details?: string;
      confirmLabel?: string;
      cancelLabel?: string;
    }
    let modalOpen = false;
    const ask = (options: AskOptions): Promise<string | null> =>
      new Promise((resolve) => {
        if (!document.body) {
          resolve(null);
          return;
        }
        modalOpen = true;
        const overlay = document.createElement("div");
        overlay.setAttribute("data-pw-codegen-smart-controls", "");
        overlay.setAttribute("data-pw-codegen-smart-modal", "");
        overlay.style.cssText =
          "position:fixed;inset:0;z-index:2147483647;background:rgba(17,24,39,.55);display:flex;align-items:center;justify-content:center;font:13px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#111827";
        const card = document.createElement("div");
        card.style.cssText =
          "width:min(560px,92vw);max-height:86vh;display:flex;flex-direction:column;background:#fff;border-radius:12px;box-shadow:0 20px 50px rgba(0,0,0,.35);overflow:hidden";
        const head = document.createElement("div");
        head.style.cssText =
          "padding:14px 16px;border-bottom:1px solid #f3f4f6";
        const title = document.createElement("strong");
        title.textContent = options.title;
        head.append(title);
        if (options.message) {
          const message = document.createElement("div");
          message.style.cssText =
            "margin-top:4px;font-size:12px;color:#6b7280;word-break:break-word";
          message.textContent = options.message;
          head.append(message);
        }
        const body = document.createElement("div");
        body.style.cssText = "padding:14px 16px;overflow:auto";
        if (options.error) {
          const error = document.createElement("div");
          error.style.cssText =
            "margin-bottom:10px;padding:8px 10px;border-radius:6px;background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;font-size:12px";
          error.textContent = options.error;
          body.append(error);
        }
        const label = document.createElement("label");
        label.style.cssText =
          "display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;margin-bottom:4px";
        label.textContent = options.label ?? "Value";
        const input = document.createElement("input");
        input.value = options.value ?? "";
        input.style.cssText =
          "width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px";
        body.append(label, input);
        if (options.suggestions?.length) {
          const heading = document.createElement("div");
          heading.style.cssText =
            "margin:12px 0 5px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#6b7280";
          heading.textContent = "Suggested locators — click to use";
          const group = document.createElement("div");
          group.style.cssText = "display:flex;flex-direction:column;gap:4px";
          for (const suggestion of options.suggestions.slice(0, 8)) {
            const option = document.createElement("button");
            option.type = "button";
            option.textContent = suggestion;
            option.style.cssText =
              "text-align:left;padding:6px 8px;border:1px solid #e5e7eb;border-radius:6px;background:#f9fafb;cursor:pointer;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#374151;word-break:break-all";
            option.addEventListener("click", () => {
              input.value = suggestion;
              input.focus();
            });
            group.append(option);
          }
          body.append(heading, group);
        }
        if (options.details) {
          const details = document.createElement("details");
          details.style.cssText = "margin-top:12px";
          const summary = document.createElement("summary");
          summary.style.cssText = "cursor:pointer;font-size:12px;color:#6d28d9";
          summary.textContent = "Show the surrounding HTML";
          const pre = document.createElement("pre");
          pre.style.cssText =
            "margin:8px 0 0;padding:10px;max-height:220px;overflow:auto;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;font-size:11px;white-space:pre-wrap;word-break:break-all";
          pre.textContent = options.details;
          details.append(summary, pre);
          body.append(details);
        }
        const foot = document.createElement("div");
        foot.style.cssText =
          "padding:12px 16px;border-top:1px solid #f3f4f6;display:flex;justify-content:flex-end;gap:8px";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.setAttribute("data-modal-cancel", "");
        cancel.textContent = options.cancelLabel ?? "Skip";
        cancel.style.cssText =
          "padding:7px 12px;border:1px solid #d1d5db;background:#fff;color:#374151;border-radius:6px;cursor:pointer;font:inherit;font-size:12px";
        const confirm = document.createElement("button");
        confirm.type = "button";
        confirm.setAttribute("data-modal-confirm", "");
        confirm.textContent = options.confirmLabel ?? "Use value";
        confirm.style.cssText =
          "padding:7px 12px;border:1px solid #7c3aed;background:#7c3aed;color:#fff;border-radius:6px;cursor:pointer;font:inherit;font-size:12px;font-weight:600";
        foot.append(cancel, confirm);
        card.append(head, body, foot);
        overlay.append(card);
        const close = (result: string | null): void => {
          modalOpen = false;
          overlay.remove();
          resolve(result);
        };
        confirm.addEventListener("click", () => {
          close(input.value);
        });
        cancel.addEventListener("click", () => {
          close(null);
        });
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            close(input.value);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            close(null);
          }
        });
        document.body.append(overlay);
        input.focus();
        input.select();
      });
    const promptExpected = async (
      matcher: AssertionMatcher,
      target: Element,
    ): Promise<NonNullable<ScenarioAction["assertion"]>> => {
      if (
        [
          "toBeVisible",
          "toBeAttached",
          "toBeHidden",
          "toBeEnabled",
          "toBeDisabled",
          "toBeEditable",
          "toBeEmpty",
          "toBeFocused",
          "toBeChecked",
          "toBeInViewport",
        ].includes(matcher)
      )
        return { matcher, negated: negateAssertion };
      if (
        ["toHaveAttribute", "toHaveCSS", "toHaveJSProperty"].includes(matcher)
      ) {
        const label =
          matcher === "toHaveAttribute"
            ? "Attribute name"
            : matcher === "toHaveCSS"
              ? "CSS property"
              : "JavaScript property";
        const attribute =
          (await ask({
            title: `expect.${matcher}`,
            message: "Which property should be asserted?",
            label,
            value: matcher === "toHaveCSS" ? "display" : "aria-label",
            confirmLabel: "Next",
          })) ?? "";
        const expected =
          (await ask({
            title: `expect.${matcher}`,
            message: `Expected value for ${attribute || label}`,
            label: "Expected value",
            value: target.getAttribute(attribute) ?? "",
          })) ?? "";
        return { matcher, attribute, expected, negated: negateAssertion };
      }
      const defaultValue =
        matcher === "toHaveCount"
          ? "1"
          : matcher === "toHaveValue" && target instanceof HTMLInputElement
            ? target.value
            : (target.textContent?.trim() ?? "");
      const entered = await ask({
        title: `expect.${matcher}`,
        message: negateAssertion
          ? "Recorded with .not, so the assertion passes when the value differs."
          : "Confirm the value this assertion should expect.",
        label:
          matcher === "toHaveValues"
            ? "Expected values (comma separated)"
            : "Expected value",
        value: defaultValue,
      });
      return {
        matcher,
        expected:
          matcher === "toHaveCount"
            ? Number(entered ?? defaultValue)
            : matcher === "toHaveValues"
              ? (entered ?? defaultValue)
                  .split(",")
                  .map((value) => value.trim())
              : (entered ?? defaultValue),
        negated: negateAssertion,
      };
    };
    const promptedSteps = new Set<number>();
    const send = async (
      element: Element,
      action: ScenarioAction,
    ): Promise<RecordResponse> => {
      if (!recorderActive)
        return { stepIndex: 0, unresolved: true, suggestions: [] };
      const response = await record?.({ id: mark(element), action });
      const fallback = response ?? {
        stepIndex: 0,
        unresolved: true,
        suggestions: [],
      };
      if (
        fallback.unresolved &&
        manual &&
        askOnWeakLocator &&
        !promptedSteps.has(fallback.stepIndex)
      ) {
        promptedSteps.add(fallback.stepIndex);
        let error: string | undefined;
        for (;;) {
          const entered = await ask({
            title: "This locator needs your help",
            message: `${action.type} on ${fallback.description ?? "the clicked element"} — the automatic locator was low confidence. Pick a suggestion or type your own, or skip to keep the fallback.`,
            label: "Playwright locator",
            value: fallback.suggestions[0] ?? "",
            suggestions: fallback.suggestions,
            confirmLabel: "Use locator",
            cancelLabel: "Keep fallback",
            ...(error ? { error } : {}),
            ...(fallback.containerHtml
              ? { details: fallback.containerHtml }
              : {}),
          });
          if (!entered) break;
          const result = await manual({
            stepIndex: fallback.stepIndex,
            locator: entered,
          });
          if (result.accepted) break;
          error = result.message;
        }
      }
      syncPanel();
      return fallback;
    };
    const sensitive = (element: Element): boolean =>
      /(password|token|secret|api[-_]?key|credit|card|cvv)/i.test(
        [
          element.getAttribute("type"),
          element.getAttribute("name"),
          element.getAttribute("id"),
          element.getAttribute("autocomplete"),
        ]
          .filter(Boolean)
          .join(" "),
      );
    type EditableField = HTMLInputElement | HTMLTextAreaElement;
    const fillTimers = new Map<EditableField, number>();
    const flushFill = (element: EditableField): void => {
      const timer = fillTimers.get(element);
      if (timer === undefined) return;
      window.clearTimeout(timer);
      fillTimers.delete(element);
      void send(element, {
        type: "fill",
        value: sensitive(element) ? "[REDACTED]" : element.value,
      });
    };
    const flushAllFills = (): void => {
      for (const element of [...fillTimers.keys()]) flushFill(element);
    };
    const scheduleFill = (element: EditableField): void => {
      const pending = fillTimers.get(element);
      if (pending !== undefined) window.clearTimeout(pending);
      fillTimers.set(
        element,
        window.setTimeout(() => flushFill(element), 600),
      );
    };
    const selectedAction = async (
      target: Element,
    ): Promise<ScenarioAction | null> => {
      if (mode.startsWith("assert:"))
        return {
          type: "assert",
          assertion: await promptExpected(
            mode.slice("assert:".length) as AssertionMatcher,
            target,
          ),
        };
      if (mode === "forceClick") return { type: "click", force: true };
      if (mode === "doubleClick") return { type: "doubleClick" };
      if (mode === "hover") return { type: "hover" };
      if (mode === "check") return { type: "check" };
      if (mode === "uncheck") return { type: "uncheck" };
      if (mode === "press") {
        const key = await ask({
          title: "Record a key press",
          message: "Which key should the test press on this element?",
          label: "Key",
          value: "Enter",
          confirmLabel: "Record press",
        });
        if (key === null) return null;
        return { type: "press", value: key || "Enter" };
      }
      return null;
    };
    const controls =
      'button,a,input,[role="button"],[role="link"],[role="checkbox"],[role="menuitem"],[role="menuitemcheckbox"],[role="option"],[role="tab"]';
    const ownText = (node: Element): string =>
      (node.textContent ?? "").replace(/\s+/g, " ").trim();
    // A control carries the text of one thing; a paragraph of it is a wrapper.
    const oversized = (node: Element): boolean => ownText(node).length > 120;
    /**
     * Menus and panels are frequently rendered inside the control that opens
     * them, so the nearest control can own an entire menu. Such a wrapper is
     * never the thing that was clicked: keep the widest item under it instead,
     * which is the row or card the pointer landed on.
     */
    const clicked = (origin: Element): Element => {
      const control = origin.closest(controls);
      if (!control || control === origin) return control ?? origin;
      if (!oversized(control) && !control.querySelector(controls))
        return control;
      let item = origin;
      for (
        let node: Element | null = origin;
        node && node !== control;
        node = node.parentElement
      )
        if (ownText(node) && !oversized(node)) item = node;
      return item;
    };

    document.addEventListener(
      "click",
      (event) => {
        const origin = event.composedPath()[0];
        if (!(origin instanceof Element)) return;
        flushAllFills();
        if (origin.closest("[data-pw-codegen-smart-controls]")) return;
        const target = clicked(origin);
        if (target.hasAttribute("data-pw-codegen-smart-replay")) {
          target.removeAttribute("data-pw-codegen-smart-replay");
          return;
        }
        if (mode !== "auto") {
          event.preventDefault();
          event.stopImmediatePropagation();
          void selectedAction(target).then(async (explicit) => {
            if (!explicit) return;
            await send(target, explicit);
            if (explicit.type === "assert" || explicit.type === "hover") return;
            if (!target.isConnected) return;
            target.setAttribute("data-pw-codegen-smart-replay", "");
            if (explicit.type === "doubleClick")
              target.dispatchEvent(
                new MouseEvent("dblclick", { bubbles: true, cancelable: true }),
              );
            else (target as HTMLElement).click();
          });
          return;
        }
        if (
          target.matches(
            'input,textarea,select,option,[contenteditable="true"]',
          )
        )
          return;
        event.preventDefault();
        event.stopImmediatePropagation();
        void send(target, { type: "click" }).then(() => {
          if (!target.isConnected) return;
          target.setAttribute("data-pw-codegen-smart-replay", "");
          (target as HTMLElement).click();
        });
      },
      true,
    );
    document.addEventListener(
      "input",
      (event) => {
        const target = event.composedPath()[0];
        if (
          !(
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement
          ) ||
          target.closest("[data-pw-codegen-smart-controls]") ||
          (target instanceof HTMLInputElement &&
            ["checkbox", "radio"].includes(target.type))
        )
          return;
        scheduleFill(target);
      },
      true,
    );
    document.addEventListener(
      "blur",
      (event) => {
        const target = event.composedPath()[0];
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement
        )
          flushFill(target);
      },
      true,
    );
    document.addEventListener(
      "change",
      (event) => {
        const target = event.composedPath()[0];
        if (
          !(target instanceof Element) ||
          target.closest("[data-pw-codegen-smart-controls]")
        )
          return;
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement
        )
          flushFill(target);
        flushAllFills();
        if (!(
          target instanceof HTMLInputElement ||
          target instanceof HTMLSelectElement
        ))
          return;
        if (target instanceof HTMLInputElement && target.type === "file")
          void send(target, {
            type: "setInputFiles",
            value: [...(target.files ?? [])].map(({ name }) => name).join(","),
          });
        else if (target instanceof HTMLSelectElement) {
          const selected = target.selectedOptions[0];
          const label = (selected?.label || selected?.textContent || "").trim();
          const byLabel = Boolean(label && label !== target.value);
          void send(target, {
            type: "selectOption",
            value: byLabel ? label : target.value,
            selectBy: byLabel ? "label" : "value",
          });
        } else if (["checkbox", "radio"].includes(target.type))
          void send(target, { type: target.checked ? "check" : "uncheck" });
      },
      true,
    );
    document.addEventListener(
      "keydown",
      (event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("[data-pw-codegen-smart-controls]")
        )
          return;
        if (event.key === "Escape" && mode !== "auto" && !modalOpen) {
          setMode("auto");
          return;
        }
        if (event.key === "Enter" && event.target instanceof Element) {
          if (
            event.target instanceof HTMLInputElement ||
            event.target instanceof HTMLTextAreaElement
          )
            flushFill(event.target);
          void send(event.target, { type: "press", value: "Enter" });
        }
        if (
          event.key.toLowerCase() === "s" &&
          event.ctrlKey &&
          event.shiftKey
        ) {
          event.preventDefault();
          flushAllFills();
          recorderActive = false;
          (
            window as unknown as Record<string, () => void>
          ).__pwCodegenSmartStop?.();
        }
      },
      true,
    );

    if (
      window.top === window &&
      state.__pwCodegenSmartEmbeddedControls === true
    ) {
      const addControls = (): void => {
        if (
          !recorderActive ||
          !document.body ||
          document.querySelector("[data-pw-codegen-smart-controls]")
        )
          return;
        const panel = document.createElement("div");
        panel.setAttribute("data-pw-codegen-smart-controls", "");
        panel.style.cssText =
          "position:fixed;right:16px;bottom:16px;width:330px;z-index:2147483647;background:#fff;color:#111827;border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.28);font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;overflow:hidden";
        panel.innerHTML = `
          <div data-drag style="display:flex;align-items:center;gap:8px;cursor:move;padding:10px 12px;background:#faf5ff;border-bottom:1px solid #ede9fe">
            <span style="width:8px;height:8px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 3px #fee2e2"></span>
            <strong style="flex:1;font-size:13px">Smart Recorder</strong>
            <span data-test-name style="font-size:11px;font-weight:600;color:#6d28d9;background:#f3e8ff;border-radius:99px;padding:2px 8px">Test 1</span>
          </div>
          <div style="padding:10px 12px">
            <label data-label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;margin-bottom:4px">Click mode <span style="font-weight:500;text-transform:none;letter-spacing:0">(stays active)</span></label>
            <select data-mode style="width:100%;padding:7px 8px;border:1px solid #d1d5db;border-radius:6px;background:#fff;font:inherit;color:inherit">
              <option value="auto">Auto — record normal actions</option>
              <optgroup label="Actions">
                <option value="forceClick">Force click</option>
                <option value="doubleClick">Double click</option>
                <option value="hover">Hover</option>
                <option value="check">Check</option>
                <option value="uncheck">Uncheck</option>
                <option value="press">Press key</option>
              </optgroup>
              <optgroup label="Assertions">
                ${["toBeAttached", "toBeVisible", "toBeHidden", "toBeEnabled", "toBeDisabled", "toBeEditable", "toBeEmpty", "toBeFocused", "toBeChecked", "toBeInViewport", "toHaveAccessibleDescription", "toHaveAccessibleErrorMessage", "toHaveAccessibleName", "toHaveText", "toContainText", "toHaveValue", "toHaveValues", "toHaveAttribute", "toHaveClass", "toHaveCSS", "toHaveId", "toHaveJSProperty", "toHaveRole", "toHaveScreenshot", "toHaveCount"].map((value) => `<option value="assert:${value}">expect.${value}</option>`).join("")}
              </optgroup>
            </select>
            <div data-mode-hint style="display:none;margin-top:6px;padding:6px 8px;border-radius:6px;background:#f5f3ff;border:1px solid #ddd6fe;color:#5b21b6;font-size:11px"></div>
            <div style="display:flex;flex-wrap:wrap;gap:14px;margin:9px 0 10px">
              <label data-check style="display:inline-flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;margin:0"><span>Negate assertion (.not)</span><input data-negate type="checkbox"></label>
              <label data-check style="display:inline-flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;margin:0"><span>Ask when locator is weak</span><input data-ask type="checkbox"></label>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
              <button data-new>+ New testcase</button>
              <button data-delete-line>Undo last line</button>
              <button data-delete-test>Delete testcase</button>
              <button data-stop data-primary>Stop recording</button>
            </div>
          </div>
          <div style="border-top:1px solid #f3f4f6">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 12px;background:#f9fafb">
              <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#6b7280">Recorded steps</span>
              <span data-count style="font-size:11px;color:#6b7280">0</span>
            </div>
            <ol data-steps style="list-style:none;margin:0;padding:0;max-height:180px;overflow:auto"></ol>
          </div>
          <div data-status style="padding:7px 12px;font-size:11px;color:#6b7280;border-top:1px solid #f3f4f6;background:#fff">Recording Test 1</div>`;
        for (const element of panel.querySelectorAll("button")) {
          const button = element;
          const primary = button.hasAttribute("data-primary");
          button.style.cssText = `border:1px solid ${primary ? "#7c3aed" : "#d1d5db"};background:${primary ? "#7c3aed" : "#fff"};color:${primary ? "#fff" : "#374151"};border-radius:6px;padding:7px 6px;cursor:pointer;font:inherit;font-size:12px;font-weight:${primary ? "600" : "500"}`;
        }
        for (const box of panel.querySelectorAll<HTMLInputElement>(
          "[data-check] input",
        ))
          box.style.cssText =
            "width:13px;height:13px;margin:0;flex:none;accent-color:#7c3aed;vertical-align:middle";
        const select = panel.querySelector<HTMLSelectElement>("[data-mode]")!;
        const hint = panel.querySelector<HTMLElement>("[data-mode-hint]")!;
        const negateBox =
          panel.querySelector<HTMLInputElement>("[data-negate]")!;
        const askBox = panel.querySelector<HTMLInputElement>("[data-ask]")!;
        renderMode = (value): void => {
          select.value = value;
          const active = value !== "auto";
          select.style.borderColor = active ? "#7c3aed" : "#d1d5db";
          select.style.background = active ? "#faf5ff" : "#fff";
          hint.style.display = active ? "block" : "none";
          if (!active) return;
          const label = select.selectedOptions[0]?.textContent ?? value;
          const negated = negateBox.checked ? " (negated with .not)" : "";
          hint.textContent = value.startsWith("assert:")
            ? `Every click records ${label}${negated} without interacting with the page. Choose Auto or press Esc to click normally again.`
            : `Every click is recorded as ${label}. Choose Auto or press Esc for normal recording.`;
        };
        renderToggles = (negate, ask): void => {
          negateBox.checked = negate;
          askBox.checked = ask;
        };
        select.addEventListener("change", () => {
          setMode(select.value);
        });
        negateBox.addEventListener("change", () => {
          negateAssertion = negateBox.checked;
          pushSettings({ negate: negateAssertion });
          renderMode?.(mode);
        });
        askBox.addEventListener("change", () => {
          askOnWeakLocator = askBox.checked;
          pushSettings({ ask: askOnWeakLocator });
        });
        renderMode(mode);
        renderToggles(negateAssertion, askOnWeakLocator);
        const status = panel.querySelector<HTMLElement>("[data-status]")!;
        const list = panel.querySelector<HTMLElement>("[data-steps]")!;
        const counter = panel.querySelector<HTMLElement>("[data-count]")!;
        const testName = panel.querySelector<HTMLElement>("[data-test-name]")!;
        const tone: Record<string, string> = {
          high: "#16a34a",
          medium: "#d97706",
          low: "#dc2626",
          unresolved: "#dc2626",
        };
        let signature = "";
        let rendered = 0;
        const render = (update: PanelUpdate): void => {
          if (update.message) status.textContent = update.message;
          testName.textContent = update.activeTestCase;
          const next = update.steps
            .map(({ index, businessStep, confidence }) =>
              [index, businessStep, confidence].join("\u0001"),
            )
            .join("\u0002");
          if (next === signature) return;
          const grew = update.steps.length > rendered;
          signature = next;
          rendered = update.steps.length;
          counter.textContent = String(update.steps.length);
          list.textContent = "";
          if (update.steps.length === 0) {
            const empty = document.createElement("li");
            empty.style.cssText =
              "padding:12px;text-align:center;color:#9ca3af;font-size:12px";
            empty.textContent = "Interact with the page to record a step";
            list.append(empty);
            return;
          }
          let lastTestCase = "";
          for (const step of update.steps) {
            if (step.testCase !== lastTestCase) {
              lastTestCase = step.testCase;
              const heading = document.createElement("li");
              heading.style.cssText =
                "padding:5px 12px;font-size:11px;font-weight:700;color:#6d28d9;background:#faf5ff;position:sticky;top:0";
              heading.textContent = step.testCase;
              list.append(heading);
            }
            const row = document.createElement("li");
            row.style.cssText =
              "display:flex;align-items:flex-start;gap:7px;padding:6px 8px 6px 12px;border-top:1px solid #f3f4f6";
            const badge = document.createElement("span");
            badge.style.cssText = `flex:none;margin-top:3px;width:6px;height:6px;border-radius:50%;background:${tone[step.confidence] ?? "#9ca3af"}`;
            badge.title = `locator confidence: ${step.confidence}`;
            const text = document.createElement("span");
            text.style.cssText = "flex:1;font-size:12px;word-break:break-word";
            text.textContent = `${String(step.index)}. ${step.businessStep}`;
            const remove = document.createElement("button");
            remove.textContent = "×";
            remove.title = "Delete this line";
            remove.style.cssText =
              "flex:none;border:0;background:transparent;color:#9ca3af;cursor:pointer;font-size:16px;line-height:1;padding:0 2px";
            remove.addEventListener("mouseenter", () => {
              remove.style.color = "#dc2626";
            });
            remove.addEventListener("mouseleave", () => {
              remove.style.color = "#9ca3af";
            });
            remove.addEventListener("click", () => {
              promptedSteps.clear();
              void deleteStep(step.index).then(render);
            });
            row.append(badge, text, remove);
            list.append(row);
          }
          if (grew) list.scrollTop = list.scrollHeight;
        };
        refreshPanel = render;
        window.setInterval(syncPanel, 1500);
        panel.querySelector("[data-new]")?.addEventListener("click", () => {
          void call("__pwCodegenSmartNewTest").then(render);
        });
        panel
          .querySelector("[data-delete-line]")
          ?.addEventListener("click", () => {
            promptedSteps.clear();
            void call("__pwCodegenSmartDeleteLine").then(render);
          });
        panel
          .querySelector("[data-delete-test]")
          ?.addEventListener("click", () => {
            promptedSteps.clear();
            void call("__pwCodegenSmartDeleteTest").then(render);
          });
        panel.querySelector("[data-stop]")?.addEventListener("click", () => {
          flushAllFills();
          recorderActive = false;
          (
            window as unknown as Record<string, () => void>
          ).__pwCodegenSmartStop?.();
        });
        void call("__pwCodegenSmartSteps").then(render);
        let drag: { x: number; y: number; left: number; top: number } | null =
          null;
        panel
          .querySelector("[data-drag]")
          ?.addEventListener("pointerdown", (event) => {
            const pointer = event as PointerEvent;
            const box = panel.getBoundingClientRect();
            drag = {
              x: pointer.clientX,
              y: pointer.clientY,
              left: box.left,
              top: box.top,
            };
            panel.setPointerCapture(pointer.pointerId);
          });
        panel.addEventListener("pointermove", (event) => {
          if (!drag) return;
          panel.style.left = `${drag.left + event.clientX - drag.x}px`;
          panel.style.top = `${drag.top + event.clientY - drag.y}px`;
          panel.style.right = "auto";
          panel.style.bottom = "auto";
        });
        panel.addEventListener("pointerup", () => {
          drag = null;
        });
        document.body.append(panel);
      };
      void settingsBinding?.({}).then((next) => {
        applySettings(next);
        if (document.body) addControls();
        else
          document.addEventListener("DOMContentLoaded", addControls, {
            once: true,
          });
      });
    } else {
      // Child frames have no panel, so they poll for the mode chosen in the top frame.
      pullSettings();
      window.setInterval(pullSettings, 1000);
    }
  };

  await page.addInitScript(installRecorder);
  for (const frame of page.frames()) await frame.evaluate(installRecorder);
  const pickerStatus: { report: (message: string) => void } = {
    report: () => undefined,
  };
  const picker = await createElementPicker(page, {
    onStatus: (message) => pickerStatus.report(message),
  });
  let pickLoop: Promise<void> | undefined;
  const applySettingsInFrames = async (): Promise<void> => {
    await Promise.all(
      page.frames().map((frame) =>
        frame
          .evaluate((next) => {
            const apply = (
              window as unknown as Record<
                string,
                (value: RecorderSettings) => void
              >
            ).__pwCodegenSmartApplySettings;
            apply?.(next);
          }, settings)
          .catch(() => undefined),
      ),
    );
  };
  const noValueMatchers: AssertionMatcher[] = [
    "toBeAttached",
    "toBeVisible",
    "toBeHidden",
    "toBeEnabled",
    "toBeDisabled",
    "toBeEditable",
    "toBeEmpty",
    "toBeFocused",
    "toBeChecked",
    "toBeInViewport",
    "toHaveScreenshot",
  ];
  const actionForPick = async (
    selectedMode: string,
    target: Awaited<ReturnType<typeof picker.pick>> & {},
  ): Promise<ScenarioAction | null> => {
    if (selectedMode === "forceClick") return { type: "click", force: true };
    if (selectedMode === "doubleClick") return { type: "doubleClick" };
    if (selectedMode === "hover") return { type: "hover" };
    if (selectedMode === "check") return { type: "check" };
    if (selectedMode === "uncheck") return { type: "uncheck" };
    if (selectedMode === "press") {
      const key = await control.prompt({
        title: "Record a key press",
        message: "Which key should the test press on this element?",
        label: "Key",
        value: "Enter",
        confirmLabel: "Record press",
      });
      return key === null ? null : { type: "press", value: key || "Enter" };
    }
    if (!selectedMode.startsWith("assert:")) return null;
    const matcher = selectedMode.slice("assert:".length) as AssertionMatcher;
    if (noValueMatchers.includes(matcher))
      return {
        type: "assert",
        assertion: { matcher, negated: settings.negate },
      };
    let attribute: string | undefined;
    if (
      ["toHaveAttribute", "toHaveCSS", "toHaveJSProperty"].includes(matcher)
    ) {
      attribute =
        (await control.prompt({
          title: `expect.${matcher}`,
          message: "Which property should be asserted?",
          label: "Property name",
          value: matcher === "toHaveCSS" ? "display" : "aria-label",
          confirmLabel: "Next",
        })) ?? "";
    }
    const defaultValue = await target.locator.evaluate(
      (element, options) => {
        if (options.matcher === "toHaveCount") return "1";
        if (
          options.matcher === "toHaveValue" &&
          (element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement)
        )
          return element.value;
        if (options.matcher === "toHaveId") return element.id;
        if (options.matcher === "toHaveClass")
          return element.getAttribute("class") ?? "";
        if (options.matcher === "toHaveRole")
          return element.getAttribute("role") ?? "";
        if (options.matcher === "toHaveAccessibleName")
          return element.getAttribute("aria-label") ?? "";
        if (options.matcher === "toHaveAttribute")
          return element.getAttribute(options.attribute ?? "") ?? "";
        if (options.matcher === "toHaveCSS")
          return getComputedStyle(element).getPropertyValue(
            options.attribute ?? "",
          );
        if (options.matcher === "toHaveJSProperty") {
          const value = (element as unknown as Record<string, unknown>)[
            options.attribute ?? ""
          ];
          return typeof value === "string"
            ? value
            : (JSON.stringify(value) ?? "");
        }
        return element.textContent?.trim() ?? "";
      },
      { matcher, attribute },
    );
    const entered = await control.prompt({
      title: `expect.${matcher}`,
      label:
        matcher === "toHaveValues"
          ? "Expected values (comma separated)"
          : "Expected value",
      value: defaultValue,
    });
    if (entered === null) return null;
    return {
      type: "assert",
      assertion: {
        matcher,
        expected:
          matcher === "toHaveCount"
            ? Number(entered)
            : matcher === "toHaveValues"
              ? entered.split(",").map((value) => value.trim())
              : entered,
        ...(attribute !== undefined ? { attribute } : {}),
        negated: settings.negate,
      },
    };
  };
  const requestManualLocator = async (
    source: Frame,
    response: RecordResponse,
    action: ScenarioAction,
  ): Promise<void> => {
    if (!settings.ask || !response.unresolved || response.stepIndex === 0)
      return;
    let error: string | undefined;
    for (;;) {
      const entered = await control.prompt({
        title: "This locator needs your help",
        message: `${action.type} on ${response.description ?? "the selected element"} — pick a suggestion and edit it, or type your own.`,
        label: "Playwright locator",
        value: response.suggestions[0] ?? "",
        suggestions: response.offers ?? [],
        context: response.targetFacts ?? [],
        ...(response.containerHtml
          ? {
              details: response.containerHtml,
              detailsTruncated: response.containerHtmlTruncated ?? false,
            }
          : {}),
        ...(error ? { error } : {}),
        confirmLabel: "Use locator",
        cancelLabel: "Keep unresolved",
      });
      if (!entered) return;
      const result = await source.evaluate(
        (payload) =>
          (
            window as unknown as Record<
              string,
              (value: unknown) => Promise<{
                accepted: boolean;
                message: string;
              }>
            >
          ).__pwCodegenSmartManualLocator?.(payload),
        { stepIndex: response.stepIndex, locator: entered },
      );
      if (result?.accepted) return;
      error = result?.message ?? "Invalid locator";
    }
  };
  externalHandlers.weakLocator = requestManualLocator;
  const recordPick = async (selectedMode: string): Promise<void> => {
    const picked = await picker.pick();
    if (!picked) return;
    try {
      const action = await actionForPick(selectedMode, picked);
      if (!action) return;
      await picked.locator.evaluate(
        (element, value) =>
          element.setAttribute("data-pw-codegen-smart-action", value),
        picked.markerId,
      );
      await picked.frame.evaluate(
        (payload) =>
          (
            window as unknown as Record<
              string,
              (value: unknown) => Promise<RecordResponse>
            >
          ).__pwCodegenSmartRecord?.(payload),
        { id: picked.markerId, action },
      );
    } finally {
      await picked.release();
    }
  };
  const runPickLoop = async (selectedMode: string): Promise<void> => {
    while (
      settings.active &&
      settings.mode === selectedMode &&
      selectedMode !== "auto"
    ) {
      try {
        await recordPick(selectedMode);
      } catch (error) {
        if (
          settings.active &&
          settings.mode === selectedMode &&
          !(error instanceof Error && /cancel/i.test(error.message))
        )
          warnings.push(`Element picker: ${String(error)}`);
      }
    }
  };
  const control: RecorderControl = await createRecorderControl(
    page,
    {
      settings: async (patch) => {
        const previousMode = settings.mode;
        Object.assign(settings, patch);
        if (
          patch.mode !== undefined &&
          (patch.mode === "auto" || patch.mode !== previousMode)
        )
          await picker.cancel();
        await applySettingsInFrames();
        return settings;
      },
      refresh: async () => {
        await queue;
        return panelUpdate("");
      },
      pick: async (selectedMode) => {
        if (pickLoop) return;
        pickLoop = runPickLoop(selectedMode).finally(() => {
          pickLoop = undefined;
        });
        await pickLoop;
      },
      newTest: async () => {
        await queue;
        const number = testCases.length + 1;
        activeTestCase = {
          id: `test-${number}`,
          name: `Test ${number}`,
          steps: [],
        };
        testCases.push(activeTestCase);
        lastElementId = undefined;
        options.onTestCase?.(activeTestCase.name);
        return panelUpdate(`Recording ${activeTestCase.name}`);
      },
      deleteLine: async () => {
        await queue;
        const removed = activeTestCase.steps.at(-1);
        if (!removed) return panelUpdate("No line to delete");
        removeStep(removed);
        return panelUpdate(`Deleted: ${removed.businessStep}`);
      },
      deleteTest: async () => {
        await queue;
        if (testCases.length === 1) {
          for (const step of [...activeTestCase.steps]) removeStep(step);
          return panelUpdate(`Cleared ${activeTestCase.name}`);
        }
        const removed = activeTestCase;
        for (const step of [...removed.steps]) removeStep(step);
        testCases.splice(testCases.indexOf(removed), 1);
        activeTestCase = testCases.at(-1)!;
        options.onTestCase?.(activeTestCase.name);
        return panelUpdate(
          `Deleted ${removed.name}; recording ${activeTestCase.name}`,
        );
      },
      deleteStep: async (index) => {
        await queue;
        const step = steps.find((candidate) => candidate.index === index);
        if (!step) return panelUpdate("Step not found");
        removeStep(step);
        return panelUpdate(`Deleted step ${String(index)}`);
      },
      testMetadata: (patch) => {
        const jiraId = patch.jiraId?.trim();
        const zephyrId = patch.zephyrId?.trim();
        if (jiraId) activeTestCase.jiraId = jiraId;
        else delete activeTestCase.jiraId;
        if (zephyrId) activeTestCase.zephyrId = zephyrId;
        else delete activeTestCase.zephyrId;
        return panelUpdate(`Updated metadata for ${activeTestCase.name}`);
      },
      stop: () => {
        settings.active = false;
        void picker.cancel();
        resolveStop?.();
      },
      onClose: () => {
        settings.active = false;
        void picker.cancel();
        resolveStop?.();
      },
    },
    {
      prettyHtml: prettyFormatHtml,
    },
  );
  await control.setSettings({
    mode: settings.mode,
    negate: settings.negate,
    ask: settings.ask,
  });
  pickerStatus.report = (message) => {
    void control.setStatus(message);
  };
  externalHandlers.syncSettings = () => {
    void control.setSettings({
      mode: settings.mode,
      negate: settings.negate,
      ask: settings.ask,
    });
  };
  await control.setCapability(
    picker.capabilities.freezeScripts && picker.capabilities.inspectMode
      ? "True application freeze is available."
      : "True freeze unavailable; the in-page picker fallback will be used.",
    picker.capabilities.freezeScripts && picker.capabilities.inspectMode,
  );
  await stopped;
  await picker.cancel();
  await pickLoop?.catch(() => undefined);
  await queue;
  for (const frame of page.frames()) {
    await frame
      .evaluate(() => {
        document
          .querySelectorAll(
            "[data-pw-codegen-smart-action],[data-pw-codegen-smart-controls]",
          )
          .forEach((element) => {
            if (element.hasAttribute("data-pw-codegen-smart-controls"))
              element.remove();
            else element.removeAttribute("data-pw-codegen-smart-action");
          });
      })
      .catch(() => undefined);
  }
  await picker.clearMarkers();
  await picker.dispose();
  await control.close();
  return enrichScenario({
    version: "1.0",
    name: options.name ?? "Recorded Playwright scenario",
    capturedAt,
    startUrl,
    endUrl: page.url(),
    steps,
    testCases: testCases.map(
      ({ id, name, jiraId, zephyrId, steps: testSteps }) => ({
        id,
        name,
        ...(jiraId ? { jiraId } : {}),
        ...(zephyrId ? { zephyrId } : {}),
        stepIndexes: testSteps.map(({ index }) => index),
      }),
    ),
    generatedCode: testCases.flatMap(({ name, steps: testSteps }) => [
      `// ${name}`,
      ...testSteps.map(({ code }) => code),
    ]),
    warnings,
  });
}
