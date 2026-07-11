import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createRehypeExtractor } from "../extensions/web-tools/fetchers/local/local-extractor.ts";

const extractor = createRehypeExtractor();
let dir: string;
let counter = 0;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "rehype-extractor-"));
});

async function extract(html: string): Promise<string> {
  const file = path.join(dir, `page-${counter++}.html`);
  await writeFile(file, html);
  return extractor.extractToMarkdown(file, "https://example.com/docs/page");
}

function page(body: string, head = ""): string {
  return `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;
}

describe("createRehypeExtractor", () => {
  it("converts headings, paragraphs, and data tables", async () => {
    const md = await extract(
      page(
        "<main><h1>Title</h1><p>Some <em>prose</em>.</p>" +
          "<table><tr><th>k</th></tr><tr><td>v</td></tr></table></main>",
      ),
    );
    expect(md).toContain("# Title");
    expect(md).toContain("Some *prose*.");
    expect(md).toContain("| k |");
    expect(md).toContain("| v |");
  });

  it("survives a relative <base> and keeps links as-authored", async () => {
    const md = await extract(
      page('<main><a href="/relative/link">rel</a></main>', '<base href="/">'),
    );
    expect(md).toContain("[rel](/relative/link)");
  });

  it("unwraps declarative shadow templates", async () => {
    const md = await extract(
      page(
        "<main><code-host><template shadowrootmode='open'>" +
          "<pre><code>shadow_code = 1</code></pre>" +
          "</template></code-host></main>",
      ),
    );
    expect(md).toContain("shadow_code = 1");
  });

  it("unwraps shadow templates nested inside shadow templates", async () => {
    const md = await extract(
      page(
        "<main><outer-host><template shadowrootmode='open'>" +
          "<inner-host><template shadowrootmode='open'><p>deep content</p></template></inner-host>" +
          "</template></outer-host></main>",
      ),
    );
    expect(md).toContain("deep content");
  });

  it("keeps ordinary templates hidden", async () => {
    const md = await extract(
      page("<main><p>kept</p><template><p>unrendered</p></template></main>"),
    );
    expect(md).toContain("kept");
    expect(md).not.toContain("unrendered");
  });

  describe("pruning", () => {
    it("prunes to <main> when present", async () => {
      const md = await extract(
        page("<nav>site nav</nav><main><p>content</p></main><footer>legal</footer>"),
      );
      expect(md).toContain("content");
      expect(md).not.toContain("site nav");
      expect(md).not.toContain("legal");
    });

    it("falls back to <article> without <main>", async () => {
      const md = await extract(page("<nav>site nav</nav><article><p>content</p></article>"));
      expect(md).toContain("content");
      expect(md).not.toContain("site nav");
    });

    it("falls back to <body> without either", async () => {
      const md = await extract(page("<div><p>content</p></div>"));
      expect(md).toContain("content");
    });

    it("finds <main> inside a shadow template", async () => {
      const md = await extract(
        page(
          "<app-root><template shadowrootmode='open'><main><p>hydrated</p></main></template>" +
            "<nav>fallback nav</nav></app-root>",
        ),
      );
      expect(md).toContain("hydrated");
      expect(md).not.toContain("fallback nav");
    });
  });

  describe("cruft stripping", () => {
    it("drops comments, scripts, styles, and noscript", async () => {
      const md = await extract(
        page(
          "<main><!-- hidden note --><script>var x = 'scripted';</script>" +
            "<style>.a{color:red}</style><noscript>enable js</noscript><p>content</p></main>",
        ),
      );
      expect(md.trim()).toBe("content");
    });

    it("drops aria-hidden elements and empty anchors", async () => {
      const md = await extract(
        page(
          '<main><h2>Heading<a href="#heading"></a></h2>' +
            '<span aria-hidden="true">decoration</span><p>content</p></main>',
        ),
      );
      expect(md).toContain("## Heading");
      expect(md).not.toContain("#heading");
      expect(md).not.toContain("decoration");
    });

    it("keeps aria-hidden images whose alt carries content", async () => {
      const md = await extract(
        page(
          '<main><span class="mwe-math-element">' +
            '<span style="display: none;"><math><mi>x</mi></math></span>' +
            '<img aria-hidden="true" alt="{\\displaystyle x^{2}}" src="/math/x2.svg">' +
            "</span></main>",
        ),
      );
      expect(md).toContain("displaystyle x^{2}");
    });

    it("keeps anchors that wrap only an image", async () => {
      const md = await extract(
        page('<main><a href="/big.png"><img src="/thumb.png" alt="thumb"></a></main>'),
      );
      expect(md).toContain("[![thumb](/thumb.png)](/big.png)");
    });
  });

  describe("layout tables", () => {
    it("demotes tables whose cells hold block content", async () => {
      const md = await extract(
        page(
          "<table><tr><td><p>first comment</p></td></tr>" +
            "<tr><td><p>second comment</p></td></tr></table>",
        ),
      );
      expect(md).not.toContain("|");
      expect(md).toContain("first comment");
      expect(md).toContain("second comment");
    });

    it("demotes nested structural tags, not just the table", async () => {
      const md = await extract(
        page("<table><tbody><tr><td><div><h2>Section</h2></div></td></tr></tbody></table>"),
      );
      expect(md).toContain("## Section");
      expect(md).not.toContain("|");
    });

    it("leaves data tables intact", async () => {
      const md = await extract(
        page("<main><table><tr><td>plain</td><td>cells</td></tr></table></main>"),
      );
      expect(md).toContain("| plain | cells |");
    });
  });

  describe("code blocks", () => {
    it("keeps div-per-line highlighter output line-faithful", async () => {
      const md = await extract(
        page(
          '<main><pre data-language="sh"><code>' +
            "<div class='line'><span>SECRET_KEY</span><span>=\"value\"</span></div>" +
            "<div class='line'><span>API_TOKEN</span><span>=\"token\"</span></div>" +
            "</code></pre></main>",
        ),
      );
      expect(md).toContain('```sh\nSECRET_KEY="value"\nAPI_TOKEN="token"\n```');
    });

    it("preserves bare <pre> text verbatim", async () => {
      const md = await extract(page("<main><pre>def f(x):\n    return x + 1</pre></main>"));
      expect(md).toContain("```\ndef f(x):\n    return x + 1\n```");
    });

    it("recovers language from language-* classes", async () => {
      const md = await extract(
        page('<main><pre><code class="language-python">x = 1</code></pre></main>'),
      );
      expect(md).toContain("```python\nx = 1\n```");
    });

    it("converts <br> line breaks inside code", async () => {
      const md = await extract(page("<main><pre><code>line1<br>line2</code></pre></main>"));
      expect(md).toContain("```\nline1\nline2\n```");
    });
  });

  it("emits GFM tables without alignment padding", async () => {
    const md = await extract(
      page(
        "<main><table><tr><th>a</th><th>b</th></tr>" +
          "<tr><td>short</td><td>a much longer cell value than the header</td></tr></table></main>",
      ),
    );
    expect(md).toContain("| a | b |");
  });
});
