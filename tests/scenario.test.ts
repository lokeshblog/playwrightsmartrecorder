import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import {
  defaultConfig,
  recordScenario,
  scenarioToCsv,
  scenarioContextSchema,
  smartConfigSchema,
} from "../src/index.js";
import type { SmartConfig } from "../src/types.js";

const config: SmartConfig = smartConfigSchema.parse(defaultConfig);
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
});

describe("scenario recording", () => {
  it("records an ordered flow with locator context and generated code", async () => {
    await page.setContent(`
      <main>
        <form data-testid="checkout">
          <label for="name">Name</label>
          <input id="name" />
          <label><input data-testid="terms" type="checkbox" /> Accept terms</label>
          <select aria-label="Country"><option>US</option><option>CA</option></select>
          <button type="button">Submit order</button>
        </form>
      </main>
    `);
    const recording = recordScenario(page, config, { name: "Checkout" });
    await page.waitForSelector("[data-pw-codegen-smart-controls]");

    await page.getByLabel("Name").fill("David");
    await page.getByLabel("Country").selectOption("CA");
    await page.getByTestId("terms").check();
    await page.getByRole("button", { name: "Submit order" }).click();
    await page.keyboard.press("Control+Shift+S");

    const result = await recording;
    expect(result.name).toBe("Checkout");
    expect(result.steps.map(({ action }) => action.type)).toEqual([
      "fill",
      "selectOption",
      "check",
      "click",
    ]);
    expect(
      result.steps.every(({ locatorContext }) => locatorContext !== null),
    ).toBe(true);
    expect(result.steps.every(({ locator }) => locator !== null)).toBe(true);
    expect(result.generatedCode).toEqual(
      expect.arrayContaining([
        expect.stringContaining('.fill("David")'),
        expect.stringContaining('.selectOption("CA")'),
        expect.stringContaining(".check()"),
        expect.stringContaining(".click()"),
      ]),
    );
    expect(scenarioContextSchema.parse(result)).toEqual(result);
  });

  it("redacts sensitive values in the scenario action and code", async () => {
    const isolated = await browser.newPage();
    await isolated.setContent(
      '<label for="password">Password</label><input id="password" type="password"><button type="button">Continue</button>',
    );
    const recording = recordScenario(isolated, config);
    await isolated.waitForSelector("[data-pw-codegen-smart-controls]");
    await isolated.getByLabel("Password").fill("super-secret");
    await isolated.getByRole("button", { name: "Continue" }).click();
    await isolated.keyboard.press("Control+Shift+S");
    const result = await recording;
    expect(JSON.stringify(result)).not.toContain("super-secret");
    expect(result.steps[0]?.action.value).toBe("[REDACTED]");
    await isolated.close();
  });

  it("records assertions and multiple automatically named testcases", async () => {
    const isolated = await browser.newPage();
    await isolated.setContent(
      '<main><button type="button">Continue</button></main>',
    );
    const recording = recordScenario(isolated, config);
    const panel = isolated.locator("[data-pw-codegen-smart-controls]");
    await panel.waitFor();
    const before = await panel.boundingBox();
    if (!before) throw new Error("Recorder panel was not visible");
    await isolated.mouse.move(before.x + 30, before.y + 12);
    await isolated.mouse.down();
    await isolated.mouse.move(before.x - 80, before.y - 60);
    await isolated.mouse.up();
    const after = await panel.boundingBox();
    expect(after?.x).not.toBe(before.x);

    await panel.locator("[data-mode]").selectOption("assert:toBeVisible");
    await isolated.getByRole("button", { name: "Continue" }).click();
    await panel.locator("[data-mode]").selectOption("auto");
    await panel.locator("[data-new]").click();
    await isolated.waitForFunction(
      () =>
        document.querySelector("[data-test-name]")?.textContent === "Test 2",
    );
    await isolated.getByRole("button", { name: "Continue" }).click();
    await panel.locator("[data-delete-line]").click();
    await isolated.waitForFunction(() =>
      document
        .querySelector("[data-status]")
        ?.textContent?.startsWith("Deleted"),
    );
    await isolated.getByRole("button", { name: "Continue" }).click();
    await panel.locator("[data-new]").click();
    await isolated.waitForFunction(
      () =>
        document.querySelector("[data-test-name]")?.textContent === "Test 3",
    );
    await panel.locator("[data-delete-test]").click();
    await isolated.waitForFunction(() =>
      document
        .querySelector("[data-status]")
        ?.textContent?.startsWith("Deleted Test 3"),
    );
    await panel.locator("[data-stop]").click();

    const result = await recording;
    expect(result.testCases.map(({ name }) => name)).toEqual([
      "Test 1",
      "Test 2",
    ]);
    const firstTestSteps = result.steps.filter(
      ({ testCaseId }) => testCaseId === "test-1",
    );
    const secondTestSteps = result.steps.filter(
      ({ testCaseId }) => testCaseId === "test-2",
    );
    expect(firstTestSteps[0]?.action.assertion?.matcher).toBe("toBeVisible");
    expect(firstTestSteps[0]?.code).toContain("expect(page.getByRole");
    expect(secondTestSteps).toHaveLength(1);
    const csv = scenarioToCsv(result);
    expect(csv).toContain('"Business Step"');
    expect(csv).toContain('"Test 2"');
    await isolated.close();
  });

  it("asks for a manual locator with an in-page modal, not a native dialog", async () => {
    const isolated = await browser.newPage();
    await isolated.setContent('<div style="width:100px;height:100px"></div>');
    let nativeDialogs = 0;
    isolated.on("dialog", (dialog) => {
      nativeDialogs += 1;
      void dialog.dismiss();
    });
    const recording = recordScenario(isolated, config);
    await isolated.waitForSelector("[data-pw-codegen-smart-controls]");
    await isolated.locator("[data-ask]").check();
    await isolated
      .locator("body > div")
      .first()
      .click({ position: { x: 5, y: 5 } });

    const modal = isolated.locator("[data-pw-codegen-smart-modal]");
    await modal.waitFor();
    // The modal must stay open until the user answers it.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await expect.poll(() => modal.isVisible()).toBe(true);
    expect(await modal.locator("button").count()).toBeGreaterThan(2);

    await modal
      .locator("input")
      .fill('page.locator("body > div:not([data-pw-codegen-smart-controls])")');
    await modal.locator("[data-modal-confirm]").click();
    await expect.poll(() => modal.count()).toBe(0);
    await isolated.locator("[data-stop]").click();

    const result = await recording;
    expect(nativeDialogs).toBe(0);
    expect(result.steps[0]?.locator).toBe(
      'locator("body > div:not([data-pw-codegen-smart-controls])")',
    );
    expect(result.steps[0]?.suggestions.length).toBeGreaterThan(0);
    await isolated.close();
  });

  it("keeps the modal open and reports why an invalid locator was rejected", async () => {
    const isolated = await browser.newPage();
    await isolated.setContent(
      '<main><div style="width:80px;height:80px"></div><div style="width:80px;height:80px"></div></main>',
    );
    const recording = recordScenario(isolated, config);
    await isolated.waitForSelector("[data-pw-codegen-smart-controls]");
    await isolated.locator("[data-ask]").check();
    await isolated
      .locator("main > div")
      .first()
      .click({ position: { x: 5, y: 5 } });

    const modal = isolated.locator("[data-pw-codegen-smart-modal]");
    await modal.waitFor();
    await modal.locator("input").fill('page.locator("main > div")');
    await modal.locator("[data-modal-confirm]").click();
    await expect
      .poll(() => modal.locator("[data-modal-confirm]").isVisible())
      .toBe(true);
    expect(await modal.textContent()).toContain("matched 2 elements");

    await modal.locator("[data-modal-cancel]").click();
    await expect.poll(() => modal.count()).toBe(0);
    await isolated.locator("[data-stop]").click();

    const result = await recording;
    expect(result.steps[0]?.locator).not.toBe('locator("main > div")');
    await isolated.close();
  });

  it("stays silent on weak locators unless prompting is enabled", async () => {
    const isolated = await browser.newPage();
    await isolated.setContent('<div style="width:80px;height:80px"></div>');
    const recording = recordScenario(isolated, config);
    await isolated.waitForSelector("[data-pw-codegen-smart-controls]");
    await isolated
      .locator("body > div")
      .first()
      .click({ position: { x: 5, y: 5 } });
    await isolated.locator("[data-stop]").click();
    const result = await recording;
    expect(
      await isolated.locator("[data-pw-codegen-smart-modal]").count(),
    ).toBe(0);
    expect(result.steps[0]?.locator).toBeTruthy();
    expect(result.steps[0]?.suggestions.length).toBeGreaterThan(0);
    await isolated.close();
  });

  it("records typing as one fill step and prompts at most once", async () => {
    const isolated = await browser.newPage();
    await isolated.setContent(
      '<main><input aria-label="Search" /><input aria-label="Notes" /></main>',
    );
    const recording = recordScenario(isolated, config);
    await isolated.waitForSelector("[data-pw-codegen-smart-controls]");
    await isolated.locator("[data-ask]").check();

    await isolated.getByLabel("Search").pressSequentially("budget");
    await isolated.getByLabel("Notes").click();
    await isolated.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "Notes",
    );
    const modal = isolated.locator("[data-pw-codegen-smart-modal]");
    if (await modal.count()) await modal.locator("[data-modal-cancel]").click();
    await isolated.locator("[data-stop]").click();

    const result = await recording;
    const fills = result.steps.filter(({ action }) => action.type === "fill");
    expect(fills).toHaveLength(1);
    expect(fills[0]?.action.value).toBe("budget");
    await isolated.close();
  });

  it("keeps the selected click mode active until it is changed", async () => {
    const isolated = await browser.newPage();
    await isolated.setContent(
      '<main><button type="button">Alpha</button><button type="button">Beta</button><button type="button">Gamma</button></main>',
    );
    const recording = recordScenario(isolated, config);
    const panel = isolated.locator("[data-pw-codegen-smart-controls]");
    await panel.waitFor();

    await panel.locator("[data-mode]").selectOption("assert:toBeVisible");
    await expect
      .poll(() => panel.locator("[data-mode-hint]").isVisible())
      .toBe(true);
    await isolated.getByRole("button", { name: "Alpha" }).click();
    await isolated.getByRole("button", { name: "Beta" }).click();
    await isolated.getByRole("button", { name: "Gamma" }).click();

    await isolated.keyboard.press("Escape");
    await expect
      .poll(() => panel.locator("[data-mode]").inputValue())
      .toBe("auto");
    await expect
      .poll(() => panel.locator("[data-mode-hint]").isVisible())
      .toBe(false);
    await isolated.getByRole("button", { name: "Alpha" }).click();
    await panel.locator("[data-stop]").click();

    const result = await recording;
    expect(result.steps.map(({ action }) => action.type)).toEqual([
      "assert",
      "assert",
      "assert",
      "click",
    ]);
    expect(
      result.steps
        .filter(({ action }) => action.type === "assert")
        .map(({ action }) => action.assertion?.matcher),
    ).toEqual(["toBeVisible", "toBeVisible", "toBeVisible"]);
    await isolated.close();
  });

  it("negates assertions and reports the negation in the business step", async () => {
    const isolated = await browser.newPage();
    await isolated.setContent(
      '<main><button type="button">Alpha</button></main>',
    );
    const recording = recordScenario(isolated, config);
    const panel = isolated.locator("[data-pw-codegen-smart-controls]");
    await panel.waitFor();
    await panel.locator("[data-negate]").check();
    await panel.locator("[data-mode]").selectOption("assert:toBeVisible");
    await isolated.getByRole("button", { name: "Alpha" }).click();
    await panel.locator("[data-stop]").click();

    const result = await recording;
    const step = result.steps[0];
    expect(step?.action.assertion?.negated).toBe(true);
    expect(step?.code).toContain(".not.toBeVisible()");
    expect(step?.businessStep).toContain("not.toBeVisible");
    expect(scenarioToCsv(result)).toContain("not.toBeVisible");
    await isolated.close();
  });

  it("keeps the click mode and negate choice across a navigation", async () => {
    const isolated = await browser.newPage();
    await isolated.goto(
      "data:text/html,<main><button type=button>Alpha</button></main>",
    );
    const recording = recordScenario(isolated, config);
    const panel = isolated.locator("[data-pw-codegen-smart-controls]");
    await panel.waitFor();
    await panel.locator("[data-negate]").check();
    await panel.locator("[data-mode]").selectOption("assert:toBeVisible");

    await isolated.goto(
      "data:text/html,<main><button type=button>Beta</button></main>",
    );
    await panel.waitFor();
    await expect
      .poll(() => panel.locator("[data-mode]").inputValue())
      .toBe("assert:toBeVisible");
    await expect
      .poll(() => panel.locator("[data-negate]").isChecked())
      .toBe(true);

    await isolated.getByRole("button", { name: "Beta" }).click();
    await panel.locator("[data-stop]").click();

    const result = await recording;
    const asserted = result.steps.filter(
      ({ action }) => action.type === "assert",
    );
    expect(asserted).toHaveLength(1);
    expect(asserted[0]?.code).toContain(".not.toBeVisible()");
    await isolated.close();
  });

  it("lists recorded steps live and deletes an individual line", async () => {
    const isolated = await browser.newPage();
    await isolated.setContent(
      '<main><button type="button">Alpha</button><button type="button">Beta</button><button type="button">Gamma</button></main>',
    );
    const removed: string[] = [];
    const recording = recordScenario(isolated, config, {
      onStepRemoved: (step) => removed.push(step.businessStep),
    });
    const panel = isolated.locator("[data-pw-codegen-smart-controls]");
    await panel.waitFor();
    for (const name of ["Alpha", "Beta", "Gamma"])
      await isolated.getByRole("button", { name }).click();
    const rows = panel.locator("[data-steps] li:has(button)");
    await expect.poll(() => rows.count()).toBe(3);
    expect(await panel.locator("[data-count]").textContent()).toBe("3");
    await expect
      .poll(async () => (await rows.nth(1).textContent())?.trim())
      .toContain("Beta");

    await rows.nth(1).locator("button").click();
    await expect.poll(() => rows.count()).toBe(2);
    await panel.locator("[data-stop]").click();

    const result = await recording;
    expect(result.steps.map(({ index }) => index)).toEqual([1, 2]);
    expect(result.steps.map(({ businessStep }) => businessStep)).toEqual([
      expect.stringContaining("Alpha"),
      expect.stringContaining("Gamma"),
    ]);
    expect(removed).toEqual([expect.stringContaining("Beta")]);
    await isolated.close();
  });

  it("records navigation as a business and Playwright step", async () => {
    const isolated = await browser.newPage();
    const recording = recordScenario(isolated, config);
    await isolated.goto("data:text/html,<main>Destination</main>");
    await isolated.waitForSelector("[data-pw-codegen-smart-controls]");
    await isolated.keyboard.press("Control+Shift+S");
    const result = await recording;
    expect(result.steps[0]?.action.type).toBe("navigate");
    expect(result.steps[0]?.businessStep).toContain("Navigate to");
    expect(result.steps[0]?.code).toContain("page.goto");
    await isolated.close();
  });
});
