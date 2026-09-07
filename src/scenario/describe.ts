import type { ElementContext, LocatorContext } from "../types.js";

/** Long text identifies a container rather than the element, so it is dropped. */
function short(value: string | undefined, limit = 80): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text || text.length > limit) return undefined;
  return text;
}

function name(element: ElementContext): string | undefined {
  return short(element.accessibleName) ?? short(element.text);
}

/** Markup identity, used when the element has no name of its own. */
function marker(element: ElementContext): string | undefined {
  const attributes = element.attributes;
  for (const key of ["data-testid", "data-test-id", "name", "id"]) {
    const value = attributes[key];
    if (value) return `${key}="${value}"`;
  }
  return undefined;
}

function tag(element: ElementContext): string {
  const identity = marker(element);
  return identity ? `<${element.tag} ${identity}>` : `<${element.tag}>`;
}

/** The nearest named thing around the element, closest first. */
function surroundings(context: LocatorContext): string | undefined {
  for (const ancestor of context.ancestors) {
    const label = name(ancestor);
    if (label) return label;
  }
  for (const relationship of ["label", "heading", "semantic", "control"]) {
    const near = context.nearby.find(
      (item) => item.relationship === relationship && name(item),
    );
    if (near) return name(near);
  }
  for (const sibling of context.siblings) {
    const label = name(sibling);
    if (label) return label;
  }
  return undefined;
}

/**
 * What to call the element in a business step.
 *
 * Icons, spans and wrappers frequently have no name of their own, and a bare
 * `<span>` says nothing about what the step did. Naming what surrounds the
 * element keeps such a step recognisable.
 */
export function describeTarget(context: LocatorContext): string {
  const { target } = context;
  const own = name(target) ?? marker(target);
  if (own) return own;
  const around = surroundings(context);
  return around ? `${tag(target)} in "${around}"` : tag(target);
}

/**
 * Evidence about the element, for whoever has to repair the step later.
 *
 * A weak step reaches the generated test as a locator nobody can read, so the
 * facts that identify the element are recorded alongside it.
 */
export function summarizeTarget(context: LocatorContext): string[] {
  const { target } = context;
  const facts = [`element: ${tag(target)}`];
  if (target.role) facts.push(`role: ${target.role}`);
  const targetName = short(target.accessibleName);
  if (targetName) facts.push(`name: "${targetName}"`);
  const text = short(target.text, 120);
  if (text && text !== targetName) facts.push(`text: "${text}"`);
  for (const key of ["type", "placeholder", "href", "class"]) {
    const value = short(target.attributes[key], 120);
    if (value) facts.push(`${key}: "${value}"`);
  }
  if (context.ancestors.length)
    facts.push(
      `path: ${[...context.ancestors]
        .reverse()
        .map((ancestor) => tag(ancestor))
        .join(" > ")} > ${tag(target)}`,
    );
  // A container whose label repeats the target only says it holds the target.
  const own = name(target);
  const container = context.ancestors.find((ancestor) => {
    const label = name(ancestor);
    return label !== undefined && (!own || !label.includes(own));
  });
  const containerName = container ? name(container) : undefined;
  if (container && containerName)
    facts.push(
      `inside: ${tag(container)} "${containerName}" (${String(container.depth)} level${container.depth === 1 ? "" : "s"} up)`,
    );
  const near = context.nearby
    .map((item) => {
      const label = name(item);
      return label ? `"${label}" (${item.relationship})` : undefined;
    })
    .filter((value): value is string => value !== undefined)
    .slice(0, 3);
  if (near.length) facts.push(`near: ${near.join(", ")}`);
  return facts;
}
