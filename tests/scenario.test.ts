import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import {
  defaultConfig,
  recordScenario,
  scenarioToCsv,
  scenarioToIntent,
  scenarioContextSchema,
  scenarioIntentSchema,
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

async function waitForPicker(
  panel: Locator,
  previous?: string,
): Promise<string> {
  let status = "";
  await expect
    .poll(async () => {
      status = (await panel.locator("[data-status]").textContent()) ?? "";
      return (
        status.startsWith("Picker ready") &&
        (previous === undefined || status !== previous)
      );
    })
    .toBe(true);
  return status;
}

describe("scenario recording", () => {
  it("records an ordered flow with locator context and generated code", async () => {
    await page.setContent(`
      <main>
        <form data-testid="checkout">
          <label for="name">Name</label>
          <input id="name" />
          <label><input data-testid="terms" type="checkbox" /> Accept terms</label>
          <select aria-label="Country"><option value="us-id">United States</option><option value="ca-id">Canada</option></select>
          <button type="button">Submit order</button>
        </form>
      </main>
    `);
    const recording = recordScenario(page, config, { name: "Checkout" });
    await recorderControl(page);

    await page.getByLabel("Name").fill("David");
    await page.getByLabel("Country").selectOption("ca-id");
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
        expect.stringContaining('.selectOption({ label: "Canada" })'),
        expect.stringContaining(".check()"),
        expect.stringContaining(".click()"),
      ]),
    );
    expect(scenarioContextSchema.parse(result)).toEqual(result);
  });

  it("sizes the control window to the panel", async () => {
    const isolated = await browser.newPage();
    await isolated.setContent('<button type="button">Continue</button>');
    const recording = recordScenario(isolated, config);
    const control = await recorderControl(isolated);
    const panel = control.locator("[data-pw-codegen-smart-control-panel]");
    const size = async () =>
      panel.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return { width: box.width, height: Math.ceil(box.height) };
      });
    // The window ends up as the panel plus its 14px margin on every side.
    await expect
      .poll(async () => {
        const panelSize = await size();
        return (
          control.viewportSize()?.width === panelSize.width + 28 &&
          control.viewportSize()?.height === panelSize.height + 28
        );
      })
      .toBe(true);
    expect((await size()).width).toBe(420);
    expect((await size()).height).toBeLessThan(760);
    await isolated.keyboard.press("Control+Shift+S");
    await recording;
    await isolated.close();
  });

  it("records testcase IDs and emits a compact conversion intent", async () => {
    const isolated = await browser.newPage();
    await isolated.setContent(`
      <main>
        <h1>Budgets</h1>
        <button data-testid="new-budget">New Budget</button>
      </main>
    `);
    const recording = recordScenario(isolated, config, { name: "Checkout" });
    const control = await recorderControl(isolated);
    await control.locator("[data-jira]").fill("QPE-1234");
    await control.locator("[data-jira]").blur();
    await control.locator("[data-zephyr]").fill("ZEP-42");
    await control.locator("[data-zephyr]").blur();
    await isolated.getByTestId("new-budget").click();
    await control.locator("[data-stop]").click();

    const result = await recording;
    expect(result.testCases[0]).toMatchObject({
      jiraId: "QPE-1234",
      zephyrId: "ZEP-42",
    });
    const step = result.steps.find(({ action }) => action.type === "click")!;
    expect(step.intent).toBe("Click New Budget");
    expect(step.urlAfter).toBe("about:blank");
    expect(step.productHints?.pageHeading).toBe("Budgets");
    expect(step.locatorHint).toEqual({
      testId: "new-budget",
      role: "button",
      name: "New Budget",
    });
    const intent = scenarioToIntent(result);
    expect(scenarioIntentSchema.parse(intent)).toEqual(intent);
    expect(intent.name).toBe("Checkout");
    expect(intent.productHints.pageHeadings).toContain("Budgets");
    expect(intent.testCases[0]).toMatchObject({
      jiraId: "QPE-1234",
      zephyrId: "ZEP-42",
    });
    expect(JSON.stringify(intent)).not.toContain("containerHtml");
    await isolated.close();
  });

  it("records the menu item that was clicked, not the control owning the menu", async () => {
    const isolated = await browser.newPage();
    const modules = [
      "Continuous Delivery &amp; GitOps",
      "Continuous Integration",
      "Feature Management &amp; Experimentation",
      "Infrastructure as Code Management",
      "Cloud &amp; AI Cost Management",
    ]
      .map((label) => `<div class="card"><p>${label}</p></div>`)
      .join("");
    await isolated.setContent(
      `<div role="button" id="picker">Unified View<div class="menu">${modules}</div></div>`,
    );
    const recording = recordScenario(isolated, config);
    await recorderControl(isolated);
    await isolated.getByText("Cloud & AI Cost Management").click();
    await isolated.keyboard.press("Control+Shift+S");
    const result = await recording;
    const step = result.steps[0];
    expect(step?.businessStep).toBe("Click Cloud & AI Cost Management");
    expect(step?.locatorContext.target.tag).toBe("div");
    expect(JSON.stringify(step?.locatorContext.candidates)).not.toContain(
      "Unified View",
    );
    await isolated.close();
  });

  it("redacts sensitive values in the scenario action and code", async () => {
    const isolated = await browser.newPage();
    await isolated.setContent(
      '<label for="password">Password</label><input id="password" type="password"><button type="button">Continue</button>',
    );
    const recording = recordScenario(isolated, config);
    await recorderControl(isolated);
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
    let recordedSteps = 0;
    const recording = recordScenario(isolated, config, {
      onStep: () => {
        recordedSteps += 1;
      },
    });
    const control = await recorderControl(isolated);
    const panel = control.locator("[data-pw-codegen-smart-controls]");

    await panel.locator("[data-mode]").selectOption("assert:toBeVisible");
    await waitForPicker(panel);
    await isolated.getByRole("button", { name: "Continue" }).click();
    await expect
      .poll(() => panel.locator("[data-count]").textContent())
      .toBe("1");
    await panel.locator("[data-mode]").selectOption("auto");
    await expect
      .poll(() => panel.locator("[data-cancel-pick]").isDisabled())
      .toBe(true);
    await panel.locator("[data-new]").click();
    await expect
      .poll(() => panel.locator("[data-test-name]").textContent())
      .toBe("Test 2");
    await isolated.getByRole("button", { name: "Continue" }).click();
    await expect.poll(() => recordedSteps).toBe(2);
    await panel.locator("[data-delete-line]").click();
    await expect
      .poll(async () =>
        (await panel.locator("[data-status]").textContent())?.startsWith(
          "Deleted",
        ),
      )
      .toBe(true);
    await isolated.getByRole("button", { name: "Continue" }).click();
    await expect
      .poll(() => panel.locator("[data-count]").textContent())
      .toBe("2");
    await panel.locator("[data-new]").click();
    await expect
      .poll(() => panel.locator("[data-test-name]").textContent())
      .toBe("Test 3");
    await panel.locator("[data-delete-test]").click();
    await expect
      .poll(async () =>
        (await panel.locator("[data-status]").textContent())?.startsWith(
          "Deleted Test 3",
        ),
      )
      .toBe(true);
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

  it("freezes application timers while an explicit element pick is active", async () => {
    const isolated = await browser.newPage();
    await isolated.setContent(
      '<main><div role="status">Saved</div></main><script>setTimeout(() => document.querySelector("[role=status]")?.remove(), 500)</script>',
    );
    const recording = recordScenario(isolated, config);
    const control = await recorderControl(isolated);
    await control.locator("[data-mode]").selectOption("assert:toBeVisible");
    await waitForPicker(control.locator("[data-pw-codegen-smart-controls]"));

    await new Promise((resolve) => setTimeout(resolve, 700));
    await expect
      .poll(() => isolated.getByRole("status").isVisible())
      .toBe(true);
    await isolated.getByRole("status").click();
    await expect
      .poll(() => control.locator("[data-count]").textContent())
      .toBe("1");

    await control.locator("[data-mode]").selectOption("auto");
    await control.locator("[data-stop]").click();
    const result = await recording;
    expect(result.steps[0]?.action.assertion?.matcher).toBe("toBeVisible");
    await isolated.close();
  });

  it("keeps an open dropdown available for frozen locator picking", async () => {
    const isolated = await browser.newPage();
    await isolated.setContent(`
      <button type="button" aria-label="Choose view">Choose view</button>
      <div role="listbox" hidden><div role="option">Cost overview</div></div>
      <script>
        document.querySelector("button").addEventListener("click", () => {
          document.querySelector("[role=listbox]").hidden = false;
        });
      </script>
    `);
    const recording = recordScenario(isolated, config);
    const control = await recorderControl(isolated);
    const panel = control.locator("[data-pw-codegen-smart-controls]");
    await isolated.getByRole("button", { name: "Choose view" }).click();
    await expect
      .poll(() => panel.locator("[data-count]").textContent())
      .toBe("1");
    await panel.locator("[data-mode]").selectOption("assert:toBeVisible");
    await waitForPicker(panel);
    await isolated.getByRole("option", { name: "Cost overview" }).click();
    await expect
      .poll(() => panel.locator("[data-count]").textContent())
      .toBe("2");
    await panel.locator("[data-mode]").selectOption("auto");
    await expect
      .poll(() => panel.locator("[data-cancel-pick]").isDisabled())
      .toBe(true);
    await panel.locator("[data-stop]").click();
    const result = await recording;
    expect(result.steps[1]?.locator).toContain('getByRole("option"');
    await isolated.close();
  });

  it("picks a frozen element inside an iframe", async () => {
    const isolated = await browser.newPage();
    await isolated.setContent(
      '<iframe srcdoc="<button type=button>Frame action</button>"></iframe>',
    );
    const recording = recordScenario(isolated, config);
    const control = await recorderControl(isolated);
    const panel = control.locator("[data-pw-codegen-smart-controls]");
    await panel.locator("[data-mode]").selectOption("assert:toBeVisible");
    await waitForPicker(panel);
    await isolated
      .frameLocator("iframe")
      .getByRole("button", { name: "Frame action" })
      .click();
    await expect
      .poll(() => panel.locator("[data-count]").textContent())
      .toBe("1");
    await panel.locator("[data-mode]").selectOption("auto");
    await expect
      .poll(() => panel.locator("[data-cancel-pick]").isDisabled())
      .toBe(true);
    await panel.locator("[data-stop]").click();
    const result = await recording;
    expect(result.steps[0]?.pageUrl).toContain("about:srcdoc");
    await isolated.close();
  });

  const tooltipPage = `
    <span id="target" style="display:inline-block;padding:14px">
      <button type="button" disabled style="pointer-events:none">New Perspective</button>
    </span>
    <script>
      const target = document.querySelector("#target");
      const clear = () => {
        for (const tip of document.querySelectorAll(".tip")) tip.remove();
      };
      target.addEventListener("mouseenter", () => {
        clear();
        const tip = document.createElement("div");
        tip.className = "tip";
        tip.textContent = "You are not authorized to create Perspectives";
        document.body.append(tip);
      });
      target.addEventListener("mouseleave", clear);
    </script>
  `;

  it("freezes the application from the keyboard so a tooltip stays open", async () => {
    const isolated = await browser.newPage();
    await isolated.setContent(tooltipPage);
    const recording = recordScenario(isolated, config);
    const control = await recorderControl(isolated);
    await isolated.locator("#target").hover();
    await expect.poll(() => isolated.locator(".tip").count()).toBe(1);

    await isolated.keyboard.press("Control+Shift+F");
    await expect
      .poll(() => control.locator("[data-hold]").isVisible())
      .toBe(true);
    // The pointer leaving the control is what normally takes the tooltip away.
    await isolated.mouse.move(5, 400);
    expect(await isolated.locator(".tip").count()).toBe(1);

    // Held UI can be picked against by choosing a mode, as on a platform
    // where the browser keeps Ctrl+Shift+A for itself.
    const panel = control.locator("[data-pw-codegen-smart-controls]");
    await panel.locator("[data-mode]").selectOption("assert:toContainText");
    await waitForPicker(panel);
    await isolated.locator(".tip").click();
    const modal = control.locator("[data-pw-codegen-smart-modal]");
    await modal.waitFor();
    await modal.locator("[data-modal-confirm]").click();
    await expect
      .poll(() => panel.locator("[data-count]").textContent())
      .toBe("1");
    await panel.locator("[data-mode]").selectOption("auto");

    await control.locator("[data-release-hold]").click();
    await expect
      .poll(() => control.locator("[data-hold]").isVisible())
      .toBe(false);
    // Resumed: the application handles the pointer again.
    await isolated.locator("#target").hover();
    await isolated.mouse.move(5, 400);
    await expect.poll(() => isolated.locator(".tip").count()).toBe(0);

    await control.locator("[data-stop]").click();
    const result = await recording;
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.action.assertion?.expected).toContain(
      "not authorized",
    );
    await isolated.close();
  });

  it("records the hover and asserts the frozen tooltip from one shortcut", async () => {
    const isolated = await browser.newPage();
    await isolated.setContent(tooltipPage);
    const recording = recordScenario(isolated, config);
    const control = await recorderControl(isolated);
    await isolated.locator("#target").hover();
    await expect.poll(() => isolated.locator(".tip").count()).toBe(1);

    await isolated.keyboard.press("Control+Shift+A");
    await expect
      .poll(() => control.locator("[data-count]").textContent())
      .toBe("1");
    await waitForPicker(control.locator("[data-pw-codegen-smart-controls]"));
    await isolated.locator(".tip").click();

    const modal = control.locator("[data-pw-codegen-smart-modal]");
    await modal.waitFor();
    expect(await modal.locator("input").inputValue()).toContain(
      "not authorized",
    );
    await modal.locator("[data-modal-confirm]").click();
    await expect
      .poll(() => control.locator("[data-count]").textContent())
      .toBe("2");
    // The assertion ends the hold, so the application is usable again.
    await expect
      .poll(() => control.locator("[data-hold]").isVisible())
      .toBe(false);

    await control.locator("[data-stop]").click();
    const result = await recording;
    const [hover, assertion] = result.steps;
    // The pointer sits on the wrapper that owns the tooltip, not the button
    // inside it that refuses pointer events.
    expect(hover?.action.type).toBe("hover");
    expect(hover?.code).toContain(".hover(");
    expect(assertion?.action.assertion?.matcher).toBe("toContainText");
    expect(assertion?.action.assertion?.expected).toContain("not authorized");
    await isolated.close();
  });

  it("asks for a manual locator in the external controller, not a native dialog", async () => {
    const isolated = await browser.newPage();
    await isolated.setContent(
      '<section><div style="width:100px;height:100px"></div></section>',
    );
    let nativeDialogs = 0;
    isolated.on("dialog", (dialog) => {
      nativeDialogs += 1;
      void dialog.dismiss();
    });
    const recording = recordScenario(isolated, {
      ...config,
      minimumLocatorScore: 110,
    });
    const control = await recorderControl(isolated);
    await control.locator("[data-ask]").check();
    await isolated
      .locator("section > div")
      .first()
      .click({ position: { x: 5, y: 5 } });

    const modal = control.locator("[data-pw-codegen-smart-modal]");
    await modal.waitFor();
    // The modal must stay open until the user answers it.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await expect.poll(() => modal.isVisible()).toBe(true);
    expect(await modal.locator("button").count()).toBeGreaterThan(2);
    expect(await modal.locator("pre").textContent()).toContain("\n  <div");
    expect(
      await modal.locator("button", { hasText: "Copy raw HTML" }).count(),
    ).toBe(1);

    await modal.locator("input").fill('page.locator("section > div")');
    await modal.locator("[data-modal-confirm]").click();
    await expect.poll(() => modal.count()).toBe(0);
    await control.locator("[data-stop]").click();

    const result = await recording;
    expect(nativeDialogs).toBe(0);
    expect(result.steps[0]?.locator).toBe('locator("section > div")');
    expect(result.steps[0]?.suggestions.length).toBeGreaterThan(0);
    await isolated.close();
  });

  it("offers grouped locator options and element context for a weak locator", async () => {
    const isolated = await browser.newPage();
    await isolated.setContent(
      "<ul><li><span>Rule update</span></li><li><span>Rule update</span></li></ul>",
    );
    const recording = recordScenario(isolated, config);
    const control = await recorderControl(isolated);
    await control.locator("[data-ask]").check();
    await isolated.getByText("Rule update").first().click();

    const modal = control.locator("[data-pw-codegen-smart-modal]");
    await modal.waitFor();
    const options = modal.locator("[data-prompt-suggestions] option");
    await expect.poll(() => options.count()).toBeGreaterThan(0);
    const groups = await modal
      .locator("[data-prompt-suggestions] optgroup")
      .evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLOptGroupElement).label),
      );
    expect(groups).toContain("Matches several elements");
    const facts = await modal
      .locator("[data-prompt-context] li")
      .allTextContents();
    expect(facts[0]).toBe("element: <span>");

    // Choosing an option is what fills the locator field.
    const chosen = await options.first().getAttribute("value");
    await modal.locator("[data-prompt-suggestions]").selectOption(chosen);
    expect(await modal.locator("input").inputValue()).toBe(chosen);
    expect(await modal.locator("[data-prompt-note]").textContent()).toContain(
      "Matches several elements:",
    );

    await modal.locator("[data-modal-cancel]").click();
    await control.locator("[data-stop]").click();
    const result = await recording;
    const step = result.steps[0];
    expect(step?.suggestions.length).toBeGreaterThan(0);
    expect(step?.targetSummary).toContain("element: <span>");
    expect(step?.businessStep).toBe("Click Rule update");
    expect(scenarioToCsv(result)).toContain("Element Context");
    await isolated.close();
  });

  it("resolves a menu item click through the label it wraps", async () => {
    const isolated = await browser.newPage();
    await isolated.setContent(
      '<ul><li style="padding:20px"><p>AWS</p></li>' +
        '<li style="padding:20px"><p>GCP</p></li></ul>',
    );
    const recording = recordScenario(isolated, config);
    const control = await recorderControl(isolated);
    await control.locator("[data-ask]").check();
    await isolated
      .locator("li", { hasText: "GCP" })
      .click({ position: { x: 2, y: 2 } });

    await expect.poll(() => control.locator("[data-step]").count()).toBe(1);
    expect(await control.locator("[data-pw-codegen-smart-modal]").count()).toBe(
      0,
    );
    await control.locator("[data-stop]").click();

    const result = await recording;
    expect(result.steps[0]?.locator).toContain("GCP");
    expect(result.steps[0]?.confidence).not.toBe("low");
    await isolated.close();
  });

  it("keeps the modal open and reports why an invalid locator was rejected", async () => {
    const isolated = await browser.newPage();
    await isolated.setContent(
      '<main><div style="width:80px;height:80px"></div><div style="width:80px;height:80px"></div></main>',
    );
    const recording = recordScenario(isolated, config);
    const control = await recorderControl(isolated);
    await control.locator("[data-ask]").check();
    await isolated
      .locator("main > div")
      .first()
      .click({ position: { x: 5, y: 5 } });

    const modal = control.locator("[data-pw-codegen-smart-modal]");
    await modal.waitFor();
    await modal.locator("input").fill('page.locator("main > div")');
    await modal.locator("[data-modal-confirm]").click();
    await expect
      .poll(() => modal.locator("[data-modal-confirm]").isVisible())
      .toBe(true);
    expect(await modal.textContent()).toContain("matched 2 elements");

    await modal.locator("[data-modal-cancel]").click();
    await expect.poll(() => modal.count()).toBe(0);
    await control.locator("[data-stop]").click();

    const result = await recording;
    expect(result.steps[0]?.locator).not.toBe('locator("main > div")');
    await isolated.close();
  });

  it("stays silent on weak locators unless prompting is enabled", async () => {
    const isolated = await browser.newPage();
    await isolated.setContent('<div style="width:80px;height:80px"></div>');
    const recording = recordScenario(isolated, config);
    const control = await recorderControl(isolated);
    await isolated
      .locator("body > div")
      .first()
      .click({ position: { x: 5, y: 5 } });
    expect(await control.locator("[data-pw-codegen-smart-modal]").count()).toBe(
      0,
    );
    await control.locator("[data-stop]").click();
    const result = await recording;
    expect(result.steps[0]?.locator).toBeTruthy();
    expect(result.steps[0]?.suggestions.length).toBeGreaterThan(0);
    // Position-dependent locators are offered, but never ahead of the rest.
    expect(result.steps[0]?.suggestions[0]).not.toContain(".nth(");
    expect(result.steps[0]?.suggestions).not.toContain(
      'locator(".pw-codegen-generated")',
    );
    await isolated.close();
  });

  it("records typing as one fill step and prompts at most once", async () => {
    const isolated = await browser.newPage();
    await isolated.setContent(
      '<main><input aria-label="Search" /><input aria-label="Notes" /></main>',
    );
    const recording = recordScenario(isolated, config);
    const control = await recorderControl(isolated);
    await control.locator("[data-ask]").check();

    await isolated.getByLabel("Search").pressSequentially("budget");
    await isolated.getByLabel("Notes").click();
    await isolated.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "Notes",
    );
    const modal = control.locator("[data-pw-codegen-smart-modal]");
    if (await modal.count()) await modal.locator("[data-modal-cancel]").click();
    await control.locator("[data-stop]").click();

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
    const panel = (await recorderControl(isolated)).locator(
      "[data-pw-codegen-smart-controls]",
    );

    await panel.locator("[data-mode]").selectOption("assert:toBeVisible");
    let pickerStatus = await waitForPicker(panel);
    await expect
      .poll(() => panel.locator("[data-mode-hint]").isVisible())
      .toBe(true);
    for (const [index, name] of ["Alpha", "Beta", "Gamma"].entries()) {
      await isolated.getByRole("button", { name }).click();
      await expect
        .poll(() => panel.locator("[data-count]").textContent())
        .toBe(String(index + 1));
      if (index < 2) pickerStatus = await waitForPicker(panel, pickerStatus);
    }

    await panel.locator("[data-mode]").selectOption("auto");
    await expect
      .poll(() => panel.locator("[data-mode]").inputValue())
      .toBe("auto");
    await expect
      .poll(() => panel.locator("[data-cancel-pick]").isDisabled())
      .toBe(true);
    await expect
      .poll(() => panel.locator("[data-mode-hint]").isVisible())
      .toBe(false);
    await isolated.getByRole("button", { name: "Alpha" }).click();
    await expect
      .poll(() => panel.locator("[data-count]").textContent())
      .toBe("4");
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
    const panel = (await recorderControl(isolated)).locator(
      "[data-pw-codegen-smart-controls]",
    );
    await panel.locator("[data-negate]").check();
    await panel.locator("[data-mode]").selectOption("assert:toBeVisible");
    await waitForPicker(panel);
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
    const panel = (await recorderControl(isolated)).locator(
      "[data-pw-codegen-smart-controls]",
    );
    await panel.locator("[data-negate]").check();
    await panel.locator("[data-mode]").selectOption("assert:toBeVisible");
    await waitForPicker(panel);

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
    const panel = (await recorderControl(isolated)).locator(
      "[data-pw-codegen-smart-controls]",
    );
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
    await recorderControl(isolated);
    await isolated.keyboard.press("Control+Shift+S");
    const result = await recording;
    expect(result.steps[0]?.action.type).toBe("navigate");
    expect(result.steps[0]?.businessStep).toContain("Navigate to");
    expect(result.steps[0]?.code).toContain("page.goto");
    await isolated.close();
  });
});
