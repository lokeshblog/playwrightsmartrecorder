/**
 * Decides whether a locator drives the same action as the recorded element.
 *
 * The body must stay self contained: it is serialized into the page by
 * `Locator.evaluateAll`, so it cannot reference anything outside itself.
 */
export function resolvesToActionTarget(
  elements: Element[],
  targetSelector: string,
): boolean {
  const label = (node: Element): string =>
    (node.textContent ?? "").replace(/\s+/g, " ").trim();
  return elements.some((element) => {
    if (element.matches(targetSelector)) return true;
    const owner = element.closest(targetSelector);
    if (owner) return label(element) === label(owner);
    const inner = element.querySelector(targetSelector);
    return (
      inner !== null &&
      element.children.length === 1 &&
      label(element) === label(inner)
    );
  });
}
