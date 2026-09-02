import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import {
  analyzeContext,
  captureSelection,
  defaultConfig,
  extractDomContext,
  generateCandidates,
  isGeneratedValue,
  repairLocator,
  scoreCandidate,
  smartConfigSchema,
} from "../src/index.js";
import type { RawDomContext, SmartConfig } from "../src/types.js";

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

async function analyze(html: string, selector: string) {
  await page.setContent(html);
  const raw = await extractDomContext(page.locator(selector), config);
  return analyzeContext(page, raw, config);
}

function raw(
  target: RawDomContext["target"],
  ancestors: RawDomContext["ancestors"] = [],
): RawDomContext {
  return {
    url: "https://example.test",
    target,
    ancestors,
    siblings: [],
    nearby: [],
  };
}

describe("candidate generation", () => {
  it.each([
    [
      "test ID",
      {
        tag: "button",
        text: "Save",
        attributes: { "data-testid": "save" },
        role: "button",
        accessibleName: "Save",
      },
      'getByTestId("save")',
    ],
    [
      "stable ID",
      {
        tag: "button",
        text: "Save",
        attributes: { id: "save-profile" },
        role: "button",
        accessibleName: "Save",
      },
      'locator("#save-profile")',
    ],
    [
      "placeholder",
      {
        tag: "input",
        attributes: { placeholder: "Email" },
        role: "textbox",
        accessibleName: "Email",
      },
      'getByPlaceholder("Email", { exact: true })',
    ],
    [
      "label",
      {
        tag: "input",
        attributes: {},
        role: "textbox",
        accessibleName: "Email address",
      },
      'getByLabel("Email address", { exact: true })',
    ],
  ])("creates a %s candidate", (_name, target, expression) => {
    const result = generateCandidates(raw(target), config);
    expect(result.candidates.map(({ locator }) => locator)).toContain(
      expression,
    );
  });

  it("rejects dynamic IDs and recognizes common generated values", () => {
    expect(isGeneratedValue("css-1abc23", config)).toBe(true);
    expect(
      isGeneratedValue("550e8400-e29b-41d4-a716-446655440000", config),
    ).toBe(true);
    const result = generateCandidates(
      raw({ tag: "button", attributes: { id: "ember123" }, text: "Go" }),
      config,
    );
    expect(result.rejected).toContainEqual({
      locator: 'locator("#ember123")',
      reason: "generated-looking ID",
    });
  });

  it("generates a stable scoped semantic locator", () => {
    const result = generateCandidates(
      raw(
        {
          tag: "button",
          attributes: {},
          role: "button",
          accessibleName: "Edit",
          text: "Edit",
        },
        [
          {
            depth: 1,
            boundary: true,
            tag: "article",
            attributes: { "data-testid": "user-david" },
          },
        ],
      ),
      config,
    );
    expect(result.candidates.map(({ locator }) => locator)).toContain(
      'getByTestId("user-david").getByRole("button", { name: "Edit", exact: true })',
    );
  });
});

describe("scoring", () => {
  it.each([
    ["testId", 110],
    ["applicationAttribute", 105],
    ["role", 100],
    ["label", 98],
    ["id", 95],
    ["placeholder", 85],
    ["text", 75],
    ["css", 65],
    ["xpath", 45],
    ["positional", 25],
  ] as const)(
    "applies the %s baseline and uniqueness bonus",
    (kind, expected) => {
      expect(
        scoreCandidate({ locator: "x", kind, evidence: [] }, 1, config).score,
      ).toBe(expected);
    },
  );

  it("penalizes zero and duplicate matches", () => {
    expect(
      scoreCandidate(
        { locator: 'getByRole("button")', kind: "role", evidence: [] },
        0,
        config,
      ).score,
    ).toBe(30);
    expect(
      scoreCandidate(
        { locator: 'getByRole("button")', kind: "role", evidence: [] },
        4,
        config,
      ).score,
    ).toBe(63);
  });

  it("strongly penalizes positional dependency", () => {
    const scored = scoreCandidate(
      { locator: 'locator("button").nth(4)', kind: "positional", evidence: [] },
      1,
      config,
    );
    expect(scored.score).toBe(0);
    expect(scored.confidence).toBe("low");
  });
});

