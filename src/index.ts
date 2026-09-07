export { captureSelection, withPage } from "./capture/capture.js";
export {
  createElementPicker,
  pickerMarkerAttribute,
} from "./capture/cdp-picker.js";
export { extractDomContext } from "./context/extract.js";
export { analyzeContext } from "./locator/analyze.js";
export {
  candidateToLocator,
  generateCandidates,
  isGeneratedValue,
} from "./locator/candidates.js";
export { resolvesToActionTarget } from "./locator/identity.js";
export { scoreCandidate } from "./locator/score.js";
export { repairLocator } from "./repair/repair.js";
export { scenarioToCsv } from "./scenario/export.js";
export {
  createRecorderControl,
  openRecorderControl,
} from "./scenario/control.js";
export { actionCode, recordScenario } from "./scenario/record.js";
export { describeTarget, summarizeTarget } from "./scenario/describe.js";
export { suggestLocators } from "./locator/suggest.js";
export { enrichScenario, scenarioToIntent } from "./scenario/intent.js";
export { prettyFormatHtml } from "./ui/format-html.js";
export {
  DEFAULT_REPLAY_TIMEOUT_MS,
  replayScenario,
} from "./scenario/replay.js";
export { reviewScenario } from "./scenario/review.js";
export {
  findRepositoryRoot,
  initializeProject,
  loadConfig,
} from "./config/load.js";
export {
  defaultConfig,
  locatorContextSchema,
  replayReportSchema,
  scenarioContextSchema,
  scenarioIntentSchema,
  smartConfigSchema,
} from "./config/schema.js";
export type * from "./types.js";
