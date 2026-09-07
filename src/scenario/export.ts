import type { ScenarioContext } from "../types.js";

type CsvValue = string | number | boolean | null | undefined;

const csvCell = (value: CsvValue): string => {
  const text = value === undefined || value === null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
};

export function scenarioToCsv(scenario: ScenarioContext): string {
  const rows: CsvValue[][] = [
    [
      "Test Case",
      "Jira ID",
      "Zephyr ID",
      "Step",
      "Business Step",
      "Action",
      "Value",
      "Locator",
      "Confidence",
      "Page URL",
      "Playwright Code",
      // A weak locator is only repairable with the element it came from.
      "Element Context",
      "Warning",
      "Locator Options",
    ],
  ];
  for (const testCase of scenario.testCases) {
    scenario.steps
      .filter(({ testCaseId }) => testCase.id === testCaseId)
      .forEach((step, index) => {
        rows.push([
          testCase.name,
          testCase.jiraId,
          testCase.zephyrId,
          index + 1,
          step.businessStep,
          step.action.type === "assert"
            ? step.action.assertion?.matcher
            : step.action.type,
          Array.isArray(step.action.assertion?.expected)
            ? JSON.stringify(step.action.assertion.expected)
            : (step.action.assertion?.expected ?? step.action.value),
          step.locator,
          step.confidence,
          step.pageUrl,
          step.code,
          step.targetSummary,
          step.warning,
          step.suggestions.join(" | "),
        ]);
      });
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}
