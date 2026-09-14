import { describe, expect, it } from "vite-plus/test";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";

import {
  markdownAlertKind,
  markdownDetails,
  nativeMarkdownDocumentChunks,
  nativeMarkdownWithExtensions,
} from "@t3tools/mobile-markdown-text/markdown";

const text = (content: string): MarkdownNode => ({ type: "text", content });
const paragraph = (...children: MarkdownNode[]): MarkdownNode => ({ type: "paragraph", children });
const document = (...children: MarkdownNode[]): MarkdownNode => ({ type: "document", children });
/** md4c hands an HTML block over as one `html_inline` child per source line. */
const htmlBlock = (...lines: string[]): MarkdownNode => ({
  type: "html_block",
  children: lines.map((line) => ({ type: "html_inline", content: `${line}\n` })),
});

describe("GitHub alerts", () => {
  it("lifts a marker line into the alert kind and drops it from the quote", () => {
    const [alert] = nativeMarkdownWithExtensions(
      document({
        type: "blockquote",
        beg: 4,
        children: [
          paragraph(text("[!WARNING]"), { type: "soft_break" }, text("Mind the gap.")),
          paragraph(text("Second paragraph.")),
        ],
      }),
    ).children!;

    expect(markdownAlertKind(alert!)).toBe("warning");
    expect(alert).toMatchObject({
      type: "blockquote",
      beg: 4,
      children: [paragraph(text("Mind the gap.")), paragraph(text("Second paragraph."))],
    });
  });

  it("accepts a hard break after the marker and a marker-only first paragraph", () => {
    const [hard, alone] = nativeMarkdownWithExtensions(
      document(
        {
          type: "blockquote",
          children: [paragraph(text("[!tip]"), { type: "line_break" }, text("Lower case too."))],
        },
        {
          type: "blockquote",
          children: [paragraph(text("[!CAUTION]")), paragraph(text("Body."))],
        },
      ),
    ).children!;

    expect(markdownAlertKind(hard!)).toBe("tip");
    expect(hard!.children).toEqual([paragraph(text("Lower case too."))]);
    expect(markdownAlertKind(alone!)).toBe("caution");
    expect(alone!.children).toEqual([paragraph(text("Body."))]);
  });

  it("leaves a quote alone when something shares the marker's line, GitHub's rule", () => {
    const quote: MarkdownNode = {
      type: "blockquote",
      children: [paragraph(text("[!NOTE] aside"))],
    };
    const [unchanged] = nativeMarkdownWithExtensions(document(quote)).children!;
    expect(markdownAlertKind(unchanged!)).toBeUndefined();
    expect(unchanged).toEqual(quote);
  });

  it("finds alerts nested inside list items", () => {
    const [list] = nativeMarkdownWithExtensions(
      document({
        type: "list",
        children: [
          {
            type: "list_item",
            children: [
              {
                type: "blockquote",
                children: [paragraph(text("[!IMPORTANT]"), { type: "soft_break" }, text("Nested"))],
              },
            ],
          },
        ],
      }),
    ).children!;
    expect(markdownAlertKind(list!.children![0]!.children![0]!)).toBe("important");
  });
});

