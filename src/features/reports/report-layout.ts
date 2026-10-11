// The template's shape, in one place: which inspection types render, in what
// order, and how many tables each one takes.
//
// Both sides of the contract import this. `spike/create-template.ts` lays the
// tables out from it, and the renderer names one region per picture and per
// table from it. The builder's self-check fails when the two drift apart.

// Emission order across the whole document.
export const TYPE_ORDER = [
  "GVI",
  "CVI",
  "DVI",
  "MGI",
  "CP",
  "FMD",
  "SCOUR",
  "BSI",
  "CGB",
  "RISER",
  "CAISSON",
  "SEABED",
  "PIPELINE",
] as const;

export type InspectionType = (typeof TYPE_ORDER)[number];

// Tables a type splits over. BSI carries 24 columns, and RISER and CAISSON
// split their blocks in two, so no row grows too wide to read.
export const TYPE_TABLES: Record<InspectionType, number> = {
  GVI: 1,
  CVI: 1,
  DVI: 1,
  MGI: 1,
  CP: 1,
  FMD: 1,
  SCOUR: 1,
  BSI: 4,
  CGB: 1,
  RISER: 2,
  CAISSON: 2,
  SEABED: 1,
  PIPELINE: 1,
};

// The flag a section carries for one type. A false flag drops that block.
export const typeFlag = (type: InspectionType) => `is${type}`;

// What a section offers a refresh, and to a region. A target holds one section
// per type, so the pair names a region's family exactly once.
export type RegionSection = {
  target_key: string;
  inspection_type: string;
} & Record<string, unknown>;

// Every region one section renders, in document order: its picture, then each
// table of each enabled type.
//
// The picture carries its own region because it is generated content too: a
// refresh must be able to replace a picture whose evidence changed. The
// paragraph behind each region belongs to nobody, which is what lets a user
// type there and keep the text through a refresh.
export const sectionRegionTags = (section: RegionSection): string[] => {
  const family = `region:${section.target_key}:${section.inspection_type}`;
  const tags = [`${family}:picture`];

  for (const type of TYPE_ORDER) {
    if (!section[typeFlag(type)]) continue;
    for (let table = 1; table <= TYPE_TABLES[type]; table += 1) {
      tags.push(`${family}:${table}`);
    }
  }

  return tags;
};
