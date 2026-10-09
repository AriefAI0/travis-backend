// Spike: does @docx-editor.dev/core read+write our docxtemplater output losslessly?
// The editor serializes the whole OOXML package from its own model, so anything it
// does not model gets dropped. This measures that on a real generated report.
// flow: read zip > write zip > compare entries > read package > write > compare fingerprints

import {
  canonicalOoxmlFingerprint,
  readOoxmlPackage,
  readZip,
  writeOoxmlPackage,
  writeZip,
} from "@docx-editor.dev/core/store";

const target = process.argv[2] ?? "/tmp/spike-report.docx";
const bytes = new Uint8Array(await Bun.file(target).arrayBuffer());

console.log(`input: ${target} (${bytes.byteLength} bytes)`);

// ── 1. zip layer ──────────────────────────────────────────────────────────
const zip = readZip(bytes);
if (!zip.ok) {
  console.error(`FAIL zip read: ${zip.reason} ${zip.detail ?? ""}`);
  process.exit(1);
}

const originalNames = [...zip.entries.keys()].sort();
console.log(`zip entries: ${originalNames.length}`);

const rewritten = writeZip(zip.entries);
const rezip = readZip(rewritten);
if (!rezip.ok) {
  console.error(`FAIL zip re-read: ${rezip.reason} ${rezip.detail ?? ""}`);
  process.exit(1);
}

const newNames = [...rezip.entries.keys()].sort();
const dropped = originalNames.filter((name) => !newNames.includes(name));
const added = newNames.filter((name) => !originalNames.includes(name));

console.log(`dropped entries: ${dropped.length}${dropped.length ? ` > ${dropped.join(", ")}` : ""}`);
console.log(`added entries:   ${added.length}${added.length ? ` > ${added.join(", ")}` : ""}`);

// byte-level drift per part (zip metadata like timestamps can differ harmlessly)
let byteDiff = 0;
for (const name of originalNames) {
  const before = zip.entries.get(name);
  const after = rezip.entries.get(name);
  if (!before || !after) continue;
  if (before.byteLength !== after.byteLength) {
    byteDiff += 1;
    console.log(`  size change: ${name} ${before.byteLength} > ${after.byteLength}`);
  }
}
console.log(`parts with size change: ${byteDiff}`);

// ── 2. ooxml package layer ────────────────────────────────────────────────
const original = readOoxmlPackage(bytes);
if (!original.ok) {
  console.error(`FAIL package read: ${original.reason} ${original.detail ?? ""}`);
  process.exit(1);
}

const roundTripped = writeOoxmlPackage(original.package);
const reread = readOoxmlPackage(roundTripped);
if (!reread.ok) {
  console.error(`FAIL package re-read: ${reread.reason} ${reread.detail ?? ""}`);
  process.exit(1);
}

console.log(`package written: ${roundTripped.byteLength} bytes`);

// canonical fingerprints ignore node ids, so this compares what the document SAYS
const parts = Object.keys((original.package as { parts?: Record<string, unknown> }).parts ?? {});
console.log(`package parts: ${parts.length}`);

let mismatch = 0;
for (const name of parts) {
  const a = canonicalOoxmlFingerprint(
    (original.package as { parts: Record<string, never> }).parts[name],
  );
  const b = canonicalOoxmlFingerprint(
    (reread.package as { parts: Record<string, never> }).parts[name],
  );
  if (a !== b) {
    mismatch += 1;
    console.log(`  FINGERPRINT MISMATCH: ${name}`);
  }
}
console.log(`parts with fingerprint mismatch: ${mismatch}`);

const verdict = dropped.length === 0 && added.length === 0 && mismatch === 0;
console.log(verdict ? "ROUND-TRIP: lossless at the package level" : "ROUND-TRIP: LOSSY — inspect above");
process.exit(verdict ? 0 : 1);
