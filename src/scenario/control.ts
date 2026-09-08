import type { BrowserContext, CDPSession, Page } from "playwright";
import type { AssertionMatcher, LocatorSuggestion } from "../types.js";

/**
 * Out-of-page recorder controls.
 *
 * The in-page panel competes with the application for clicks and z-index, and
 * it cannot be used while the application is frozen for element picking. This
 * module renders the same controls in a dedicated Chromium window (or tab)
 * driven entirely from Node, so the recorded page keeps no recorder UI.
 *
 * Node owns the state. The panel only reflects what a handler returns, which
 * keeps it correct across navigations and reloads of the recorded page.
 *
 * Everything captured from the recorded page is written with `textContent`, so
 * application markup is never parsed as HTML here.
 */

/** Recorder state owned by Node and mirrored into the panel. */
export interface ControlSettings {
  mode: string;
  negate: boolean;
  ask: boolean;
  active: boolean;
}

/** One row of the recorded-steps list. */
export interface ControlStepSummary {
  index: number;
  testCase: string;
  businessStep: string;
  confidence: string;
}

/** Full panel state. */
export interface ControlPanelUpdate {
  message: string;
  steps: ControlStepSummary[];
  activeTestCase: string;
  jiraId?: string | undefined;
  zephyrId?: string | undefined;
}

export interface ControlModeOption {
  value: string;
  label: string;
}

/** A group of mode options. An empty label renders the options ungrouped. */
export interface ControlModeGroup {
  label: string;
  options: ControlModeOption[];
}

/** Prompt shown in the control surface instead of a native or in-page dialog. */
export interface ControlPromptRequest {
  title: string;
  message?: string | undefined;
  label?: string | undefined;
  value?: string | undefined;
  error?: string | undefined;
  /** Locators to choose from, grouped by how much they can be trusted. */
  suggestions?: LocatorSuggestion[] | undefined;
  /** Facts about the element, so the request explains which step it is. */
  context?: string[] | undefined;
  /** Captured markup. Rendered as text, never as HTML. */
  details?: string | undefined;
  /** Whether {@link ControlPromptRequest.details} was cut short at capture. */
  detailsTruncated?: boolean | undefined;
  /** Original markup retained when `details` has been pretty formatted. */
  rawDetails?: string | undefined;
  confirmLabel?: string | undefined;
  cancelLabel?: string | undefined;
}

/**
 * Formats captured markup before a prompt shows it. Runs in Node, so a
 * pretty-printer can be plugged in without shipping it to the browser.
 */
export type PrettyHtmlFormatter = (html: string) => string | Promise<string>;

/**
 * Callbacks invoked when the user drives the panel. Handlers own the recorder
 * state; whatever they return is what the panel renders next.
 */
export interface RecorderControlHandlers {
  /** Applies a settings patch and returns the merged state. */
  settings: (
    patch: Partial<ControlSettings>,
  ) => ControlSettings | Promise<ControlSettings>;
  /** Returns the current panel state; also used for polling. */
  refresh: () => ControlPanelUpdate | Promise<ControlPanelUpdate>;
  /**
   * Starts picking for the given mode. May stay pending for as long as the
   * picker keeps recording; the panel shows a picking state until it settles.
   */
  pick?: ((mode: string) => void | Promise<void>) | undefined;
  /** Resumes an application the user froze from the recorded page. */
  releaseHold?:
    (() => ControlPanelUpdate | Promise<ControlPanelUpdate>) | undefined;
  newTest: () => ControlPanelUpdate | Promise<ControlPanelUpdate>;
  deleteLine: () => ControlPanelUpdate | Promise<ControlPanelUpdate>;
  deleteTest: () => ControlPanelUpdate | Promise<ControlPanelUpdate>;
  deleteStep: (
    index: number,
  ) => ControlPanelUpdate | Promise<ControlPanelUpdate>;
  testMetadata: (patch: {
    jiraId?: string;
    zephyrId?: string;
  }) => ControlPanelUpdate | Promise<ControlPanelUpdate>;
  stop: () => void | Promise<void>;
  /** The user closed the control window or tab. */
  onClose?: (() => void) | undefined;
}

export interface RecorderControlOptions {
  title?: string | undefined;
  /** Try a separate OS window before falling back to a tab. Defaults to true. */
  separateWindow?: boolean | undefined;
  /** Window and viewport size. Defaults to a snug fit around the panel. */
  width?: number | undefined;
  height?: number | undefined;
  /** Panel refresh cadence in ms. `0` disables polling. Defaults to 1000. */
  pollIntervalMs?: number | undefined;
  prettyHtml?: PrettyHtmlFormatter | undefined;
  modeGroups?: ControlModeGroup[] | undefined;
}

export interface RecorderControl {
  /** The control surface. Never the recorded page. */
  readonly page: Page;
  /** True when the controls own a separate OS window rather than a tab. */
  readonly ownsWindow: boolean;
  /** Resolves when the control surface closes, for any reason. */
  readonly closed: Promise<void>;
  /** Re-renders the steps list and status line. */
  update(update: ControlPanelUpdate): Promise<void>;
  /** Mirrors Node-side settings into the panel without invoking handlers. */
  setSettings(settings: Partial<ControlSettings>): Promise<void>;
  setStatus(message: string): Promise<void>;
  /** Shows whether true application freeze is available. */
  setCapability(message: string, available: boolean): Promise<void>;
  /** Reflects an in-flight pick and enables the cancel control. */
  setPicking(active: boolean, message?: string): Promise<void>;
  /** Shows that the application is frozen, with the control that resumes it. */
  setHold(active: boolean, message?: string): Promise<void>;
  /** Resolves with the entered value, or `null` when skipped or closed. */
  prompt(request: ControlPromptRequest): Promise<string | null>;
  setPrettyHtml(formatter: PrettyHtmlFormatter | null): void;
  isClosed(): boolean;
  close(): Promise<void>;
}

