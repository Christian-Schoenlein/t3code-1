import type { MarkdownNode } from "react-native-nitro-markdown/headless";

/**
 * Two GitHub-flavoured constructs md4c does not know about, applied to its AST so the mobile
 * renderer matches web: alerts (`> [!NOTE]`) and `<details>` blocks. Each is a pure tree rewrite;
 * the renderer only has to recognise the two marker fields below.
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

export function nativeMarkdownWithExtensions(document: MarkdownNode): MarkdownNode {
  return liftGithubAlerts(foldDetailsTree(document));
}
