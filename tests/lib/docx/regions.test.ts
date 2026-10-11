import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import { spliceRegions } from "../../../src/lib/docx/regions";

const require = createRequire(import.meta.url);
const PizZip = require("pizzip");

// One region, with whatever content the case needs.
const region = (tag: string, content: string) =>
  `<w:sdt><w:sdtPr><w:tag w:val="${tag}"/></w:sdtPr><w:sdtContent>${content}</w:sdtContent></w:sdt>`;

const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

// A docx with the given body, plus a part that lives outside every region so a
// splice cannot quietly rewrite it.
const docx = (body: string) => {
  const zip = new PizZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document><w:body>${body}</w:body></w:document>`,
  );
  zip.file("word/styles.xml", "<w:styles/>");

  return zip.generate({ type: "nodebuffer" }) as Buffer;
};

const bodyOf = (buffer: Buffer) =>
  (new PizZip(buffer).file("word/document.xml").asText() as string).match(
    /<w:body>(.*)<\/w:body>/s,
  )![1]!;

const stylesOf = (buffer: Buffer) =>
  new PizZip(buffer).file("word/styles.xml").asText() as string;

describe("spliceRegions", () => {
  it("replaces a region both documents carry", () => {
    const stored = docx(region("region:description:1:GVI", paragraph("as the user left it")));
    const fresh = docx(region("region:description:1:GVI", paragraph("current data")));

    const { docx: spliced, result } = spliceRegions(stored, fresh);

    expect(result.replaced).toEqual(["region:description:1:GVI"]);
    expect(result.removed).toEqual([]);
    expect(result.unplaced).toEqual([]);
    expect(bodyOf(spliced)).toContain("current data");
    expect(bodyOf(spliced)).not.toContain("as the user left it");
  });

  it("keeps an edit made outside every region", () => {
    const edit = paragraph("a note the inspector typed");
    const stored = docx(edit + region("region:description:1:GVI", paragraph("stale")));
    const fresh = docx(region("region:description:1:GVI", paragraph("current data")));

    const { docx: spliced } = spliceRegions(stored, fresh);

    expect(bodyOf(spliced)).toContain("a note the inspector typed");
    expect(bodyOf(spliced)).toContain("current data");
  });

  it("leaves a region the render no longer produces, and names it", () => {
    const stored = docx(region("region:description:1:GVI", paragraph("kept as is")));
    const fresh = docx("");

    const { docx: spliced, result } = spliceRegions(stored, fresh);

    expect(result.removed).toEqual(["region:description:1:GVI"]);
    expect(result.replaced).toEqual([]);
    expect(bodyOf(spliced)).toContain("kept as is");
  });

  it("never inserts a region the stored document has no place for", () => {
    const stored = docx(region("region:description:1:GVI", paragraph("kept as is")));
    // the user deleted the MGI region in the editor, or the data is new
    const fresh = docx(
      region("region:description:1:GVI", paragraph("current")) +
        region("region:description:1:MGI", paragraph("brand new")),
    );

    const { docx: spliced, result } = spliceRegions(stored, fresh);

    expect(result.unplaced).toEqual(["region:description:1:MGI"]);
    expect(result.replaced).toEqual(["region:description:1:GVI"]);
    expect(bodyOf(spliced)).not.toContain("brand new");
  });

  it("replaces every region in document order, and nothing else", () => {
    const stored = docx(
      region("region:a", paragraph("one")) +
        paragraph("between") +
        region("region:b", paragraph("two")) +
        paragraph("after"),
    );
    const fresh = docx(
      region("region:a", paragraph("ONE")) +
        paragraph("between") +
        region("region:b", paragraph("TWO")) +
        paragraph("after"),
    );

    const { docx: spliced, result } = spliceRegions(stored, fresh);

    expect(result.replaced).toEqual(["region:a", "region:b"]);
    expect(bodyOf(spliced)).toContain("<w:t>ONE</w:t>");
    expect(bodyOf(spliced)).toContain("<w:t>TWO</w:t>");
    // the paragraphs outside the regions are untouched
    expect(bodyOf(spliced)).toContain("<w:t>between</w:t>");
    expect(bodyOf(spliced)).toContain("<w:t>after</w:t>");
    // a part outside the document is untouched
    expect(stylesOf(spliced)).toBe("<w:styles/>");
  });

  it("pairs the right ends when one region nests inside another", () => {
    const inner = region("region:inner", paragraph("inner old"));
    const stored = docx(region("region:outer", paragraph("before") + inner + paragraph("after")));
    const fresh = docx(
      region("region:outer", paragraph("before") + region("region:inner", paragraph("inner new")) + paragraph("after")),
    );

    const { docx: spliced, result } = spliceRegions(stored, fresh);

    expect(result.replaced).toEqual(["region:outer", "region:inner"]);
    expect(bodyOf(spliced)).toContain("inner new");
    expect(bodyOf(spliced)).not.toContain("inner old");
  });

  it("skips a content control that carries no tag", () => {
    const untagged = "<w:sdt><w:sdtContent>" + paragraph("the user's own") + "</w:sdtContent></w:sdt>";
    const stored = docx(untagged + region("region:a", paragraph("old")));
    const fresh = docx(region("region:a", paragraph("new")));

    const { docx: spliced, result } = spliceRegions(stored, fresh);

    expect(result.replaced).toEqual(["region:a"]);
    expect(result.removed).toEqual([]);
    expect(result.unplaced).toEqual([]);
    expect(bodyOf(spliced)).toContain("the user's own");
    expect(bodyOf(spliced)).toContain("new");
  });
});
