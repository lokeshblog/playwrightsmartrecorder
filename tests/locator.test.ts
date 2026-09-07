import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import {
  analyzeContext,
  captureSelection,
  defaultConfig,
  describeTarget,
  extractDomContext,
  generateCandidates,
  isGeneratedValue,
  prettyFormatHtml,
  repairLocator,
  resolvesToActionTarget,
  scoreCandidate,
  smartConfigSchema,
  suggestLocators,
  summarizeTarget,
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

describe("surrounding HTML formatting", () => {
  it("indents nested HTML without interpreting captured markup", () => {
    const formatted = prettyFormatHtml(
      '<form action="#"><div><label for="view">View</label><select id="view"><option>One</option></select></div><script>alert("not executed")</script></form>',
    );
    expect(formatted).toContain(
      '\n  <div>\n    <label for="view">View</label>',
    );
    expect(formatted).toContain('<script>alert("not executed")</script>');
  });

  it("preserves a truncated tag instead of throwing", () => {
    expect(prettyFormatHtml('<main><div data-name="partial')).toContain(
      '<div data-name="partial',
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

  it("keeps a text locator that resolves to the label inside the clicked item", async () => {
    await page.setContent(
      '<ul class="bp3-menu"><li class="Select--menuItem"><p>All Costs</p></li>' +
        '<li class="Select--menuItem" data-mark="yes"><p>GCP</p></li></ul>',
    );
    const context = await extractDomContext(
      page.locator('[data-mark="yes"]'),
      config,
    );
    const result = await analyzeContext(page, context, config, {
      targetSelector: '[data-mark="yes"]',
    });
    const text = result.candidates.find(({ kind }) => kind === "text");
    expect(text?.resolvesToTarget).toBe(true);
    expect(result.recommended?.locator).toContain("GCP");
  });

  it("separates wrappers of the target from other controls inside it", async () => {
    await page.setContent(
      '<ul><li><p>AWS</p></li><li data-mark="yes"><p>GCP</p></li></ul>' +
        '<div data-row="yes">Budget A<button>Delete</button></div>',
    );
    const label = page.getByText("GCP", { exact: true });
    await expect(
      label.evaluateAll(resolvesToActionTarget, '[data-mark="yes"]'),
    ).resolves.toBe(true);
    await expect(
      page
        .locator("ul")
        .evaluateAll(resolvesToActionTarget, '[data-mark="yes"]'),
    ).resolves.toBe(false);
    await expect(
      page
        .getByRole("button", { name: "Delete" })
        .evaluateAll(resolvesToActionTarget, '[data-row="yes"]'),
    ).resolves.toBe(false);
  });

  it("skips text locators built from concatenated container text", async () => {
    const result = await analyze(
      "<section><div><h2>Work more productively</h2><p>Have all the modules you work with in one view</p></div></section>",
      "section > div",
    );
    expect(result.candidates.some(({ kind }) => kind === "text")).toBe(false);
  });

  it("does not name a menu container after the items it contains", async () => {
    const items = [
      "Continuous Delivery & GitOps",
      "Continuous Integration",
      "Feature Flags",
      "Cloud & AI Cost Management",
    ]
      .map((label) => `<div class="card"><p>${label}</p></div>`)
      .join("");
    const result = await analyze(
      `<div role="button" id="module-picker">Unified View${items}</div>`,
      "#module-picker",
    );
    expect(result.target.accessibleName).toBeUndefined();
    expect(result.candidates.some(({ kind }) => kind === "role")).toBe(false);
  });

  it("excludes decorative icon descriptions from a button name", async () => {
    const result = await analyze(
      '<button><span>Continue</span><span icon="chevron-right"><svg><desc>chevron-right</desc></svg></span></button>',
      "button",
    );
    expect(result.target.accessibleName).toBe("Continue");
    expect(result.candidates.map(({ locator }) => locator)).toContain(
      'getByRole("button", { name: "Continue", exact: true })',
    );
  });

  it("uses only the associated label as a native select name", async () => {
    const result = await analyze(
      '<label for="country">Country</label><select id="country"><option>United States</option><option>Canada</option></select>',
      "select",
    );
    expect(result.target.accessibleName).toBe("Country");
    expect(result.target.text).toBeUndefined();
    expect(result.candidates.map(({ locator }) => locator)).toContain(
      'getByLabel("Country", { exact: true })',
    );
    expect(result.candidates.some(({ kind }) => kind === "text")).toBe(false);
  });

  it("does not include wrapping select options in the label", async () => {
    const result = await analyze(
      "<label>Country<select><option>United States</option><option>Canada</option></select></label>",
      "select",
    );
    expect(result.target.accessibleName).toBe("Country");
  });

  it("does not recommend an ambiguous duplicate select label", async () => {
    const result = await analyze(
      '<select aria-label="Type"><option>One</option></select><select aria-label="Type"><option>Two</option></select>',
      "select:first-child",
    );
    expect(
      result.candidates.find(({ kind }) => kind === "label")?.matchCount,
    ).toBe(2);
    expect(result.recommended).toBeNull();
  });

  it("rejects common component-library generated IDs", () => {
    for (const id of [
      "react-select-3-input",
      "mui-12345",
      ":r0:",
      "radix-_r_123",
    ])
      expect(isGeneratedValue(id, config), id).toBe(true);
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

describe("suggestions", () => {
  it("offers ambiguous and rejected locators when nothing resolves", async () => {
    const result = await analyze(
      "<ul><li><span>Rule update</span></li><li><span>Rule update</span></li></ul>",
      "li:first-child span",
    );
    expect(result.recommended).toBeNull();
    const offers = suggestLocators(result, config);
    expect(offers.length).toBeGreaterThan(0);
    const ambiguous = offers.find(
      ({ group }) => group === "Matches several elements",
    );
    expect(ambiguous?.note).toContain("matches 2 elements");
  });

  it("offers the recommended locator first and never repeats one", async () => {
    const result = await analyze(
      '<button data-testid="save" id="save">Save</button>',
      "button",
    );
    const offers = suggestLocators(result, config);
    expect(offers[0]?.group).toBe("Recommended");
    expect(offers[0]?.locator).toBe(result.recommended?.locator);
    expect(new Set(offers.map(({ locator }) => locator)).size).toBe(
      offers.length,
    );
  });

  it("explains why a candidate was rejected", async () => {
    const result = await analyze(
      '<button id="ember123">Save</button>',
      "button",
    );
    const offers = suggestLocators(result, config);
    expect(offers).toContainEqual({
      locator: 'locator("#ember123")',
      group: "Rejected by analysis",
      note: "generated-looking ID",
    });
  });
});

describe("step description", () => {
  it("names an unnamed element after its surroundings", async () => {
    const result = await analyze(
      '<nav><a href="/ce"><svg viewBox="0 0 1 1"></svg><p>Cloud &amp; AI Cost Management</p></a></nav>',
      "svg",
    );
    expect(describeTarget(result)).toBe(
      '<svg> in "Cloud & AI Cost Management"',
    );
  });

  it("summarizes what an unresolved step touched", async () => {
    const result = await analyze(
      '<ul data-testid="alerts"><li><label>Rule update</label><span>Rule update</span></li></ul>',
      "span",
    );
    const facts = summarizeTarget(result);
    expect(facts[0]).toBe("element: <span>");
    expect(facts).toContain('name: "Rule update"');
    expect(facts).toContain('path: <ul data-testid="alerts"> > <li> > <span>');
    expect(facts.some((fact) => fact.includes("(label)"))).toBe(true);
  });

  it("does not label a container with the text of the element inside it", async () => {
    const result = await analyze(
      "<ul><li><span>Rule update</span></li><li><span>Rule update</span></li></ul>",
      "li:first-child span",
    );
    expect(
      summarizeTarget(result).some((fact) => fact.startsWith("inside:")),
    ).toBe(false);
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
