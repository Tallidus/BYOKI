import { Buffer } from "node:buffer";
import { deflateRawSync } from "node:zlib";

function crc32(buffer) {
  let crc = ~0;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return ~crc >>> 0;
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

/**
 * DOS time and date. The date field cannot be zero: that is 1980-00-00, which
 * unzip and Python reject. Dates before 1980 fall back to 1980-01-01.
 */
function dosStamp(date = new Date()) {
  let year = date.getFullYear();
  let month = date.getMonth() + 1;
  let day = date.getDate();
  let hours = date.getHours();
  let minutes = date.getMinutes();
  let seconds = Math.floor(date.getSeconds() / 2);
  if (year < 1980 || month < 1 || day < 1) {
    return { time: 0, date: (1 << 5) | 1 };
  }
  if (year > 2107) {
    year = 2107;
    month = 12;
    day = 31;
    hours = 23;
    minutes = 59;
    seconds = 29;
  }
  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day,
  };
}

/** Zip archive using deflate. `files` is `{ name, data }` with POSIX paths. */
export function createZip(files, date = new Date()) {
  const locals = [];
  const centrals = [];
  const stamp = dosStamp(date);
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name.replaceAll("\\", "/"), "utf8");
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const compressed = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(8),
      u16(stamp.time),
      u16(stamp.date),
      u32(crc),
      u32(compressed.length),
      u32(raw.length),
      u16(name.length),
      u16(0),
      name,
      compressed,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(8),
      u16(stamp.time),
      u16(stamp.date),
      u32(crc),
      u32(compressed.length),
      u32(raw.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, centralDir, end]);
}
