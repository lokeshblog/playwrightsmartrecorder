# Onboarding

How this package is built, how to set it up, and the exact commands to run,
rerun, and test a scenario.

`README.md` documents the product surface. This document covers the
architecture and the developer runbook.

## 1. What the tool does

Playwright Codegen tells you _a_ locator. It tells you nothing about why that
locator was chosen, whether it is unique, or whether it will survive the next
release. This package captures the surrounding evidence, scores every
alternative deterministically, replays the flow to prove it works, and hands
that verified evidence to a repository-specific Cursor skill for conversion.

Three phases, three artifacts:

| Phase   | Command               | Produces                                  |
| ------- | --------------------- | ----------------------------------------- |
| Record  | `capture` / `session` | detailed context, compact intent, and CSV |
| Replay  | `session` / `replay`  | `replay-report.json`                      |
| Convert | Cursor skill          | Repository-standard test code             |

## 2. Architecture

### Core principle

Deterministic browser and DOM analysis is strictly separated from AI reasoning.
Everything in `src/` runs without an LLM and produces identical output for
identical input. The AI layer is a Cursor skill that consumes the JSON; it never
participates in locator scoring.

### Module map

| Path                                | Responsibility                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `src/types.ts`                      | Domain model. No logic                                                                 |
| `src/config/schema.ts`              | Zod schemas and `defaultConfig`                                                        |
| `src/config/load.ts`                | Repository-root discovery, `init` scaffolding                                          |
| `src/capture/capture.ts`            | Browser lifecycle (`withPage`), single-element picker                                  |
| `src/capture/cdp-picker.ts`         | Chromium application freeze, held freeze for hover-only UI, CDP element inspection     |
| `src/context/extract.ts`            | In-page DOM walk: target, ancestors, siblings, nearby, container HTML, redaction       |
| `src/locator/candidates.ts`         | Candidate generation; `candidateToLocator` parses an expression into a live `Locator`  |
| `src/locator/score.ts`              | Deterministic scoring with evidence and penalties                                      |
| `src/locator/analyze.ts`            | Live match counting plus identity validation against the real target                   |
| `src/locator/identity.ts`           | Shared rule for when a locator drives the same action as the recorded element          |
| `src/locator/suggest.ts`            | Groups every candidate into locator offers with the reason for each                    |
| `src/scenario/record.ts`            | In-page event recorder, step assembly, and code generation                             |
| `src/scenario/describe.ts`          | Names a step's target and summarizes the element for later repair                      |
| `src/scenario/control.ts`           | External recorder window, settings, prompts, and live step list                        |
| `src/ui/format-html.ts`             | Safe text-only formatting for captured surrounding HTML                                |
| `src/scenario/replay.ts`            | Headless-capable execution engine and `ReplayReport`                                   |
| `src/scenario/review.ts`            | Interactive Replay & repair panel bound to the engine                                  |
| `src/scenario/intent.ts`            | Conversion hints and compact `scenario-intent.json`                                    |
| `src/scenario/export.ts`            | Business-readable CSV                                                                  |
| `src/repair/repair.ts`              | Standalone locator repair against a live page                                          |
| `src/cli/index.ts`                  | Commander CLI: `init`, `capture`, `session`, `replay`, `analyze`, `repair`, `validate` |
| `schemas/*.json`                    | Published JSON Schema contracts, kept in sync with the Zod schemas                     |
| `skill/codegen-to-project/SKILL.md` | Cursor skill source, installed by `init`                                               |

### Data flow

```
Browser event
  └─ record.ts  (in-page listener, debounced typing)
       └─ extract.ts   deterministic DOM context
            └─ candidates.ts   candidate expressions
                 └─ score.ts + analyze.ts   score, count, identity-check
                      └─ ScenarioStep { action, intent, URL, product and locator hints }
                           ├─ scenario-context.json   detailed repair evidence
                           └─ scenario-intent.json    compact conversion handoff
                                └─ replay.ts   executes each step
                                     └─ replay-report.json
                                          └─ Cursor skill   repository test code

External control action/assertion
  └─ cdp-picker.ts   freeze application + inspect node
       └─ record.ts   same extraction, scoring, and step pipeline
```

