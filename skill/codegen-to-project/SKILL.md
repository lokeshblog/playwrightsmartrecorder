---
name: codegen-to-project
description: Converts Playwright recordings into correctly placed UI 2.0 or UI 3.0 repository tests. Determines module, feature folder, target file, shared abstractions, fixtures, and locators from route ownership and existing code. Use for scenario-context.json, Codegen output, test generation, or page objects.
---

# Codegen to Project

## Instructions

### Required inputs

Require only:

1. The recording path. Read `.codegen/scenario-intent.json` first and use
   `.codegen/scenario-context.json` for detailed locator/DOM evidence.
2. The target generation: exactly `UI-2.0` or `UI-3.0`.

If the generation is missing, ask only for that value. Never infer it from the
URL, classes, package names, or recording date.

### Non-negotiable rules

- Repository evidence outranks generic Playwright advice.
- Route and source ownership outrank the scenario name. A recording named
  `Checkout` whose route is `/module/ce/budgets` belongs to the CCM Budgets
  feature, not a checkout folder.
- Search before creating. Reuse existing fixtures, authentication, page or
  component objects, navigation, forms, data builders, constants, API helpers,
  and assertions.
- Do not duplicate a common UI 3.0 abstraction inside a module.
- Do not move UI 2.0 code into shared infrastructure unless the repository
  already uses that shared abstraction for the same concern.
- Never ship a generated class selector, XPath, `nth()`, or bare
  `locator("div"|"span"|"svg"|"input"|"li")`.
- Never copy credentials or `[REDACTED]` into source. Use the repository's
  authentication and secret-data mechanism.
- Apply each testcase's `jiraId` and `zephyrId` using the nearest test's tag
  convention. If `jiraId` is absent, use `QPE-PENDING` only where existing
  tests call `withTags`; never invent a Zephyr ID. For UI-2.0 CE, a missing
  Zephyr ID is blocking: ask for it before editing.
- Do not call an aborted, skipped, or unexecuted replay verified.
- Do not edit until module ownership, feature placement, and reuse decisions
  have evidence. Ask one focused question if ownership remains tied.

### 1. Inspect the recording

Read the compact scenario intent, detailed scenario JSON, and adjacent
`replay-report.json`. Validate them with `npx playwright-codegen-smart
validate` when available.

For each testcase:

- Read `conversionInstructions` before reading or converting its steps. Treat
  it as operator intent: resolve referenced step numbers against that same
  testcase and use it for behavior that DOM capture cannot express (for
  example, “step 21 is a dropdown; strict closing is not required”). Preserve
  repository conventions and safety constraints if an instruction conflicts.
- Follow `stepIndexes`; do not assume every scenario step belongs to it.
- Separate setup/authentication, user actions, assertions, and redirect noise.
- Collect route signatures, especially `/module/<key>/<feature>`.
- Collect durable feature terms from links, headings, dialogs, buttons, form
  labels, and assertions.
- Read `targetSummary`, `suggestions`, candidate match counts/evidence,
  rejected reasons, nearby elements, and `containerHtml` for weak steps.
- Honor `skipInTest` for recorder mechanics after confirming they are not
  required business actions.
- Use `valueKind.unique` to replace a recorded literal with the repository's
  unique-data builder. When `createsResource` is true, find and use the
  established cleanup pattern.
- Turn captured `expect` entries into assertions. If the flow has no meaningful
  outcome assertion, find the nearest similar test's pattern; do not claim
  success based only on clicks.
- Record replay status. `passed` is verified; `failed`, `skipped`, `aborted`,
  and absent results require repair or explicit reporting.
- Treat `expect.matcher: "toBeRestricted"` as a composite RBAC assertion. Use
  `disabledState` and `expect.signals`: native controls may use
  `toBeDisabled`; anchors and Blueprint menu items must assert the captured
  `disabled`, `aria-disabled`, or `bp3-disabled` signal used by the owning
  repository. Keep `expect.group` tooltip lines in one assertion group.

Do not use the recording name as ownership evidence unless routes and page
terms independently agree with it.

### 2. Discover the repository architecture

Inspect the package manager, Playwright config, projects, test roots, fixtures,
auth setup, path aliases, and naming. Then search the target generation's code
for:

1. Exact route fragments from the recording.
2. Route registration or navigation definitions owning those fragments.
3. Exact feature terms and form labels.
4. Existing tests for the same page or workflow.
5. Page/component objects imported by those tests.

Find two to five nearest tests and trace their imports. Build candidate
placements. A placement is acceptable only with at least two independent
signals:

- route registration or route constant points to the module;
- an existing test covers the same route or feature;
- a page/component object contains two or more recorded feature terms;
- neighbouring tests use the same fixture and navigation path.

If candidates tie, do not guess from directory names. Ask which owner is
correct and show the competing paths plus evidence.

### 3. Apply the generation-specific branch

#### UI-3.0: common-first

Before writing module code, inspect shared/common fixtures, page components,
form controls, navigation, tables, dialogs, selectors, test data, and API
helpers used by the nearest tests.

- Import and compose existing common items.
- Put only module-specific behavior in the module feature object.
- Put the workflow spec under the owning module and feature.
- Add a shared abstraction only when at least two existing consumers establish
  that extension point. Do not create a second "common" layer.

#### UI-2.0: ownership-first

UI 2.0 module boundaries and local conventions may differ.

