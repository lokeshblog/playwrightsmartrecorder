import type { CDPSession, Frame, Locator, Page } from "playwright";

/** Attribute stamped on the picked element so Playwright can locate it again. */
export const pickerMarkerAttribute = "data-pw-codegen-smart-pick";

/** How the element was selected. */
export type PickStrategy = "cdp" | "dom";

/**
 * What the attached Chromium target actually supports. Every field is probed
 * with a harmless no-op command so a partially capable target still picks.
 */
export interface PickerCapabilities {
  /** A page-level CDP session is attached. */
  cdp: boolean;
  /** `Overlay.setInspectMode` is usable, so Chromium draws the picker overlay. */
  inspectMode: boolean;
  /** `Emulation.setScriptExecutionDisabled` is usable. */
  freezeScripts: boolean;
  /** `Animation.setPlaybackRate` is usable. */
  freezeAnimations: boolean;
  /** `DOM.setAttributeValue` is usable, so markers attach without page script. */
  domMutation: boolean;
}

export interface PickedElement {
  /** Frame that owns the picked element. */
  frame: Frame;
  /** Locator resolving the marked element inside {@link PickedElement.frame}. */
  locator: Locator;
  /** Value written into the marker attribute. */
  markerId: string;
  /** Attribute name used for the marker. */
  markerAttribute: string;
  /** `[attribute="markerId"]`, ready for `extractDomContext`/`analyzeContext`. */
  selector: string;
  strategy: PickStrategy;
  /** Resume a frozen application after locator context has been captured. */
  release(): Promise<void>;
}

export interface ElementPickerOptions {
  /** Defaults to {@link pickerMarkerAttribute}. */
  markerAttribute?: string | undefined;
  /** Disable page script while the overlay is open. Defaults to true. */
  freezeScripts?: boolean | undefined;
  /** Pause CSS/Web animations while the overlay is open. Defaults to true. */
  freezeAnimations?: boolean | undefined;
  /** Fall back to the in-page picker when CDP cannot pick. Defaults to true. */
  allowDomFallback?: boolean | undefined;
  /** Progress messages suitable for a status line. */
  onStatus?: ((message: string) => void) | undefined;
}

export interface PickOptions {
  /** Give up after this long and resolve `null`. Defaults to no timeout. */
  timeoutMs?: number | undefined;
  /** Cancels the pick when aborted; resolves `null`. */
  signal?: AbortSignal | undefined;
}

export interface ElementPicker {
  readonly capabilities: PickerCapabilities;
  /** Strategy the next {@link ElementPicker.pick} will attempt first. */
  readonly strategy: PickStrategy;
  /** True while an overlay is open and waiting for the user. */
  readonly picking: boolean;
  /**
   * Opens the picker and resolves the marked element, or `null` when the pick
   * was cancelled, timed out, or the page closed. A successful CDP pick stays
   * frozen until `PickedElement.release()`; cancellation and errors resume it.
   */
  pick(options?: PickOptions): Promise<PickedElement | null>;
  /** Cancels an in-flight {@link ElementPicker.pick}. Safe to call when idle. */
  cancel(): Promise<void>;
  /** Removes every marker attribute this picker wrote, in all frames. */
  clearMarkers(): Promise<void>;
  /** Cancels, resumes the page, and detaches the CDP session. */
  dispose(): Promise<void>;
}

