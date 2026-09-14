import type { MarkdownNode } from "react-native-nitro-markdown/headless";

/**
 * Three GitHub-flavoured constructs md4c does not know about, applied to its AST so the mobile
 * renderer matches web: alerts (`> [!NOTE]`), `<details>` blocks, and footnotes. Each is a pure
 * tree rewrite; the renderer only has to recognise the two marker fields below. Footnotes also
 * need a small source rewrite before parsing, see `nativeMarkdownSource`.
 */

export type GithubAlertKind = "note" | "tip" | "important" | "warning" | "caution";

/** A blockquote that opened with a GitHub alert marker; the marker line itself is gone. */
interface AlertMarkedNode extends MarkdownNode {
  readonly type: "blockquote";
  readonly alert: GithubAlertKind;
}

export interface MarkdownDetails {
  readonly summary: string;
  readonly open: boolean;
}

/** An `html_block` folded from `<details>…</details>`; its children are the body blocks. */
interface DetailsMarkedNode extends MarkdownNode {
  readonly type: "html_block";
  readonly details: MarkdownDetails;
}

export function markdownAlertKind(node: MarkdownNode): GithubAlertKind | undefined {
  return node.type === "blockquote" ? (node as Partial<AlertMarkedNode>).alert : undefined;
}

export function markdownDetails(node: MarkdownNode): MarkdownDetails | undefined {
  return node.type === "html_block" ? (node as Partial<DetailsMarkedNode>).details : undefined;
}

function nodeText(node: MarkdownNode): string {
  return node.content ?? (node.children ?? []).map(nodeText).join("");
}

function isBreak(node: MarkdownNode | undefined): boolean {
  return node?.type === "soft_break" || node?.type === "line_break";
}

function textParagraph(content: string): MarkdownNode {
  return { type: "paragraph", children: [{ type: "text", content }] };
}

/** Block containers whose children can hold another block. Inline containers cannot. */
function hasBlockChildren(node: MarkdownNode): boolean {
  return (
    node.type === "document" ||
    node.type === "blockquote" ||
    node.type === "list" ||
    node.type === "list_item" ||
    node.type === "task_list_item" ||
    node.type === "html_block"
  );
}

// --- Source rewrite ------------------------------------------------------------------------

const CONTAINER_PREFIX = "(?:[ ]{0,3}>[ ]?)*";
const FOOTNOTE_DEFINITION_LINE = new RegExp(`^(${CONTAINER_PREFIX}[ ]{0,3})\\[\\^([^\\]\\s]+)\\]:`);
const FENCE_LINE = new RegExp(`^${CONTAINER_PREFIX}[ ]{0,3}(\`{3,}|~{3,})(.*)$`);
const INDENTED_LINE = /^(?: {4}|\t)(.*)$/;

/**
 * md4c has no footnote syntax and reads `[^a]: Alpha` as a link reference definition, which
 * drops the line from the AST and turns every `[^a]` into a link. Escaping the bracket keeps the
 * line as literal text for the AST pass. A paragraph indented under a definition after a blank
 * line is that footnote's next paragraph on GitHub, where md4c would see an indented code block,
 * so it is re-tagged with the definition's own marker and merged back into it by `foldFootnotes`.
 * Fenced code is left alone.
 */
export function nativeMarkdownSource(markdown: string): string {
  if (!markdown.includes("[^")) return markdown;
  let fence: string | null = null;
  let continuation: { readonly id: string; blank: boolean } | null = null;
  const lines = markdown.split("\n").map((line) => {
    const fenceMatch = FENCE_LINE.exec(line);
    if (fence) {
      const run = fenceMatch?.[1];
      if (run && run[0] === fence[0] && run.length >= fence.length && !fenceMatch[2]?.trim()) {
        fence = null;
      }
      return line;
    }
    if (fenceMatch?.[1]) {
      fence = fenceMatch[1];
      continuation = null;
      return line;
    }
    const definition = FOOTNOTE_DEFINITION_LINE.exec(line);
    if (definition?.[1] !== undefined && definition[2] !== undefined) {
      continuation = definition[1].includes(">") ? null : { id: definition[2], blank: false };
      return `${definition[1]}\\${line.slice(definition[1].length)}`;
    }
    if (line.trim().length === 0) {
      if (continuation) continuation.blank = true;
      return line;
    }
    const indented = continuation?.blank ? INDENTED_LINE.exec(line) : null;
    if (continuation && indented?.[1] !== undefined) {
      continuation.blank = false;
      return `\\[^${continuation.id}]: ${indented[1]}`;
    }
    if (!continuation?.blank || !INDENTED_LINE.test(line)) continuation = null;
    return line;
  });
  return lines.join("\n");
}

