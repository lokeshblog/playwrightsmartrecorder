import type { Locator } from "playwright";
import type {
  AncestorContext,
  ElementContext,
  NearbyContext,
  RawDomContext,
  SiblingContext,
  SmartConfig,
} from "../types.js";

interface BrowserExtraction {
  pageHeading?: string;
  target: ElementContext;
  ancestors: AncestorContext[];
  siblings: SiblingContext[];
  nearby: NearbyContext[];
  containerHtml: string;
  containerHtmlTruncated: boolean;
}

export async function extractDomContext(
  locator: Locator,
  config: SmartConfig,
): Promise<RawDomContext> {
  const page = locator.page();
  const context = await locator.evaluate<BrowserExtraction, SmartConfig>(
    (element, options) => {
      const sensitive =
        /(password|token|authorization|cookie|secret|api[-_]?key|credit[-_]?card|cvv)/i;
      const clean = (value: string, key = ""): string =>
        sensitive.test(key) || sensitive.test(value)
          ? "[REDACTED]"
          : value.slice(0, 500);
      const text = (node: Element): string | undefined => {
        const value = node.textContent
          ?.replace(/\s+/g, " ")
          .trim()
          .slice(0, 300);
        return value || undefined;
      };
      const role = (node: Element): string | undefined => {
        const explicit = node.getAttribute("role");
        if (explicit) return explicit;
        const roles: Record<string, string> = {
          BUTTON: "button",
          A: node.hasAttribute("href") ? "link" : "",
          INPUT:
            node.getAttribute("type") === "checkbox"
              ? "checkbox"
              : node.getAttribute("type") === "radio"
                ? "radio"
                : node.getAttribute("type") === "submit"
                  ? "button"
                  : "textbox",
          SELECT: "combobox",
          TEXTAREA: "textbox",
          NAV: "navigation",
          MAIN: "main",
          FORM: "form",
          TABLE: "table",
          DIALOG: "dialog",
          H1: "heading",
          H2: "heading",
          H3: "heading",
        };
        return roles[node.tagName] || undefined;
      };
      const formControl = (node: Element): boolean =>
        node instanceof HTMLInputElement ||
        node instanceof HTMLSelectElement ||
        node instanceof HTMLTextAreaElement;
      // Option text is the value of a select, never part of a label name.
      const labelText = (
        label: Element,
        exclude?: Element,
      ): string | undefined => {
        const parts: string[] = [];
        const walk = (node: Node): void => {
          if (node === exclude) return;
          if (node.nodeType === Node.TEXT_NODE) {
            parts.push(node.textContent ?? "");
            return;
          }
          if (!(node instanceof Element)) return;
          if (
            node instanceof HTMLSelectElement ||
            node instanceof HTMLOptionElement
          )
            return;
          for (const child of [...node.childNodes]) walk(child);
        };
        walk(label);
        const value = parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 300);
        return value || undefined;
      };
      /** Text that contributes to a control name, excluding decorative icons. */
      const controlText = (control: Element): string | undefined => {
        const parts: string[] = [];
        const walk = (node: Node): void => {
          if (node.nodeType === Node.TEXT_NODE) {
            parts.push(node.textContent ?? "");
            return;
          }
          if (!(node instanceof Element)) return;
          if (
            node instanceof SVGElement ||
            node.getAttribute("aria-hidden") === "true" ||
            node.hasAttribute("icon") ||
            node.classList.contains("bp3-icon")
          )
            return;
          for (const child of [...node.childNodes]) walk(child);
        };
        walk(control);
        const value = parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 300);
        return value || undefined;
      };
      const accessibleName = (node: Element): string | undefined => {
        const labelledBy = node.getAttribute("aria-labelledby");
        if (labelledBy) {
          const label = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim())
            .filter(Boolean)
            .join(" ");
          if (label) return clean(label, "aria-labelledby");
        }
        for (const attr of ["aria-label", "alt", "title", "placeholder"]) {
          const value = node.getAttribute(attr);
          if (value) return clean(value, attr);
        }
        if (formControl(node) && node.id) {
          const label = document.querySelector(
            `label[for="${CSS.escape(node.id)}"]`,
          );
          const value = label ? labelText(label, node) : undefined;
          if (value) return clean(value, "label");
        }
        const wrappingLabel = node.closest("label");
        if (wrappingLabel) {
          const value = labelText(
            wrappingLabel,
            wrappingLabel === node ? undefined : node,
          );
          if (value) return clean(value, "label");
        }
        // Controls have no name of their own; their text is data, not identity.
        if (formControl(node)) return undefined;
        const own = controlText(node);
        // Descendant text joined across a container names the container's
        // contents, not the element, so it cannot serve as a name.
        if (
          !own ||
          own.length > 120 ||
          (node.childElementCount > 0 && own.length > 60)
        )
          return undefined;
        return clean(own, "text") || undefined;
      };
      const attributes = (node: Element): Record<string, string> => {
        const output: Record<string, string> = {};
        for (const attribute of [...node.attributes]) {
          const key = attribute.name;
          const permitted =
            [
              "id",
              "class",
              "name",
              "type",
              "placeholder",
              "title",
              "alt",
              "href",
              "value",
            ].includes(key) ||
            key.startsWith("aria-") ||
            key.startsWith("data-") ||
            options.applicationAttributes.includes(key);
          if (!permitted || options.avoidAttributes.includes(key)) continue;
          // Recorder markers describe the recorder, not the application.
          if (key.startsWith("data-pw-codegen-")) continue;
          if (
            key === "value" &&
            ["password", "hidden"].includes(node.getAttribute("type") ?? "")
          )
            continue;
          output[key] = clean(attribute.value, key);
        }
        return output;
      };
      const serialize = (
        node: Element,
        maximum: number,
      ): { html: string; truncated: boolean } => {
        const clone = node.cloneNode(true) as Element;
        for (const descendant of [clone, ...clone.querySelectorAll("*")]) {
          for (const attribute of [...descendant.attributes]) {
            if (
              sensitive.test(attribute.name) ||
              sensitive.test(attribute.value)
            )
              descendant.setAttribute(attribute.name, "[REDACTED]");
          }
          if (
            descendant instanceof HTMLInputElement ||
            descendant instanceof HTMLTextAreaElement ||
            descendant instanceof HTMLSelectElement
          ) {
            descendant.removeAttribute("value");
            if (descendant instanceof HTMLTextAreaElement)
              descendant.textContent = "";
          }
        }
        const html = clone.outerHTML;
        return {
          html: html.slice(0, maximum),
          truncated: html.length > maximum,
        };
      };
      const describe = (node: Element, includeHtml = false): ElementContext => {
        const result: ElementContext = {
          tag: node.tagName.toLowerCase(),
          childElementCount: node.childElementCount,
          attributes: attributes(node),
        };
        // A form control's descendant text is value data (for example all
        // <option> labels), not a stable name for the control itself.
        const nodeText = formControl(node) ? undefined : text(node);
        const name = accessibleName(node);
        const nodeRole = role(node);
        if (nodeText) result.text = nodeText;
        if (name) result.accessibleName = name;
        if (nodeRole) result.role = nodeRole;
        if (includeHtml) result.html = serialize(node, 2_000).html;
        return result;
      };
      const isBoundary = (node: Element): boolean =>
        options.semanticBoundaries.includes(node.tagName.toLowerCase()) ||
        options.semanticBoundaries.includes(node.getAttribute("role") ?? "") ||
        options.preferredAttributes.some((attribute) =>
          node.hasAttribute(attribute),
        ) ||
        options.applicationAttributes.some((attribute) =>
          node.hasAttribute(attribute),
        );

      const ancestors: AncestorContext[] = [];
      let parent = element.parentElement;
      let semanticContainer: Element | null = null;
      for (
        let depth = 1;
        parent && depth <= options.maxAncestorDepth;
        depth += 1
      ) {
        const boundary = isBoundary(parent);
        ancestors.push({ ...describe(parent), depth, boundary });
        if (boundary) {
          semanticContainer = parent;
          break;
        }
        parent = parent.parentElement;
      }

      const siblings: SiblingContext[] = [];
      if (element.previousElementSibling)
        siblings.push({
          ...describe(element.previousElementSibling),
          relation: "previous",
        });
      if (element.nextElementSibling)
        siblings.push({
          ...describe(element.nextElementSibling),
          relation: "next",
        });
      const parentSiblings = element.parentElement
        ? [...element.parentElement.children].filter(
            (item) =>
              item !== element &&
              item !== element.previousElementSibling &&
              item !== element.nextElementSibling,
          )
        : [];
      for (const sibling of parentSiblings.slice(0, 3))
        siblings.push({ ...describe(sibling), relation: "relevant" });

      const nearby: NearbyContext[] = [];
      const scope =
        element.closest(options.semanticBoundaries.join(",")) ??
        element.parentElement;
      if (scope) {
        const candidates = scope.querySelectorAll(
          "label,h1,h2,h3,h4,h5,h6,input,select,textarea,button,a,[role]",
        );
        for (const candidate of [...candidates]) {
          if (
            candidate === element ||
            candidate.contains(element) ||
            element.contains(candidate)
          )
            continue;
          const tag = candidate.tagName.toLowerCase();
          const relationship: NearbyContext["relationship"] =
            tag === "label"
              ? "label"
              : /^h[1-6]$/.test(tag)
                ? "heading"
                : ["input", "select", "textarea", "button"].includes(tag)
                  ? "control"
                  : "semantic";
          nearby.push({ ...describe(candidate), relationship });
          if (nearby.length >= options.nearbyElementLimit) break;
        }
      }
      const container = serialize(
        semanticContainer ?? element.parentElement ?? element,
        options.maxContainerHtmlLength,
      );
      const heading = [...document.querySelectorAll("h1,h2,[role='heading']")]
        .map((node) => text(node))
        .find((value) => value !== undefined);
      return {
        ...(heading ? { pageHeading: heading } : {}),
        target: describe(element, true),
        ancestors,
        siblings,
        nearby,
        containerHtml: container.html,
        containerHtmlTruncated: container.truncated,
      };
    },
    config,
  );
  return { url: page.url(), ...context };
}
