import { inflateRawSync } from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * The first file in a zip whose name ends with `suffix`, decompressed (stored
 * or deflated, the two methods real zips use). Read through the central
 * directory, so sizes are right even when the local header defers them.
 * Throws on anything else: not a zip, no such file, ZIP64, another method,
 * or a file larger than `maxBytes` once decompressed.
 */
export function unzipFile(zip: Buffer, suffix: string, maxBytes: number): Buffer {
  // The end-of-central-directory record: 22 bytes plus a comment of up to 64 KB, at the very end.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip file.");
  const entries = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < entries; n++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== CENTRAL) throw new Error("Damaged zip directory.");
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const skip = nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + skip;
    if (!name.toLowerCase().endsWith(suffix)) continue;
    if (packed === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw new Error("ZIP64 isn't supported.");
    if (size > maxBytes) throw new Error(`${name} is larger than expected.`);
    if (offset + 30 > zip.length || zip.readUInt32LE(offset) !== LOCAL) throw new Error("Damaged zip entry.");
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const data = zip.subarray(start, start + packed);
    if (data.length !== packed) throw new Error("Truncated zip entry.");
    if (method === 0) return data;
    if (method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes });
    throw new Error(`Unsupported zip method ${method}.`);
  }
  throw new Error(`No ${suffix} file in the zip.`);
}
