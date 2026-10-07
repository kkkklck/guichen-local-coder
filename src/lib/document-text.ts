import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { validatePath, getAllowedRoots } from "./path-security.js";

const MAX_INPUT = 80 * 1024 * 1024;
const MAX_TEXT = 16 * 1024 * 1024;

async function snapshotInput(input: string, extension: string): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const original = await validatePath(input);
  if (path.extname(original).toLowerCase() !== extension) throw new Error(`Only ${extension} input is supported`);
  const handle = await fsp.open(original, "r");
  let temp = "";
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_INPUT) throw new Error("Document is not a regular file or exceeds 80 MiB");
    await validatePath(original);
    const current = await fsp.stat(original);
    if (current.dev !== stat.dev || current.ino !== stat.ino) throw new Error("Document changed during validation");
    temp = await fsp.mkdtemp(path.join(os.tmpdir(), "guichen-document-"));
    const file = path.join(temp, `input${extension}`);
    await pipeline(handle.createReadStream({ autoClose: false }), fs.createWriteStream(file, { flags: "wx" }));
    await validatePath(original);
    const after = await fsp.stat(original);
    if (after.dev !== stat.dev || after.ino !== stat.ino) throw new Error("Document changed during extraction");
    return { file, cleanup: () => fsp.rm(temp, { recursive: true, force: true }) };
  } catch (err) {
    if (temp) await fsp.rm(temp, { recursive: true, force: true });
    throw err;
  } finally {
    await handle.close();
  }
}

async function findPdfToText(): Promise<string> {
  const requested = process.env.PDFTOTEXT_PATH;
  const names = process.platform === "win32" ? ["pdftotext.exe"] : ["pdftotext"];
  const candidates = requested ? [requested] : (process.env.PATH || "")
    .split(path.delimiter)
    .flatMap((directory) => names.map((name) => path.resolve(directory, name)));
  const workspace = path.resolve(getAllowedRoots()[0]).toLowerCase();
  for (const candidate of candidates) {
    try {
      const real = await fsp.realpath(candidate);
      const lower = real.toLowerCase();
      if (lower === workspace || lower.startsWith(`${workspace}${path.sep}`)) continue;
      if (path.basename(real).toLowerCase() !== names[0].toLowerCase()) continue;
      if ((await fsp.stat(real)).isFile()) return real;
    } catch { /* Try the next installed binary. */ }
  }
  throw new Error("pdftotext is unavailable; configure a trusted PDFTOTEXT_PATH outside the workspace");
}

export async function extractPdfText(input: string, maxChars = 100_000): Promise<{ text: string; truncated: boolean }> {
  const binary = await findPdfToText();
  const snapshot = await snapshotInput(input, ".pdf");
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(binary, ["-enc", "UTF-8", "-layout", "-nopgbrk", snapshot.file, "-"], {
        windowsHide: true, shell: false, cwd: path.dirname(snapshot.file), env: { PATH: process.env.PATH || "" },
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let stderr = "";
      const timeout = setTimeout(() => child.kill(), 30_000);
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_TEXT) child.kill();
        else chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-2000); });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (bytes > MAX_TEXT) return reject(new Error("Extracted PDF text exceeds 16 MiB"));
        if (code !== 0) return reject(new Error(`pdftotext failed (exit ${code}): ${stderr}`));
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ text: text.slice(0, maxChars), truncated: text.length > maxChars });
      });
    });
  } finally {
    await snapshot.cleanup();
  }
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[entity.toLowerCase()] || "";
  });
}

function docxXmlToText(xml: string): string {
  // Read only visible document text. No relationship, field, macro, URL or script is opened.
  const parts: string[] = [];
  const token = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?\s*>|<w:br\b[^>]*\/?\s*>|<\/w:p>/g;
  for (const match of xml.matchAll(token)) {
    if (match[1] !== undefined) parts.push(decodeXml(match[1]));
    else if (match[0].startsWith("<w:tab")) parts.push("\t");
    else parts.push("\n");
  }
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

export async function convertDocumentText(input: string, maxChars = 100_000): Promise<{ text: string; truncated: boolean }> {
  const snapshot = await snapshotInput(input, ".docx");
  try {
    const xml = await new Promise<string>((resolve, reject) => {
      yauzl.open(snapshot.file, { lazyEntries: true, validateEntrySizes: true }, (openError, zip) => {
        if (openError || !zip) return reject(openError || new Error("Invalid DOCX archive"));
        let entries = 0;
        let done = false;
        const fail = (error: Error) => { if (!done) { done = true; zip.close(); reject(error); } };
        zip.on("error", fail);
        zip.on("entry", (entry) => {
          if (++entries > 10_000) return fail(new Error("DOCX has too many archive entries"));
          if (entry.fileName !== "word/document.xml") return zip.readEntry();
          if (entry.uncompressedSize > MAX_TEXT) return fail(new Error("DOCX text XML exceeds 16 MiB"));
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) return fail(streamError || new Error("Could not read DOCX XML"));
            const chunks: Buffer[] = [];
            let bytes = 0;
            stream.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > MAX_TEXT) stream.destroy(new Error("DOCX text XML exceeds 16 MiB"));
              else chunks.push(chunk);
            });
            stream.on("error", fail);
            stream.on("end", () => {
              if (!done) { done = true; zip.close(); resolve(Buffer.concat(chunks).toString("utf8")); }
            });
          });
        });
        zip.on("end", () => { if (!done) fail(new Error("DOCX has no word/document.xml")); });
        zip.readEntry();
      });
    });
    const text = docxXmlToText(xml);
    return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
  } finally {
    await snapshot.cleanup();
  }
}