/** Purple overlay matching the recorder panel. */
const highlightConfig = {
  showInfo: true,
  showStyles: false,
  showRulers: false,
  showAccessibilityInfo: true,
  showExtensionLines: false,
  contentColor: { r: 124, g: 58, b: 237, a: 0.24 },
  paddingColor: { r: 147, g: 197, b: 253, a: 0.3 },
  borderColor: { r: 124, g: 58, b: 237, a: 0.7 },
  marginColor: { r: 251, g: 191, b: 36, a: 0.3 },
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Leaves inspect mode.
 *
 * Chromium rejects `Overlay.setInspectMode` when `highlightConfig` is absent,
 * even for `mode: "none"`, and a rejected call leaves the overlay swallowing
 * every mouse event in the page. The config must therefore always be sent.
 */
async function stopInspectMode(session: CDPSession): Promise<void> {
  await session
    .send("Overlay.setInspectMode", { mode: "none", highlightConfig: {} })
    .catch(() => undefined);
}

/**
 * Raised when Chromium picked a node this session cannot mark — most often an
 * out-of-process iframe, whose nodes belong to a different CDP target. The
 * picker retries with the in-page strategy instead of failing the pick.
 */
class UnreachableNodeError extends Error {}

/** Node-side half of the in-page picker, shared by every picker on a page. */
interface DomPickerBridge {
  handler: ((frame: Frame, markerId: string) => void) | undefined;
}

/**
 * `exposeBinding` and `addInitScript` both throw or accumulate when repeated on
 * one page, so the in-page picker is installed once and its handler is swapped.
 */
const domBridges = new WeakMap<Page, Promise<DomPickerBridge>>();

/** Runs in the page: hover outline plus a one-shot capture-phase click. */
function installDomPicker(attribute: string): void {
  const scope = window as unknown as Record<string, unknown>;
  if (scope.__pwCodegenSmartPickController) return;
  const hoverAttribute = `${attribute}-hover`;
  let active = false;
  let sequence = 0;
  let hovered: Element | null = null;

  const addStyle = (): void => {
    const id = "pw-codegen-smart-pick-style";
    if (document.getElementById(id) || !document.documentElement) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = `[${hoverAttribute}]{outline:3px solid #7c3aed!important;outline-offset:2px!important;cursor:crosshair!important}`;
    document.documentElement.append(style);
  };
  const clearHover = (): void => {
    hovered?.removeAttribute(hoverAttribute);
    hovered = null;
  };
  const stop = (): void => {
    active = false;
    clearHover();
  };

  document.addEventListener(
    "pointerover",
    (event) => {
      if (!active) return;
      const target = event.composedPath()[0];
      if (!(target instanceof Element)) return;
      if (target.closest("[data-pw-codegen-smart-controls]")) return;
      clearHover();
      hovered = target;
      target.setAttribute(hoverAttribute, "");
    },
    true,
  );
  document.addEventListener(
    "click",
    (event) => {
      if (!active) return;
      const target = event.composedPath()[0];
      if (!(target instanceof Element)) return;
      if (target.closest("[data-pw-codegen-smart-controls]")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      stop();
      sequence += 1;
      const markerId = `${Date.now().toString(36)}-${String(sequence)}`;
      target.setAttribute(attribute, markerId);
      (
        scope.__pwCodegenSmartPicked as
          ((payload: { id: string }) => void) | undefined
      )?.({ id: markerId });
    },
    true,
  );

  scope.__pwCodegenSmartPickController = {
    start: (): void => {
      active = true;
      addStyle();
    },
    stop,
  };
}

async function ensureDomBridge(
  page: Page,
  attribute: string,
): Promise<DomPickerBridge> {
  const existing = domBridges.get(page);
  if (existing) return existing;
  const pending = (async (): Promise<DomPickerBridge> => {
    const bridge: DomPickerBridge = { handler: undefined };
    await page
      .exposeBinding(
        "__pwCodegenSmartPicked",
        ({ frame }, payload: unknown) => {
          const { id } = payload as { id: string };
          bridge.handler?.(frame, id);
        },
      )
      .catch(() => undefined);
    await page.addInitScript(installDomPicker, attribute);
    return bridge;
  })();
  domBridges.set(page, pending);
  return pending;
}

/**
 * Toggles the in-page picker in the main frame and every child frame.
 *
 * `addInitScript` only reaches documents created after it is registered, so
 * every activation also installs the picker into the documents that already
 * exist. The installer is idempotent, so repeating it is free.
 */
async function setDomPickerActive(
  page: Page,
  attribute: string,
  active: boolean,
): Promise<void> {
  if (active)
    await Promise.all(
      page
        .frames()
        .map((frame) =>
          frame.evaluate(installDomPicker, attribute).catch(() => undefined),
        ),
    );
  await Promise.all(
    page.frames().map((frame) =>
      frame
        .evaluate((shouldStart) => {
          const controller = (window as unknown as Record<string, unknown>)
            .__pwCodegenSmartPickController as
            { start: () => void; stop: () => void } | undefined;
          if (!controller) return;
          if (shouldStart) controller.start();
          else controller.stop();
        }, active)
        .catch(() => undefined),
    ),
  );
}

async function attachSession(page: Page): Promise<CDPSession | null> {
  const context = page.context();
  const browser = context.browser();
  if (browser && browser.browserType().name() !== "chromium") return null;
  try {
    return await context.newCDPSession(page);
  } catch {
    return null;
  }
}

/** Probes a command with arguments that leave the target unchanged. */
async function probe(attempt: () => Promise<unknown>): Promise<boolean> {
  try {
    await attempt();
    return true;
  } catch {
    return false;
  }
}

async function detectCapabilities(
  session: CDPSession,
): Promise<PickerCapabilities> {
  const domMutation = await probe(() => session.send("DOM.enable"));
  const inspectMode = await probe(() => session.send("Overlay.enable"));
  const freezeScripts = await probe(() =>
    session.send("Emulation.setScriptExecutionDisabled", { value: false }),
  );
  const freezeAnimations =
    (await probe(() => session.send("Animation.enable"))) &&
    (await probe(() =>
      session.send("Animation.setPlaybackRate", { playbackRate: 1 }),
    ));
  return {
    cdp: true,
    inspectMode,
    freezeScripts,
    freezeAnimations,
    domMutation,
  };
}

/**
 * Finds the frame holding the marker. Playwright does not expose CDP frame ids,
 * so the marker itself identifies the frame: the attribute value is unique, so
 * exactly one frame reports a single match.
 */
async function locateMarkerFrame(
  page: Page,
  selector: string,
): Promise<Frame | null> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    for (const frame of page.frames()) {
      const count = await frame
        .locator(selector)
        .count()
        .catch(() => 0);
      if (count === 1) return frame;
    }
    await delay(50);
  }
  return null;
}

