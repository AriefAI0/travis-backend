// Can hoisting the namespace declarations onto the root element make the
// editor's reader accept a docxtemplater report? If yes, the fix is a small
// normalization step after renderAsync.
// flow: read zip > collect prefix>uri > inject missing into root > rewrite zip > re-test

import { readOoxmlPackage, readZip, writeZip } from "@docx-editor.dev/core/store";

const target = process.argv[2] ?? "/tmp/spike-report.docx";
const bytes = new Uint8Array(await Bun.file(target).arrayBuffer());

const zip = readZip(bytes);
if (!zip.ok) {
  console.error(`zip read failed: ${zip.reason}`);
  process.exit(1);
}

const MAIN = "/word/document.xml";
const docPart = zip.entries.get(MAIN);
if (!docPart) {
  console.error(`${MAIN} missing`);
  process.exit(1);
}

const xml = new TextDecoder().decode(docPart);

// every prefix -> uri declared anywhere in the part
const declared = new Map<string, string>();
for (const match of xml.matchAll(/xmlns:([A-Za-z0-9_.-]+)="([^"]*)"/g)) {
  if (!declared.has(match[1]!)) declared.set(match[1]!, match[2]!);
}

// prefixes actually used in element or attribute names
const used = new Set<string>();
for (const match of xml.matchAll(/<\/?([A-Za-z0-9_.-]+):[A-Za-z0-9_.-]+/g)) used.add(match[1]!);
for (const match of xml.matchAll(/\s([A-Za-z0-9_.-]+):[A-Za-z0-9_.-]+="/g)) used.add(match[1]!);

const rootDeclared = new Set<string>();
const rootTag = xml.match(/<w:document\b[^>]*>/)?.[0] ?? "";
for (const match of rootTag.matchAll(/xmlns:([A-Za-z0-9_.-]+)=/g)) rootDeclared.add(match[1]!);

const missing = [...used].filter((prefix) => !rootDeclared.has(prefix) && declared.has(prefix));

// the image module injects wp:/a:/pic: markup expecting the document root to
// declare the drawing namespaces (as Word's own files do). Our template's root
// declares only w and r, so wp: ships undeclared and the XML is invalid.
const STANDARD_URIS: Record<string, string> = {
  wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
  a14: "http://schemas.microsoft.com/office/drawing/2010/main",
};

const undeclared = [...used].filter(
  (prefix) => !rootDeclared.has(prefix) && !declared.has(prefix) && prefix !== "xmlns",
);

console.log(`prefixes used:      ${[...used].sort().join(", ")}`);
console.log(`at root already:    ${[...rootDeclared].sort().join(", ")}`);
console.log(`hoist (declared elsewhere): ${missing.length ? missing.join(", ") : "(none)"}`);
console.log(`NEVER declared:     ${undeclared.length ? undeclared.join(", ") : "(none)"}`);

const hoisted = [...missing, ...undeclared].filter((prefix, i, all) => all.indexOf(prefix) === i);
if (hoisted.length === 0) {
  console.log("nothing to hoist — root already declares every prefix");
  process.exit(1);
}

const additions = hoisted
  .map((prefix) => {
    const uri = declared.get(prefix) ?? STANDARD_URIS[prefix];
    return uri ? ` xmlns:${prefix}="${uri}"` : null;
  })
  .filter((entry): entry is string => entry !== null)
  .join("");

if (additions.length === 0) {
  console.log("no URI known for the undeclared prefixes — cannot patch");
  process.exit(1);
}

const patched = xml.replace(/<w:document\b/, `<w:document${additions}`);

const entries = new Map(zip.entries);
entries.set(MAIN, new TextEncoder().encode(patched));
const repacked = writeZip(entries);

const check = readOoxmlPackage(repacked);
if (check.ok) {
  console.log("\nRESULT: ACCEPTED after hoisting — normalization is a viable fix");
  await Bun.write("/tmp/spike-report-fixed.docx", repacked);
  console.log("wrote /tmp/spike-report-fixed.docx");
  process.exit(0);
}

console.log(`\nRESULT: still rejected: ${check.reason} ${check.detail ?? ""}`);
process.exit(1);
