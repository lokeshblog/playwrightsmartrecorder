#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { captureSelection, withPage } from "../capture/capture.js";
import {
  findRepositoryRoot,
  initializeProject,
  loadConfig,
} from "../config/load.js";
import {
  locatorContextSchema,
  replayReportSchema,
  scenarioContextSchema,
  scenarioIntentSchema,
} from "../config/schema.js";
import { scoreCandidate } from "../locator/score.js";
import { repairLocator } from "../repair/repair.js";
import { scenarioToCsv } from "../scenario/export.js";
import {
  scenarioToIntent,
  validateScenarioIntent,
} from "../scenario/intent.js";
import { recordScenario } from "../scenario/record.js";
import { replayScenario } from "../scenario/replay.js";
import { reviewScenario } from "../scenario/review.js";
import type {
  LocatorContext,
  ReplayReport,
  ReplayStepStatus,
  ScenarioContext,
  ScenarioIntent,
} from "../types.js";

function confidenceMark(confidence: string): string {
  if (confidence === "high") return "●";
  if (confidence === "medium") return "◐";
  return "○";
}

/**
 * Every capture gets its own folder so earlier recordings are never overwritten.
 * Timestamps are second-accurate, so a suffix is added when one already exists.
 */
async function createRunDirectory(
  root: string,
  name?: string,
): Promise<string> {
  const stamp = new Date()
    .toISOString()
    .replace(/\.\d+Z$/, "")
    .replace(/[:]/g, "-");
  const slug = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const base = path.resolve(
    root,
    ".codegen/recordings",
    slug ? `${stamp}-${slug}` : stamp,
  );
  await mkdir(path.dirname(base), { recursive: true });
  for (let attempt = 1; ; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    try {
      await mkdir(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function replayMark(status: ReplayStepStatus): string {
  if (status === "passed") return "✓";
  if (status === "failed") return "✕";
  if (status === "skipped") return "↷";
  if (status === "running") return "…";
  return "·";
}

async function saveSessionArtifacts(
  root: string,
  scenario: ScenarioContext,
  report: ReplayReport,
  name?: string,
): Promise<string> {
  const directory = await createRunDirectory(root, name ?? scenario.name);
  const scenarioFile = path.join(directory, "scenario-context.json");
  await writeFile(scenarioFile, `${JSON.stringify(scenario, null, 2)}\n`);
  await writeFile(
    path.join(directory, "scenario-context.csv"),
    scenarioToCsv(scenario),
  );
  await writeFile(
    path.join(directory, "scenario-intent.json"),
    `${JSON.stringify(scenarioToIntent(scenario), null, 2)}\n`,
  );
  await writeFile(
    path.join(directory, "replay-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const relative = path.relative(root, scenarioFile);
  const relativeIntent = path.relative(
    root,
    path.join(directory, "scenario-intent.json"),
  );
  const weak = scenario.steps.filter(
    ({ confidence }) => confidence === "unresolved" || confidence === "low",
  );
  const cursorPrompt = [
    "Use the codegen-to-project skill.",
    `Read each testcase's conversionInstructions first in ${relativeIntent}, then read its compact steps. Use detailed evidence from ${relative} only where needed.`,
    "Convert the recording into repository-standard Playwright tests.",
    report.status === "passed"
      ? "The replay passed; still revalidate repository-specific assumptions."
      : `The replay status is ${report.status}; do not treat these steps as verified.`,
    "Reuse existing fixtures, page objects, authentication, and naming conventions.",
    // A weak step needs its element context to be readable, so point at it.
    ...(weak.length
      ? [
          `Steps ${weak.map(({ index }) => index).join(", ")} have no trustworthy locator: read their targetSummary, suggestions, and locatorContext in the JSON to work out what each step does, then write a locator that expresses that intent.`,
        ]
      : []),
    "Run the narrowest generated test and repair any remaining locator failures.",
  ].join(" ");
  await writeFile(
    path.join(directory, "cursor-prompt.txt"),
    `${cursorPrompt}\n`,
  );

  await mkdir(path.resolve(root, ".codegen"), { recursive: true });
  await writeFile(
    path.resolve(root, ".codegen/scenario-context.json"),
    `${JSON.stringify(scenario, null, 2)}\n`,
  );
  await writeFile(
    path.resolve(root, ".codegen/scenario-context.csv"),
    scenarioToCsv(scenario),
  );
  await writeFile(
    path.resolve(root, ".codegen/scenario-intent.json"),
    `${JSON.stringify(scenarioToIntent(scenario), null, 2)}\n`,
  );
  await writeFile(
    path.resolve(root, ".codegen/replay-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`saved verified session ${path.relative(root, directory)}`);
  console.log(
    `Cursor prompt saved at ${path.relative(root, path.join(directory, "cursor-prompt.txt"))}`,
  );
  console.log(`\nCursor: ${cursorPrompt}`);
  return directory;
}

const program = new Command()
  .name("playwright-codegen-smart")
  .description("Capture DOM context and generate robust Playwright locators")
  .version("1.8.0");

program
  .command("init")
  .description(
    "Create project config and the Cursor skill without overwriting files",
  )
  .option("--root <directory>", "project root")
  .action(async ({ root }: { root?: string }) => {
    const repository = root ? path.resolve(root) : await findRepositoryRoot();
    const result = await initializeProject(repository);
    for (const file of result.created)
      console.log(`created ${path.relative(repository, file)}`);
    for (const file of result.skipped)
      console.log(`kept existing ${path.relative(repository, file)}`);
  });

program
  .command("capture")
  .description("Record a scenario with action-specific DOM and locator context")
  .argument("[url]", "page URL", "about:blank")
  .option("-o, --output <file>", "output JSON path")
  .option("--csv <file>", "business-flow CSV output path")
  .option("--name <name>", "scenario name")
  .option("--single", "capture one locator instead of a scenario", false)
  .option("--cdp <endpoint>", "connect to an existing Chromium CDP endpoint")
  .option("--headless", "run headless (primarily for scripted use)", false)
  .action(
    async (
      url: string,
      options: {
        output?: string;
        csv?: string;
        name?: string;
        single: boolean;
        cdp?: string;
        headless: boolean;
      },
    ) => {
      const root = await findRepositoryRoot();
      const config = await loadConfig(root);
      console.log(
        options.single
          ? "Browser ready. Click the element to inspect."
          : [
              "Recording scenario. Use the Smart Recorder control window, then click 'Stop recording' or press Ctrl+Shift+S.",
              "Explicit actions and assertions freeze the application while you pick an element.",
              "Steps appear in the control window as you record them.",
              "Locator confidence: ● high  ◐ medium  ○ low",
              "",
              "▸ Test 1",
            ].join("\n"),
      );
      const result = await withPage<LocatorContext | ScenarioContext>(
        {
          url,
          ...(options.cdp ? { cdp: options.cdp } : {}),
          headless: options.headless,
        },
        (page) =>
          options.single
            ? captureSelection(page, config)
            : recordScenario(page, config, {
                ...(options.name ? { name: options.name } : {}),
                onStep: (step) =>
                  console.log(
                    `  ${String(step.index).padStart(3)}  ${confidenceMark(step.confidence)}  ${step.businessStep}\n       ${step.code}`,
                  ),
                onStepRemoved: (step) =>
                  console.log(
                    `  ${String(step.index).padStart(3)}  ✕  deleted: ${step.businessStep}`,
                  ),
                onTestCase: (name) => console.log(`\n▸ ${name}`),
              }),
      );
      const fileName = options.single
        ? "locator-context.json"
        : "scenario-context.json";
      const output = options.output
        ? path.resolve(root, options.output)
        : path.join(await createRunDirectory(root, options.name), fileName);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
      console.log(`saved ${path.relative(root, output)}`);
      if ("recommended" in result)
        console.log(
          result.recommended
            ? `recommended: page.${result.recommended.locator} (${result.recommended.score})`
            : "No candidate met the configured safety threshold.",
        );
      else {
        const csvOutput = path.resolve(
          root,
          options.csv ?? output.replace(/\.json$/i, ".csv"),
        );
        await mkdir(path.dirname(csvOutput), { recursive: true });
        await writeFile(csvOutput, scenarioToCsv(result));
        await writeFile(
          path.join(path.dirname(output), "scenario-intent.json"),
          `${JSON.stringify(scenarioToIntent(result), null, 2)}\n`,
        );
        console.log(`saved ${path.relative(root, csvOutput)}`);
        console.log(
          `captured ${result.testCases.length} testcase${result.testCases.length === 1 ? "" : "s"} and ${result.steps.length} step${result.steps.length === 1 ? "" : "s"}`,
        );
      }
      // Mirror the run to a stable path so skills and `analyze` keep a fixed target.
      const latest = path.resolve(root, ".codegen", fileName);
      if (latest !== output) {
        await mkdir(path.dirname(latest), { recursive: true });
        await writeFile(latest, `${JSON.stringify(result, null, 2)}\n`);
        if (!("recommended" in result))
          await writeFile(
            latest.replace(/\.json$/i, ".csv"),
            scenarioToCsv(result),
          );
        if (!("recommended" in result))
          await writeFile(
            latest.replace(/scenario-context\.json$/i, "scenario-intent.json"),
            `${JSON.stringify(scenarioToIntent(result), null, 2)}\n`,
          );
        console.log(`latest copy at ${path.relative(root, latest)}`);
      }
    },
  );

program
  .command("session")
  .description(
    "Record, replay, repair, and save a verified scenario in one browser session",
  )
  .argument("[url]", "page URL", "about:blank")
  .option("--name <name>", "scenario name")
  .option("--cdp <endpoint>", "connect to an existing authenticated Chromium")
  .option("--timeout <milliseconds>", "timeout per replay action", "30000")
  .action(
    async (
      url: string,
      options: {
        name?: string;
        cdp?: string;
        timeout: string;
      },
    ) => {
      const root = await findRepositoryRoot();
      const config = await loadConfig(root);
      console.log(
        "Recording. Click Stop recording when the flow is complete; the Replay & repair panel will open in the same browser session.",
      );
      const result = await withPage(
        {
          url,
          ...(options.cdp ? { cdp: options.cdp } : {}),
          headless: false,
        },
        async (page) => {
          const scenario = await recordScenario(page, config, {
            ...(options.name ? { name: options.name } : {}),
            onStep: (step) =>
              console.log(
                `  ${String(step.index).padStart(3)}  ${confidenceMark(step.confidence)}  ${step.businessStep}`,
              ),
          });
          console.log(
            "\nReplay review ready. Run the flow, repair or skip failures, then click Finish & save.",
          );
          return reviewScenario(page, scenario, {
            timeoutMs: Number(options.timeout),
            onStatus: (status, step, error) =>
              console.log(
                `  ${String(step.index).padStart(3)}  ${replayMark(status)}  ${step.businessStep}${error ? `\n       ${error}` : ""}`,
              ),
          });
        },
      );
      await saveSessionArtifacts(
        root,
        result.scenario,
        result.report,
        options.name,
      );
    },
  );

program
  .command("replay")
  .description(
    "Replay and repair a previously recorded scenario in an authenticated browser",
  )
  .argument("[file]", "scenario context JSON", ".codegen/scenario-context.json")
  .option("--cdp <endpoint>", "connect to an existing authenticated Chromium")
  .option("--headless", "run once without the interactive repair panel", false)
  .option("--testcase <id>", "replay only one testcase ID")
  .option("--from <step>", "start from a specific step", "1")
  .option("--timeout <milliseconds>", "timeout per replay action", "30000")
  .action(
    async (
      file: string,
      options: {
        cdp?: string;
        headless: boolean;
        testcase?: string;
        from: string;
        timeout: string;
      },
    ) => {
      const root = await findRepositoryRoot();
      const scenario = scenarioContextSchema.parse(
        JSON.parse(await readFile(path.resolve(root, file), "utf8")),
      ) as ScenarioContext;
      console.log(
        options.headless
          ? "Replaying scenario once."
          : "Replay review ready. Use the browser panel, then click Finish & save.",
      );
      const result = await withPage(
        {
          url: scenario.startUrl,
          ...(options.cdp ? { cdp: options.cdp } : {}),
          headless: options.headless,
        },
        (page) => {
          const common = {
            startAt: Number(options.from),
            ...(options.testcase ? { testCaseId: options.testcase } : {}),
            resetBeforeRun: true,
            timeoutMs: Number(options.timeout),
            onStep: (
              replay: { status: ReplayStepStatus },
              step: ScenarioContext["steps"][number],
            ) =>
              console.log(
                `  ${String(step.index).padStart(3)}  ${replayMark(replay.status)}  ${step.businessStep}`,
              ),
          };
          return options.headless
            ? replayScenario(page, scenario, common)
            : reviewScenario(page, scenario, {
                timeoutMs: Number(options.timeout),
                onStatus: (status, step, error) =>
                  console.log(
                    `  ${String(step.index).padStart(3)}  ${replayMark(status)}  ${step.businessStep}${error ? `\n       ${error}` : ""}`,
                  ),
              });
        },
      );
      await saveSessionArtifacts(
        root,
        result.scenario,
        result.report,
        `${scenario.name}-replay`,
      );
      if (result.report.status === "failed") process.exitCode = 1;
    },
  );

program
  .command("analyze")
  .description(
    "Validate and deterministically re-score a captured context file",
  )
  .argument("[file]", "context JSON", ".codegen/locator-context.json")
  .option("-o, --output <file>", "write result to a different path")
  .action(async (file: string, options: { output?: string }) => {
    const root = await findRepositoryRoot();
    const config = await loadConfig(root);
    const parsed = locatorContextSchema.parse(
      JSON.parse(await readFile(path.resolve(root, file), "utf8")),
    );
    const candidates = parsed.candidates
      .map((candidate) =>
        scoreCandidate(candidate, candidate.matchCount, config),
      )
      .sort((left, right) => right.score - left.score);
    const recommended =
      candidates.find(
        ({ matchCount, score }) =>
          (!config.requireUniqueLocator || matchCount === 1) &&
          score >= config.minimumLocatorScore,
      ) ?? null;
    const result: LocatorContext = {
      ...parsed,
      candidates,
      recommended,
      alternatives: candidates
        .filter(({ locator }) => locator !== recommended?.locator)
        .slice(0, 5),
    };
    const output = path.resolve(root, options.output ?? file);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
    console.log(
      recommended
        ? `recommended: page.${recommended.locator}`
        : "No safe recommendation.",
    );
  });

program
  .command("repair")
  .description("Check a failed locator and recommend a live-page replacement")
  .requiredOption("-l, --locator <expression>", "existing locator expression")
  .option("-u, --url <url>", "page URL", "about:blank")
  .option("--cdp <endpoint>", "connect to an existing Chromium CDP endpoint")
  .option(
    "--hint <text>",
    "current visible text or accessible name when the old locator matches zero",
  )
  .option("--apply", "replace the locator in a file", false)
  .option("--file <path>", "test file used with --apply")
  .option("-o, --output <file>", "repair report", ".codegen/repair-result.json")
  .action(
    async (options: {
      locator: string;
      url: string;
      cdp?: string;
      hint?: string;
      apply: boolean;
      file?: string;
      output: string;
    }) => {
      const root = await findRepositoryRoot();
      const config = await loadConfig(root);
      const result = await withPage(
        { url: options.url, ...(options.cdp ? { cdp: options.cdp } : {}) },
        (page) =>
          repairLocator(page, options.locator, config, {
            ...(options.hint ? { hint: options.hint } : {}),
            ...(options.file ? { file: path.resolve(root, options.file) } : {}),
            apply: options.apply,
          }),
      );
      const output = path.resolve(root, options.output);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
      console.log(
        result.replacement
          ? `replacement: page.${result.replacement.locator}`
          : `status: ${result.status}`,
      );
    },
  );

program
  .command("validate")
  .description("Validate locator, scenario, or replay report JSON")
  .argument("[file]", "context JSON", ".codegen/scenario-context.json")
  .action(async (file: string) => {
    const root = await findRepositoryRoot();
    const input: unknown = JSON.parse(
      await readFile(path.resolve(root, file), "utf8"),
    );
    const scenario = scenarioContextSchema.safeParse(input);
    const locator = locatorContextSchema.safeParse(input);
    const replay = replayReportSchema.safeParse(input);
    const intent = scenarioIntentSchema.safeParse(input);
    if (intent.success) validateScenarioIntent(intent.data as ScenarioIntent);
    if (
      !scenario.success &&
      !locator.success &&
      !replay.success &&
      !intent.success
    )
      scenarioContextSchema.parse(input);
    console.log(`${file} is valid`);
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`playwright-codegen-smart: ${message}`);
  process.exitCode = 1;
});
