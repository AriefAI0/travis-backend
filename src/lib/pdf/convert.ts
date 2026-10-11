// docx bytes in, pdf bytes out, through a headless LibreOffice.
//
// One conversion runs at a time: LibreOffice keeps a single user profile per
// installation, and two runs against one profile fail. Each run gets its own
// profile directory inside its own temporary directory, removed either way.
// flow: temp dir > write docx > soffice convert > read pdf > remove dir

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { env } from "../../config/env";
import { AppError } from "../error";

// Every caller waits on the one before it. A failed run must not break the
// chain, so the stored promise never rejects.
let gate: Promise<unknown> = Promise.resolve();

const serialize = <T>(work: () => Promise<T>): Promise<T> => {
  const run = gate.then(work, work);
  gate = run.catch(() => undefined);
  return run;
};

// flow: spawn > collect stderr > kill at the deadline > settle once
const runSoffice = (sofficePath: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(sofficePath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;

    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };

    const timer = setTimeout(() => {
      // a hung converter is killed, never waited on
      child.kill("SIGKILL");
      settle(
        new AppError(
          504,
          "pdf_conversion_timeout",
          `soffice exceeded ${env.PDF_CONVERT_TIMEOUT_MS}ms and was killed`,
        ),
      );
    }, env.PDF_CONVERT_TIMEOUT_MS);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2_000);
    });

    child.on("error", (error) => {
      // the one failure an operator can fix, so the message carries the fix
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        settle(
          new AppError(
            503,
            "pdf_converter_missing",
            `${sofficePath} is not installed. Install libreoffice-writer in the runtime image.`,
          ),
        );
        return;
      }
      settle(error);
    });

    child.on("close", (code) =>
      code === 0
        ? settle()
        : settle(
            new AppError(500, "pdf_conversion_failed", `soffice exited ${code}: ${stderr}`),
          ),
    );
  });

// Render one stored document to a PDF. A run that writes nothing reports the
// document as the cause, since the converter itself exited clean.
export const convertDocxToPdf = (
  docx: Uint8Array,
  // the only seam a test needs: point it at a binary that is not there
  sofficePath: string = env.SOFFICE_PATH,
): Promise<Buffer> =>
  serialize(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "report-pdf-"));
    const input = path.join(dir, "report.docx");

    try {
      await writeFile(input, docx);
      await runSoffice(sofficePath, [
        // its own profile, so no two runs share one
        `-env:UserInstallation=file://${path.join(dir, "profile")}`,
        "--headless",
        "--norestore",
        "--convert-to",
        "pdf",
        "--outdir",
        dir,
        input,
      ]);

      // soffice names the output after the input
      return await readFile(path.join(dir, "report.pdf")).catch(() => {
        throw new AppError(
          500,
          "pdf_conversion_failed",
          "soffice wrote no PDF; the stored document is unreadable",
        );
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
