import type { Page } from "playwright";
import type {
  ReplayFailureDecision,
  ReplayReport,
  ReplayStepStatus,
  ScenarioContext,
  ScenarioStep,
} from "../types.js";
import { replayScenario } from "./replay.js";

interface ReviewRow {
  index: number;
  testCaseId: string;
  testCase: string;
  businessStep: string;
  actionType: ScenarioStep["action"]["type"];
  acceptsCustomData: boolean;
  protectedData: boolean;
  locator: string;
  code: string;
  status: ReplayStepStatus;
  attempts: number;
  error?: string;
  suggestions: string[];
  containerHtml?: string;
}

interface ReviewState {
  running: boolean;
  message: string;
  testCases: { id: string; name: string; stepCount: number }[];
  rows: ReviewRow[];
}

export interface ReviewScenarioOptions {
  timeoutMs?: number | undefined;
  onStatus?: (
    status: ReplayStepStatus,
    step: ScenarioStep,
    error?: string,
  ) => void;
}

export async function reviewScenario(
  page: Page,
  scenario: ScenarioContext,
  options: ReviewScenarioOptions = {},
): Promise<{ scenario: ScenarioContext; report: ReplayReport }> {
  const statuses = new Map<
    number,
    { status: ReplayStepStatus; attempts: number; error?: string }
  >();
  let running = false;
  let activeRun: Promise<void> | undefined;
  let pendingDecision:
    | {
        stepIndex: number;
        resolve: (decision: ReplayFailureDecision) => void;
      }
    | undefined;
  let lastReport: ReplayReport | undefined;
  let resolveFinish: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    resolveFinish = resolve;
  });

  const testName = (testCaseId: string): string =>
    scenario.testCases.find(({ id }) => id === testCaseId)?.name ?? testCaseId;
  const state = (message = ""): ReviewState => ({
    running,
    message,
    testCases: scenario.testCases.map((testCase) => ({
      id: testCase.id,
      name: testCase.name,
      stepCount: testCase.stepIndexes.length,
    })),
    rows: scenario.steps.map((step) => {
      const current = statuses.get(step.index);
      return {
        index: step.index,
        testCaseId: step.testCaseId,
        testCase: testName(step.testCaseId),
        businessStep: step.businessStep,
        actionType: step.action.type,
        acceptsCustomData: [
          "fill",
          "selectOption",
          "setInputFiles",
          "press",
        ].includes(step.action.type),
        protectedData: step.action.value === "[REDACTED]",
        locator: step.locator,
        code: step.code,
        status: current?.status ?? "pending",
        attempts: current?.attempts ?? 0,
        ...(current?.error ? { error: current.error } : {}),
        suggestions: step.suggestions,
        ...(step.locatorContext?.containerHtml
          ? { containerHtml: step.locatorContext.containerHtml }
          : {}),
      };
    }),
  });

  await page.exposeBinding("__pwCodegenSmartReviewState", () => state());
  await page.exposeBinding(
    "__pwCodegenSmartReviewRun",
    async (_source, payload: unknown) => {
      const request = payload as {
        startAt?: number;
        testCaseId?: string;
        reset?: boolean;
        restart?: boolean;
      };
      if (running) {
        if (!request.restart) return state("A replay is already running");
        pendingDecision?.resolve({ action: "abort" });
        pendingDecision = undefined;
        await activeRun;
      }
      const selectedTest = request.testCaseId
        ? scenario.testCases.find(({ id }) => id === request.testCaseId)
        : undefined;
      const startAt = request.startAt ?? selectedTest?.stepIndexes[0] ?? 1;
      const selectedIndexes = new Set(selectedTest?.stepIndexes ?? []);
      for (const step of scenario.steps) {
        const selected = selectedTest
          ? selectedIndexes.has(step.index) && step.index >= startAt
          : step.index >= startAt;
        if (selected) statuses.delete(step.index);
      }
      running = true;
      // Defer until the browser binding returns. Starting page.goto from inside
      // the binding callback can deadlock the document that invoked it.
      activeRun = Promise.resolve()
        .then(() =>
          replayScenario(page, scenario, {
            startAt,
            ...(request.testCaseId ? { testCaseId: request.testCaseId } : {}),
            resetBeforeRun: request.reset ?? false,
            ...(options.timeoutMs === undefined
              ? {}
              : { timeoutMs: options.timeoutMs }),
            onStep: (result, step) => {
              statuses.set(step.index, {
                status: result.status,
                attempts: result.attempts,
                ...(result.error ? { error: result.error } : {}),
              });
              options.onStatus?.(result.status, step, result.error);
            },
            onFailure: (result) =>
              new Promise<ReplayFailureDecision>((resolve) => {
                pendingDecision = { stepIndex: result.stepIndex, resolve };
              }),
          }),
        )
        .then((result) => {
          lastReport = result.report;
        })
        .finally(() => {
          running = false;
          pendingDecision = undefined;
        });
      return state(
        selectedTest
          ? `Running ${selectedTest.name} from step ${String(startAt)}`
          : `Running all testcases from step ${String(startAt)}`,
      );
    },
  );
  await page.exposeBinding(
    "__pwCodegenSmartReviewDecision",
    (_source, payload: unknown) => {
      const decision = payload as ReplayFailureDecision & { stepIndex: number };
      if (pendingDecision?.stepIndex !== decision.stepIndex)
        return state("That step is not waiting for a decision");
      const resolve = pendingDecision.resolve;
      pendingDecision = undefined;
      if (decision.action === "retry")
        resolve({
          action: "retry",
          ...(decision.locator ? { locator: decision.locator } : {}),
          ...(decision.value === undefined ? {} : { value: decision.value }),
        });
      else resolve({ action: decision.action });
      return state(
        decision.action === "retry"
          ? `Retrying step ${String(decision.stepIndex)}`
          : `${decision.action} step ${String(decision.stepIndex)}`,
      );
    },
  );
  await page.exposeBinding("__pwCodegenSmartReviewFinish", async () => {
    pendingDecision?.resolve({ action: "abort" });
    pendingDecision = undefined;
    await activeRun;
    resolveFinish?.();
    return state("Review finished");
  });

  function installReviewPanel(): void {
    if (window.top !== window) return;
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", installReviewPanel, {
        once: true,
      });
      return;
    }
    const existing = document.querySelector("[data-pw-codegen-smart-review]");
    if (existing) return;
    const invoke = <T>(name: string, payload?: unknown): Promise<T> =>
      (window as unknown as Record<string, (value?: unknown) => Promise<T>>)[
        name
      ]?.(payload) ?? Promise.reject(new Error(`${name} unavailable`));

    const panel = document.createElement("div");
    panel.setAttribute("data-pw-codegen-smart-review", "");
    panel.setAttribute("data-pw-codegen-smart-controls", "");
    panel.style.cssText =
      "position:fixed;right:16px;bottom:16px;width:390px;max-height:88vh;z-index:2147483647;background:#fff;color:#111827;border:1px solid #ddd6fe;border-radius:12px;box-shadow:0 16px 40px rgba(0,0,0,.32);font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;display:flex;flex-direction:column;overflow:hidden";
    panel.innerHTML = `
      <div data-drag style="display:flex;align-items:center;gap:8px;cursor:move;padding:11px 12px;background:#f5f3ff;border-bottom:1px solid #ddd6fe">
        <span style="width:9px;height:9px;border-radius:50%;background:#7c3aed"></span>
        <strong style="flex:1">Replay & repair</strong>
        <span data-summary style="font-size:11px;color:#6b7280">Ready</span>
      </div>
      <div style="padding:9px 10px 3px">
        <label style="display:block;margin-bottom:4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#6b7280">Testcase to replay</label>
        <select data-testcase style="width:100%;box-sizing:border-box;padding:7px 8px;border:1px solid #d1d5db;border-radius:6px;background:#fff;font:inherit"></select>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:9px 10px;border-bottom:1px solid #f3f4f6">
        <button data-run-test>▶ Run testcase</button>
        <button data-restart>↻ Restart testcase</button>
        <button data-run>Run all testcases</button>
        <button data-run-failed>↻ Resume failed</button>
        <button data-copy>Copy Cursor request</button>
        <button data-finish data-primary>Finish & save</button>
      </div>
      <div data-message style="padding:6px 10px;font-size:11px;color:#6b7280;background:#f9fafb">Run the captured flow in this authenticated browser session.</div>
      <ol data-rows style="list-style:none;margin:0;padding:0;overflow:auto"></ol>`;
    for (const button of panel.querySelectorAll("button")) {
      const primary = button.hasAttribute("data-primary");
      (button as HTMLElement).style.cssText =
        `border:1px solid ${primary ? "#7c3aed" : "#d1d5db"};background:${primary ? "#7c3aed" : "#fff"};color:${primary ? "#fff" : "#374151"};border-radius:6px;padding:7px 9px;cursor:pointer;font:inherit;font-size:12px;font-weight:600`;
    }
    const rows = panel.querySelector<HTMLElement>("[data-rows]")!;
    const testcase = panel.querySelector<HTMLSelectElement>("[data-testcase]")!;
    const summary = panel.querySelector<HTMLElement>("[data-summary]")!;
    const message = panel.querySelector<HTMLElement>("[data-message]")!;
    let latest: ReviewState | undefined;
    let signature = "";
    const render = (next: ReviewState): void => {
      latest = next;
      const selected = testcase.value;
      if (testcase.options.length !== next.testCases.length) {
        testcase.textContent = "";
        for (const test of next.testCases) {
          const option = document.createElement("option");
          option.value = test.id;
          option.textContent = `${test.name} (${String(test.stepCount)} steps)`;
          testcase.append(option);
        }
        if (selected && next.testCases.some(({ id }) => id === selected))
          testcase.value = selected;
      }
      if (next.message) message.textContent = next.message;
      const passed = next.rows.filter(
        ({ status }) => status === "passed",
      ).length;
      const failed = next.rows.filter(
        ({ status }) => status === "failed",
      ).length;
      summary.textContent = next.running
        ? `${String(passed)} passed · running`
        : `${String(passed)} passed${failed ? ` · ${String(failed)} failed` : ""}`;
      const nextSignature = JSON.stringify(next.rows);
      if (nextSignature === signature) return;
      signature = nextSignature;
      rows.textContent = "";
      for (const row of next.rows) {
        const item = document.createElement("li");
        item.setAttribute("data-review-step", String(row.index));
        item.setAttribute("data-status", row.status);
        item.style.cssText = "padding:8px 10px;border-top:1px solid #f3f4f6";
        const line = document.createElement("div");
        line.style.cssText = "display:flex;align-items:flex-start;gap:7px";
        const icon = document.createElement("span");
        const colors: Record<ReplayStepStatus, string> = {
          pending: "#9ca3af",
          running: "#2563eb",
          passed: "#16a34a",
          failed: "#dc2626",
          skipped: "#d97706",
        };
        icon.style.cssText = `flex:none;margin-top:4px;width:8px;height:8px;border-radius:50%;background:${colors[row.status]}`;
        const label = document.createElement("span");
        label.style.cssText = "flex:1;font-size:12px;word-break:break-word";
        label.textContent = `${String(row.index)}. ${row.businessStep}`;
        const from = document.createElement("button");
        from.textContent = "▶";
        from.title = "Run from this step";
        from.style.cssText =
          "border:0;background:transparent;color:#7c3aed;cursor:pointer;padding:0 3px";
        from.disabled = next.running;
        from.addEventListener("click", () => {
          void invoke<ReviewState>("__pwCodegenSmartReviewRun", {
            startAt: row.index,
            testCaseId: row.testCaseId,
            restart: true,
          }).then(render);
        });
        line.append(icon, label, from);
        item.append(line);
        if (row.error) {
          const error = document.createElement("div");
          error.style.cssText =
            "margin:7px 0 6px 15px;padding:7px 8px;border-radius:6px;background:#fef2f2;color:#b91c1c;font-size:11px;max-height:80px;overflow:auto;white-space:pre-wrap";
          error.textContent = row.error;
          const locatorLabel = document.createElement("label");
          locatorLabel.style.cssText =
            "display:block;margin:6px 0 3px 15px;font-size:10px;font-weight:700;text-transform:uppercase;color:#6b7280";
          locatorLabel.textContent = "Custom locator";
          const input = document.createElement("input");
          input.value = row.locator;
          input.setAttribute("data-repair-locator", "");
          input.style.cssText =
            "width:calc(100% - 15px);box-sizing:border-box;margin-left:15px;padding:7px 8px;border:1px solid #d1d5db;border-radius:6px;font:11px ui-monospace,SFMono-Regular,Menlo,monospace";
          let customData: HTMLInputElement | undefined;
          const customDataElements: HTMLElement[] = [];
          if (row.acceptsCustomData) {
            const dataLabel = document.createElement("label");
            dataLabel.style.cssText =
              "display:block;margin:7px 0 3px 15px;font-size:10px;font-weight:700;text-transform:uppercase;color:#6b7280";
            dataLabel.textContent =
              row.actionType === "setInputFiles"
                ? "Custom file path(s), comma separated"
                : "Custom action data (runtime only)";
            customData = document.createElement("input");
            customData.type = row.protectedData ? "password" : "text";
            customData.autocomplete = "off";
            customData.placeholder = row.protectedData
              ? "Enter protected value for this replay"
              : "Optional replacement value";
            customData.setAttribute("data-repair-value", "");
            customData.style.cssText =
              "width:calc(100% - 15px);box-sizing:border-box;margin-left:15px;padding:7px 8px;border:1px solid #d1d5db;border-radius:6px;font:11px ui-monospace,SFMono-Regular,Menlo,monospace";
            customDataElements.push(dataLabel, customData);
          }
          const actions = document.createElement("div");
          actions.style.cssText = "display:flex;gap:5px;margin:6px 0 0 15px";
          for (const [text, action] of [
            ["Retry", "retry"],
            ["Skip", "skip"],
            ["Abort", "abort"],
          ] as const) {
            const button = document.createElement("button");
            button.textContent = text;
            button.style.cssText =
              "border:1px solid #d1d5db;background:#fff;border-radius:5px;padding:4px 8px;cursor:pointer;font:11px system-ui";
            button.addEventListener("click", () => {
              void invoke<ReviewState>("__pwCodegenSmartReviewDecision", {
                stepIndex: row.index,
                action,
                ...(action === "retry" ? { locator: input.value } : {}),
                ...(action === "retry" && customData?.value
                  ? { value: customData.value }
                  : {}),
              }).then(render);
            });
            actions.append(button);
          }
          if (row.suggestions.length) {
            const suggestionLabel = document.createElement("label");
            suggestionLabel.style.cssText =
              "display:block;margin:7px 0 3px 15px;font-size:10px;font-weight:700;text-transform:uppercase;color:#6b7280";
            suggestionLabel.textContent = "Recorded locator suggestions";
            const select = document.createElement("select");
            select.style.cssText =
              "width:calc(100% - 15px);margin:6px 0 0 15px;padding:5px;border:1px solid #e5e7eb;border-radius:5px;font-size:11px";
            for (const suggestion of row.suggestions) {
              const option = document.createElement("option");
              option.value = suggestion;
              option.textContent = suggestion;
              select.append(option);
            }
            select.addEventListener("change", () => {
              input.value = select.value;
            });
            item.append(
              error,
              locatorLabel,
              input,
              suggestionLabel,
              select,
              ...customDataElements,
              actions,
            );
          } else
            item.append(
              error,
              locatorLabel,
              input,
              ...customDataElements,
              actions,
            );
        }
        rows.append(item);
      }
    };
    const refresh = (): void => {
      void invoke<ReviewState>("__pwCodegenSmartReviewState").then(render);
    };
    panel.querySelector("[data-run]")?.addEventListener("click", () => {
      void invoke<ReviewState>("__pwCodegenSmartReviewRun", {
        startAt: 1,
        reset: true,
        restart: true,
      }).then(render);
    });
    panel.querySelector("[data-run-test]")?.addEventListener("click", () => {
      void invoke<ReviewState>("__pwCodegenSmartReviewRun", {
        testCaseId: testcase.value,
        reset: true,
        restart: true,
      }).then(render);
    });
    panel.querySelector("[data-restart]")?.addEventListener("click", () => {
      void invoke<ReviewState>("__pwCodegenSmartReviewRun", {
        testCaseId: testcase.value,
        reset: true,
        restart: true,
      }).then(render);
    });
    panel.querySelector("[data-run-failed]")?.addEventListener("click", () => {
      const failed = latest?.rows.find(
        ({ status, testCaseId }) =>
          status === "failed" && testCaseId === testcase.value,
      );
      void invoke<ReviewState>("__pwCodegenSmartReviewRun", {
        startAt: failed?.index,
        testCaseId: testcase.value,
        restart: true,
      }).then(render);
    });
    panel.querySelector("[data-copy]")?.addEventListener("click", () => {
      const request =
        "Use the codegen-to-project skill to convert .codegen/scenario-context.json into repository-standard Playwright tests. Inspect .codegen/replay-report.json and do not treat failed or skipped steps as verified.";
      const copy = async (): Promise<void> => {
        try {
          await navigator.clipboard.writeText(request);
          message.textContent =
            "Cursor request copied. Finish & save before pasting it into Cursor.";
        } catch {
          message.textContent =
            "Clipboard access was blocked. Finish & save, then use cursor-prompt.txt from the recording folder.";
        }
      };
      void copy();
    });
    panel.querySelector("[data-finish]")?.addEventListener("click", () => {
      void invoke<ReviewState>("__pwCodegenSmartReviewFinish").then(render);
    });
    let drag: { x: number; y: number; left: number; top: number } | undefined;
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
      drag = undefined;
    });
    document.body.append(panel);
    refresh();
    window.setInterval(refresh, 500);
  }

  await page.addInitScript(installReviewPanel);
  await page.evaluate(installReviewPanel);
  await finished;
  await page
    .evaluate(() => {
      document.querySelector("[data-pw-codegen-smart-review]")?.remove();
    })
    .catch(() => undefined);

  return {
    scenario,
    report: lastReport ?? {
      version: "1.0",
      scenarioName: scenario.name,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "aborted",
      startUrl: scenario.startUrl,
      results: [],
      repairedStepIndexes: [],
      skippedStepIndexes: [],
    },
  };
}
