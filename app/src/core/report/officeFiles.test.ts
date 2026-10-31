import { describe, expect, it } from "vitest";
import { columnName, crc32, tableDocx, tableXlsx, zipStored } from "./officeFiles";

/** Reads a zip whose entries are stored: [name, text] pairs, with the CRC of each entry checked against its data. */
function readZip(zip: Uint8Array): [string, string][] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const out: [string, string][] = [];
  // the end record says where the central directory is and how many entries there are
  const end = zip.length - 22;
  expect(v.getUint32(end, true)).toBe(0x06054b50);
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(at, true)).toBe(0x02014b50);
    const crc = v.getUint32(at + 16, true);
    const size = v.getUint32(at + 24, true);
    const nameLen = v.getUint16(at + 28, true);
    const local = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
    expect(v.getUint32(local, true)).toBe(0x04034b50);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const data = zip.subarray(start, start + size);
    expect(crc32(data), name).toBe(crc);
    out.push([name, new TextDecoder().decode(data)]);
    at += 46 + nameLen;
  }
  return out;
}

const t = { title: "Product list", headers: ["Product name", "List price"], rows: [["Ridge <MTB> & co", "1450"], ["Orbit Helmet", "59.5"], ["Blank", ""]] };

describe("Office files of the paginated report export", () => {
  it("writes a zip whose entries read back with the right CRC (the known CRC of 123456789)", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const z = readZip(zipStored([{ name: "a.txt", data: "hello" }, { name: "dir/b.txt", data: "wörld" }]));
    expect(z).toEqual([["a.txt", "hello"], ["dir/b.txt", "wörld"]]);
  });
  it("names spreadsheet columns", () => {
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"]);
  });
  it("the workbook has one sheet with the header row, text as text and numbers as numbers", () => {
    const parts = Object.fromEntries(readZip(tableXlsx(t)));
    expect(Object.keys(parts)).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml"]);
    expect(parts["xl/workbook.xml"]).toContain('<sheet name="Product list" sheetId="1"');
    const sheet = parts["xl/worksheets/sheet1.xml"];
    expect(sheet).toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve">Product name</t></is></c>');
    expect(sheet).toContain("Ridge &lt;MTB&gt; &amp; co");
    expect(sheet).toContain('<c r="B2"><v>1450</v></c>');
    expect(sheet).toContain('<c r="B3"><v>59.5</v></c>');
    expect(sheet).toContain('<c r="B4" t="inlineStr">');
  });
  it("the document has the title and the table with a bold header row", () => {
    const parts = Object.fromEntries(readZip(tableDocx(t)));
    const doc = parts["word/document.xml"];
    expect(doc).toContain("<w:b/></w:rPr><w:t xml:space=\"preserve\">Product list</w:t>");
    expect(doc.match(/<w:tr>/g)).toHaveLength(4);
    expect(doc).toContain("Ridge &lt;MTB&gt; &amp; co");
    expect(parts["[Content_Types].xml"]).toContain("wordprocessingml.document.main+xml");
  });
});