// --- GitHub alerts -------------------------------------------------------------------------

/**
 * Only a marker with nothing after it on its own line counts, which is GitHub's rule:
 * `> [!NOTE] aside` is an ordinary quote. md4c merges adjacent plain text into one node and emits
 * the line break separately, so the marker is a whole text node followed by a break.
 */
const GITHUB_ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]$/i;

function liftGithubAlert(node: MarkdownNode): MarkdownNode {
  const paragraph = node.children?.[0];
  const marker = paragraph?.children?.[0];
  if (paragraph?.type !== "paragraph" || marker?.type !== "text" || marker.content === undefined) {
    return node;
  }
  const match = GITHUB_ALERT_MARKER.exec(marker.content.trimEnd());
  if (!match?.[1]) return node;
  const [next, ...body] = (paragraph.children ?? []).slice(1);
  if (next !== undefined && !isBreak(next)) return node;

  const blocks = (node.children ?? []).slice(1);
  const lifted: AlertMarkedNode = {
    ...node,
    type: "blockquote",
    alert: match[1].toLowerCase() as GithubAlertKind,
    children: body.length > 0 ? [{ ...paragraph, children: body }, ...blocks] : blocks,
  };
  return lifted;
}

function liftGithubAlerts(node: MarkdownNode): MarkdownNode {
  if (!hasBlockChildren(node) || !node.children) return node;
  let changed = false;
  const children = node.children.map((child) => {
    const lifted = liftGithubAlerts(child);
    changed ||= lifted !== child;
    return lifted;
  });
  const rewritten = changed ? { ...node, children } : node;
  return rewritten.type === "blockquote" ? liftGithubAlert(rewritten) : rewritten;
}

// --- <details> -----------------------------------------------------------------------------

const DETAILS_OPEN_TAG = /^\s*<details(\s[^>]*)?>/i;
const DETAILS_CLOSE_TAG = /<\/details\s*>/i;
const SUMMARY_TAG = /^\s*<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary\s*>/i;
const OPEN_ATTRIBUTE = /\sopen(?=[\s=>]|$)/i;

function htmlText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface DetailsFrame {
  readonly source: MarkdownNode;
  readonly details: MarkdownDetails;
  readonly body: MarkdownNode[];
}

function detailsNode(frame: DetailsFrame): MarkdownNode {
  const folded: DetailsMarkedNode = {
    type: "html_block",
    ...(frame.source.beg === undefined ? {} : { beg: frame.source.beg }),
    ...(frame.source.end === undefined ? {} : { end: frame.source.end }),
    details: frame.details,
    children: frame.body,
  };
  return folded;
}

/**
 * CommonMark ends an HTML block at the first blank line, so md4c hands us `<details>` plus its
 * `<summary>` as one `html_block`, the body as ordinary markdown blocks, and `</details>` as
 * another `html_block`. Fold that sibling range into one node. Nesting works through a stack;
 * a block still missing its close tag (the message is streaming) stays folded rather than
 * flashing its body as plain text. Raw HTML sharing a block with the tags, before or after them,
 * is kept as text where it stood.
 */
