/**
 * Dependency-free pretty printer for HTML markup.
 *
 * The formatter is pure text-in / text-out: it never touches the DOM, never
 * parses through `innerHTML`, and never executes markup. Input is scanned once
 * into a flat token stream and re-emitted with indentation, so malformed or
 * truncated markup degrades into readable output instead of throwing.
 *
 * Whitespace in normal element content is collapsed to single spaces. Content of
 * `pre` and `textarea` is copied byte-for-byte, and `script` / `style` bodies are
 * re-indented as a block without altering the code itself.
 *
 * @module
 */

/** Indentation applied per nesting level. */
const INDENT = "  ";

/** Soft limit used to decide between single-line and multi-line layout. */
const MAX_LINE = 100;

/** Elements that never have children or a closing tag. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Elements whose content is raw text and is re-indented as a block. */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(["script", "style"]);

/** Elements whose content is whitespace sensitive and copied verbatim. */
const VERBATIM_ELEMENTS: ReadonlySet<string> = new Set(["pre", "textarea"]);

/**
 * Tags that implicitly close a still-open sibling when they are opened, keeping
 * indentation sane for markup that omits optional end tags.
 */
const IMPLICIT_CLOSERS: Readonly<Record<string, readonly string[]>> = {
  li: ["li"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  tr: ["tr", "td", "th"],
  td: ["td", "th"],
  th: ["td", "th"],
  option: ["option"],
  optgroup: ["option", "optgroup"],
  tbody: ["thead", "tr", "td", "th"],
  tfoot: ["thead", "tbody", "tr", "td", "th"],
};

/** A single parsed attribute of a start tag. */
interface Attribute {
  readonly name: string;
  /** Attribute value without quotes, or `null` for a boolean attribute. */
  readonly value: string | null;
  /** Original quote character (`"`, `'`) or an empty string when unquoted. */
  readonly quote: string;
}

interface TextToken {
  readonly kind: "text";
  readonly value: string;
}

interface CommentToken {
  readonly kind: "comment";
  readonly raw: string;
}

/** Doctype, processing instruction, CDATA or conditional-comment block. */
interface DeclarationToken {
  readonly kind: "declaration";
  readonly raw: string;
}

interface OpenToken {
  readonly kind: "open";
  /** Lower-cased tag name, used for matching. */
  readonly name: string;
  /** Tag name as written, so camel-cased SVG tags survive round-tripping. */
  readonly rawName: string;
  readonly attributes: readonly Attribute[];
  readonly selfClosing: boolean;
}

interface CloseToken {
  readonly kind: "close";
  readonly name: string;
  readonly rawName: string;
}

/** A raw-text or verbatim element captured together with its content. */
interface RawElementToken {
  readonly kind: "rawElement";
  readonly name: string;
  readonly rawName: string;
  readonly attributes: readonly Attribute[];
  readonly content: string;
  /** Empty when the closing tag is missing from truncated input. */
  readonly closeTag: string;
  readonly verbatim: boolean;
}

type Token =
  | TextToken
  | CommentToken
  | DeclarationToken
  | OpenToken
  | CloseToken
  | RawElementToken;

/**
 * Finds the index of the `>` that terminates a tag starting at `from`, ignoring
 * any `>` that appears inside a quoted attribute value.
 *
 * @returns Index of the closing `>`, or `-1` when the tag is truncated.
 */
function findTagEnd(source: string, from: number): number {
  let quote = "";
  for (let i = from; i < source.length; i += 1) {
    const char = source.charAt(i);
    if (quote !== "") {
      if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") {
      return i;
    }
  }
  return -1;
}

/**
 * Parses the attribute section of a start tag, tolerating stray characters,
 * unquoted values and unterminated quotes.
 */
function parseAttributes(source: string): readonly Attribute[] {
  const attributes: Attribute[] = [];
  let i = 0;
  while (i < source.length) {
    while (i < source.length && /[\s/]/.test(source.charAt(i))) {
      i += 1;
    }
    if (i >= source.length) {
      break;
    }
    const nameStart = i;
    while (i < source.length && !/[\s/=]/.test(source.charAt(i))) {
      i += 1;
    }
    const name = source.slice(nameStart, i);
    if (name === "") {
      i += 1;
      continue;
    }
    let cursor = i;
    while (cursor < source.length && /\s/.test(source.charAt(cursor))) {
      cursor += 1;
    }
    if (source.charAt(cursor) !== "=") {
      attributes.push({ name, value: null, quote: "" });
      continue;
    }
    cursor += 1;
    while (cursor < source.length && /\s/.test(source.charAt(cursor))) {
      cursor += 1;
    }
    const quoteChar = source.charAt(cursor);
    if (quoteChar === '"' || quoteChar === "'") {
      const valueStart = cursor + 1;
      const valueEnd = source.indexOf(quoteChar, valueStart);
      if (valueEnd < 0) {
        attributes.push({
          name,
          value: source.slice(valueStart),
          quote: quoteChar,
        });
        break;
      }
      attributes.push({
        name,
        value: source.slice(valueStart, valueEnd),
        quote: quoteChar,
      });
      i = valueEnd + 1;
      continue;
    }
    const valueStart = cursor;
    while (cursor < source.length && !/\s/.test(source.charAt(cursor))) {
      cursor += 1;
    }
    attributes.push({
      name,
      value: source.slice(valueStart, cursor),
      quote: "",
    });
    i = cursor;
  }
  return attributes;
}

/**
 * Locates the end tag of a raw-text element, matching the tag name
 * case-insensitively.
 *
 * @returns Content boundaries plus the literal end tag (empty when truncated).
 */
function findRawElementEnd(
  source: string,
  from: number,
  name: string,
): {
  readonly content: string;
  readonly closeTag: string;
  readonly next: number;
} {
  const needle = `</${name}`;
  let search = from;
  while (search < source.length) {
    const found = source.toLowerCase().indexOf(needle, search);
    if (found < 0) {
      break;
    }
    const after = source.charAt(found + needle.length);
    if (after !== "" && !/[\s>/]/.test(after)) {
      search = found + needle.length;
      continue;
    }
    const tagEnd = findTagEnd(source, found);
    if (tagEnd < 0) {
      return {
        content: source.slice(from, found),
        closeTag: "",
        next: source.length,
      };
    }
    return {
      content: source.slice(from, found),
      closeTag: source.slice(found, tagEnd + 1),
      next: tagEnd + 1,
    };
  }
  return { content: source.slice(from), closeTag: "", next: source.length };
}

/**
 * Scans markup into a flat token stream. Anything that cannot be understood as
 * a tag is preserved as text so no input is silently dropped.
 */
function tokenize(source: string): readonly Token[] {
  const tokens: Token[] = [];
  const closeTagRe = /<\/\s*([a-zA-Z][^\s/>]*)/y;
  const openTagRe = /<([a-zA-Z][^\s/>]*)/y;
  let i = 0;

  /** Appends text, merging with a preceding text token so runs stay on one line. */
  const pushText = (value: string): void => {
    const previous = tokens[tokens.length - 1];
    if (previous?.kind === "text") {
      tokens[tokens.length - 1] = {
        kind: "text",
        value: previous.value + value,
      };
      return;
    }
    tokens.push({ kind: "text", value });
  };

  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt < 0) {
      pushText(source.slice(i));
      break;
    }
    if (lt > i) {
      pushText(source.slice(i, lt));
    }
    i = lt;

    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      const stop = end < 0 ? source.length : end + 3;
      tokens.push({ kind: "comment", raw: source.slice(i, stop) });
      i = stop;
      continue;
    }

    if (source.startsWith("<![", i)) {
      const end = source.indexOf("]]>", i + 3);
      const stop = end < 0 ? source.length : end + 3;
      tokens.push({ kind: "declaration", raw: source.slice(i, stop) });
      i = stop;
      continue;
    }

    if (source.startsWith("<!", i) || source.startsWith("<?", i)) {
      const end = findTagEnd(source, i);
      const stop = end < 0 ? source.length : end + 1;
      tokens.push({ kind: "declaration", raw: source.slice(i, stop) });
      i = stop;
      continue;
    }

    closeTagRe.lastIndex = i;
    const closeMatch = closeTagRe.exec(source);
    if (closeMatch !== null) {
      const rawName = closeMatch[1] ?? "";
      const end = findTagEnd(source, i);
      tokens.push({ kind: "close", name: rawName.toLowerCase(), rawName });
      i = end < 0 ? source.length : end + 1;
      continue;
    }

    openTagRe.lastIndex = i;
    const openMatch = openTagRe.exec(source);
    if (openMatch === null) {
      // A bare "<" that does not start a tag is literal text.
      pushText("<");
      i += 1;
      continue;
    }

    const end = findTagEnd(source, i);
    if (end < 0) {
      // Truncated start tag: keep the remainder verbatim rather than guessing.
      pushText(source.slice(i));
      break;
    }

    const rawName = openMatch[1] ?? "";
    const name = rawName.toLowerCase();
    const inner = source.slice(i + 1 + rawName.length, end);
    // A trailing "/" only self-closes the tag when it is not part of an
    // unquoted attribute value such as `<a href=/foo/>`.
    const trimmedInner = inner.trimEnd();
    const selfClosing = /(^|[\s"'])\/$/.test(trimmedInner);
    const attributes = parseAttributes(
      selfClosing ? trimmedInner.slice(0, -1) : inner,
    );
    i = end + 1;

    const isRaw = RAW_TEXT_ELEMENTS.has(name);
    const isVerbatim = VERBATIM_ELEMENTS.has(name);
    if ((isRaw || isVerbatim) && !selfClosing) {
      const region = findRawElementEnd(source, i, name);
      tokens.push({
        kind: "rawElement",
        name,
        rawName,
        attributes,
        content: region.content,
        closeTag: region.closeTag,
        verbatim: isVerbatim,
      });
      i = region.next;
      continue;
    }

    tokens.push({ kind: "open", name, rawName, attributes, selfClosing });
  }

  return tokens;
}

