import { readFile } from "node:fs/promises";
import type { Element, ElementContent, Root } from "hast";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { EXIT, SKIP, visit } from "unist-util-visit";

export interface Extractor {
  name: string;
  extractToMarkdown(htmlPath: string, url: string): Promise<string>;
}

export function createRehypeExtractor(): Extractor {
  const pipeline = unified()
    .use(rehypeParse)
    .use(removeBaseElements)
    .use(unwrapShadowTemplates)
    .use(pruneToContentRoot)
    .use(stripCruft)
    .use(demoteLayoutTables)
    .use(flattenCodeBlocks)
    .use(rehypeRemark)
    .use(remarkGfm, { tablePipeAlign: false })
    .use(remarkStringify, { bullet: "-", fences: true });

  return {
    name: "rehype",
    async extractToMarkdown(htmlPath, _url) {
      const html = await readFile(htmlPath, "utf8");
      return String(await pipeline.process(html));
    },
  };
}

// A relative <base href="/"> crashes hast-util-to-mdast's URL resolution.
// Deleting the element skips resolution entirely, keeping links as-authored.
function removeBaseElements() {
  return (tree: Root) => {
    visit(tree, "element", (node, index, parent) => {
      if (node.tagName === "base" && parent && index !== undefined) {
        parent.children.splice(index, 1);
        return index;
      }
    });
  };
}

// Declarative shadow templates: hast parks template children in node.content,
// which hast-util-to-mdast never visits. Splice them into the host element.
function unwrapShadowTemplates() {
  return (tree: Root) => {
    visit(tree, "element", (node) => {
      node.children = node.children.flatMap((child) =>
        child.type === "element" &&
        child.tagName === "template" &&
        child.properties.shadowRootMode !== undefined
          ? (child.content?.children ?? []).filter(
              (node): node is ElementContent => node.type !== "doctype",
            )
          : [child],
      );
    });
  };
}

const CONTENT_ROOTS = ["main", "article", "body"];

function pruneToContentRoot() {
  return (tree: Root) => {
    for (const tagName of CONTENT_ROOTS) {
      let found: Element | undefined;
      visit(tree, "element", (node) => {
        if (node.tagName === tagName) {
          found = node;
          return EXIT;
        }
      });
      if (found) {
        tree.children = [found];
        return;
      }
    }
  };
}

const CRUFT_TAGS = new Set(["script", "style", "noscript"]);

function stripCruft() {
  return (tree: Root) => {
    visit(tree, (node, index, parent) => {
      if (!parent || index === undefined) return;
      const cruft =
        node.type === "comment" ||
        (node.type === "element" &&
          (CRUFT_TAGS.has(node.tagName) ||
            (String(node.properties.ariaHidden) === "true" && !containsAltImage(node)) ||
            (node.tagName === "a" && !hasVisibleContent(node))));
      if (cruft) {
        parent.children.splice(index, 1);
        return index;
      }
    });
  };
}

// Wikipedia math (and similar) renders as an aria-hidden fallback <img> whose
// alt carries the source text — the best markdown representation, so keep it.
function containsAltImage(node: Element): boolean {
  let found = false;
  visit(node, "element", (child) => {
    if (
      child.tagName === "img" &&
      typeof child.properties.alt === "string" &&
      child.properties.alt.trim()
    ) {
      found = true;
      return EXIT;
    }
  });
  return found;
}

function hasVisibleContent(node: Element): boolean {
  let visible = false;
  visit(node, (child) => {
    if (
      (child.type === "text" && child.value.trim()) ||
      (child.type === "element" && child.tagName === "img")
    ) {
      visible = true;
      return EXIT;
    }
  });
  return visible;
}

const BLOCK_TAGS = new Set([
  "div",
  "p",
  "table",
  "ul",
  "ol",
  "pre",
  "blockquote",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "section",
  "article",
  "center",
]);

const TABLE_TAGS = new Set(["table", "thead", "tbody", "tfoot", "tr", "td", "th"]);

// Tables used for page layout (cells holding block content) cannot survive as
// GFM tables: entire pages collapse into a handful of giant rows. Demote them
// and their structural descendants to divs so content converts normally.
function demoteLayoutTables() {
  return (tree: Root) => {
    visit(tree, "element", (node) => {
      if (node.tagName === "table" && hasBlockContent(node)) demote(node);
    });
  };
}

function hasBlockContent(node: Element): boolean {
  return node.children.some(
    (child) =>
      child.type === "element" && (BLOCK_TAGS.has(child.tagName) || hasBlockContent(child)),
  );
}

function demote(node: Element) {
  if (TABLE_TAGS.has(node.tagName)) node.tagName = "div";
  for (const child of node.children) {
    if (child.type === "element") demote(child);
  }
}

// Syntax highlighters render code as one div per line; converting that markup
// naively fuses lines together. Rebuild each <pre> as a single text node with
// line breaks at block boundaries, tagged with any recoverable language.
function flattenCodeBlocks() {
  return (tree: Root) => {
    visit(tree, "element", (node) => {
      if (node.tagName !== "pre") return;
      const language = findLanguage(node);
      node.children = [
        {
          type: "element",
          tagName: "code",
          properties: language ? { className: [`language-${language}`] } : {},
          children: [{ type: "text", value: preText(node) }],
        },
      ];
      return SKIP;
    });
  };
}

function preText(node: Element): string {
  const text = node.children
    .map((child) => {
      if (child.type === "text") return child.value;
      if (child.type !== "element") return "";
      return child.tagName === "br" ? "\n" : preText(child);
    })
    .join("");
  return node.tagName === "div" && !text.endsWith("\n") ? `${text}\n` : text;
}

function findLanguage(pre: Element): string | undefined {
  let language: string | undefined;
  visit(pre, "element", (node) => {
    const fromData = node.properties.dataLanguage;
    if (typeof fromData === "string" && fromData) {
      language = fromData;
      return EXIT;
    }
    const classes = Array.isArray(node.properties.className) ? node.properties.className : [];
    for (const name of classes) {
      const match = /^language-(\S+)$/.exec(String(name));
      if (match) {
        language = match[1];
        return EXIT;
      }
    }
  });
  return language;
}