export async function createElementPicker(
  page: Page,
  options: ElementPickerOptions = {},
): Promise<ElementPicker> {
  const markerAttribute = options.markerAttribute ?? pickerMarkerAttribute;
  const wantsScriptFreeze = options.freezeScripts ?? true;
  const wantsAnimationFreeze = options.freezeAnimations ?? true;
  const allowDomFallback = options.allowDomFallback ?? true;
  const status = (message: string): void => options.onStatus?.(message);

  const session = await attachSession(page);
  const capabilities: PickerCapabilities = session
    ? await detectCapabilities(session)
    : {
        cdp: false,
        inspectMode: false,
        freezeScripts: false,
        freezeAnimations: false,
        domMutation: false,
      };
  const canUseCdp = Boolean(
    session && capabilities.inspectMode && capabilities.domMutation,
  );
  const strategy: PickStrategy = canUseCdp ? "cdp" : "dom";
  const bridge = await ensureDomBridge(page, markerAttribute);

  let picking = false;
  let cancelCurrent: (() => void) | undefined;

  const freeze = async (active: CDPSession): Promise<void> => {
    if (wantsScriptFreeze && capabilities.freezeScripts)
      await active
        .send("Emulation.setScriptExecutionDisabled", { value: true })
        .catch(() => undefined);
    if (wantsAnimationFreeze && capabilities.freezeAnimations)
      await active
        .send("Animation.setPlaybackRate", { playbackRate: 0 })
        .catch(() => undefined);
  };
  /**
   * Never throws, and is safe to repeat: a frozen page or a live inspect
   * overlay left behind would make the application unusable.
   */
  const resume = async (active: CDPSession): Promise<void> => {
    await stopInspectMode(active);
    await active.send("Overlay.disable").catch(() => undefined);
    if (wantsScriptFreeze && capabilities.freezeScripts)
      await active
        .send("Emulation.setScriptExecutionDisabled", { value: false })
        .catch(() => undefined);
    if (wantsAnimationFreeze && capabilities.freezeAnimations)
      await active
        .send("Animation.setPlaybackRate", { playbackRate: 1 })
        .catch(() => undefined);
  };

  const attachMarker = async (
    active: CDPSession,
    backendNodeId: number,
    markerId: string,
  ): Promise<void> => {
    // Pure protocol calls: no page script runs, so the application cannot
    // observe or undo the marker while it is frozen.
    await active.send("DOM.getDocument", { depth: 0 });
    const pushed = await active.send("DOM.pushNodesByBackendIdsToFrontend", {
      backendNodeIds: [backendNodeId],
    });
    const nodeId = pushed.nodeIds[0];
    if (nodeId === undefined || nodeId === 0)
      throw new UnreachableNodeError(
        "The picked node belongs to another Chromium target.",
      );
    await active.send("DOM.setAttributeValue", {
      nodeId,
      name: markerAttribute,
      value: markerId,
    });
  };

  let sequence = 0;
  const nextMarkerId = (): string => {
    sequence += 1;
    return `${Date.now().toString(36)}-${String(sequence)}`;
  };

  const pickWithCdp = async (
    active: CDPSession,
    pickOptions: PickOptions,
  ): Promise<PickedElement | null> => {
    const markerId = nextMarkerId();
    let settle: ((backendNodeId: number | null) => void) | undefined;
    const selected = new Promise<number | null>((resolve) => {
      settle = resolve;
    });
    const cancelPick = (): void => settle?.(null);
    const onInspect = (payload: { backendNodeId: number }): void =>
      settle?.(payload.backendNodeId);
    const timer =
      pickOptions.timeoutMs === undefined
        ? undefined
        : setTimeout(cancelPick, pickOptions.timeoutMs);

    active.on("Overlay.inspectNodeRequested", onInspect);
    page.on("close", cancelPick);
    pickOptions.signal?.addEventListener("abort", cancelPick, { once: true });
    cancelCurrent = cancelPick;

    let backendNodeId: number | null = null;
    let keepFrozen = false;
    try {
      await freeze(active);
      await active.send("Overlay.enable");
      await active.send("Overlay.setInspectMode", {
        mode: "searchForNode",
        highlightConfig,
      });
      status(
        `Picker ready (${markerId}) — select an element in the application window.`,
      );
      backendNodeId = await selected;
      if (backendNodeId === null) return null;
      await attachMarker(active, backendNodeId, markerId);
      keepFrozen = true;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      pickOptions.signal?.removeEventListener("abort", cancelPick);
      page.off("close", cancelPick);
      active.off("Overlay.inspectNodeRequested", onInspect);
      cancelCurrent = undefined;
      await stopInspectMode(active);
      if (!keepFrozen) await resume(active);
    }

    const selector = `[${markerAttribute}="${markerId}"]`;
    const frame = await locateMarkerFrame(page, selector);
    if (!frame) {
      await resume(active);
      throw new UnreachableNodeError(
        "The marked element was not found in any frame of this page.",
      );
    }
    return {
      frame,
      locator: frame.locator(selector).first(),
      markerId,
      markerAttribute,
      selector,
      strategy: "cdp",
      release: () => resume(active),
    };
  };

  const pickWithDom = async (
    pickOptions: PickOptions,
  ): Promise<PickedElement | null> => {
    let settle:
      ((picked: { frame: Frame; markerId: string } | null) => void) | undefined;
    const selected = new Promise<{ frame: Frame; markerId: string } | null>(
      (resolve) => {
        settle = resolve;
      },
    );
    const cancelPick = (): void => settle?.(null);
    const timer =
      pickOptions.timeoutMs === undefined
        ? undefined
        : setTimeout(cancelPick, pickOptions.timeoutMs);

    bridge.handler = (frame, markerId) => settle?.({ frame, markerId });
    page.on("close", cancelPick);
    pickOptions.signal?.addEventListener("abort", cancelPick, { once: true });
    cancelCurrent = cancelPick;

    let picked: { frame: Frame; markerId: string } | null = null;
    try {
      // Animations can still be paused without the overlay; script freezing
      // cannot, because the in-page picker needs its own listeners to run.
      if (session && wantsAnimationFreeze && capabilities.freezeAnimations)
        await session
          .send("Animation.setPlaybackRate", { playbackRate: 0 })
          .catch(() => undefined);
      await setDomPickerActive(page, markerAttribute, true);
      status("Picker ready — select an element in the application window.");
      picked = await selected;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      pickOptions.signal?.removeEventListener("abort", cancelPick);
      page.off("close", cancelPick);
      bridge.handler = undefined;
      cancelCurrent = undefined;
      await setDomPickerActive(page, markerAttribute, false).catch(
        () => undefined,
      );
      if (session && wantsAnimationFreeze && capabilities.freezeAnimations)
        await session
          .send("Animation.setPlaybackRate", { playbackRate: 1 })
          .catch(() => undefined);
    }
    if (!picked) return null;
    const selector = `[${markerAttribute}="${picked.markerId}"]`;
    return {
      frame: picked.frame,
      locator: picked.frame.locator(selector).first(),
      markerId: picked.markerId,
      markerAttribute,
      selector,
      strategy: "dom",
      release: () => Promise.resolve(),
    };
  };

  const picker: ElementPicker = {
    capabilities,
    strategy,
    get picking(): boolean {
      return picking;
    },
    async pick(pickOptions: PickOptions = {}): Promise<PickedElement | null> {
      if (picking) throw new Error("A pick is already in progress.");
      picking = true;
      try {
        if (session && canUseCdp) {
          try {
            return await pickWithCdp(session, pickOptions);
          } catch (error) {
            if (!(error instanceof UnreachableNodeError) || !allowDomFallback)
              throw error;
            status(`${error.message} Falling back to the in-page picker.`);
          }
        }
        return await pickWithDom(pickOptions);
      } finally {
        picking = false;
      }
    },
    async cancel(): Promise<void> {
      cancelCurrent?.();
      await setDomPickerActive(page, markerAttribute, false).catch(
        () => undefined,
      );
      if (session) {
        await stopInspectMode(session);
        await resume(session);
      }
    },
    async clearMarkers(): Promise<void> {
      await Promise.all(
        page.frames().map((frame) =>
          frame
            .evaluate((name) => {
              for (const element of document.querySelectorAll(`[${name}]`))
                element.removeAttribute(name);
              for (const element of document.querySelectorAll(
                `[${name}-hover]`,
              ))
                element.removeAttribute(`${name}-hover`);
            }, markerAttribute)
            .catch(() => undefined),
        ),
      );
    },
    async dispose(): Promise<void> {
      cancelCurrent?.();
      cancelCurrent = undefined;
      if (!session) return;
      await stopInspectMode(session);
      await resume(session);
      await session.detach().catch(() => undefined);
    },
  };
  return picker;
}