### Separate recording controls

Recording controls run in a separate browser window from the application.
Normal actions are still captured by the lightweight listeners installed by
`record.ts`. For an explicit action or assertion, `cdp-picker.ts` disables
script execution and pauses animations only in the application target, then
uses Chromium's native element inspector. The control window remains
responsive while dropdowns, prompts, and timer-based toasts stay frozen.

A pick freezes the application only for as long as the pick lasts. Hover-only
UI needs longer, so `picker.hold()` freezes it until the user says otherwise:
`Ctrl+Shift+F` and `Ctrl+Shift+A` in the application call the
`__pwCodegenSmartHold` binding, which pins `:hover` on the pointed-at chain via
`CSS.forcePseudoState` and then freezes. While a hold is active, `resume()`
leaves the freeze in place, so picking inside a hold releases only the overlay.
A frozen application runs none of its own script, which is why only the control
window can resume it — through the hold banner, `Esc`, stopping, or teardown.

Control state that must survive navigation (click mode, negate, and
ask-on-weak-locator) is owned by Node, not either page. Freeze cancellation,
selection, shutdown, and errors always resume the application in a `finally`
path. The Chrome DevTools Protocol implementation is Chromium-only; unsupported
or headless window configurations use a separate control tab and display their
reduced capability.

Recording is disabled before replay begins, otherwise replay clicks would be
re-recorded by the still-active listeners.

### Output layout

Every capture and every replay writes a new timestamped folder, so no run ever
overwrites an earlier one:

```
.codegen/
  config.json                        committed
  recordings/
    2026-09-02T06-37-06-checkout/
      scenario-context.json
      scenario-intent.json
      scenario-context.csv
      replay-report.json             session/replay only
      cursor-prompt.txt              session/replay only
  scenario-context.json              mirror of the most recent run
  scenario-intent.json
  scenario-context.csv
  replay-report.json
```

The mirrors at `.codegen/*` are the stable paths that the Cursor skill and the
`analyze` / `validate` defaults read.

`scenario-intent.json` is deliberately stricter than the forensic context.
`intent.ts` derives ownership from `/module/<module>/<feature>` (including
direct `/ce/` paths), strips generated test-ID suffixes and decorative icon
names, and marks login, launcher, redirect, duplicate assertion, and generic
tag noise as `skipInTest`. Its final validator rejects any non-skipped
unresolved step, generic expression, generated test ID, contaminated name, CE
step without CE product hints, or `toBeDisabled` assertion against a
non-native control.

Restriction evidence is captured on every element as `disabledState`.
`disabled`, `aria-disabled`, native form-control state, Blueprint
`bp3-disabled`, tab index, tag, and role remain distinct because Playwright's
native `toBeDisabled` semantics do not describe every RBAC control. The intent
layer emits `toBeRestricted` plus the exact observed signals and preserves the
three common permission-tooltip lines as one structured assertion group.

## 3. Setup

### Consuming the package

```bash
npm install -D playwright-codegen-smart
npx playwright install chromium
npx playwright-codegen-smart init
```

`init` creates `.codegen/config.json` and
`.cursor/skills/codegen-to-project/SKILL.md`. It never overwrites existing
files; it reports what it kept.

### Developing this repository

```bash
git clone <repo-url>
cd PlaywrightCodeGen
npm install
npx playwright install chromium
npm run check
```

`npm run check` runs build, lint, and the full test suite. A clean run means the
environment is correct.

Requirements: Node 20+, Playwright 1.45+.

## 4. Run

### Record only

```bash
npx playwright-codegen-smart capture https://app.example.com/checkout \
  --name "Checkout"
```

Record the flow, then click **Stop recording** or press `Ctrl+Shift+S`.