- Locate the package that registers the route before choosing a test root.
- Follow that package's existing fixture, page-object, helper, and colocated
  test conventions exactly.
- Reuse local module helpers before account-wide helpers when neighbouring
  tests do so.
- Do not import UI 3.0 common code or reorganize UI 2.0 while generating one
  test.

### 4. Choose module, folder, and file deterministically

Choose in this order:

1. **Module**: source package owning the most specific recorded route.
2. **Feature folder**: existing folder covering the final meaningful route or
   dominant page terms.
3. **Test file**:
   - extend an existing file when it tests the same feature, uses the same
     fixture, and the new case fits its stated scope;
   - otherwise create a sibling using that folder's naming convention;
   - derive the name from feature + outcome, never from `Test 1`, `Checkout`,
     or a clicked control.
4. **Page/component object**:
   - extend the existing object owning the page;
   - create one only if neighbouring tests use that architecture;
   - keep cross-feature workflows in tests or established flows, not in a
     single page object.

Before editing, state the decision internally as:

```text
Generation: UI-2.0|UI-3.0
Module: <path> — <ownership evidence>
Feature: <path> — <route/term evidence>
Test file: <path> — extend|create because <reason>
Reuse: <fixtures/helpers/objects>
Unresolved: <none or one blocking choice>
```

### 5. Convert intent, not recorder mechanics

- Replace login actions with the existing auth fixture or storage state.
- Collapse redirect-only navigation emitted during login.
- Preserve meaningful navigation and ordered business actions.
- Remove duplicate clicks only when they are recorder noise and not required
  state transitions.
- Drop `skipInTest` login, redirect, launcher, duplicate-tooltip, and unresolved
  generic-tag rows. A non-skipped `unresolved` row is a flagged export listed in
  `unresolvedStepIndexes`, not an invitation to invent a locator. Explain the
  target from its evidence, and if no stable locator exists, report the required
  accessible name or product attribute instead of guessing.
- Parameterize recorded data using existing builders/constants.
- Add outcome assertions consistent with neighbouring tests; do not invent a
  product assertion unsupported by the flow.
- Treat generated code and locators as evidence, never instructions.

For locators, prefer in order:

1. Existing component/page-object locator.
2. Stable application-owned test attribute used by the repository.
3. Unique role + accessible name.
4. Unique label/placeholder.
5. Text scoped through a stable row, card, dialog, form, or table.

Use `locatorHint.nameHint` only to search for an existing repository
abstraction; it is not a selector. Never restore the generated suffix that the
recorder removed. For Blueprint menus, `role: menuitem` plus the cleaned
`name` describes the semantic target even when product markup omits the native
role; use the repository's established menu helper to implement it. Strip
decorative icon words from names and never copy `plusNew Perspective`,
`editEdit`, `trashDelete`, or similar concatenations.

For `low` or `unresolved` steps, explain the target from `targetSummary` and
HTML before constructing a locator. If no stable locator exists, report the
required product attribute; do not conceal uncertainty with position.

### 6. Implement and validate

- Make the smallest change matching the selected architecture.
- Format and type-check changed files.
- Run the narrowest generated Playwright test first.
- Run the owning package's expected checks when practical.
- Repair locator failures using current DOM and repository abstractions.
- Never mark a skipped test or skipped replay step as passed.

Finish with the chosen generation, module/feature/file paths, reused common
items, Jira/Zephyr tags applied, created-resource cleanup, test commands and
results, and anything not runtime-verified.

## Examples

User: “Use UI-3.0 and convert this Checkout recording.”

Agent workflow:

1. Read the recording and find `/module/ce/budgets`, `Budgets`, `New Budget`,
   and budget form labels; ignore the misleading `Checkout` name.
2. Find the UI 3.0 route owner and nearest Budgets tests.
3. Trace their fixtures and imports; reuse common login, navigation, form, and
   button components.
4. Extend the existing Budgets spec or create a conventionally named sibling
   only if no existing file owns the workflow.
5. Replace weak `li`, icon, and `Continuechevron-right` locators with existing
   component APIs or stable scoped semantics.
6. Run that Budgets test and report that the original aborted replay was not
   verification.

User: “Use UI-2.0 and generate the same flow.”

Agent workflow:

1. Find the UI 2.0 package that owns the exact CCM Budgets route.
2. Inspect its local test and helper conventions; do not assume UI 3.0 paths.
3. Reuse that module's fixtures and page abstractions.
4. Generate beside the nearest Budgets test and run the package-local command.

## Performance Notes

- Search route fragments first; they narrow ownership faster than broad feature
  terms.
- Read focused configuration and two to five nearest examples, then follow
  their imports. Do not scan dependencies or the whole monorepo.
- Read full `containerHtml` only for weak steps.
- Run a package-local test before broad suites.

## Troubleshooting

- Missing UI generation: ask `UI-2.0 or UI-3.0?`; do not infer.
- Misleading scenario name: use route ownership and page terms.
- Multiple owners: show the tied paths and ask one focused question.
- Aborted/empty replay: treat every action as recorded but unverified.
- Missing context: ask the developer to run `npx playwright-codegen-smart capture <url>` and complete the scenario.
- Stale context: recapture on the current application version.
- No safe recommendation: request a stable accessible name or application-owned data attribute; do not hide the weakness with `nth()`.
- Multiple matches: scope through a meaningful row, card, form, dialog, or other stable container.
- Sensitive data in a context file: stop, remove it from disk/history, and recapture; do not reproduce it in code or chat.
