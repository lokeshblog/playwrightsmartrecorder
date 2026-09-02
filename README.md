# playwright-codegen-smart

Deterministic scenario recording, DOM context capture, locator generation, live uniqueness validation, scoring, and repair for Playwright. The CLI produces an ordered, framework-neutral automation flow; a repository skill can adapt that evidence to each team's conventions.

New to the project? [`docs/ONBOARDING.md`](docs/ONBOARDING.md) covers the architecture and the full setup, run, rerun, and test runbook.

## Installation

```bash
npm install -D playwright-codegen-smart
npx playwright-codegen-smart init
```

Node 20+ and Playwright 1.45+ are required. Install a browser if the repository has not already done so:

```bash
npx playwright install chromium
```

## Quick start

```bash
npx playwright-codegen-smart init
npx playwright-codegen-smart capture https://app.example.com/checkout --name "Checkout"
```

Navigate and authenticate in the opened browser, perform the complete scenario, then click **Stop recording** or press `Ctrl+Shift+S`.

Each capture writes to its own timestamped folder, so no recording ever overwrites an earlier one:

```
.codegen/
  recordings/
    2026-09-02T05-15-46-budget-flow/
      scenario-context.json
      scenario-context.csv
    2026-09-02T05-15-47-budget-flow/
      scenario-context.json
      scenario-context.csv
  scenario-context.json   # copy of the most recent run
  scenario-context.csv
```

The folder name combines the capture time with a slug of `--name`, and gains a numeric suffix if two captures land in the same second. The copies at `.codegen/scenario-context.*` always point at the latest run, which is what the Cursor skill and `analyze`/`validate` defaults read. Pass `--output` to write somewhere specific and skip the per-run folder.

`init` creates `.codegen/config.json`, scenario/locator context files, and `.cursor/skills/codegen-to-project/SKILL.md`. Existing files are reported and never overwritten.

## Codegen workflow

Use Playwright Codegen to explore a flow, then use `capture` to record the production scenario. Capture uses a maintained browser recorder instead of depending on Playwright's undocumented Codegen internals. Every step includes the action and sanitized value, a Codegen-compatible statement, target/ancestor/sibling context, candidates, live counts, scores, and rejection reasons.

For an already-open Chromium session:

```bash
chromium --remote-debugging-port=9222
npx playwright-codegen-smart capture --cdp http://localhost:9222
```

## Record, replay, repair, and convert

Use `session` when the captured flow must be exercised before it is handed to
Cursor:

```bash
npx playwright-codegen-smart session https://app.example.com/checkout \
  --name "Checkout"
```

Record normally and click **Stop recording**. The browser stays open in the
same context, preserving its cookies and authenticated state, and replaces the
recorder with a **Replay & repair** panel.

- Choose a testcase from **Testcase to replay**, then use **Run testcase** to
  execute only that recorded testcase. **Run all testcases** remains available
  when a complete suite replay is intentional.
- **Restart testcase** aborts a paused failed run, resets to the scenario start
  URL, clears that testcase's prior statuses, and runs it again from its first
  step.
- The `▶` button on a row runs from that step using the current browser state.
- A failed row shows the error, a suggestions dropdown, and an independent
  **Custom locator** input. Actions that consume data also show **Custom action
  data**, allowing protected input values or file paths to be supplied for that
  replay. **Retry**, **Skip**, and **Abort** control the paused step.
- **Resume failed** starts at the first failed step of the selected testcase.
- **Copy Cursor request** copies a conversion request targeting the stable latest
  scenario and replay report.
- **Finish & save** writes the corrected scenario, CSV, `replay-report.json`,
  and `cursor-prompt.txt` to a new recording folder.

Replay an earlier recording without recording it again:

```bash
npx playwright-codegen-smart replay \
  .codegen/recordings/<run>/scenario-context.json

# Connect to an already authenticated browser
npx playwright-codegen-smart replay <scenario.json> \
  --cdp http://localhost:9222

# CI-style one-pass replay without the panel
npx playwright-codegen-smart replay <scenario.json> --headless

# Replay one testcase non-interactively
npx playwright-codegen-smart replay <scenario.json> --headless \
  --testcase test-2
```

The CLI prints the exact Cursor request after saving. Paste it into Cursor, or
ask Cursor to use the `codegen-to-project` skill with the generated
`scenario-context.json`. The skill converts only after inspecting the target
repository's fixtures, page objects, authentication, and existing test style.

Every navigation, locator action, and assertion waits up to 30 seconds by
default. Override this with `--timeout <milliseconds>`.

Protected values remain `[REDACTED]` in all saved files. Enter them through
**Custom action data** when replay pauses; runtime values are held only for that
retry and are never written to the scenario or replay report. File uploads
similarly accept runtime file paths. Screenshot assertions require a repository
snapshot baseline and are reported as unsupported during framework-neutral
replay.

