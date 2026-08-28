// One-off: isolate commitPart — two sequential parts in one tracker instance.
process.env.DATA_DIR = "./data/spike-commit";
const { tracker, db } = await import("../../src/lib/db/minio_tracker");

tracker.createSession({ id: "x", identityString: "a", kind: "master", bucket: "b", storageStem: "k", projectId: 1, sessionId: 1 });
tracker.commitPart("x", { partNumber: 1, etag: "e1", sizeBytes: 50, firstIdx: 0, lastIdx: 4 });
console.log("after part 1:", JSON.stringify(tracker.parts("x")));
tracker.commitPart("x", { partNumber: 2, etag: "e2", sizeBytes: 50, firstIdx: 5, lastIdx: 9 });
console.log("after part 2:", JSON.stringify(tracker.parts("x")));
db.close();
