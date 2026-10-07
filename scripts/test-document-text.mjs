import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setDefaultCwd } from "../dist/lib/path-security.js";
import { extractPdfText, convertDocumentText } from "../dist/lib/document-text.js";

function pdfFixture() {
  const commands = "BT /F1 18 Tf 50 700 Td (PDF_APPROVAL_TEST) Tj ET\n";
  const lines = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(commands)} >>\nstream\n${commands}endstream`,
  ];
  let text = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < lines.length; i++) {
    offsets.push(Buffer.byteLength(text));
    text += `${i + 1} 0 obj\n${lines[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 6\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) text += `${String(offset).padStart(10, "0")} 00000 n \n`;
  text += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return text;
}

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

function zipFixture(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [filename, value] of entries) {
    const name = Buffer.from(filename);
    const body = Buffer.from(value);
    const crc = crc32(body);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(body.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += header.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "guichen-doc-test-"));
const originalCwd = process.cwd();
try {
  setDefaultCwd(testRoot);
  const docx = path.join(testRoot, "sample.docx");
  await fs.writeFile(docx, zipFixture([
    ["word/document.xml", '<w:document xmlns:w="x"><w:p><w:r><w:t>Research &amp; review</w:t></w:r></w:p></w:document>'],
    ["word/vbaProject.bin", "SHOULD_NOT_APPEAR"],
  ]));
  const converted = await convertDocumentText(docx);
  assert.equal(converted.text, "Research & review");
  assert.equal(converted.truncated, false);
  console.log("PASS DOCX text only; embedded macro bytes ignored");

  const pdf = path.join(testRoot, "sample.pdf");
  await fs.writeFile(pdf, pdfFixture());
  const extracted = await extractPdfText(pdf);
  assert.match(extracted.text, /PDF_APPROVAL_TEST/);
  console.log("PASS PDF text extraction through fixed pdftotext invocation");
} finally {
  setDefaultCwd(originalCwd);
  const resolved = path.resolve(testRoot);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unsafe test cleanup path");
  await fs.rm(testRoot, { recursive: true, force: true });
}