/** Re-emits an attribute using its original quoting style. */
function renderAttribute(attribute: Attribute): string {
  if (attribute.value === null) {
    return attribute.name;
  }
  if (attribute.quote === "") {
    return `${attribute.name}=${attribute.value}`;
  }
  return `${attribute.name}=${attribute.quote}${attribute.value}${attribute.quote}`;
}

/**
 * Renders a start tag, spreading attributes over multiple lines when a single
 * line would grow past {@link MAX_LINE}.
 */
function renderStartTag(
  token: OpenToken,
  indent: string,
  selfClose: boolean,
): string[] {
  const rendered = token.attributes.map(renderAttribute);
  const suffix = selfClose ? " />" : ">";
  const singleLine = `${indent}<${token.rawName}${rendered.map((attr) => ` ${attr}`).join("")}${suffix}`;
  if (rendered.length < 2 || singleLine.length <= MAX_LINE) {
    return [singleLine];
  }
  const attributeIndent = indent + INDENT;
  return [
    `${indent}<${token.rawName}`,
    ...rendered.map((attr) => `${attributeIndent}${attr}`),
    `${indent}${suffix.trimStart()}`,
  ];
}

/** Collapses runs of whitespace in element text content. */
function collapseText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Renders a multi-line literal (comment, doctype, CDATA), shifting it to
 * `indent` while keeping the relative indentation of its inner lines.
 */