/** Kept as `AssertionMatcher[]` so it cannot drift from the scenario types. */
const assertionMatchers: AssertionMatcher[] = [
  "toBeAttached",
  "toBeVisible",
  "toBeHidden",
  "toBeEnabled",
  "toBeDisabled",
  "toBeEditable",
  "toBeEmpty",
  "toBeFocused",
  "toBeChecked",
  "toBeInViewport",
  "toHaveAccessibleDescription",
  "toHaveAccessibleErrorMessage",
  "toHaveAccessibleName",
  "toHaveText",
  "toContainText",
  "toHaveValue",
  "toHaveValues",
  "toHaveAttribute",
  "toHaveClass",
  "toHaveCSS",
  "toHaveId",
  "toHaveJSProperty",
  "toHaveRole",
  "toHaveScreenshot",
  "toHaveCount",
];

/** Mirrors the recorder's mode list, including the `assert:` prefix. */
export const defaultControlModeGroups: ControlModeGroup[] = [
  {
    label: "",
    options: [{ value: "auto", label: "Auto — record normal actions" }],
  },
  {
    label: "Actions",
    options: [
      { value: "forceClick", label: "Force click" },
      { value: "doubleClick", label: "Double click" },
      { value: "hover", label: "Hover" },
      { value: "check", label: "Check" },
      { value: "uncheck", label: "Uncheck" },
      { value: "press", label: "Press key" },
    ],
  },
  {
    label: "Assertions",
    options: assertionMatchers.map((matcher) => ({
      value: `assert:${matcher}`,
      label: `expect.${matcher}`,
    })),
  },
];

/** Everything the installer needs; passed as a single evaluate argument. */
interface ControlPanelConfig {
  title: string;
  modeGroups: ControlModeGroup[];
  pollIntervalMs: number;
  panelWidth: number;
  panelMargin: number;
  listMaxHeight: number;
  maxHeight: number;
}

/** Widest the panel renders; the window is sized from it. */
const panelWidth = 420;
/** Gap between the panel and the window edge, on every side. */
const panelMargin = 14;
/**
 * Tallest the steps list grows before it scrolls. Fixed in pixels rather than
 * viewport units so the panel's height does not shrink along with the window
 * that is being fitted to it.
 */
const listMaxHeight = 340;
/** A window this size is all panel, with no empty background around it. */
const defaultControlSize = {
  width: panelWidth + panelMargin * 2,
  height: 760,
};
/** Below this the panel cannot show its controls. */
const minControlHeight = 220;

/** Page to Node messages, funnelled through one binding. */
type ControlEvent =
  | { kind: "settings"; patch: Partial<ControlSettings> }
  | { kind: "refresh" }
  | { kind: "pick"; mode: string }
  | { kind: "releaseHold" }
  | { kind: "newTest" }
  | { kind: "deleteLine" }
  | { kind: "deleteTest" }
  | { kind: "deleteStep"; index: number }
  | { kind: "testMetadata"; patch: { jiraId?: string; zephyrId?: string } }
  | { kind: "fit"; height: number }
  | { kind: "stop" };

/** Whatever a handler produced. Both fields may be present. */
interface ControlResponse {
  settings?: ControlSettings | undefined;
  update?: ControlPanelUpdate | undefined;
}

/** Node to page messages, funnelled through one evaluate. */
type BridgeCall =
  | { kind: "render"; update: ControlPanelUpdate }
  | { kind: "settings"; settings: Partial<ControlSettings> }
  | { kind: "status"; message: string }
  | { kind: "capability"; message: string; available: boolean }
  | { kind: "picking"; active: boolean; message: string | null }
  | { kind: "hold"; active: boolean; message: string | null }
  | { kind: "prompt"; request: ControlPromptRequest };

interface ControlBridge {
  render: (update: ControlPanelUpdate) => void;
  settings: (settings: Partial<ControlSettings>) => void;
  status: (message: string) => void;
  capability: (message: string, available: boolean) => void;
  picking: (active: boolean, message: string | null) => void;
  hold: (active: boolean, message: string | null) => void;
  prompt: (request: ControlPromptRequest) => Promise<string | null>;
}

const eventBinding = "__pwCodegenSmartControlEvent";

/**
 * Runs in the control surface. Builds the panel and installs the bridge. The
 * static shell uses `innerHTML`; every recorded value goes through
 * `textContent`.
 */