describe("live uniqueness and DOM context", () => {
  it("recommends a unique semantic button", async () => {
    const result = await analyze("<button>Submit</button>", "button");
    expect(result.recommended?.locator).toContain('getByRole("button"');
    expect(result.recommended?.matchCount).toBe(1);
  });

  it("does not recommend an unscoped duplicate role locator", async () => {
    const result = await analyze(
      "<button>Edit</button><button>Edit</button>",
      "button:first-child",
    );
    const role = result.candidates.find(({ kind }) => kind === "role");
    expect(role?.matchCount).toBe(2);
    expect(result.recommended).toBeNull();
  });

  it("uses a stable repeated-list container to create a unique locator", async () => {
    const result = await analyze(
      '<article data-testid="david"><h2>David</h2><button>Edit</button></article>' +
        '<article data-testid="sam"><h2>Sam</h2><button>Edit</button></article>',
      '[data-testid="david"] button',
    );
    expect(result.recommended?.kind).toBe("scoped");
    expect(result.recommended?.matchCount).toBe(1);
  });

  it.each([
    [
      "form",
      '<form data-testid="checkout"><label for="email">Email</label><input id="email"><button>Pay</button></form>',
      "#email",
    ],
    [
      "modal",
      '<div role="dialog" aria-label="Confirm"><h2>Delete?</h2><button>Delete</button></div>',
      "button",
    ],
    [
      "table",
      "<table><tr><th>Name</th><th>Action</th></tr><tr><td>David</td><td><button>Edit</button></td></tr></table>",
      "button",
    ],
    [
      "nested component",
      '<main><section data-component="profile"><div><button>Save</button></div></section></main>',
      "button",
    ],
  ])("extracts bounded context for a %s", async (_name, html, selector) => {
    const result = await analyze(html, selector);
    expect(result.target.tag).toBeTruthy();
    expect(result.ancestors.length).toBeGreaterThan(0);
    expect(result.ancestors.length).toBeLessThanOrEqual(
      config.maxAncestorDepth,
    );
    expect(result.ancestors.some(({ boundary }) => boundary)).toBe(true);
  });

  it("captures siblings and nearby semantic elements", async () => {
    const result = await analyze(
      '<form><h2>Checkout</h2><label for="code">Code</label><input id="code"><button>Apply</button></form>',
      "#code",
    );
    expect(result.siblings.length).toBeGreaterThan(0);
    expect(
      result.nearby.some(({ relationship }) => relationship === "heading"),
    ).toBe(true);
    expect(
      result.nearby.some(({ relationship }) => relationship === "control"),
    ).toBe(true);
  });

  it("obeys a custom ancestor depth limit", async () => {
    const shallow = { ...config, maxAncestorDepth: 1 };
    await page.setContent(
      "<main><section><div><span><button>Go</button></span></div></section></main>",
    );
    const result = await extractDomContext(page.locator("button"), shallow);
    expect(result.ancestors).toHaveLength(1);
  });

  it("captures a target inside open shadow DOM", async () => {
    await page.setContent('<div id="host"></div>');
    await page.locator("#host").evaluate((host) => {
      host.attachShadow({ mode: "open" }).innerHTML =
        '<button data-testid="shadow-save">Save</button>';
    });
    const result = await extractDomContext(
      page.getByTestId("shadow-save"),
      config,
    );
    expect(result.target.attributes["data-testid"]).toBe("shadow-save");
  });

  it("never recommends a candidate that resolves to a different element", async () => {
    await page.setContent(
      '<button id="first" data-mark="yes">Save</button><button id="second">Save</button>',
    );
    const raw = await extractDomContext(page.locator("#second"), config);
    const result = await analyzeContext(page, raw, config, {
      targetSelector: "#first",
    });
    for (const candidate of result.candidates) {
      if (candidate.penalties.includes("resolves to a different element"))
        expect(result.recommended?.locator).not.toBe(candidate.locator);
    }
    expect(result.recommended?.locator).not.toBe('locator("#second")');
  });

  it("skips text locators built from concatenated container text", async () => {
    const result = await analyze(
      "<section><div><h2>Work more productively</h2><p>Have all the modules you work with in one view</p></div></section>",
      "section > div",
    );
    expect(result.candidates.some(({ kind }) => kind === "text")).toBe(false);
  });

  it("does not expose password values", async () => {
    const result = await analyze(
      '<form><input id="password" type="password" value="hunter2"></form>',
      "input",
    );
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(result.containerHtml).toContain("<form>");
    expect(result.containerHtml).not.toContain('value="hunter2"');
  });

  it("captures a user-selected element through the picker", async () => {
    await page.setContent(
      '<main><button data-testid="picked">Pick me</button></main>',
    );
    const capture = captureSelection(page, config);
    await page.waitForFunction(() =>
      Boolean(
        (window as unknown as Record<string, unknown>).__pwCodegenSmartPicker,
      ),
    );
    await page.getByTestId("picked").click();
    const result = await capture;
    expect(result.target.attributes["data-testid"]).toBe("picked");
    expect(result.recommended?.matchCount).toBe(1);
  });
});

describe("repair", () => {
  it("reports a still-working locator", async () => {
    await page.setContent("<button>Submit</button>");
    const result = await repairLocator(
      page,
      "page.getByText('Submit')",
      config,
    );
    expect(result.status).toBe("working");
  });

  it("recovers after text changes with a hint", async () => {
    await page.setContent(
      '<form data-testid="checkout"><button>Submit order</button></form>',
    );
    const result = await repairLocator(
      page,
      'page.getByText("Submit", { exact: true })',
      config,
      {
        hint: "Submit order",
      },
    );
    expect(result.status).toBe("failed");
    expect(result.replacement?.matchCount).toBe(1);
  });

  it("recovers after DOM nesting changes", async () => {
    await page.setContent(
      '<section data-testid="checkout"><div><span><button>Pay now</button></span></div></section>',
    );
    const result = await repairLocator(
      page,
      "page.locator('.actions > button')",
      config,
      { hint: "Pay now" },
    );
    expect(result.status).toBe("failed");
    expect(result.replacement?.matchCount).toBe(1);
  });

  it("recovers after an attribute changes", async () => {
    await page.setContent('<button data-testid="new-submit">Submit</button>');
    const result = await repairLocator(
      page,
      "page.locator('[data-testid=\"old-submit\"]')",
      config,
      { hint: "Submit" },
    );
    expect(result.replacement?.locator).toBe('getByTestId("new-submit")');
  });

  it("repairs ambiguity introduced by an additional duplicate", async () => {
    await page.setContent(
      '<section data-testid="primary"><button>Edit</button></section><section><button>Edit</button></section>',
    );
    const result = await repairLocator(page, 'page.getByText("Edit")', config);
    expect(result.status).toBe("ambiguous");
    expect(result.replacement?.kind).toBe("scoped");
  });

  it("returns no invented replacement when the target cannot be identified", async () => {
    await page.setContent("<button>Continue</button>");
    const result = await repairLocator(
      page,
      'page.getByText("Submit")',
      config,
    );
    expect(result.replacement).toBeNull();
  });
});
