//decompress data as it comes from the server
export function decompress(input: Buffer) {
	switch (input.readUInt8(0x0)) {
		case 0:
			return _uncompressed(input);
		case 1:
			return _bz2(input);
		case 2:
			return _zlib(input);
		case 3:
			return _lzma(input);
		default:
			throw new Error("Unknown compression type (" + input.readUInt8(0x0).toString() + ")");
	}
}

//decompress the BLOBs in the sqlite caches, this may or may not be compatible with the other decompress function
export function decompressSqlite(input: Buffer) {
	switch (input.readUInt8(0x0)) {
		case 0x5a:
			return _zlibSqlite(input);
		default:
			return decompress(input);
			throw new Error(`unknown sqlite compresstion type ${input.readUInt8(0x0).toString(16)}`)
	}
}

//compress data to use in sqlite BLOBs
export function compressSqlite(input: Buffer, compression: "zlib") {
	switch (compression) {
		case "zlib":
			return _zlibSqliteCompress(input);
		default:
			throw new Error(`unknown compression type ${compression}`);
	}
}


/**
 * @param {Buffer} input The input buffer straight from the server
 */
var _uncompressed = function (input: Buffer) {
	var size = input.readUInt32BE(0x1);
	var output = Buffer.alloc(size);
	input.copy(output, 0x0, 0x5);
	return output;
}

/**
 * @param {Buffer} input The input buffer straight from the server
 */
var _bz2 = function (input: Buffer) {
	var bzip2 = require("bzip2");
	var compressed = input.readUInt32BE(0x1);
	var uncompressed = input.readUInt32BE(0x5);
	var processed = Buffer.alloc(compressed + 0x2 + 0x1 + 0x1);
	input.copy(processed, 0x4, 0x9);

	// Add the header
	processed.writeUInt16BE(0x425A, 0x0); // Magic Number
	processed.writeUInt8(0x68, 0x2); // Version
	processed.writeUInt8(Math.ceil(uncompressed / (1024 * 102.4)) + 0x30, 0x3); // Block size in 100kB because why the hell not

	return Buffer.from(bzip2.simple(bzip2.array(processed)));
}

/**
 * @param {Buffer} input The input buffer straight from the server
 */
var _zlib = function (input: Buffer) {
	var zlib = require("zlib") as typeof import("zlib");
	var compressed = input.readUInt32BE(0x1);
	var uncompressed = input.readUInt32BE(0x5);
	var processed = Buffer.alloc(compressed);
	input.copy(processed, 0x0, 0x9);

	return zlib.gunzipSync(processed);
}

/**
 * @param {Buffer} input The input buffer straight from the server
 */
var _lzma = function (input: Buffer) {
	var lzma = require("lzma");
	var compressed = input.readUInt32BE(0x1);
	var uncompressed = input.readUInt32BE(0x5);
	var processed = Buffer.alloc(compressed + 8);
	input.copy(processed, 0x0, 0x9, 0xE);
	processed.writeUInt32LE(uncompressed, 0x5);
	processed.writeUInt32LE(0, 0x5 + 0x4);
	input.copy(processed, 0xD, 0xE);
	return Buffer.from(lzma.decompress(processed));
}


function _zlibSqlite(input: Buffer) {
	//skip header bytes 5a4c4201
	var uncompressed_size = input.readUInt32BE(0x4);
	var zlib = require("zlib") as typeof import("zlib");
	return zlib.inflateSync(input.slice(0x8));
}
function _zlibSqliteCompress(input: Buffer) {
	const zlib = require("zlib") as typeof import("zlib");
	let compressbytes = zlib.deflateSync(input);
	let result = Buffer.alloc(4 + 4 + compressbytes.byteLength);
	result.write("5a4c4201", 0x0, "hex");
	result.writeUInt32BE(input.byteLength, 0x4);
	compressbytes.copy(result, 0x8);
	return result;
}