function renderLiteralLines(raw: string, indent: string): string[] {
  const normalized = raw.replace(/\r\n?/g, "\n");
  if (!normalized.includes("\n")) {
    return [indent + normalized.trim()];
  }
  const [first = "", ...rest] = normalized.split("\n");
  return [indent + first.trim(), ...reindentBlock(rest.join("\n"), indent)];
}

/**
 * Re-indents a raw-text block: shared leading whitespace is removed and the
 * block is shifted to `indent`, leaving the code itself untouched.
 */
function reindentBlock(content: string, indent: string): string[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0) {
    const first = lines[0];
    if (first?.trim() !== "") {
      break;
    }
    lines.shift();
  }
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last?.trim() !== "") {
      break;
    }
    lines.pop();
  }
  let common = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.trim() === "") {
      continue;
    }
    common = Math.min(common, line.length - line.trimStart().length);
  }
  const strip = Number.isFinite(common) ? common : 0;
  return lines.map((line) =>
    line.trim() === "" ? "" : indent + line.slice(strip),
  );
}

/** Renders a `script` / `style` / `pre` / `textarea` element and its content. */
function renderRawElement(token: RawElementToken, indent: string): string[] {
  const startTag = renderStartTag(
    {
      kind: "open",
      name: token.name,
      rawName: token.rawName,
      attributes: token.attributes,
      selfClosing: false,
    },
    indent,
    false,
  );
  const lastStartLine =
    startTag[startTag.length - 1] ?? `${indent}<${token.rawName}>`;
  const head = startTag.slice(0, -1);

  if (token.verbatim) {
    // Whitespace is significant: emit the content exactly as it was received.
    return [...head, `${lastStartLine}${token.content}${token.closeTag}`];
  }
  if (token.content.trim() === "") {
    return [...head, `${lastStartLine}${token.closeTag}`];
  }
  const oneLine = `${lastStartLine}${token.content.trim()}${token.closeTag}`;
  if (!token.content.includes("\n") && oneLine.length <= MAX_LINE) {
    return [...head, oneLine];
  }
  const body = reindentBlock(token.content, indent + INDENT);
  const tail = token.closeTag === "" ? [] : [`${indent}${token.closeTag}`];
  return [...head, lastStartLine, ...body, ...tail];
}

