// Minimal Office files for the Paginated report export: a .xlsx workbook and a .docx document that hold the report's table,
// written as an uncompressed zip (no library: the files are small and every entry is stored). Pure.
import type { TableText } from "./paginated";

const enc = new TextEncoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip file with every entry stored (method 0). */
export function zipStored(entries: { name: string; data: string }[]): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (v: number) => [v & 255, (v >>> 8) & 255];
  const u32 = (v: number) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = enc.encode(e.data);
    const crc = crc32(data);
    // 1980-01-01 00:00 as the time stamp
    const common = [...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)];
    parts.push(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...common]), name, data);
    central.push(Uint8Array.from([0x50, 0x4b, 0x01, 0x02, ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((a, p) => a + p.length, 0);
  const end = Uint8Array.from([0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(centralSize), ...u32(offset), ...u16(0)]);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(new ArrayBuffer(all.reduce((a, p) => a + p.length, 0)));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// characters XML 1.0 cannot hold are dropped
const clean = (t: string) => t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Column letters: 0 -> A, 26 -> AA. */
export function columnName(i: number): string {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** The table as an Excel workbook: one sheet, the header row bold-free, text in inline strings (numbers stay numbers). */
export function tableXlsx(t: TableText): Uint8Array<ArrayBuffer> {
  const cell = (v: string, r: number, c: number) => {
    const ref = `${columnName(c)}${r + 1}`;
    return r > 0 && v.trim() !== "" && /^-?\d+(\.\d+)?$/.test(v.trim()) ? `<c r="${ref}"><v>${v.trim()}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(clean(v))}</t></is></c>`;
  };
  const rows = [t.headers, ...t.rows].map((row, r) => `<row r="${r + 1}">${row.map((v, c) => cell(v, r, c)).join("")}</row>`).join("");
  const sheetName = (t.title.replace(/[\\/?*[\]:]/g, " ").trim() || "Report").slice(0, 31);
  return zipStored([
    { name: "[Content_Types].xml", data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>` },
    { name: "_rels/.rels", data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>` },
    { name: "xl/worksheets/sheet1.xml", data: `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>` },
  ]);
}

/** The table as a Word document: the title and a table with the header row in bold. */
export function tableDocx(t: TableText): Uint8Array<ArrayBuffer> {
  const para = (v: string, bold = false) => `<w:p><w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${esc(clean(v))}</w:t></w:r></w:p>`;
  const tc = (v: string, bold: boolean) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${para(v, bold)}</w:tc>`;
  const tr = (row: string[], bold: boolean) => `<w:tr>${row.map((v) => tc(v, bold)).join("")}</w:tr>`;
  const body = `${t.title ? para(t.title, true) : ""}<w:tbl><w:tblPr><w:tblBorders><w:bottom w:val="single" w:sz="4" w:space="0" w:color="888888"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="DDDDDD"/></w:tblBorders></w:tblPr>${tr(t.headers, true)}${t.rows.map((r) => tr(r, false)).join("")}</w:tbl><w:sectPr/>`;
  return zipStored([
    { name: "[Content_Types].xml", data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>` },
    { name: "_rels/.rels", data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: "word/document.xml", data: `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>` },
  ]);
}
