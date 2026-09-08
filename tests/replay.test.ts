import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import {
  DEFAULT_REPLAY_TIMEOUT_MS,
  defaultConfig,
  recordScenario,
  replayReportSchema,
  replayScenario,
  reviewScenario,
  smartConfigSchema,
} from "../src/index.js";
import type { ScenarioContext, ScenarioStep } from "../src/types.js";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
});

async function recorderControl(application: Page): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(async () => {
      for (const candidate of application.context().pages()) {
        if (
          candidate !== application &&
          !candidate.isClosed() &&
          (await candidate
            .locator("[data-pw-codegen-smart-controls]")
            .count()
            .catch(() => 0))
        ) {
          found = candidate;
          return true;
        }
      }
      return false;
    })
    .toBe(true);
  return found!;
}

function step(
  index: number,
  partial: Pick<ScenarioStep, "action" | "locator" | "businessStep"> &
    Partial<Pick<ScenarioStep, "pageUrl">>,
): ScenarioStep {
  return {
    index,
    timestamp: new Date().toISOString(),
    pageUrl: "about:blank",
    locatorContext: null,
    code: "",
    confidence: "high",
    suggestions: [],
    testCaseId: "test-1",
    ...partial,
  };
}

function scenario(steps: ScenarioStep[]): ScenarioContext {
  return {
    version: "1.0",
    name: "Replay test",
    capturedAt: new Date().toISOString(),
    startUrl: "about:blank",
    endUrl: "about:blank",
    steps,
    testCases: [
      {
        id: "test-1",
        name: "Test 1",
        stepIndexes: steps.map(({ index }) => index),
      },
    ],
    generatedCode: [],
    warnings: [],
  };
}

