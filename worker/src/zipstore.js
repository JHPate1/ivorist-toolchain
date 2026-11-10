/* =========================================================
   STORE-method zip writer, zero dependencies, isomorphic:
   runs in Node (AWS bot / local runner) AND in Cloudflare
   Workers / Durable Objects (no Buffer anywhere).

   Lets the ops layer wrap raw attachments into one
   upload-ready archive with NO compression; extractors
   (Expand-Archive) accept the result byte-for-byte.
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

function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
        crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function u16(target, offset, value) {
    target[offset] = value & 0xff;
    target[offset + 1] = (value >>> 8) & 0xff;
}

function u32(target, offset, value) {
    target[offset] = value & 0xff;
    target[offset + 1] = (value >>> 8) & 0xff;
    target[offset + 2] = (value >>> 16) & 0xff;
    target[offset + 3] = (value >>> 24) & 0xff;
}

// Fixed date: 2026-01-01 00:00 (deterministic archives)
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function concatParts(parts) {
    let total = 0;
    for (const p of parts) {
        total += p.length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}

/**
 * entries: [{ name: "relative/path.txt", data: Uint8Array | ArrayBuffer | string }]
 * Returns Uint8Array of a valid STORE zip.
 */
export function createZipStore(entries) {
    const localParts = [];
    const localBufs = []; // full local sections, so offsets stay correct
    const centralParts = [];
    let offset = 0;

    for (const entry of entries) {
        const nameBytes = new TextEncoder().encode(String(entry.name));
        let data;
        if (typeof entry.data === "string") {
            data = new TextEncoder().encode(entry.data);
        } else {
            data = new Uint8Array(entry.data);
        }
        if (nameBytes.length === 0 || nameBytes.length > 240) {
            throw new Error(`bad zip entry name: ${entry.name}`);
        }
        const crc = crc32(data);

        const local = new Uint8Array(30 + nameBytes.length + data.length);
        u32(local, 0, 0x04034b50); // local file header sig
        u16(local, 4, 20);         // version needed
        u16(local, 6, 0);          // flags
        u16(local, 8, 0);          // method STORE
        u16(local, 10, DOS_TIME);
        u16(local, 12, DOS_DATE);
        u32(local, 14, crc);
        u32(local, 18, data.length); // compressed
        u32(local, 22, data.length); // uncompressed
        u16(local, 26, nameBytes.length);
        u16(local, 28, 0);           // extra len
        local.set(nameBytes, 30);
        local.set(data, 30 + nameBytes.length);

        localBufs.push(local);
        localParts.push(local);

        const central = new Uint8Array(46 + nameBytes.length);
        u32(central, 0, 0x02014b50); // central dir sig
        u16(central, 4, 20);         // version made by
        u16(central, 6, 20);         // version needed
        u16(central, 8, 0);          // flags
        u16(central, 10, 0);         // method
        u16(central, 12, DOS_TIME);
        u16(central, 14, DOS_DATE);
        u32(central, 16, crc);
        u32(central, 20, data.length);
        u32(central, 24, data.length);
        u16(central, 28, nameBytes.length);
        u16(central, 30, 0);         // extra
        u16(central, 32, 0);         // comment
        u16(central, 34, 0);         // disk
        u16(central, 36, 0);         // internal attrs
        u32(central, 38, 0);         // external attrs
        u32(central, 42, offset);    // local header offset
        central.set(nameBytes, 46);
        centralParts.push(central);

        offset += localBufs[localBufs.length - 1].length;
    }

    void localParts;
    const centralBuf = concatParts(centralParts);

    const eocd = new Uint8Array(22);
    u32(eocd, 0, 0x06054b50);
    u16(eocd, 4, 0); // disk number
    u16(eocd, 6, 0);
    u16(eocd, 8, entries.length);
    u16(eocd, 10, entries.length);
    u32(eocd, 12, centralBuf.length);
    u32(eocd, 16, offset); // offset of central directory
    u16(eocd, 20, 0);      // comment len

    return concatParts([...localBufs, centralBuf, eocd]);
}
