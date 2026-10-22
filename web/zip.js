// Minimal .zip reading and writing for save backups and patches, with no libraries.
//   RcZip.write([{ path, data: Blob | Uint8Array | string, date? }]) -> Blob   (stored, not compressed)
//   RcZip.read(blob) -> [{ path, size, read: () => Promise<Uint8Array> }]     (stored or deflated entries)
// Reading checks every entry's size and CRC-32 and refuses encrypted, split and ZIP64 archives; paths are
// returned as written (callers decide what a safe path is).
(function (root) {
  'use strict';

  const CRC = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC[n] = c >>> 0;
  }
  function crc32(bytes, crc = 0) {
    crc = ~crc >>> 0;
    for (let i = 0; i < bytes.length; i++) crc = CRC[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return ~crc >>> 0;
  }

  const bytesOf = async (data) => (typeof data === 'string' ? new TextEncoder().encode(data)
    : data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer()));

  // MS-DOS date and time, as zip stores them
  function dosTime(d) {
    return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
  }

  async function write(entries) {
    const parts = [], central = [];
    let offset = 0;
    for (const e of entries) {
      const data = await bytesOf(e.data);
      const name = new TextEncoder().encode(e.path);
      const { time, date } = dosTime(e.date || new Date());
      const crc = crc32(data);
      const head = new DataView(new ArrayBuffer(30));
      head.setUint32(0, 0x04034b50, true);
      head.setUint16(4, 20, true);
      head.setUint16(6, 0x0800, true);   // names in UTF-8
      head.setUint16(8, 0, true);        // stored
      head.setUint16(10, time, true);
      head.setUint16(12, date, true);
      head.setUint32(14, crc, true);
      head.setUint32(18, data.length, true);
      head.setUint32(22, data.length, true);
      head.setUint16(26, name.length, true);
      const dir = new DataView(new ArrayBuffer(46));
      dir.setUint32(0, 0x02014b50, true);
      dir.setUint16(4, 20, true);
      dir.setUint16(6, 20, true);
      dir.setUint16(8, 0x0800, true);
      dir.setUint16(12, time, true);
      dir.setUint16(14, date, true);
      dir.setUint32(16, crc, true);
      dir.setUint32(20, data.length, true);
      dir.setUint32(24, data.length, true);
      dir.setUint16(28, name.length, true);
      dir.setUint32(42, offset, true);
      parts.push(head, name, data);
      central.push(dir, name);
      offset += 30 + name.length + data.length;
      if (offset > 0xffffffff) throw new Error('Backup too large for a zip file.');
    }
    const size = central.reduce((s, p) => s + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, size, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  // Inflates at most `limit` bytes: a damaged or hostile entry that unpacks to more than it declares is
  // stopped there instead of filling memory. Memory follows the data that actually arrives, not the
  // declared size, so a small archive can't make the page reserve gigabytes.
  async function inflate(bytes, limit) {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const parts = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > limit) { reader.cancel().catch(() => {}); throw new Error('larger than declared'); }
      parts.push(value);
    }
    const out = new Uint8Array(n);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  async function read(blob) {
    const bad = (why) => new Error(`Not a usable .zip file: ${why}.`);
    // the end record sits in the last 22 bytes plus a comment of up to 64 KB
    const tail = new Uint8Array(await blob.slice(Math.max(0, blob.size - 22 - 65535)).arrayBuffer());
    const tv = new DataView(tail.buffer);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw bad('no zip directory found');
    const count = tv.getUint16(e + 10, true), dirSize = tv.getUint32(e + 12, true), dirAt = tv.getUint32(e + 16, true);
    if (tv.getUint16(e + 4, true) || tv.getUint16(e + 6, true)) throw bad('split archives are not supported');
    if (count === 0xffff || dirAt === 0xffffffff) throw bad('ZIP64 archives are not supported');
    if (dirAt + dirSize > blob.size) throw bad('the directory is cut off');
    const dir = new DataView(await blob.slice(dirAt, dirAt + dirSize).arrayBuffer());
    const out = [];
    for (let p = 0, k = 0; k < count; k++) {
      if (p + 46 > dir.byteLength || dir.getUint32(p, true) !== 0x02014b50) throw bad('damaged directory');
      const flags = dir.getUint16(p + 8, true), method = dir.getUint16(p + 10, true);
      const crc = dir.getUint32(p + 16, true), csize = dir.getUint32(p + 20, true), size = dir.getUint32(p + 24, true);
      const nlen = dir.getUint16(p + 28, true), xlen = dir.getUint16(p + 30, true), clen = dir.getUint16(p + 32, true);
      const at = dir.getUint32(p + 42, true);
      const raw = new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nlen);
      const path = flags & 0x0800 ? new TextDecoder().decode(raw) : String.fromCharCode(...raw);
      p += 46 + nlen + xlen + clen;
      if (path.endsWith('/')) continue;   // a folder entry
      if (flags & 1) throw bad(`${path} is encrypted`);
      if (method !== 0 && method !== 8) throw bad(`${path} uses an unsupported compression method`);
      const dataStart = async () => {
        const lh = new DataView(await blob.slice(at, at + 30).arrayBuffer());
        if (lh.getUint32(0, true) !== 0x04034b50) throw bad(`damaged entry ${path}`);
        return at + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      };
      out.push({
        path, size, crc,
        async read() {
          const start = await dataStart();
          const packed = new Uint8Array(await blob.slice(start, start + csize).arrayBuffer());
          const data = method === 0 ? packed : await inflate(packed, size).catch(() => { throw bad(`${path} is damaged`); });
          if (data.length !== size || crc32(data) !== crc) throw bad(`${path} is damaged (size or checksum mismatch)`);
          return data;
        },
        // The data as a stream, for big files (a patch's data.gob): checked against the size and CRC-32 as it
        // flows, so a consumer piping it into a file sees an error, not a silently damaged copy.
        async stream() {
          const start = await dataStart();
          let s = blob.slice(start, start + csize).stream();
          if (method === 8) s = s.pipeThrough(new DecompressionStream('deflate-raw'));
          let n = 0, sum = 0;
          return s.pipeThrough(new TransformStream({
            transform(chunk, ctl) {
              n += chunk.length;
              if (n > size) { ctl.error(bad(`${path} is damaged`)); return; }
              sum = crc32(chunk, sum);
              ctl.enqueue(chunk);
            },
            flush(ctl) { if (n !== size || sum !== crc) ctl.error(bad(`${path} is damaged (size or checksum mismatch)`)); },
          }));
        },
      });
    }
    return out;
  }

  const api = { read, write, crc32 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RcZip = api;
})(typeof self !== 'undefined' ? self : this);
