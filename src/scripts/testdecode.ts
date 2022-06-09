import { DecodeState, getDebug } from "../opcode_reader";
import { CacheFileSource, CacheIndex, SubFile } from "../cache";
import { DecodeMode, cacheFileDecodeModes } from "./extractfiles";
import { CLIScriptOutput, ScriptOutput } from "../viewer/scriptsui";


export type DecodeErrorJson = {
	chunks: { offset: number, bytes: string, text: string }[],
	remainder: string,
	state: any,
	error: string
}

export type DecodeEntry = { major: number, minor: number, subfile: number, file: Buffer, name?: string };

export function defaultTestDecodeOpts() {
	return {
		skipMinorAfterError: false,
		skipFilesizeAfterError: false,
		memlimit: 200e6,
		orderBySize: false,
		outmode: "json" as "json" | "hextext" | "original" | "none"
	};
}

export async function testDecode(output: ScriptOutput, source: CacheFileSource, mode: DecodeMode, opts: ReturnType<typeof defaultTestDecodeOpts>) {
	const { skipMinorAfterError, skipFilesizeAfterError, memlimit, orderBySize } = opts;
	if (!mode.parser) { throw new Error("decode mode doesn't have a standard parser"); }
	const decoder = mode.parser;
	let memuse = 0;
	let errminors: number[] = [];
	let errfilesizes: number[] = [];
	let maxerrs = 20;
	let nsuccess = 0;
	let lastProgress = Date.now();

	let fileiter: () => AsyncGenerator<DecodeEntry>;

	let files = await mode.logicalRangeToFiles(source, [0, 0], [Infinity, Infinity]);

	//pre-sort to get more small file under mem limit
	// files.sort((a, b) => (a.index.size ?? 0) - (b.index.size ?? 0));

	fileiter = async function* () {
		let allfiles: DecodeEntry[] = [];
		let currentarch: SubFile[] | null = null;
		let currentarchindex: CacheIndex | null = null;
		for (let file of files) {
			let index = file.index;
			if (index != currentarchindex) {
				currentarch = await source.getFileArchive(index);
				currentarchindex = index;
				memuse += currentarch.reduce((a, v) => a + v.size, 0);
			}

			let subfile = currentarch![file.subindex];
			if (!subfile) {
				output.log("subfile not found");
				continue;
			}
			let entry: DecodeEntry = { major: index.major, minor: index.minor, subfile: file.subindex, file: subfile.buffer };
			if (orderBySize) {
				allfiles.push(entry);
				if (memuse > memlimit) {
					output.log("skipping file because of memory limit", files.indexOf(file), "/", files.length);
					return false;
				}
			} else {
				yield entry;
			}
		}

		if (allfiles.length != 0) {
			allfiles.sort((a, b) => a.file.byteLength - b.file.byteLength);
			output.log("starting files:", allfiles.length);
			// allfiles = allfiles.filter((q, i) => i % 20 == 0);
			yield* allfiles;
		}
	}

	function testFile(file: DecodeEntry) {
		if (skipMinorAfterError && errminors.indexOf(file.minor) != -1) { return true; }
		if (skipFilesizeAfterError && errfilesizes.indexOf(file.file.byteLength) != -1) { return true; }
		if (Date.now() - lastProgress > 10000) {
			output.log("progress, file ", file.major, file.minor, file.subfile);
			lastProgress = Date.now();
		}

		getDebug(true);
		let state: DecodeState = {
			buffer: file.file,
			stack: [],
			hiddenstack: [],
			scan: 0,
			startoffset: 0,
			endoffset: file.file.byteLength,
			args: {}
		};
		try {
			decoder.readInternal(state);
			nsuccess++;
			return true;
		} catch (e) {
			errminors.push(file.minor);
			errfilesizes.push(file.file.byteLength);
			let debugdata = getDebug(false)!;
			output.log("decode", file.minor, file.subfile, (e as Error).message);

			if (output.state == "running") {
				let outname = (file.name ? `err-${file.name}` : `err-${file.major}_${file.minor}_${file.subfile}.bin`);
				if (opts.outmode == "original") {
					output.writeFile(outname, file.file, "bin");
				}
				if (opts.outmode == "json" || opts.outmode == "hextext") {
					let err: DecodeErrorJson = {
						chunks: [],
						remainder: "",
						state: null,
						error: (e as Error).message
					};
					let index = 0;
					let outindex = 0;
					for (let i = 0; i < debugdata.opcodes.length; i++) {
						let op = debugdata.opcodes[i];
						let endindex = (i + 1 < debugdata.opcodes.length ? debugdata.opcodes[i + 1].index : state.scan);
						let bytes = file.file.slice(index, endindex).toString("hex");
						outindex += endindex - index;
						let opstr = " ".repeat(op.stacksize - 1) + (typeof op.op == "number" ? "0x" + op.op.toString(16).padStart(2, "0") : op.op);
						err.chunks.push({ offset: index, bytes, text: opstr });
						index = endindex;
					}
					err.remainder = file.file.slice(index).toString("hex");
					// err.state = state.stack[state.stack.length - 1] ?? null;
					err.state = debugdata.structstack[debugdata.structstack.length - 1] ?? null;

					if (opts.outmode == "json") {
						output.writeFile(outname, JSON.stringify(err), "filedecodeerror");
					}
					if (opts.outmode == "hextext") {
						let chunks: Buffer[] = [];
						let outindex = 0;
						for (let chunk of err.chunks) {
							chunks.push(Buffer.from(chunk.bytes, "hex"));
							outindex += chunk.bytes.length;
							let opstr = chunk.text.slice(0, 6).padStart(6, "\0");
							let minfill = opstr.length + 1;
							let fillsize = (outindex == 0 ? 0 : Math.ceil((outindex + minfill) / 16) * 16 - outindex);
							if (fillsize > 0) {
								chunks.push(Buffer.alloc(1, 0xDD));
								chunks.push(Buffer.alloc(fillsize - 1 - opstr.length, 0xff));
								chunks.push(Buffer.from(opstr, "ascii"));
							}
							outindex += fillsize;
						}
						let remainder = Buffer.from(err.remainder, "hex");
						chunks.push(remainder);
						outindex += remainder.byteLength
						chunks.push(Buffer.alloc(2, 0xcc));
						outindex += 2;
						let fillsize = (outindex == 0 ? 0 : Math.ceil((outindex + 33) / 16) * 16 - outindex);
						chunks.push(Buffer.alloc(fillsize, 0xff));
						chunks.push(Buffer.from(err.error, "ascii"));
						chunks.push(Buffer.alloc(5));
						chunks.push(Buffer.from(err.state, "ascii"));

						output.writeFile(outname, Buffer.concat(chunks), "bin");
					}
				}
			}

			maxerrs--;
			return maxerrs > 0;
		}
	}

	for await (let file of fileiter()) {
		if (output.state != "running") {
			break;
		}
		if (!testFile(file)) {
			break;
		}
	}

	output.log("completed files:", nsuccess);
}