function foldDetails(children: ReadonlyArray<MarkdownNode>): MarkdownNode[] {
  const output: MarkdownNode[] = [];
  const stack: DetailsFrame[] = [];
  const emit = (node: MarkdownNode) => (stack.at(-1)?.body ?? output).push(node);
  const emitText = (html: string) => {
    const text = htmlText(html);
    if (text.length > 0) emit(textParagraph(text));
  };
  const afterCloseTag = (html: string) => html.replace(DETAILS_CLOSE_TAG, "");

  for (const child of children) {
    if (child.type !== "html_block") {
      emit(foldDetailsTree(child));
      continue;
    }
    const source = nodeText(child);
    let html = source;
    while (html.length > 0) {
      const openTag = DETAILS_OPEN_TAG.exec(html);
      if (openTag) {
        let rest = html.slice(openTag[0].length);
        const summaryTag = SUMMARY_TAG.exec(rest);
        if (summaryTag) rest = rest.slice(summaryTag[0].length);
        const frame: DetailsFrame = {
          source: child,
          details: {
            summary: summaryTag?.[1] === undefined ? "Details" : htmlText(summaryTag[1]),
            open: OPEN_ATTRIBUTE.test(openTag[1] ?? ""),
          },
          body: [],
        };
        stack.push(frame);
        const closeAt = rest.search(DETAILS_CLOSE_TAG);
        if (closeAt < 0) {
          emitText(rest);
          break;
        }
        emitText(rest.slice(0, closeAt));
        stack.pop();
        emit(detailsNode(frame));
        html = afterCloseTag(rest.slice(closeAt));
        continue;
      }
      const closeAt = html.search(DETAILS_CLOSE_TAG);
      const frame = stack.at(-1);
      if (closeAt >= 0 && frame) {
        emitText(html.slice(0, closeAt));
        stack.pop();
        emit(detailsNode(frame));
        html = afterCloseTag(html.slice(closeAt));
        continue;
      }
      if (html === source) emit(child);
      else emitText(html);
      break;
    }
  }

  for (let frame = stack.pop(); frame; frame = stack.pop()) {
    emit(detailsNode(frame));
  }
  return output;
}

function foldDetailsTree(node: MarkdownNode): MarkdownNode {
  if (!hasBlockChildren(node) || !node.children) return node;
  const children = foldDetails(node.children);
  const unchanged =
    children.length === node.children.length &&
    children.every((child, index) => child === node.children?.[index]);
  return unchanged ? node : { ...node, children };
}

// --- Footnotes -----------------------------------------------------------------------------

const FOOTNOTE_DEFINITION = /^\[\^([^\]\s]+)\]:[ \t]?/;
const FOOTNOTE_REFERENCE = /\[\^([^\]\s]+)\]/g;
const SUPERSCRIPT_DIGITS = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"];

function superscript(value: number): string {
  return Array.from(String(value), (digit) => SUPERSCRIPT_DIGITS[Number(digit)] ?? digit).join("");
}

interface FootnoteDefinition {
  readonly id: string;
  /** One paragraph per `[^id]:` line; a multi-paragraph footnote arrives as several. */
  readonly blocks: MarkdownNode[];
}

function definitionStart(node: MarkdownNode | undefined): RegExpExecArray | null {
  return node?.type === "text" && node.content !== undefined
    ? FOOTNOTE_DEFINITION.exec(node.content)
    : null;
}

/**
 * After `nativeMarkdownSource`, `[^1]: text` lines parse as ordinary paragraph text, and a
 * definition may share its paragraph with the prose above it or with the next definition,
 * separated by breaks. Split such a paragraph into the prose that stays and one paragraph per
 * definition, keeping each definition's inline nodes so links survive.
 */