/** Pops ancestors that an opening `name` implicitly closes. */
function applyImplicitClose(stack: string[], name: string): void {
  const closers = IMPLICIT_CLOSERS[name];
  if (closers === undefined) {
    return;
  }
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top === undefined || !closers.includes(top)) {
      return;
    }
    stack.pop();
  }
}

/**
 * Formats HTML markup into an indented, human-readable form.
 *
 * The transform is text-only and never throws: unknown, malformed or truncated
 * markup is passed through as faithfully as possible.
 *
 * @param raw - Markup such as an element's `outerHTML`, or a fragment thereof.
 * @returns The formatted markup, or an empty string for blank input.
 *
 * @example
 * ```ts
 * prettyFormatHtml('<ul><li class="a">One</li><li>Two</li></ul>');
 * // <ul>
 * //   <li class="a">One</li>
 * //   <li>Two</li>
 * // </ul>
 * ```
 */
export function prettyFormatHtml(raw: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    return "";
  }

  const tokens = tokenize(raw);
  const lines: string[] = [];
  const stack: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) {
      continue;
    }
    const indent = INDENT.repeat(stack.length);

    if (token.kind === "text") {
      const value = collapseText(token.value);
      if (value !== "") {
        lines.push(indent + value);
      }
      continue;
    }

    if (token.kind === "comment" || token.kind === "declaration") {
      lines.push(...renderLiteralLines(token.raw, indent));
      continue;
    }

    if (token.kind === "rawElement") {
      lines.push(...renderRawElement(token, indent));
      continue;
    }

    if (token.kind === "close") {
      if (VOID_ELEMENTS.has(token.name)) {
        continue;
      }
      const depth = stack.lastIndexOf(token.name);
      if (depth >= 0) {
        // Any element left open inside this one is closed implicitly.
        stack.length = depth;
        lines.push(`${INDENT.repeat(stack.length)}</${token.rawName}>`);
      } else {
        lines.push(`${indent}</${token.rawName}>`);
      }
      continue;
    }

    applyImplicitClose(stack, token.name);
    const openIndent = INDENT.repeat(stack.length);
    const isVoid = token.selfClosing || VOID_ELEMENTS.has(token.name);
    const startTag = renderStartTag(token, openIndent, token.selfClosing);
    if (isVoid) {
      lines.push(...startTag);
      continue;
    }

    // Keep short elements with at most one text child on a single line.
    const startLine = startTag.length === 1 ? startTag[0] : undefined;
    if (startLine !== undefined) {
      const next = tokens[i + 1];
      if (next?.kind === "close" && next.name === token.name) {
        lines.push(`${startLine}</${next.rawName}>`);
        i += 1;
        continue;
      }
      const after = tokens[i + 2];
      if (
        next?.kind === "text" &&
        after?.kind === "close" &&
        after.name === token.name
      ) {
        const text = collapseText(next.value);
        const candidate = `${startLine}${text}</${after.rawName}>`;
        if (candidate.length <= MAX_LINE) {
          lines.push(candidate);
          i += 2;
          continue;
        }
      }
    }

    lines.push(...startTag);
    stack.push(token.name);
  }

  return lines.join("\n");
}
