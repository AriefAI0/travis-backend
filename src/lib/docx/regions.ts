// Splice a fresh render's regions into a document a user has edited.
//
// A region is a block-level content control the template tags. A refresh
// replaces the content of each tagged region and touches nothing else, so every
// edit outside a region survives. Bytes in, bytes out: no database and no MinIO,
// so the whole rule is testable on its own.
// flow: read both documents > pair regions by tag > replace content > report

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PizZip = require("pizzip");

const DOCUMENT_PART = "word/document.xml";
const SDT_OPEN = "<w:sdt>";
const SDT_CLOSE = "</w:sdt>";
const CONTENT_OPEN = "<w:sdtContent>";
const CONTENT_CLOSE = "</w:sdtContent>";
const TAG = /<w:tag w:val="([^"]*)"\/>/;

// One tagged region: its tag, and the bounds of the content inside it.
type Region = { tag: string; contentStart: number; contentEnd: number };

// What a splice did, so the caller can say which regions it left alone.
export type RegionSplice = {
  // Region tags whose content the fresh render replaced.
  replaced: string[];
  // Region tags the stored document has and the render no longer produces.
  // Left exactly as the user has them.
  removed: string[];
  // Region tags the render produces and the stored document has no place for.
  // Either the data is new or the user deleted that region; nothing here can
  // tell the two apart, so nothing is inserted.
  unplaced: string[];
};

// The index just past the element that opens at `from`, or -1 when unclosed.
//
// Depth is counted rather than matched lazily: a user who inserts a content
// control of their own in Word nests one region inside another, and a lazy match
// would pair the wrong ends.
const matching = (xml: string, from: number, open: string, close: string): number => {
  let depth = 0;
  let cursor = from;

  while (cursor < xml.length) {
    const nextOpen = xml.indexOf(open, cursor);
    const nextClose = xml.indexOf(close, cursor);
    if (nextClose === -1) return -1;

    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      cursor = nextOpen + open.length;
      continue;
    }

    depth -= 1;
    cursor = nextClose + close.length;
    if (depth === 0) return nextClose;
  }

  return -1;
};

// Every tagged region in one document, in document order.
//
// `<w:sdt>` is matched exactly, so the sdtPr, sdtContent and sdtEndPr elements
// beside it never confuse the scan. A content control with no tag is skipped: a
// stray control the user added is not a region.
const findRegions = (xml: string): Region[] => {
  const regions: Region[] = [];
  let cursor = 0;

  while (cursor < xml.length) {
    const open = xml.indexOf(SDT_OPEN, cursor);
    if (open === -1) break;

    const close = matching(xml, open, SDT_OPEN, SDT_CLOSE);
    if (close === -1) break;

    const block = xml.slice(open, close);
    const tag = block.match(TAG)?.[1];
    const contentOpen = block.indexOf(CONTENT_OPEN);
    const contentClose =
      contentOpen === -1 ? -1 : matching(block, contentOpen, CONTENT_OPEN, CONTENT_CLOSE);

    if (tag && contentOpen !== -1 && contentClose !== -1) {
      regions.push({
        tag,
        contentStart: open + contentOpen + CONTENT_OPEN.length,
        contentEnd: open + contentClose,
      });
    }

    // Step past the opening tag alone, not past the whole region, so a region
    // nested inside this one is still found on a later turn.
    cursor = open + SDT_OPEN.length;
  }

  return regions;
};

// Replace each of the stored document's regions with the fresh render's copy.
//
// A region the render no longer produces stays as the user has it, and a region
// the stored document has no place for is only reported. Neither case is a
// guess this function is entitled to make.
export const spliceRegions = (
  stored: Buffer,
  fresh: Buffer,
): { docx: Buffer; result: RegionSplice } => {
  const storedZip = new PizZip(stored);
  const freshXml = new PizZip(fresh).file(DOCUMENT_PART).asText() as string;
  const storedXml = storedZip.file(DOCUMENT_PART).asText() as string;

  const byTag = new Map(findRegions(freshXml).map((region) => [region.tag, region]));
  const result: RegionSplice = { replaced: [], removed: [], unplaced: [] };
  const seen = new Set<string>();

  let xml = storedXml;

  // Back to front, so a replacement never moves the offsets still to come.
  for (const region of findRegions(storedXml).reverse()) {
    const source = byTag.get(region.tag);

    if (!source) {
      if (!seen.has(region.tag)) result.removed.push(region.tag);
      continue;
    }

    if (!seen.has(region.tag)) result.replaced.push(region.tag);
    seen.add(region.tag);

    const content = freshXml.slice(source.contentStart, source.contentEnd);
    xml = xml.slice(0, region.contentStart) + content + xml.slice(region.contentEnd);
  }

  for (const tag of byTag.keys()) {
    if (!seen.has(tag)) result.unplaced.push(tag);
  }

  // the walk ran backwards, so the report reads back the way a caller expects
  result.replaced.reverse();
  result.removed.reverse();

  storedZip.file(DOCUMENT_PART, xml);

  return { docx: storedZip.generate({ type: "nodebuffer" }) as Buffer, result };
};