## Capture workflow

```bash
# Record a complete scenario (default)
npx playwright-codegen-smart capture https://app.example.com

# Custom output
npx playwright-codegen-smart capture https://app.example.com --output ./scenario-context.json

# Retain the original one-element inspection mode
npx playwright-codegen-smart capture https://app.example.com --single
```

The movable recorder panel provides:

- Automatic navigation, click, fill, select, file upload, check/uncheck, and Enter-key recording
- Explicit force click, double click, hover, check, uncheck, and arbitrary key-press modes, each staying active until you change it
- Playwright locator assertions: attached, visible/hidden, enabled/disabled, editable, empty, focused, checked, viewport, accessible name/description/error, text, value(s), attribute, class, CSS, ID, JS property, role, screenshot, and count, including `.not`
- **+ New testcase**, **Undo last line**, **Delete testcase**, and **Stop recording**
- A live step list grouped by testcase, showing each step's business description and a locator-confidence dot (green high, amber medium, red low), with a `×` delete button on every line so any step can be removed, not only the last one

The same steps stream into the terminal as you record them, with a confidence marker and the generated Playwright statement:

```
▸ Test 1
    1  ●  Navigate to https://app.example.com/login
    2  ●  Enter "ada@example.com" in Email
    3  ◐  Click Sign in
    3  ✕  deleted: Click Sign in
```

The selected click mode stays active until you change it, so you can assert several elements in a row without reselecting the matcher each time. While a non-auto mode is active the dropdown is highlighted and a banner explains what the next click will record. Assertion modes record instead of clicking, so choose **Auto** or press `Esc` when you need to interact with the page again. Tick **Negate assertion (.not)** to record the inverse — the step's code becomes `.not.<matcher>()` and its business description reads `not.<matcher>`. The mode, negate, and prompt choices are held outside the page, so they survive navigations and apply inside iframes.

Testcases are automatically named `Test 1`, `Test 2`, and so on. Each action's DOM walk stops at a configured semantic boundary or maximum depth. Sensitive values are replaced with `[REDACTED]`.

If no candidate meets the recommendation threshold, recording keeps the best low-confidence fallback, candidate suggestions, clicked-element details, and sanitized HTML from the nearest semantic container. Recording never interrupts you for this by default. Tick **Ask when locator is weak** in the panel to be asked for a manual Playwright locator instead; each step asks at most once.

That request is an in-page dialog rather than a browser `prompt`, because Playwright dismisses native dialogs automatically when the driving script has no dialog listener — which made earlier prompts flash on screen and vanish. The dialog lists the suggested locators as clickable options, shows the surrounding HTML on demand, and stays open reporting why a locator was rejected until you supply a unique one or keep the fallback. Assertion values and key presses use the same dialog.

Every candidate is validated against the element you actually interacted with, not just by match count, so a locator that resolves to a different element is never recommended.

Typing is grouped into a single `fill` step rather than one step per keystroke. The value is committed after a short pause, or immediately on blur, `Enter`, or the next interaction. The manual-locator request appears at most once per step, so it never interrupts you character by character.

## JSON format

The primary scenario format is defined by [`schemas/scenario-context.schema.json`](schemas/scenario-context.schema.json). Each step embeds the locator format in [`schemas/locator-context.schema.json`](schemas/locator-context.schema.json), and replay results use [`schemas/replay-report.schema.json`](schemas/replay-report.schema.json). Validate a report with:

```bash
npx playwright-codegen-smart validate .codegen/scenario-context.json
npx playwright-codegen-smart validate .codegen/replay-report.json
npx playwright-codegen-smart analyze .codegen/locator-context.json
```

`generatedCode` provides an ordered neutral Playwright flow, while `testCases` and `steps` retain richer evidence for a framework-specific skill. A business-readable CSV is written beside the JSON by default with testcase, step, business action, value, locator, confidence, URL, and code columns. Override it with `--csv <file>`.

## Locator scoring

Baselines are deterministic: test ID 100, application data attribute 95, role/name 90, label 88, stable ID 85, placeholder 75, text 65, CSS 55, XPath 35, and positional 15. A unique live match adds 10. Stable scoping adds evidence and a bonus. Zero/multiple matches, class dependence, generated values, and positional dependence reduce the score.

Every score includes `evidence` and `penalties`. By default, only a unique candidate at or above 70 can be recommended. A weak unavoidable candidate remains low confidence rather than being presented as safe.

## Repair workflow

```bash
npx playwright-codegen-smart repair \
  --url https://app.example.com/checkout \
  --locator "page.getByText(\"Submit\")" \
  --hint "Submit order"
```

If the original locator still resolves uniquely, repair reports it as working. If it is ambiguous, the first matched target is inspected and stable scope is sought. If it matches zero elements, `--hint` identifies the current visible text/accessibility name; without target evidence the tool returns no replacement instead of guessing.