### Record, replay, and repair in one browser session

This is the recommended path, because the flow is proven before conversion.

```bash
npx playwright-codegen-smart session https://app.example.com/checkout \
  --name "Checkout"
```

1. Record the flow and click **Stop recording**.
2. The browser stays open with its cookies intact and the **Replay & repair**
   panel appears.
3. Pick a testcase in **Testcase to replay**, then click **Run testcase**.
4. On failure the run pauses: choose a suggested locator, type a **Custom
   locator**, or supply **Custom action data**, then **Retry**, **Skip**, or
   **Abort**.
5. Click **Finish & save**.

### Against an already authenticated browser

Use this when login is slow, uses SSO, or requires MFA. Start Chrome yourself,
log in once, and attach to it.

```bash
# 1. Quit all Chrome windows first, then start one with debugging enabled
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/chrome-codegen-profile"

# 2. Confirm the debugger is reachable
curl http://localhost:9222/json/version

# 3. Log in inside that window, then attach
npx playwright-codegen-smart session https://qa.harness.io \
  --name "Checkout" \
  --cdp http://localhost:9222
```

`--user-data-dir` is required so this instance does not collide with your daily
Chrome profile. A Chrome that was already running without
`--remote-debugging-port` cannot be attached to later.

## 5. Rerun

Replay a saved recording without recording it again.

```bash
# Interactive: opens the Replay & repair panel
npx playwright-codegen-smart replay \
  .codegen/recordings/2026-09-02T06-37-06-checkout/scenario-context.json

# Latest run, using the stable mirror path
npx playwright-codegen-smart replay

# Against the authenticated Chrome from step 4
npx playwright-codegen-smart replay <scenario.json> \
  --cdp http://localhost:9222

# One pass, no panel, exits non-zero on failure
npx playwright-codegen-smart replay <scenario.json> --headless

# Only one testcase
npx playwright-codegen-smart replay <scenario.json> --headless \
  --testcase test-2

# Start partway through, and raise the per-action wait
npx playwright-codegen-smart replay <scenario.json> \
  --from 12 \
  --timeout 45000
```

Testcase IDs come from `testCases[].id` in the scenario JSON (`test-1`,
`test-2`, ...). List them with:

```bash
node -e "console.log(require('./.codegen/scenario-context.json').testCases.map(t=>t.id+' '+t.name).join('\n'))"
```

Every navigation, action, and assertion waits up to 30 seconds by default.

**Rerun semantics.** **Run testcase** and **Restart testcase** both reset to the
scenario start URL and clear that testcase's prior statuses before running, so a
failed run can be retried cleanly. **Resume failed** continues from the first
failed step of the selected testcase using the current browser state. The `▶`
button on any row runs from that step without resetting.

**Protected values.** Passwords and tokens stay `[REDACTED]` in every saved
file. Supply the real value through **Custom action data** when replay pauses;
it is used for that retry only and is never written to the scenario or the
replay report. Headless replay cannot supply them, so those steps fail by
design.

### Validate the artifacts

```bash
npx playwright-codegen-smart validate .codegen/scenario-context.json
npx playwright-codegen-smart validate .codegen/scenario-intent.json
npx playwright-codegen-smart validate .codegen/replay-report.json
npx playwright-codegen-smart analyze .codegen/locator-context.json
```

### Convert with Cursor

After **Finish & save**, the CLI prints the exact request, also saved to
`cursor-prompt.txt` in the run folder. Paste it into Cursor, or ask:

> Use the codegen-to-project skill with UI-2.0 or UI-3.0. Read
> `.codegen/scenario-intent.json` first and use
> `.codegen/scenario-context.json` for detailed evidence. Check
> `.codegen/replay-report.json` and do not treat failed or skipped steps as
> verified.

## 6. Test