function installControlPanel(config: ControlPanelConfig): void {
  const scope = window as unknown as Record<string, unknown>;
  if (scope.__pwCodegenSmartControlBridge) return;

  const mount = (): void => {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", mount, { once: true });
      return;
    }
    document.title = config.title;
    document.body.style.cssText = `margin:0;padding:${String(config.panelMargin)}px;background:#f3f4f6;font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;color:#111827`;

    const send = (event: ControlEvent): Promise<ControlResponse | null> =>
      (
        scope.__pwCodegenSmartControlEvent as
          | ((payload: ControlEvent) => Promise<ControlResponse | null>)
          | undefined
      )?.(event) ?? Promise.resolve(null);

    const panel = document.createElement("div");
    panel.setAttribute("data-pw-codegen-smart-controls", "");
    panel.setAttribute("data-pw-codegen-smart-control-panel", "");
    panel.style.cssText = `max-width:${String(config.panelWidth)}px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.12);overflow:hidden`;
    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:#faf5ff;border-bottom:1px solid #ede9fe">
        <span data-live style="width:8px;height:8px;border-radius:50%;background:#ef4444;box-shadow:0 0 0 3px #fee2e2"></span>
        <strong style="flex:1;font-size:13px">Smart Recorder</strong>
        <span data-test-name style="font-size:11px;font-weight:600;color:#6d28d9;background:#f3e8ff;border-radius:99px;padding:2px 8px">Test 1</span>
      </div>
      <div data-capability style="display:none;padding:7px 12px;font-size:11px;border-bottom:1px solid #f3f4f6"></div>
      <div data-hold style="display:none;padding:8px 12px;background:#fffbeb;border-bottom:1px solid #fde68a;color:#92400e;font-size:11px">
        <div data-hold-message style="margin-bottom:6px"></div>
        <button data-release-hold style="width:100%">Resume the application (Esc)</button>
      </div>
      <div style="padding:10px 12px">
        <label data-label style="display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;margin-bottom:4px">Click mode <span style="font-weight:500;text-transform:none;letter-spacing:0">(stays active)</span></label>
        <select data-mode style="width:100%;box-sizing:border-box;padding:7px 8px;border:1px solid #d1d5db;border-radius:6px;background:#fff;font:inherit;color:inherit"></select>
        <div data-mode-hint style="display:none;margin-top:6px;padding:6px 8px;border-radius:6px;background:#f5f3ff;border:1px solid #ddd6fe;color:#5b21b6;font-size:11px"></div>
        <div style="display:flex;flex-wrap:wrap;gap:14px;margin:9px 0 10px">
          <label data-check style="display:inline-flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;margin:0"><span>Negate assertion (.not)</span><input data-negate type="checkbox"></label>
          <label data-check style="display:inline-flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;margin:0"><span>Ask when locator is weak</span><input data-ask type="checkbox"></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">
          <label style="font-size:11px;color:#6b7280">Jira ID<input data-jira placeholder="QPE-####" style="display:block;width:100%;box-sizing:border-box;margin-top:3px;padding:6px 7px;border:1px solid #d1d5db;border-radius:6px;font:inherit"></label>
          <label style="font-size:11px;color:#6b7280">Zephyr ID<input data-zephyr placeholder="Optional" style="display:block;width:100%;box-sizing:border-box;margin-top:3px;padding:6px 7px;border:1px solid #d1d5db;border-radius:6px;font:inherit"></label>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
          <button data-new>+ New testcase</button>
          <button data-delete-line>Undo last line</button>
          <button data-delete-test>Delete testcase</button>
          <button data-stop data-primary>Stop recording</button>
        </div>
        <button data-cancel-pick style="display:none;width:100%;margin-top:6px">Cancel pick (back to Auto)</button>
        <div data-shortcuts style="margin-top:9px;font-size:11px;color:#6b7280;line-height:1.6">
          In the application: <b>Ctrl+Shift+F</b> freezes it so a tooltip or menu stays open ·
          <b>Ctrl+Shift+A</b> freezes and asserts what appeared ·
          <b>Ctrl+Shift+S</b> stops recording
        </div>
      </div>
      <div style="border-top:1px solid #f3f4f6">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 12px;background:#f9fafb">
          <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#6b7280">Recorded steps</span>
          <span data-count style="font-size:11px;color:#6b7280">0</span>
        </div>
        <ol data-steps style="list-style:none;margin:0;padding:0;max-height:${String(config.listMaxHeight)}px;overflow:auto"></ol>
      </div>
      <div data-status style="padding:7px 12px;font-size:11px;color:#6b7280;border-top:1px solid #f3f4f6;background:#fff">Recording</div>`;

    for (const button of panel.querySelectorAll("button")) {
      const primary = button.hasAttribute("data-primary");
      button.style.cssText = `border:1px solid ${primary ? "#7c3aed" : "#d1d5db"};background:${primary ? "#7c3aed" : "#fff"};color:${primary ? "#fff" : "#374151"};border-radius:6px;padding:7px 6px;cursor:pointer;font:inherit;font-size:12px;font-weight:${primary ? "600" : "500"}`;
    }
    for (const box of panel.querySelectorAll<HTMLInputElement>(
      "[data-check] input",
    ))
      box.style.cssText =
        "width:13px;height:13px;margin:0;flex:none;accent-color:#7c3aed;vertical-align:middle";

    const select = panel.querySelector<HTMLSelectElement>("[data-mode]")!;
    const hint = panel.querySelector<HTMLElement>("[data-mode-hint]")!;
    const negateBox = panel.querySelector<HTMLInputElement>("[data-negate]")!;
    const askBox = panel.querySelector<HTMLInputElement>("[data-ask]")!;
    const status = panel.querySelector<HTMLElement>("[data-status]")!;
    const list = panel.querySelector<HTMLElement>("[data-steps]")!;
    const counter = panel.querySelector<HTMLElement>("[data-count]")!;
    const testName = panel.querySelector<HTMLElement>("[data-test-name]")!;
    const live = panel.querySelector<HTMLElement>("[data-live]")!;
    const capability = panel.querySelector<HTMLElement>("[data-capability]")!;
    const cancelPick =
      panel.querySelector<HTMLButtonElement>("[data-cancel-pick]")!;
    const hold = panel.querySelector<HTMLElement>("[data-hold]")!;
    const holdMessage = panel.querySelector<HTMLElement>(
      "[data-hold-message]",
    )!;
    const releaseHold = panel.querySelector<HTMLButtonElement>(
      "[data-release-hold]",
    )!;
    const stopButton = panel.querySelector<HTMLButtonElement>("[data-stop]")!;
    const jiraInput = panel.querySelector<HTMLInputElement>("[data-jira]")!;
    const zephyrInput = panel.querySelector<HTMLInputElement>("[data-zephyr]")!;

    for (const group of config.modeGroups) {
      const parent = group.label
        ? document.createElement("optgroup")
        : undefined;
      if (parent) parent.label = group.label;
      for (const option of group.options) {
        const element = document.createElement("option");
        element.value = option.value;
        element.textContent = option.label;
        (parent ?? select).append(element);
      }
      if (parent) select.append(parent);
    }

    const renderMode = (value: string): void => {
      select.value = value;
      const active = value !== "auto";
      select.style.borderColor = active ? "#7c3aed" : "#d1d5db";
      select.style.background = active ? "#faf5ff" : "#fff";
      hint.style.display = active ? "block" : "none";
      cancelPick.style.display = active ? "block" : "none";
      if (!active) return;
      const label = select.selectedOptions[0]?.textContent ?? value;
      const negated = negateBox.checked ? " (negated with .not)" : "";
      hint.textContent = value.startsWith("assert:")
        ? `Pick an element in the recorded page to record ${label}${negated}. Choose Auto to stop picking.`
        : `Pick an element in the recorded page to record ${label}. Choose Auto to stop picking.`;
    };
    const applySettings = (next: Partial<ControlSettings>): void => {
      if (next.negate !== undefined) negateBox.checked = next.negate;
      if (next.ask !== undefined) askBox.checked = next.ask;
      if (next.mode !== undefined) renderMode(next.mode);
      else renderMode(select.value);
      if (next.active !== undefined) {
        live.style.background = next.active ? "#ef4444" : "#9ca3af";
        live.style.boxShadow = `0 0 0 3px ${next.active ? "#fee2e2" : "#e5e7eb"}`;
        stopButton.disabled = !next.active;
        select.disabled = !next.active;
      }
    };

    const tone: Record<string, string> = {
      high: "#16a34a",
      medium: "#d97706",
      low: "#dc2626",
      unresolved: "#dc2626",
    };
    let signature = "";
    let rendered = 0;
    const render = (update: ControlPanelUpdate): void => {
      if (update.message) status.textContent = update.message;
      testName.textContent = update.activeTestCase;
      if (document.activeElement !== jiraInput)
        jiraInput.value = update.jiraId ?? "";
      if (document.activeElement !== zephyrInput)
        zephyrInput.value = update.zephyrId ?? "";
      const next = update.steps
        .map(({ index, businessStep, confidence }) =>
          [index, businessStep, confidence].join("\u0001"),
        )
        .join("\u0002");
      if (next === signature) return;
      const grew = update.steps.length > rendered;
      signature = next;
      rendered = update.steps.length;
      counter.textContent = String(update.steps.length);
      list.textContent = "";
      if (update.steps.length === 0) {
        const empty = document.createElement("li");
        empty.style.cssText =
          "padding:12px;text-align:center;color:#9ca3af;font-size:12px";
        empty.textContent = "Interact with the recorded page to record a step";
        list.append(empty);
        return;
      }
      let lastTestCase = "";
      for (const step of update.steps) {
        if (step.testCase !== lastTestCase) {
          lastTestCase = step.testCase;
          const heading = document.createElement("li");
          heading.style.cssText =
            "padding:5px 12px;font-size:11px;font-weight:700;color:#6d28d9;background:#faf5ff;position:sticky;top:0";
          heading.textContent = step.testCase;
          list.append(heading);
        }
        const row = document.createElement("li");
        row.setAttribute("data-step", String(step.index));
        row.style.cssText =
          "display:flex;align-items:flex-start;gap:7px;padding:6px 8px 6px 12px;border-top:1px solid #f3f4f6";
        const badge = document.createElement("span");
        badge.style.cssText = `flex:none;margin-top:3px;width:6px;height:6px;border-radius:50%;background:${tone[step.confidence] ?? "#9ca3af"}`;
        badge.title = `locator confidence: ${step.confidence}`;
        const text = document.createElement("span");
        text.style.cssText = "flex:1;font-size:12px;word-break:break-word";
        text.textContent = `${String(step.index)}. ${step.businessStep}`;
        const remove = document.createElement("button");
        remove.textContent = "×";
        remove.title = "Delete this line";
        remove.style.cssText =
          "flex:none;border:0;background:transparent;color:#9ca3af;cursor:pointer;font-size:16px;line-height:1;padding:0 2px";
        remove.addEventListener("click", () => {
          dispatch({ kind: "deleteStep", index: step.index });
        });
        row.append(badge, text, remove);
        list.append(row);
      }
      if (grew) list.scrollTop = list.scrollHeight;
    };

    const setPicking = (active: boolean, message: string | null): void => {
      cancelPick.disabled = !active;
      select.style.outline = active ? "2px solid #ddd6fe" : "none";
      if (message !== null) status.textContent = message;
    };
    // The panel is watched by a ResizeObserver, so showing the banner refits.
    let held = false;
    const setHold = (active: boolean, message: string | null): void => {
      held = active;
      hold.style.display = active ? "block" : "none";
      if (active)
        holdMessage.textContent =
          message ??
          "The application is frozen; what is on screen stays there.";
      else if (message !== null) status.textContent = message;
    };
    const apply = (response: ControlResponse | null): void => {
      if (!response) return;
      if (response.settings) applySettings(response.settings);
      if (response.update) render(response.update);
    };
    const dispatch = (event: ControlEvent): void => {
      void send(event).then(apply);
    };

    select.addEventListener("change", () => {
      const mode = select.value;
      renderMode(mode);
      void send({ kind: "settings", patch: { mode } }).then((response) => {
        apply(response);
        if (mode === "auto") return;
        setPicking(true, "Pick an element in the recorded page.");
        // Stays pending while the picker keeps recording in this mode.
        void send({ kind: "pick", mode }).then((picked) => {
          setPicking(false, null);
          apply(picked);
          void send({ kind: "refresh" }).then(apply);
        });
      });
    });
    const pushToggles = (): void => {
      renderMode(select.value);
      dispatch({
        kind: "settings",
        patch: { negate: negateBox.checked, ask: askBox.checked },
      });
    };
    negateBox.addEventListener("change", pushToggles);
    askBox.addEventListener("change", pushToggles);
    cancelPick.addEventListener("click", () => {
      cancelPick.disabled = true;
      renderMode("auto");
      dispatch({ kind: "settings", patch: { mode: "auto" } });
    });
    const resumeApplication = (): void => {
      setHold(false, "Resuming the application…");
      dispatch({ kind: "releaseHold" });
    };
    releaseHold.addEventListener("click", resumeApplication);
    // The frozen application runs no script, so only the panel can resume it.
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !held) return;
      // A prompt owns Escape while it is open.
      if (document.querySelector("[data-pw-codegen-smart-modal]")) return;
      event.preventDefault();
      resumeApplication();
    });
    panel.querySelector("[data-new]")?.addEventListener("click", () => {
      dispatch({ kind: "newTest" });
    });
    panel.querySelector("[data-delete-line]")?.addEventListener("click", () => {
      dispatch({ kind: "deleteLine" });
    });
    panel.querySelector("[data-delete-test]")?.addEventListener("click", () => {
      dispatch({ kind: "deleteTest" });
    });
    const updateMetadata = (): void => {
      dispatch({
        kind: "testMetadata",
        patch: { jiraId: jiraInput.value, zephyrId: zephyrInput.value },
      });
    };
    jiraInput.addEventListener("change", updateMetadata);
    zephyrInput.addEventListener("change", updateMetadata);
    stopButton.addEventListener("click", () => {
      stopButton.disabled = true;
      status.textContent = "Stopping the recorder…";
      dispatch({ kind: "stop" });
    });

    /**
     * Asks Node to fit the window to the panel. Only Node can resize a window
     * it did not open from script, so the measurement is reported instead.
     * A prompt covers the whole surface, so it takes all the height it can.
     */
    let modalOpen = false;
    let reported = 0;
    const fit = (): void => {
      const height = modalOpen
        ? config.maxHeight
        : Math.ceil(panel.getBoundingClientRect().height) +
          config.panelMargin * 2;
      if (Math.abs(height - reported) < 2) return;
      reported = height;
      void send({ kind: "fit", height });
    };

    /** Prompts render here because the recorded page may be frozen. */
    let closeActiveModal: ((result: string | null) => void) | undefined;
    const prompt = (request: ControlPromptRequest): Promise<string | null> =>
      new Promise((resolve) => {
        closeActiveModal?.(null);
        const overlay = document.createElement("div");
        overlay.setAttribute("data-pw-codegen-smart-controls", "");
        overlay.setAttribute("data-pw-codegen-smart-modal", "");
        overlay.style.cssText =
          "position:fixed;inset:0;z-index:2147483647;background:rgba(17,24,39,.55);display:flex;align-items:center;justify-content:center;font:13px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#111827";
        const card = document.createElement("div");
        card.style.cssText =
          "width:min(560px,92vw);max-height:86vh;display:flex;flex-direction:column;background:#fff;border-radius:12px;box-shadow:0 20px 50px rgba(0,0,0,.35);overflow:hidden";
        const head = document.createElement("div");
        head.style.cssText =
          "padding:14px 16px;border-bottom:1px solid #f3f4f6";
        const title = document.createElement("strong");
        title.textContent = request.title;
        head.append(title);
        if (request.message) {
          const message = document.createElement("div");
          message.style.cssText =
            "margin-top:4px;font-size:12px;color:#6b7280;word-break:break-word";
          message.textContent = request.message;
          head.append(message);
        }
        const body = document.createElement("div");
        body.style.cssText = "padding:14px 16px;overflow:auto";
        if (request.error) {
          const error = document.createElement("div");
          error.style.cssText =
            "margin-bottom:10px;padding:8px 10px;border-radius:6px;background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;font-size:12px";
          error.textContent = request.error;
          body.append(error);
        }
        const label = document.createElement("label");
        label.style.cssText =
          "display:block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#6b7280;margin-bottom:4px";
        label.textContent = request.label ?? "Value";
        const input = document.createElement("input");
        input.value = request.value ?? "";
        input.style.cssText =
          "width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px";
        const heading = (text: string): HTMLElement => {
          const element = document.createElement("div");
          element.style.cssText =
            "margin:0 0 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#6b7280";
          element.textContent = text;
          return element;
        };
        if (request.context?.length) {
          const facts = document.createElement("ul");
          facts.setAttribute("data-prompt-context", "");
          facts.style.cssText =
            "margin:0 0 12px;padding:8px 10px 8px 26px;border-radius:6px;background:#f9fafb;border:1px solid #e5e7eb;font-size:11px;color:#374151";
          for (const fact of request.context) {
            const item = document.createElement("li");
            item.style.cssText = "word-break:break-word";
            item.textContent = fact;
            facts.append(item);
          }
          body.append(heading("What was interacted with"), facts);
        }
        if (request.suggestions?.length) {
          // Grouped so a weak offer is never mistaken for a trustworthy one.
          const picker = document.createElement("select");
          picker.setAttribute("data-prompt-suggestions", "");
          picker.style.cssText =
            "width:100%;box-sizing:border-box;margin:0 0 6px;padding:7px 8px;border:1px solid #d1d5db;border-radius:6px;background:#fff;font:inherit;font-size:12px";
          const note = document.createElement("div");
          note.setAttribute("data-prompt-note", "");
          note.style.cssText =
            "margin:0 0 12px;font-size:11px;color:#6b7280;word-break:break-word";
          const groups = new Map<string, HTMLOptGroupElement>();
          for (const suggestion of request.suggestions) {
            let parent = groups.get(suggestion.group);
            if (!parent) {
              parent = document.createElement("optgroup");
              parent.label = suggestion.group;
              groups.set(suggestion.group, parent);
              picker.append(parent);
            }
            const option = document.createElement("option");
            option.value = suggestion.locator;
            option.textContent = suggestion.locator;
            option.dataset.note = suggestion.note;
            parent.append(option);
          }
          const describe = (): void => {
            const selected = picker.selectedOptions[0];
            note.textContent = selected
              ? `${selected.parentElement instanceof HTMLOptGroupElement ? `${selected.parentElement.label}: ` : ""}${selected.dataset.note ?? ""}`
              : "";
          };
          picker.addEventListener("change", () => {
            input.value = picker.value;
            describe();
            input.focus();
          });
          describe();
          body.append(heading("Suggested locators"), picker, note);
        }
        body.append(label, input);
        if (request.details) {
          const details = document.createElement("details");
          details.style.cssText = "margin-top:12px";
          const summary = document.createElement("summary");
          summary.style.cssText = "cursor:pointer;font-size:12px;color:#6d28d9";
          summary.textContent = request.detailsTruncated
            ? "Show the surrounding HTML (truncated)"
            : "Show the surrounding HTML";
          const copy = document.createElement("button");
          copy.type = "button";
          copy.textContent = "Copy raw HTML";
          copy.style.cssText =
            "display:block;margin:8px 0 0;padding:5px 8px;border:1px solid #d1d5db;background:#fff;border-radius:5px;cursor:pointer;font-size:11px";
          copy.addEventListener("click", () => {
            void navigator.clipboard.writeText(
              request.rawDetails ?? request.details ?? "",
            );
          });
          const pre = document.createElement("pre");
          pre.style.cssText =
            "margin:8px 0 0;padding:10px;max-height:300px;overflow:auto;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;font-size:11px;line-height:1.5;white-space:pre;tab-size:2";
          // Captured markup stays text here; it is never parsed as HTML.
          pre.textContent = request.details;
          details.append(summary, copy, pre);
          body.append(details);
        }
        const foot = document.createElement("div");
        foot.style.cssText =
          "padding:12px 16px;border-top:1px solid #f3f4f6;display:flex;justify-content:flex-end;gap:8px";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.setAttribute("data-modal-cancel", "");
        cancel.textContent = request.cancelLabel ?? "Skip";
        cancel.style.cssText =
          "padding:7px 12px;border:1px solid #d1d5db;background:#fff;color:#374151;border-radius:6px;cursor:pointer;font:inherit;font-size:12px";
        const confirm = document.createElement("button");
        confirm.type = "button";
        confirm.setAttribute("data-modal-confirm", "");
        confirm.textContent = request.confirmLabel ?? "Use value";
        confirm.style.cssText =
          "padding:7px 12px;border:1px solid #7c3aed;background:#7c3aed;color:#fff;border-radius:6px;cursor:pointer;font:inherit;font-size:12px;font-weight:600";
        foot.append(cancel, confirm);
        card.append(head, body, foot);
        overlay.append(card);
        const close = (result: string | null): void => {
          if (closeActiveModal !== close) return;
          closeActiveModal = undefined;
          overlay.remove();
          modalOpen = false;
          fit();
          resolve(result);
        };
        closeActiveModal = close;
        modalOpen = true;
        fit();
        confirm.addEventListener("click", () => {
          close(input.value);
        });
        cancel.addEventListener("click", () => {
          close(null);
        });
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            close(input.value);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            close(null);
          }
        });
        document.body.append(overlay);
        input.focus();
        input.select();
      });

    const bridge: ControlBridge = {
      render,
      settings: applySettings,
      status: (message) => {
        status.textContent = message;
      },
      capability: (message, available) => {
        capability.style.display = "block";
        capability.style.background = available ? "#f0fdf4" : "#fffbeb";
        capability.style.color = available ? "#15803d" : "#b45309";
        capability.textContent = message;
      },
      picking: setPicking,
      hold: setHold,
      prompt,
    };
    scope.__pwCodegenSmartControlBridge = bridge;

    renderMode(select.value || "auto");
    document.body.append(panel);
    new ResizeObserver(fit).observe(panel);
    void send({ kind: "refresh" }).then(apply);
    if (config.pollIntervalMs > 0)
      window.setInterval(() => {
        void send({ kind: "refresh" }).then(apply);
      }, config.pollIntervalMs);
  };

  mount();
}

/** Runs in the control surface: forwards one Node request to the bridge. */
function callBridge(call: BridgeCall): Promise<string | null> {
  const bridge = (window as unknown as Record<string, unknown>)
    .__pwCodegenSmartControlBridge as ControlBridge | undefined;
  if (!bridge) return Promise.resolve(null);
  switch (call.kind) {
    case "render":
      bridge.render(call.update);
      return Promise.resolve(null);
    case "settings":
      bridge.settings(call.settings);
      return Promise.resolve(null);
    case "status":
      bridge.status(call.message);
      return Promise.resolve(null);
    case "capability":
      bridge.capability(call.message, call.available);
      return Promise.resolve(null);
    case "picking":
      bridge.picking(call.active, call.message);
      return Promise.resolve(null);
    case "hold":
      bridge.hold(call.active, call.message);
      return Promise.resolve(null);
    case "prompt":
      return bridge.prompt(call.request);
  }
}

const isPage = (target: Page | BrowserContext): target is Page =>
  "context" in target;

/**
 * Shrinks the controls to the panel.
 *
 * `Target.createTarget` only honours a requested size while headless, so a
 * headed window opens at Chromium's default width with the panel adrift in
 * empty background. Setting the viewport is what resizes a headed Chromium
 * window, and it also keeps the emulated width the panel lays out against
 * equal to the width it is given. Contexts that emulate no viewport reject
 * that, so the window is then bounded over CDP instead.
 */
async function sizeControlWindow(
  session: CDPSession,
  page: Page,
  targetId: string,
  width: number,
  height: number,
): Promise<void> {
  const emulated = await page.setViewportSize({ width, height }).then(
    () => true,
    () => false,
  );
  if (emulated) return;
  const { windowId } = await session.send("Browser.getWindowForTarget", {
    targetId,
  });
  await session.send("Browser.setWindowBounds", {
    windowId,
    bounds: { width, height, windowState: "normal" },
  });
}

/**
 * Asks Chromium for a real OS window. Playwright cannot create one, so the
 * target is created over CDP in the same browser context and then matched to
 * the `page` event Playwright raises for it. Returns `null` when a window is
 * not available, leaving the caller to open a tab instead.
 */
async function openWindowPage(
  context: BrowserContext,
  reference: Page | undefined,
  options: RecorderControlOptions,
): Promise<Page | null> {
  const browser = context.browser();
  if (browser?.browserType().name() !== "chromium") return null;

  let browserContextId: string | undefined;
  if (reference) {
    const pageSession = await context.newCDPSession(reference);
    try {
      const info = await pageSession.send("Target.getTargetInfo");
      browserContextId = info.targetInfo.browserContextId;
    } finally {
      await pageSession.detach().catch(() => undefined);
    }
  }

  const width = options.width ?? defaultControlSize.width;
  const height = options.height ?? defaultControlSize.height;
  const browserSession = await browser.newBrowserCDPSession();
  try {
    // Subscribe before creating the target so the event cannot be missed.
    const appearing = context.waitForEvent("page", { timeout: 10_000 });
    const { targetId } = await browserSession.send("Target.createTarget", {
      url: "about:blank",
      newWindow: true,
      width,
      height,
      ...(browserContextId === undefined ? {} : { browserContextId }),
    });
    const created = await appearing;
    if (created === reference) return null;
    // The window is usable at any size, so keep it if resizing fails.
    await sizeControlWindow(
      browserSession,
      created,
      targetId,
      width,
      height,
    ).catch(() => undefined);
    return created;
  } finally {
    await browserSession.detach().catch(() => undefined);
  }
}

/**
 * Opens the recorder controls outside the recorded page.
 *
 * Pass the recorded page so the controls land in the same browser context and
 * can be created as a separate OS window; pass a context to place them in a new
 * tab of that context.
 */
export async function createRecorderControl(
  target: Page | BrowserContext,
  handlers: RecorderControlHandlers,
  options: RecorderControlOptions = {},
): Promise<RecorderControl> {
  const context = isPage(target) ? target.context() : target;
  const reference = isPage(target) ? target : context.pages()[0];

  let created: Page | null = null;
  if (options.separateWindow ?? true)
    created = await openWindowPage(context, reference, options).catch(
      () => null,
    );
  const ownsWindow = created !== null;
  const page = created ?? (await context.newPage());

  const width = options.width ?? defaultControlSize.width;
  const maxHeight = options.height ?? defaultControlSize.height;
  let windowHeight = maxHeight;
  /**
   * Follows the panel's height so the window shows no empty background. Only
   * a window of our own is resized; a fallback tab shares the recorded page's
   * window, which belongs to the application.
   */
  const fit = async (requested: number): Promise<void> => {
    const height = Math.min(Math.max(requested, minControlHeight), maxHeight);
    if (!ownsWindow || page.isClosed() || height === windowHeight) return;
    windowHeight = height;
    // Resizing needs an emulated viewport; the window stays as it is without.
    await page.setViewportSize({ width, height }).catch(() => undefined);
  };

  let prettyHtml: PrettyHtmlFormatter | null = options.prettyHtml ?? null;
  let lastUpdate: ControlPanelUpdate | undefined;
  let lastSettings: Partial<ControlSettings> = {};
  let closing = false;
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const dispatch = async (event: ControlEvent): Promise<ControlResponse> => {
    switch (event.kind) {
      case "settings": {
        const settings = await handlers.settings(event.patch);
        lastSettings = settings;
        return { settings };
      }
      case "refresh": {
        lastUpdate = await handlers.refresh();
        return { update: lastUpdate };
      }
      case "pick": {
        await handlers.pick?.(event.mode);
        return {};
      }
      case "releaseHold": {
        const update = await handlers.releaseHold?.();
        if (!update) return {};
        lastUpdate = update;
        return { update };
      }
      case "fit":
        await fit(event.height);
        return {};
      case "newTest":
        lastUpdate = await handlers.newTest();
        return { update: lastUpdate };
      case "deleteLine":
        lastUpdate = await handlers.deleteLine();
        return { update: lastUpdate };
      case "deleteTest":
        lastUpdate = await handlers.deleteTest();
        return { update: lastUpdate };
      case "deleteStep":
        lastUpdate = await handlers.deleteStep(event.index);
        return { update: lastUpdate };
      case "testMetadata":
        lastUpdate = await handlers.testMetadata(event.patch);
        return { update: lastUpdate };
      case "stop":
        await handlers.stop();
        return {};
    }
  };

  await page.exposeBinding(eventBinding, (_source, payload: unknown) =>
    dispatch(payload as ControlEvent),
  );

  const config: ControlPanelConfig = {
    title: options.title ?? "Smart Recorder controls",
    modeGroups: options.modeGroups ?? defaultControlModeGroups,
    pollIntervalMs: options.pollIntervalMs ?? 1000,
    panelWidth,
    panelMargin,
    listMaxHeight,
    maxHeight,
  };

  const call = async (payload: BridgeCall): Promise<string | null> => {
    if (page.isClosed()) return null;
    return page.evaluate(callBridge, payload).catch(() => null);
  };

  // The init script re-mounts the panel if the surface is reloaded; the
  // explicit evaluate covers the blank document it already has.
  await page.addInitScript(installControlPanel, config);
  const mount = async (): Promise<void> => {
    if (page.isClosed()) return;
    await page.evaluate(installControlPanel, config).catch(() => undefined);
    await call({ kind: "settings", settings: lastSettings });
    if (lastUpdate) await call({ kind: "render", update: lastUpdate });
  };
  page.on("load", () => {
    void mount();
  });
  page.on("close", () => {
    resolveClosed?.();
    handlers.onClose?.();
  });
  await mount();

  return {
    page,
    ownsWindow,
    closed,
    async update(update: ControlPanelUpdate): Promise<void> {
      lastUpdate = update;
      await call({ kind: "render", update });
    },
    async setSettings(settings: Partial<ControlSettings>): Promise<void> {
      lastSettings = { ...lastSettings, ...settings };
      await call({ kind: "settings", settings });
    },
    async setStatus(message: string): Promise<void> {
      await call({ kind: "status", message });
    },
    async setCapability(message: string, available: boolean): Promise<void> {
      await call({ kind: "capability", message, available });
    },
    async setPicking(active: boolean, message?: string): Promise<void> {
      await call({ kind: "picking", active, message: message ?? null });
    },
    async setHold(active: boolean, message?: string): Promise<void> {
      await call({ kind: "hold", active, message: message ?? null });
    },
    async prompt(request: ControlPromptRequest): Promise<string | null> {
      const details =
        request.details !== undefined && prettyHtml
          ? await Promise.resolve(prettyHtml(request.details)).catch(
              () => request.details,
            )
          : request.details;
      await page.bringToFront().catch(() => undefined);
      return call({
        kind: "prompt",
        request: {
          ...request,
          ...(request.details === undefined
            ? {}
            : { rawDetails: request.details }),
          ...(details === undefined ? {} : { details }),
        },
      });
    },
    setPrettyHtml(formatter: PrettyHtmlFormatter | null): void {
      prettyHtml = formatter;
    },
    isClosed(): boolean {
      return page.isClosed();
    },
    async close(): Promise<void> {
      if (closing) {
        await closed;
        return;
      }
      closing = true;
      if (!page.isClosed()) await page.close().catch(() => undefined);
      resolveClosed?.();
    },
  };
}

/** Alias for {@link createRecorderControl}. */
export const openRecorderControl = createRecorderControl;