describe("<details>", () => {
  const body = [paragraph(text("Hidden")), { type: "code_block", content: "x\n" } as MarkdownNode];

  it("folds the open block, the body, and the close block into one collapsed node", () => {
    const folded = nativeMarkdownWithExtensions(
      document(
        paragraph(text("Before")),
        { ...htmlBlock("<details>", "<summary>Click <b>me</b></summary>"), beg: 7, end: 60 },
        ...body,
        htmlBlock("</details>"),
        paragraph(text("After")),
      ),
    );

    expect(folded.children).toHaveLength(3);
    const details = folded.children![1]!;
    expect(markdownDetails(details)).toEqual({ summary: "Click me", open: false });
    expect(details).toMatchObject({ type: "html_block", beg: 7, end: 60, children: body });
    expect(folded.children![2]).toEqual(paragraph(text("After")));
  });

  it("honours the open attribute and defaults the summary", () => {
    const [details] = nativeMarkdownWithExtensions(
      document(htmlBlock("<details open>"), ...body, htmlBlock("</details>")),
    ).children!;
    expect(markdownDetails(details!)).toEqual({ summary: "Details", open: true });
  });

  it("keeps text that shares a block with the tags, and closes inside one block", () => {
    const [details] = nativeMarkdownWithExtensions(
      document(htmlBlock("<details>", "<summary>Sum</summary>", "Inline body", "</details>")),
    ).children!;
    expect(markdownDetails(details!)).toEqual({ summary: "Sum", open: false });
    expect(details!.children).toEqual([paragraph(text("Inline body"))]);
  });

  it("nests one details block inside another", () => {
    const [outer] = nativeMarkdownWithExtensions(
      document(
        htmlBlock("<details>", "<summary>Outer</summary>"),
        htmlBlock("<details>", "<summary>Inner</summary>"),
        paragraph(text("Deep")),
        htmlBlock("</details>"),
        paragraph(text("Shallow")),
        htmlBlock("</details>"),
      ),
    ).children!;
    expect(markdownDetails(outer!)?.summary).toBe("Outer");
    const [inner, shallow] = outer!.children!;
    expect(markdownDetails(inner!)?.summary).toBe("Inner");
    expect(inner!.children).toEqual([paragraph(text("Deep"))]);
    expect(shallow).toEqual(paragraph(text("Shallow")));
  });

  it("keeps a block that is still streaming folded instead of showing its body as text", () => {
    const folded = nativeMarkdownWithExtensions(
      document(htmlBlock("<details>", "<summary>Streaming</summary>"), paragraph(text("So far"))),
    );
    expect(folded.children).toHaveLength(1);
    expect(markdownDetails(folded.children![0]!)?.summary).toBe("Streaming");
    expect(folded.children![0]!.children).toEqual([paragraph(text("So far"))]);
  });

  it("ignores html blocks that are not details", () => {
    const block = htmlBlock('<p align="center">Centered</p>');
    const [unchanged] = nativeMarkdownWithExtensions(document(block)).children!;
    expect(unchanged).toEqual(block);
    expect(markdownDetails(unchanged!)).toBeUndefined();
  });
});

describe("footnotes", () => {
  const link: MarkdownNode = {
    type: "link",
    href: "https://example.com",
    children: [text("link")],
  };

  it("numbers references by first use and moves definitions into a trailing list", () => {
    const folded = nativeMarkdownWithExtensions(
      document(
        paragraph(text("Second claim.[^b] First claim.[^a] Again.[^b]")),
        // md4c merges consecutive definition lines into one paragraph split by soft breaks.
        paragraph(
          text("[^a]: Alpha text."),
          { type: "soft_break" },
          text("[^b]: Beta with a "),
          link,
          text("."),
        ),
      ),
    );

    expect(folded.children).toEqual([
      paragraph(text("Second claim.¹ First claim.² Again.¹")),
      { type: "horizontal_rule" },
      {
        type: "list",
        ordered: true,
        start: 1,
        children: [
          { type: "list_item", children: [paragraph(text("Beta with a "), link, text("."))] },
          { type: "list_item", children: [paragraph(text("Alpha text."))] },
        ],
      },
    ]);
  });

  it("leaves references without a definition literal and drops unreferenced definitions", () => {
    const folded = nativeMarkdownWithExtensions(
      document(
        paragraph(text("Known.[^1] Unknown.[^9]")),
        paragraph(text("[^1]: One")),
        paragraph(text("[^2]: Two")),
      ),
    );
    expect(folded.children![0]).toEqual(paragraph(text("Known.¹ Unknown.[^9]")));
    expect(folded.children![2]!.children).toHaveLength(1);
  });

  it("does not touch code, and returns the same document when nothing looks like a footnote", () => {
    const untouched = document(paragraph(text("Plain.[^x]")), {
      type: "code_block",
      content: "[^1]: not a footnote\n",
    });
    expect(nativeMarkdownWithExtensions(untouched)).toBe(untouched);

    const folded = nativeMarkdownWithExtensions(
      document(
        paragraph(text("Prose[^1] and "), { type: "code_inline", content: "[^1]" }),
        paragraph(text("[^1]: Def")),
      ),
    );
    expect(folded.children![0]).toEqual(
      paragraph(text("Prose¹ and "), { type: "code_inline", content: "[^1]" }),
    );
  });

  it("renders alerts and details as rich chunks, and the footnote list as selectable text", () => {
    const folded = nativeMarkdownWithExtensions(
      document(
        paragraph(text("Claim.[^1]")),
        {
          type: "blockquote",
          children: [paragraph(text("[!NOTE]"), { type: "soft_break" }, text("N"))],
        },
        htmlBlock("<details>", "<summary>S</summary>"),
        paragraph(text("Body")),
        htmlBlock("</details>"),
        paragraph(text("[^1]: Def")),
      ),
    );
    expect(nativeMarkdownDocumentChunks(folded).map((chunk) => chunk.kind)).toEqual([
      "selectable",
      "rich",
      "rich",
      "rich",
      "selectable",
    ]);
  });
});