function splitDefinitions(
  paragraph: MarkdownNode,
): { prose: MarkdownNode | null; definitions: FootnoteDefinition[] } | null {
  const inline = paragraph.children ?? [];
  const prose: MarkdownNode[] = [];
  const definitions: FootnoteDefinition[] = [];
  let current: { id: string; children: MarkdownNode[] } | null = null;
  const flush = () => {
    if (current) {
      definitions.push({
        id: current.id,
        blocks: [{ type: "paragraph", children: current.children }],
      });
    }
  };
  for (const [index, node] of inline.entries()) {
    const start = index === 0 || isBreak(inline[index - 1]) ? definitionStart(node) : null;
    if (start?.[1] !== undefined && node.content !== undefined) {
      flush();
      const content = node.content.slice(start[0].length);
      current = { id: start[1], children: content.length > 0 ? [{ ...node, content }] : [] };
      continue;
    }
    // The break in front of a marker belongs to neither side.
    if (isBreak(node) && definitionStart(inline[index + 1])) continue;
    (current?.children ?? prose).push(node);
  }
  flush();
  if (definitions.length === 0) return null;
  return { prose: prose.length > 0 ? { ...paragraph, children: prose } : null, definitions };
}

/**
 * Pull definitions out of every block container, GitHub reads them inside quotes and lists too.
 * Repeated ids extend the first definition, which is how a multi-paragraph footnote arrives.
 */
function collectDefinitions(
  node: MarkdownNode,
  definitions: Map<string, FootnoteDefinition>,
): MarkdownNode {
  if (!hasBlockChildren(node) || !node.children) return node;
  let changed = false;
  const children: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === "paragraph") {
      const split = splitDefinitions(child);
      if (!split) {
        children.push(child);
        continue;
      }
      changed = true;
      if (split.prose) children.push(split.prose);
      for (const definition of split.definitions) {
        const existing = definitions.get(definition.id);
        if (existing) existing.blocks.push(...definition.blocks);
        else definitions.set(definition.id, definition);
      }
      continue;
    }
    const collected = collectDefinitions(child, definitions);
    changed ||= collected !== child;
    // A quote that held nothing but definitions has nothing left to show.
    if (collected !== child && collected.type === "blockquote" && !collected.children?.length) {
      continue;
    }
    children.push(collected);
  }
  return changed ? { ...node, children } : node;
}

function replaceReferences(
  node: MarkdownNode,
  numberFor: (id: string) => number | undefined,
): MarkdownNode {
  if (node.type === "code_inline" || node.type === "code_block") return node;
  if (node.type === "text" && node.content !== undefined) {
    const content = node.content.replace(FOOTNOTE_REFERENCE, (reference, id: string) => {
      const number = numberFor(id);
      return number === undefined ? reference : superscript(number);
    });
    return content === node.content ? node : { ...node, content };
  }
  if (!node.children) return node;
  let changed = false;
  const children = node.children.map((child) => {
    const replaced = replaceReferences(child, numberFor);
    changed ||= replaced !== child;
    return replaced;
  });
  return changed ? { ...node, children } : node;
}

/**
 * References become superscript digits numbered by first use, the way GitHub numbers them, and
 * the definitions move to a numbered list under a rule at the end of the document. Definitions
 * nothing refers to are dropped, also GitHub's behaviour. Unknown references stay literal.
 */
function foldFootnotes(document: MarkdownNode): MarkdownNode {
  const definitions = new Map<string, FootnoteDefinition>();
  const stripped = collectDefinitions(document, definitions);
  if (definitions.size === 0) return document;

  const numbers = new Map<string, number>();
  const numberFor = (id: string) => {
    if (!definitions.has(id)) return undefined;
    const existing = numbers.get(id);
    if (existing !== undefined) return existing;
    const number = numbers.size + 1;
    numbers.set(id, number);
    return number;
  };
  const referenced = (stripped.children ?? []).map((child) => replaceReferences(child, numberFor));
  if (numbers.size === 0) return { ...stripped, children: referenced };

  const items = [...numbers.keys()].map((id): MarkdownNode => ({
    type: "list_item",
    children: definitions.get(id)?.blocks ?? [],
  }));
  return {
    ...stripped,
    children: [
      ...referenced,
      { type: "horizontal_rule" },
      { type: "list", ordered: true, start: 1, children: items },
    ],
  };
}

export function nativeMarkdownWithExtensions(document: MarkdownNode): MarkdownNode {
  return foldFootnotes(liftGithubAlerts(foldDetailsTree(document)));
}
