// Packs extension/ into dist/ebb-<version>.zip, the format the Chrome Web Store takes.
// Usage: npm run pack   (no dependencies: a small zip writer on top of zlib)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const { version } = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const walk = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => !d.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));

const locals = [];
const centrals = [];
let offset = 0;
// A fixed timestamp (2026-01-01 00:00) keeps the archive byte-for-byte reproducible.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

for (const file of walk(EXT)) {
  const name = Buffer.from(path.relative(EXT, file).split(path.sep).join('/'));
  const data = fs.readFileSync(file);
  const packed = zlib.deflateRawSync(data, { level: 9 });
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  locals.push(local, name, packed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);
  offset += local.length + name.length + packed.length;
}

const directory = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(centrals.length / 2, 8);
end.writeUInt16LE(centrals.length / 2, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist', `ebb-${version}.zip`);
fs.writeFileSync(out, Buffer.concat([...locals, directory, end]));
console.log(`wrote ${path.relative(ROOT, out)} (${centrals.length / 2} files, ${Math.round(fs.statSync(out).size / 1024)} KB)`);
