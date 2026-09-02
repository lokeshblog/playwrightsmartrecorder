import type { Frame, Locator, Page } from "playwright";
import type {
  CodegenLocator,
  LocatorCandidate,
  RawDomContext,
  RejectedCandidate,
  SmartConfig,
} from "../types.js";

type Draft = Pick<LocatorCandidate, "locator" | "kind" | "evidence"> & {
  generated?: boolean | undefined;
};

const quote = (value: string): string => JSON.stringify(value);

export function isGeneratedValue(value: string, config: SmartConfig): boolean {
  return config.generatedValuePatterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(value);
    } catch {
      return false;
    }
  });
}

export function generateCandidates(
  context: RawDomContext,
  config: SmartConfig,
): { candidates: Draft[]; rejected: RejectedCandidate[] } {
  const { target } = context;
  const drafts: Draft[] = [];
  const rejected: RejectedCandidate[] = [];
  const add = (candidate: Draft): void => {
    if (!drafts.some(({ locator }) => locator === candidate.locator))
      drafts.push(candidate);
  };

  for (const attribute of config.preferredAttributes) {
    const value = target.attributes[attribute];
    if (!value) continue;
    if (attribute === "data-testid")
      add({
        locator: `getByTestId(${quote(value)})`,
        kind: "testId",
        evidence: ["stable data-testid"],
      });
    else
      add({
        locator: `locator(${quote(`[${attribute}="${CSS_ESCAPE(value)}"]`)})`,
        kind: "applicationAttribute",
        evidence: [`preferred ${attribute} attribute`],
      });
  }
  for (const attribute of config.applicationAttributes) {
    const value = target.attributes[attribute];
    if (value)
      add({
        locator: `locator(${quote(`[${attribute}="${CSS_ESCAPE(value)}"]`)})`,
        kind: "applicationAttribute",
        evidence: [`stable application attribute: ${attribute}`],
      });
  }
  if (target.role && target.accessibleName)
    add({
      locator: `getByRole(${quote(target.role)}, { name: ${quote(target.accessibleName)}, exact: true })`,
      kind: "role",
      evidence: ["semantic role", "accessible name"],
    });
  if (
    ["input", "textarea", "select"].includes(target.tag) &&
    target.accessibleName
  )
    add({
      locator: `getByLabel(${quote(target.accessibleName)}, { exact: true })`,
      kind: "label",
      evidence: ["associated accessible label"],
    });
  const placeholder = target.attributes.placeholder;
  if (placeholder)
    add({
      locator: `getByPlaceholder(${quote(placeholder)}, { exact: true })`,
      kind: "placeholder",
      evidence: ["placeholder"],
    });
  const id = target.attributes.id;
  if (id) {
    const generated = isGeneratedValue(id, config);
    if (generated)
      rejected.push({
        locator: `locator(${quote(`#${CSS_ESCAPE(id)}`)})`,
        reason: "generated-looking ID",
      });
    else
      add({
        locator: `locator(${quote(`#${CSS_ESCAPE(id)}`)})`,
        kind: "id",
        evidence: ["stable ID"],
      });
  }
  const leafLike = (target.childElementCount ?? 0) === 0;
  if (
    target.text &&
    target.text.length <= 120 &&
    (leafLike || target.text.length <= 60)
  )
    add({
      locator: `getByText(${quote(target.text)}, { exact: true })`,
      kind: "text",
      evidence: ["visible text"],
    });
  const name = target.attributes.name;
  if (name && !isGeneratedValue(name, config))
    add({
      locator: `locator(${quote(`${target.tag}[name="${CSS_ESCAPE(name)}"]`)})`,
      kind: "css",
      evidence: ["name attribute"],
    });
  const classToken = target.attributes.class
    ?.split(/\s+/)
    .find((value) => value && !isGeneratedValue(value, config));
  if (classToken)
    add({
      locator: `locator(${quote(`${target.tag}[class~="${CSS_ESCAPE(classToken)}"]`)})`,
      kind: "css",
      evidence: ["class fallback"],
    });
  add({
    locator: `locator(${quote(target.tag)})`,
    kind: "css",
    evidence: ["target tag fallback"],
  });

  const child =
    drafts.find(({ kind }) => kind === "role") ??
    drafts.find(({ kind }) => kind === "label") ??
    drafts.find(({ kind }) => kind === "text");
  if (child) {
    for (const ancestor of context.ancestors) {
      const stable = [
        ...config.preferredAttributes,
        ...config.applicationAttributes,
      ]
        .map(
          (attribute) => [attribute, ancestor.attributes[attribute]] as const,
        )
        .find(([, value]) => Boolean(value));
      if (!stable) continue;
      const [attribute, value] = stable;
      const parent =
        attribute === "data-testid"
          ? `getByTestId(${quote(value!)})`
          : `locator(${quote(`[${attribute}="${CSS_ESCAPE(value!)}"]`)})`;
      add({
        locator: `${parent}.${child.locator}`,
        kind: "scoped",
        evidence: [...child.evidence, `scoped by stable ${attribute}`],
      });
      break;
    }
  }

  if (target.attributes.class)
    rejected.push({
      locator: `locator(${quote(`.${target.attributes.class.split(/\s+/).join(".")}`)})`,
      reason: "class-dependent",
    });
  rejected.push({
    locator: `locator(${quote(target.tag)}).nth(0)`,
    reason: "positional selector",
  });
  return { candidates: drafts, rejected };
}