Repair writes `.codegen/repair-result.json` and does not edit tests by default. Explicit replacement requires both flags:

```bash
npx playwright-codegen-smart repair ... --apply --file tests/checkout.spec.ts
```

Review applied changes. String replacement is intentionally narrow and is not an AST refactor.

## Cursor integration

After `init`—or after installing your own framework-specific skill—ask:

> Convert the latest recorded scenario into our project's standard Playwright test.

The skill reads ordered steps from `.codegen/scenario-context.json`, then inspects Playwright configuration, fixtures, test folders, page/component objects, helpers, naming, assertions, and similar tests. Existing repository patterns take precedence over generic advice and every recommended locator is revalidated.

Example generated code in a repository that already uses page objects:

```ts
export class CheckoutPage {
  constructor(private readonly page: Page) {}

  readonly submitOrder = this.page
    .getByTestId("checkout-form")
    .getByRole("button", { name: "Submit", exact: true });
}

test("submits an order", async ({ checkoutPage }) => {
  await checkoutPage.submitOrder.click();
  await expect(checkoutPage.confirmation).toBeVisible();
});
```

The skill will not introduce this architecture when the target repository uses inline locators.

## Team usage

Commit `.codegen/config.json` and your `.cursor/skills/.../SKILL.md`. Keep generated scenario reports ignored when they may contain application content. Pin the package version through the lockfile so every developer and CI job uses the same deterministic rules.

The root finder supports Git repositories and npm, pnpm, and Yarn workspace markers. Run `init` from the desired package when a monorepo needs package-specific preferences; use `--root` to select a root explicitly.

## Configuration

`.codegen/config.json`:

```json
{
  "maxAncestorDepth": 5,
  "semanticBoundaries": ["form", "section", "article", "main", "dialog"],
  "preferredAttributes": ["data-testid", "data-test", "data-cy", "data-qa"],
  "applicationAttributes": ["data-component", "data-field", "data-action"],
  "avoidAttributes": ["style"],
  "generatedValuePatterns": ["^css-[a-z0-9]+$", "^ember\\d+$"],
  "minimumLocatorScore": 70,
  "requireUniqueLocator": true,
  "nearbyElementLimit": 8,
  "maxContainerHtmlLength": 50000
}
```

Patterns are regular expressions matched case-insensitively. Invalid configuration fails with a validation error rather than silently changing behavior.

## Internal publishing

1. Change `name` in `package.json` to `@your-company/playwright-codegen-smart`.
2. Add the private registry mapping to the publishing environment's `.npmrc` (never commit a token).
3. Authenticate using the registry's CI secret mechanism.
4. Run `npm run check` and `npm pack --dry-run`.
5. Publish with the registry's required access:

```bash
npm publish --registry https://registry.example.com --access restricted
```

Consumers then run:

```bash
npm install -D @your-company/playwright-codegen-smart
npx playwright-codegen-smart init
```

## Troubleshooting

- **Browser executable missing:** run `npx playwright install chromium`.
- **Authentication or a complex session is needed:** start Chromium with CDP and use `--cdp`.
- **No recommendation:** inspect rejected candidates, add an accessible name or stable application-owned attribute, and recapture.
- **Duplicate match:** capture within a form, row, card, dialog, or component with stable context.
- **Generated ID rejected:** customize `generatedValuePatterns` only when the value is genuinely application-stable.
- **Sensitive content:** remove the report from disk/history and recapture. The tool masks known sensitive values, but visible business data may still appear as nearby text.
- **Picker disappears after navigation:** finish navigation first, then start `capture` at the destination URL.

## Examples

- Scenario report: [`examples/scenario-context.json`](examples/scenario-context.json)
- Capture report: [`examples/locator-context.json`](examples/locator-context.json)
- Team skill source: [`skill/codegen-to-project/SKILL.md`](skill/codegen-to-project/SKILL.md)

## Development

```bash
npm install
npx playwright install chromium
npm run check
```

Common loops:

```bash
npm test                                    # suite only
npx vitest run tests/replay.test.ts         # one file
npx vitest run tests/replay.test.ts -t "restarts a failed testcase"
npm run test:watch                          # watch mode
npm run lint
npm run format

npm run build                               # required before running the CLI
node dist/cli/index.js replay --help
```

Tests import from `src/` and need no build. The CLI runs from `dist/`, so rebuild before verifying a CLI change.

The test suite covers unique and duplicate controls, labels, placeholders, test IDs, stable/dynamic IDs, repeated items, nested components, forms, dialogs, tables, semantic boundaries, depth limits, open shadow DOM, scoring, uniqueness, redaction, repair after text/nesting/duplication/attribute changes, recording order and assertions, the live panel, replay execution, testcase selection, restart, and interactive locator repair.

See [`docs/ONBOARDING.md`](docs/ONBOARDING.md) for the module map, data flow, and extension guidance.
