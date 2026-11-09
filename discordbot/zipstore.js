/* =========================================================
   STORE-method zip writer (no dependencies)
   Lets the bot wrap any set of raw attachments into one
   upload-ready archive with NO compression and NO trust in
   third-party code. Extractors (Expand-Archive) accept it.
   ========================================================= */

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let c = i;
        for (let k = 0; k < 8; k += 1) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[i] = c >>> 0;
    }
    return table;
})();

function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) {
        crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function u16(v) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v & 0xffff, 0);
    return b;
}

function u32(v) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0, 0);
    return b;
}

// Fixed date: 2026-01-01 00:00 (deterministic archives)
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/**
 * entries: [{ name: "relative/path.txt", data: Buffer }]
 * returns Buffer of a valid STORE zip.
 */
export function createZipStore(entries) {
    const localBufs = [];
    const centralParts = [];
    let offset = 0;

    for (const entry of entries) {
        const nameBytes = Buffer.from(String(entry.name), "utf8");
        const data = entry.data;
        if (nameBytes.length === 0 || nameBytes.length > 240) {
            throw new Error(`bad zip entry name: ${entry.name}`);
        }
        const crc = crc32(data);

        localBufs.push(Buffer.concat([
            u32(0x04034b50), // local file header sig
            u16(20),         // version needed
            u16(0),          // flags
            u16(0),          // method STORE
            u16(DOS_TIME),
            u16(DOS_DATE),
            u32(crc),
            u32(data.length), // compressed
            u32(data.length), // uncompressed
            u16(nameBytes.length),
            u16(0),           // extra len
            nameBytes,
            data
        ]));

        centralParts.push(
            u32(0x02014b50), // central dir sig
            u16(20),          // version made by
            u16(20),          // version needed
            u16(0),
            u16(0),
            u16(DOS_TIME),
            u16(DOS_DATE),
            u32(crc),
            u32(data.length),
            u32(data.length),
            u16(nameBytes.length),
            u16(0),           // extra
            u16(0),           // comment
            u16(0),           // disk
            u16(0),           // internal attrs
            u32(0),           // external attrs
            u32(offset),      // local header offset
            nameBytes
        );

        offset += localBufs[localBufs.length - 1].length;
    }

    const localBuf = Buffer.concat(localBufs);
    const centralBuf = Buffer.concat(centralParts);

    const eocd = Buffer.concat([
        u32(0x06054b50),
        u16(0), // disk numbers
        u16(0),
        u16(entries.length),
        u16(entries.length),
        u32(centralBuf.length),
        u32(localBuf.length),
        u16(0)
    ]);

    return Buffer.concat([localBuf, centralBuf, eocd]);
}