function CSS_ESCAPE(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function parseOptions(value: string): { exact: boolean } {
  return { exact: value.includes("exact: true") };
}

function parseStringLiteral(value: string): string {
  if (value.startsWith('"')) return JSON.parse(value) as string;
  return value
    .slice(1, -1)
    .replaceAll("\\'", "'")
    .replaceAll("\\\\", "\\")
    .replaceAll("\\n", "\n")
    .replaceAll("\\r", "\r")
    .replaceAll("\\t", "\t");
}

export function candidateToLocator(
  page: Page | Frame,
  expression: string,
): Locator {
  const segments = expression.split(/\.(?=getBy|locator\()/);
  let current: Page | Frame | Locator = page;
  for (const segment of segments) {
    const first = segment.match(
      /^(getByTestId|getByText|getByLabel|getByPlaceholder)\(("(?:\\.|[^"])*"|'(?:\\.|[^'])*')/,
    );
    if (first) {
      const value = parseStringLiteral(first[2]!);
      const options = parseOptions(segment);
      if (first[1] === "getByTestId") current = current.getByTestId(value);
      if (first[1] === "getByText") current = current.getByText(value, options);
      if (first[1] === "getByLabel")
        current = current.getByLabel(value, options);
      if (first[1] === "getByPlaceholder")
        current = current.getByPlaceholder(value, options);
      continue;
    }
    const role = segment.match(
      /^getByRole\(("(?:\\.|[^"])*"|'(?:\\.|[^'])*'), \{ name: ("(?:\\.|[^"])*"|'(?:\\.|[^'])*')/,
    );
    if (role) {
      current = current.getByRole(parseStringLiteral(role[1]!) as never, {
        name: parseStringLiteral(role[2]!),
        ...parseOptions(segment),
      });
      continue;
    }
    const css = segment.match(/^locator\(("(?:\\.|[^"])*"|'(?:\\.|[^'])*')\)/);
    if (css) {
      current = current.locator(parseStringLiteral(css[1]!));
      continue;
    }
    throw new Error(`Unsupported generated locator expression: ${expression}`);
  }
  return current as Locator;
}

export function asCodegenLocator(candidate: Draft): CodegenLocator {
  const match = candidate.locator.match(/^(\w+)\(("(?:\\.|[^"])*")/);
  return {
    type: match?.[1] ?? "locator",
    value: match ? (JSON.parse(match[2]!) as string) : candidate.locator,
    expression: candidate.locator,
  };
}