```bash
# Everything: build, lint, full suite
npm run check

# Test suite only
npm test

# One file
npx vitest run tests/replay.test.ts
npx vitest run tests/scenario.test.ts
npx vitest run tests/locator.test.ts

# One test by name
npx vitest run tests/replay.test.ts -t "restarts a failed testcase"

# Watch while developing
npm run test:watch

# Lint and format independently
npm run lint
npm run format
```

Suite layout:

| File                     | Covers                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------- |
| `tests/locator.test.ts`  | DOM context, select semantics, candidate identity, HTML formatting, shadow DOM, redaction, repair |
| `tests/scenario.test.ts` | Recording, external controls, frozen CDP picking, testcases, dialogs, and locator suggestions     |
| `tests/replay.test.ts`   | Step execution, testcase selection, restart, locator repair, runtime data, iframes, review panel  |

Tests drive a real headless Chromium against `page.setContent` fixtures. They
import from `src/`, so **tests do not require a build**.

### Verifying CLI behaviour

The CLI runs from `dist/`, so it **does** require a build. Rebuild before
testing a CLI change, or you will run the previous binary:

```bash
npm run build
node dist/cli/index.js --help
node dist/cli/index.js replay --help
node dist/cli/index.js session --help
```

### Before publishing

```bash
npm run check
npm pack --dry-run
```

`npm pack --dry-run` confirms `dist/`, `schemas/`, and `skill/` are included.

## 7. Extending the code

When adding a capability, keep the layers intact:

- **New locator strategy** — add the candidate in `src/locator/candidates.ts`,
  give it a baseline in `src/locator/score.ts`, extend `CandidateKind` in
  `src/types.ts` and the `kind` enum in both `src/config/schema.ts` and
  `schemas/locator-context.schema.json`, then cover it in
  `tests/locator.test.ts`.
- **New recorded action** — extend `ScenarioActionType`, then update
  `actionCode`, `businessStep`, the recorder listener in
  `src/scenario/record.ts`, `executeStep` in `src/scenario/replay.ts`, both
  schemas, and `tests/scenario.test.ts`.
- **New control-window action** — state that must survive application
  navigation belongs in the Node-owned settings object, not in either page.
- **Any shipped change** — update `README.md`, this document, and the version in
  `package.json`.

## 8. Troubleshooting

| Symptom                                      | Cause and fix                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Executable doesn't exist`                   | Run `npx playwright install chromium`. If your browsers live in a custom cache, set `PLAYWRIGHT_BROWSERS_PATH` to it                       |
| A CLI change has no effect                   | Stale `dist/`. Run `npm run build`                                                                                                         |
| `connect ECONNREFUSED 127.0.0.1:9222`        | Chrome was not started with `--remote-debugging-port=9222`, or it was already running without the flag                                     |
| Recorder appears on the wrong tab            | The CLI uses the first page of the first context. Close extra tabs or reorder them                                                         |
| Login page instead of the app under `--cdp`  | You logged in under a different Chrome profile. Use the window started with `--user-data-dir`                                              |
| Application changes while picking a locator  | Use an explicit action/assertion in the external controller. Chromium freezes application scripts and animations until the pick completes  |
| Control window is a tab instead              | Separate OS windows are not available in that launch mode. The controller tab still works and displays whether true freeze is available    |
| Recorder controls steal clicks during replay | Recording was not stopped. Use `session`, or click **Stop recording** first                                                                |
| Assertion prompt flashes and disappears      | Rebuild the package. Prompts now live in the external controller and are not native browser dialogs                                        |
| Many low-confidence locators                 | The application relies on generated class names. Add stable `data-testid` or accessible names, or scope through a container, and recapture |
| `Locator matched N elements` on repair       | The expression is not unique. Scope it through a row, card, form, or dialog                                                                |
| Replay fails on a `[REDACTED]` step          | Expected. Supply the value via **Custom action data**, or provide test data in the generated repository test                               |
| Replay fails on `toHaveScreenshot`           | Snapshot assertions need a repository baseline and cannot be replayed from recording data alone                                            |
