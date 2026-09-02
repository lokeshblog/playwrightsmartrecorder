import {
  chromium,
  type Browser,
  type BrowserContext,
  type Frame,
  type Page,
} from "playwright";
import { extractDomContext } from "../context/extract.js";
import { analyzeContext } from "../locator/analyze.js";
import type { LocatorContext, SmartConfig } from "../types.js";

const marker = "data-pw-codegen-smart-target";

export interface BrowserOptions {
  url: string;
  cdp?: string;
  headless?: boolean;
}

export async function withPage<T>(
  options: BrowserOptions,
  operation: (page: Page) => Promise<T>,
): Promise<T> {
  let browser: Browser;
  let context: BrowserContext;
  if (options.cdp) {
    browser = await chromium.connectOverCDP(options.cdp);
    context = browser.contexts()[0] ?? (await browser.newContext());
  } else {
    browser = await chromium.launch({ headless: options.headless ?? false });
    context = await browser.newContext();
  }
  const page = context.pages()[0] ?? (await context.newPage());
  if (options.url && page.url() !== options.url) await page.goto(options.url);
  try {
    return await operation(page);
  } finally {
    await browser.close();
  }
}

export async function captureSelection(
  page: Page,
  config: SmartConfig,
): Promise<LocatorContext> {
  let resolveSelection: ((frame: Frame) => void) | undefined;
  const selected = new Promise<Frame>((resolve) => {
    resolveSelection = resolve;
  });
  await page.exposeBinding("__pwCodegenSmartSelected", ({ frame }) =>
    resolveSelection?.(frame),
  );
  const installPicker = (): void => {
    if ((window as unknown as Record<string, unknown>).__pwCodegenSmartPicker)
      return;
    (window as unknown as Record<string, unknown>).__pwCodegenSmartPicker =
      true;
    const style = document.createElement("style");
    style.dataset.pwCodegenSmart = "true";
    style.textContent =
      "[data-pw-codegen-smart-hover]{outline:3px solid #7c3aed!important;outline-offset:2px!important;cursor:crosshair!important}";
    const addStyle = (): void => {
      if (!document.querySelector("style[data-pw-codegen-smart]"))
        document.documentElement?.append(style);
    };
    if (document.documentElement) addStyle();
    else
      document.addEventListener("DOMContentLoaded", addStyle, { once: true });
    let hovered: Element | null = null;
    document.addEventListener(
      "pointerover",
      (event) => {
        const target = event.composedPath()[0];
        if (!(target instanceof Element)) return;
        hovered?.removeAttribute("data-pw-codegen-smart-hover");
        hovered = target;
        target.setAttribute("data-pw-codegen-smart-hover", "");
      },
      true,
    );
    document.addEventListener(
      "click",
      (event) => {
        const target = event.composedPath()[0];
        if (!(target instanceof Element)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        target.removeAttribute("data-pw-codegen-smart-hover");
        target.setAttribute("data-pw-codegen-smart-target", "");
        const callback = (window as unknown as Record<string, () => void>)
          .__pwCodegenSmartSelected;
        callback?.();
      },
      true,
    );
  };
  await page.addInitScript(installPicker);
  await page.evaluate(installPicker);
  const selectedFrame = await selected;
  const target = selectedFrame.locator(`[${marker}]`).first();
  const raw = await extractDomContext(target, config);
  const result = await analyzeContext(selectedFrame, raw, config);
  await target.evaluate((element) =>
    element.removeAttribute("data-pw-codegen-smart-target"),
  );
  return result;
}
