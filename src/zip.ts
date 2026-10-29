export type ZipEntry = {
	name: string;
	data: Buffer;
};

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_RECORD = 0x06054b50;
const VERSION = 20;
const UTF8_FLAG = 0x0800;
const DOS_EPOCH_YEAR = 1980;

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

export function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(date: Date): { time: number; day: number } {
	const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
	const day = ((date.getFullYear() - DOS_EPOCH_YEAR) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
	return { time, day };
}

function localHeader(name: Buffer, entry: ZipEntry, crc: number, stamp: { time: number; day: number }): Buffer {
	const header = Buffer.alloc(30);
	header.writeUInt32LE(LOCAL_HEADER, 0);
	header.writeUInt16LE(VERSION, 4);
	header.writeUInt16LE(UTF8_FLAG, 6);
	header.writeUInt16LE(0, 8);
	header.writeUInt16LE(stamp.time, 10);
	header.writeUInt16LE(stamp.day, 12);
	header.writeUInt32LE(crc, 14);
	header.writeUInt32LE(entry.data.length, 18);
	header.writeUInt32LE(entry.data.length, 22);
	header.writeUInt16LE(name.length, 26);
	header.writeUInt16LE(0, 28);
	return header;
}

function centralHeader(name: Buffer, entry: ZipEntry, crc: number, stamp: { time: number; day: number }, offset: number): Buffer {
	const header = Buffer.alloc(46);
	header.writeUInt32LE(CENTRAL_HEADER, 0);
	header.writeUInt16LE(VERSION, 4);
	header.writeUInt16LE(VERSION, 6);
	header.writeUInt16LE(UTF8_FLAG, 8);
	header.writeUInt16LE(0, 10);
	header.writeUInt16LE(stamp.time, 12);
	header.writeUInt16LE(stamp.day, 14);
	header.writeUInt32LE(crc, 16);
	header.writeUInt32LE(entry.data.length, 20);
	header.writeUInt32LE(entry.data.length, 24);
	header.writeUInt16LE(name.length, 28);
	header.writeUInt32LE(offset, 42);
	return header;
}

export function zip(entries: ZipEntry[], date = new Date()): Buffer {
	const stamp = dosTime(date);
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const crc = crc32(entry.data);
		const local = localHeader(name, entry, crc, stamp);
		parts.push(local, name, entry.data);
		central.push(centralHeader(name, entry, crc, stamp, offset), name);
		offset += local.length + name.length + entry.data.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(END_RECORD, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, directory, end]);
}