describe("scenario replay", () => {
  it("waits up to 30 seconds for each action by default", () => {
    expect(DEFAULT_REPLAY_TIMEOUT_MS).toBe(30_000);
  });

  it("executes actions and assertions in order", async () => {
    const page = await browser.newPage();
    await page.setContent(
      '<label>Name <input /></label><button type="button">Save</button><output>Waiting</output>',
    );
    await page.getByRole("button", { name: "Save" }).evaluate((button) => {
      button.addEventListener("click", () => {
        document.querySelector("output")!.textContent = "Saved";
      });
    });
    const input = 'getByLabel("Name", { exact: true })';
    const save = 'getByRole("button", { name: "Save", exact: true })';
    const output = 'getByText("Saved", { exact: true })';
    const result = await replayScenario(
      page,
      scenario([
        step(1, {
          action: { type: "fill", value: "Ada" },
          locator: input,
          businessStep: "Enter Ada in Name",
        }),
        step(2, {
          action: { type: "click" },
          locator: save,
          businessStep: "Click Save",
        }),
        step(3, {
          action: {
            type: "assert",
            assertion: { matcher: "toBeVisible" },
          },
          locator: output,
          businessStep: "Verify Saved toBeVisible",
        }),
      ]),
      { timeoutMs: 1_000 },
    );

    expect(await page.getByLabel("Name").inputValue()).toBe("Ada");
    expect(result.report.status).toBe("passed");
    expect(result.report.results.map(({ status }) => status)).toEqual([
      "passed",
      "passed",
      "passed",
    ]);
    expect(replayReportSchema.parse(result.report)).toEqual(result.report);
    await page.close();
  });

  it("replays a native select by its visible label", async () => {
    const page = await browser.newPage();
    await page.setContent(
      '<label for="country">Country</label><select id="country"><option value="us-id">United States</option><option value="ca-id">Canada</option></select>',
    );
    const result = await replayScenario(
      page,
      scenario([
        step(1, {
          action: {
            type: "selectOption",
            value: "Canada",
            selectBy: "label",
          },
          locator: 'getByLabel("Country", { exact: true })',
          businessStep: "Select Canada from Country",
        }),
      ]),
      { timeoutMs: 1_000 },
    );
    expect(result.report.status).toBe("passed");
    expect(await page.getByLabel("Country").inputValue()).toBe("ca-id");
    await page.close();
  });

  it("hovers a control that refuses the pointer only when forced", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <span id="wrap" style="display:inline-block;padding:14px">
        <button type="button" disabled style="pointer-events:none">New Perspective</button>
      </span>
      <output>quiet</output>
    `);
    await page.locator("#wrap").evaluate((wrap) => {
      wrap.addEventListener("mouseenter", () => {
        document.querySelector("output")!.textContent =
          "You are not authorized to create Perspectives";
      });
    });
    const button =
      'getByRole("button", { name: "New Perspective", exact: true })';
    const hover = (force: boolean): ScenarioStep =>
      step(1, {
        action: { type: "hover", ...(force ? { force: true } : {}) },
        locator: button,
        businessStep: "Hover over New Perspective",
      });

    const plain = await replayScenario(page, scenario([hover(false)]), {
      timeoutMs: 1_000,
    });
    expect(plain.report.status).toBe("failed");

    const forced = await replayScenario(
      page,
      scenario([
        hover(true),
        step(2, {
          action: {
            type: "assert",
            assertion: {
              matcher: "toContainText",
              expected: "not authorized",
            },
          },
          locator: 'locator("output")',
          businessStep: "Verify output toContainText",
        }),
      ]),
      { timeoutMs: 2_000 },
    );
    expect(forced.report.results.map(({ status }) => status)).toEqual([
      "passed",
      "passed",
    ]);
    await page.close();
  });

  it("repairs a failed locator and retries the same step", async () => {
    const page = await browser.newPage();
    await page.setContent('<button type="button">Save</button>');
    const recorded = scenario([
      step(1, {
        action: { type: "click" },
        locator: 'getByRole("button", { name: "Missing", exact: true })',
        businessStep: "Click Save",
      }),
    ]);
    const result = await replayScenario(page, recorded, {
      timeoutMs: 200,
      onFailure: () =>
        Promise.resolve({
          action: "retry",
          locator: 'getByRole("button", { name: "Save", exact: true })',
        }),
    });

    expect(result.report.status).toBe("passed");
    expect(result.report.results[0]?.attempts).toBe(2);
    expect(result.report.repairedStepIndexes).toEqual([1]);
    expect(result.scenario.steps[0]?.locator).toContain('"Save"');
    expect(result.scenario.steps[0]?.code).toContain("getByRole");
    await page.close();
  });

  it("replays only the selected testcase", async () => {
    const page = await browser.newPage();
    await page.setContent(
      '<button type="button">First</button><button type="button">Second</button>',
    );
    const first = step(1, {
      action: { type: "click" },
      locator: 'getByRole("button", { name: "First", exact: true })',
      businessStep: "Click First",
    });
    const second = {
      ...step(2, {
        action: { type: "click" },
        locator: 'getByRole("button", { name: "Second", exact: true })',
        businessStep: "Click Second",
      }),
      testCaseId: "test-2",
    };
    const clicks: string[] = [];
    for (const name of ["First", "Second"])
      await page.getByRole("button", { name }).evaluate((button, value) => {
        button.addEventListener("click", () => {
          (window as unknown as { replayClicks: string[] }).replayClicks.push(
            value,
          );
        });
      }, name);
    await page.evaluate(() => {
      (window as unknown as { replayClicks: string[] }).replayClicks = [];
    });
    const recorded = scenario([first, second]);
    recorded.testCases = [
      { id: "test-1", name: "First test", stepIndexes: [1] },
      { id: "test-2", name: "Second test", stepIndexes: [2] },
    ];

    const result = await replayScenario(page, recorded, {
      testCaseId: "test-2",
      timeoutMs: 1_000,
    });
    clicks.push(
      ...(await page.evaluate(
        () => (window as unknown as { replayClicks: string[] }).replayClicks,
      )),
    );

    expect(clicks).toEqual(["Second"]);
    expect(result.report.results.map(({ stepIndex }) => stepIndex)).toEqual([
      2,
    ]);
    await page.close();
  });

  it("uses custom runtime data without persisting a protected value", async () => {
    const page = await browser.newPage();
    await page.setContent('<label>Password <input type="password" /></label>');
    const recorded = scenario([
      step(1, {
        action: { type: "fill", value: "[REDACTED]" },
        locator: 'getByLabel("Password", { exact: true })',
        businessStep: "Enter a protected value in Password",
      }),
    ]);

    const result = await replayScenario(page, recorded, {
      timeoutMs: 200,
      onFailure: () =>
        Promise.resolve({ action: "retry", value: "runtime-secret" }),
    });

    expect(await page.getByLabel("Password").inputValue()).toBe(
      "runtime-secret",
    );
    expect(result.scenario.steps[0]?.action.value).toBe("[REDACTED]");
    expect(JSON.stringify(result.report)).not.toContain("runtime-secret");
    await page.close();
  });

  it("replays locators in the iframe where they were recorded", async () => {
    const page = await browser.newPage();
    await page.setContent(
      '<iframe srcdoc="<button type=button>Pay</button><output>Waiting</output>"></iframe>',
    );
    const frame = page
      .frames()
      .find((candidate) => candidate.url() === "about:srcdoc");
    if (!frame) throw new Error("Expected srcdoc frame");
    await frame.getByRole("button", { name: "Pay" }).evaluate((button) => {
      button.addEventListener("click", () => {
        document.querySelector("output")!.textContent = "Paid";
      });
    });

    const result = await replayScenario(
      page,
      scenario([
        step(1, {
          pageUrl: "about:srcdoc",
          action: { type: "click" },
          locator: 'getByRole("button", { name: "Pay", exact: true })',
          businessStep: "Click Pay",
        }),
      ]),
      { timeoutMs: 1_000 },
    );

    expect(result.report.status).toBe("passed");
    expect(await frame.getByText("Paid").textContent()).toBe("Paid");
    await page.close();
  });

  it("keeps the review panel open for repair and saves the decision", async () => {
    const page = await browser.newPage();
    await page.setContent('<button type="button">Save</button>');
    const reviewing = reviewScenario(
      page,
      scenario([
        step(1, {
          action: { type: "click" },
          locator: 'getByRole("button", { name: "Missing", exact: true })',
          businessStep: "Click Save",
        }),
      ]),
      { timeoutMs: 200 },
    );
    const panel = page.locator("[data-pw-codegen-smart-review]");
    await panel.waitFor();
    await panel.locator("[data-run]").click();
    const failed = panel.locator('[data-review-step="1"]');
    await failed.locator("[data-repair-locator]").waitFor();
    await failed
      .locator("[data-repair-locator]")
      .fill('getByRole("button", { name: "Save", exact: true })');
    await failed.getByRole("button", { name: "Retry" }).click();
    await expect
      .poll(() => panel.locator("[data-summary]").textContent())
      .toContain("1 passed");
    await panel.locator("[data-finish]").click();

    const result = await reviewing;
    expect(result.report.status).toBe("passed");
    expect(result.report.repairedStepIndexes).toEqual([1]);
    expect(result.scenario.steps[0]?.locator).toContain('"Save"');
    await page.close();
  });

  it("lets the user select and run one testcase from the review panel", async () => {
    const page = await browser.newPage();
    await page.setContent(
      '<button type="button">First</button><button type="button">Second</button>',
    );
    const first = step(1, {
      action: { type: "click" },
      locator: 'getByRole("button", { name: "First", exact: true })',
      businessStep: "Click First",
    });
    const second = {
      ...step(2, {
        action: { type: "click" },
        locator: 'getByRole("button", { name: "Second", exact: true })',
        businessStep: "Click Second",
      }),
      testCaseId: "test-2",
    };
    const recorded = scenario([first, second]);
    recorded.testCases = [
      { id: "test-1", name: "First test", stepIndexes: [1] },
      { id: "test-2", name: "Second test", stepIndexes: [2] },
    ];
    const reviewing = reviewScenario(page, recorded, { timeoutMs: 1_000 });
    const panel = page.locator("[data-pw-codegen-smart-review]");
    await panel.waitFor();

    await expect
      .poll(() => panel.locator("[data-testcase] option").count())
      .toBe(2);
    await panel.locator("[data-testcase]").selectOption("test-2");
    await panel.locator("[data-run-test]").click();
    await expect
      .poll(() =>
        panel.locator('[data-review-step="2"]').getAttribute("data-status"),
      )
      .toBe("passed");
    await panel.locator("[data-finish]").click();

    const result = await reviewing;
    expect(result.report.results.map(({ stepIndex }) => stepIndex)).toEqual([
      2,
    ]);
    await page.close();
  });

  it("restarts a failed testcase from its first step", async () => {
    const page = await browser.newPage();
    await page.setContent("<main></main>");
    const reviewing = reviewScenario(
      page,
      scenario([
        step(1, {
          action: { type: "click" },
          locator: 'getByRole("button", { name: "Ready", exact: true })',
          businessStep: "Click Ready",
        }),
      ]),
      { timeoutMs: 200 },
    );
    const panel = page.locator("[data-pw-codegen-smart-review]");
    await panel.waitFor();
    await panel.locator("[data-run-test]").click();
    await panel.locator("[data-repair-locator]").waitFor();

    await page.locator("main").evaluate((main) => {
      const button = document.createElement("button");
      button.textContent = "Ready";
      main.append(button);
    });
    await panel.locator("[data-restart]").click();
    await expect
      .poll(() =>
        panel.locator('[data-review-step="1"]').getAttribute("data-status"),
      )
      .toBe("passed");
    await panel.locator("[data-finish]").click();

    const result = await reviewing;
    expect(result.report.status).toBe("passed");
    expect(result.report.results[0]?.stepIndex).toBe(1);
    await page.close();
  });

  it("accepts custom runtime data from the repair panel", async () => {
    const page = await browser.newPage();
    await page.setContent('<label>Token <input type="password" /></label>');
    const reviewing = reviewScenario(
      page,
      scenario([
        step(1, {
          action: { type: "fill", value: "[REDACTED]" },
          locator: 'getByLabel("Token", { exact: true })',
          businessStep: "Enter a protected value in Token",
        }),
      ]),
      { timeoutMs: 200 },
    );
    const panel = page.locator("[data-pw-codegen-smart-review]");
    await panel.waitFor();
    await panel.locator("[data-run-test]").click();
    const value = panel.locator("[data-repair-value]");
    await value.waitFor();
    expect(await value.getAttribute("type")).toBe("password");
    await value.fill("runtime-token");
    await panel.getByRole("button", { name: "Retry" }).click();
    await expect
      .poll(() =>
        panel.locator('[data-review-step="1"]').getAttribute("data-status"),
      )
      .toBe("passed");
    expect(await page.getByLabel("Token").inputValue()).toBe("runtime-token");
    await panel.locator("[data-finish]").click();

    const result = await reviewing;
    expect(result.scenario.steps[0]?.action.value).toBe("[REDACTED]");
    expect(JSON.stringify(result.report)).not.toContain("runtime-token");
    await page.close();
  });

  it("records and replays in the same authenticated browser session", async () => {
    const page = await browser.newPage();
    await page.goto(
      "data:text/html,<main><button type=button>Checkout</button></main>",
    );
    const recorded = recordScenario(
      page,
      smartConfigSchema.parse(defaultConfig),
      { name: "Checkout" },
    );
    const recorder = (await recorderControl(page)).locator(
      "[data-pw-codegen-smart-controls]",
    );
    await page.getByRole("button", { name: "Checkout" }).click();
    await recorder.locator("[data-stop]").click();
    const captured = await recorded;

    const statuses: string[] = [];
    const reviewing = reviewScenario(page, captured, {
      timeoutMs: 1_000,
      onStatus: (status, step, error) =>
        statuses.push(`${String(step.index)}:${status}:${error ?? ""}`),
    });
    let review = page.locator("[data-pw-codegen-smart-review]");
    await review.waitFor();
    await review.locator("[data-run]").click();
    // The navigation step replaces the document; the review panel must return.
    review = page.locator("[data-pw-codegen-smart-review]");
    await expect
      .poll(() => review.locator("[data-summary]").textContent())
      .toContain("2 passed");
    expect(statuses).toContain("2:passed:");
    expect(
      await page
        .locator(
          "[data-pw-codegen-smart-controls]:not([data-pw-codegen-smart-review])",
        )
        .count(),
    ).toBe(0);
    await review.locator("[data-finish]").click();

    const result = await reviewing;
    expect(result.report.status).toBe("passed");
    expect(result.report.results).toHaveLength(2);
    await page.close();
  });
});
