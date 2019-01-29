const fs = require("fs");
const path = require("path");
const vm = require("vm");

const loglevel = process.env.NODE_VOO_LOGLEVEL;
const log = { $warning: 1, $verbose: 2 }["$" + loglevel] | 0;

const cacheOnly = !!process.env.NODE_VOO_CACHE_ONLY;
const noPersist = !!process.env.NODE_VOO_NO_PERSIST;

const stripBOM = content => {
	if (content.charCodeAt(0) === 0xfeff) {
		content = content.slice(1);
	}
	return content;
};

const stripShebang = content => {
	// Remove shebang
	var contLen = content.length;
	if (contLen >= 2) {
		if (
			content.charCodeAt(0) === 35 &&
			content.charCodeAt(1) === 33 // /^#!/
		) {
			if (contLen === 2) {
				// Exact match
				content = "";
			} else {
				// Find end of shebang line and slice it off
				var i = 2;
				for (; i < contLen; ++i) {
					var code = content.charCodeAt(i);
					if (code === 13 || code === 10) break; // /\r|\n/
				}
				if (i === contLen) content = "";
				else {
					// Note that this actually includes the newline character(s) in the
					// new output. This duplicates the behavior of the regular expression
					// that was previously used to replace the shebang line
					content = content.slice(i);
				}
			}
		}
	}
	return content;
};

function validateString(value) {
	if (typeof value !== "string") {
		const err = new TypeError(
			`The "request" argument must be of type string. Received type ${typeof value}`
		);
		err.code = "ERR_INVALID_ARG_TYPE";
		throw err;
	}
}

const makeRequireFunction = module => {
	const Module = module.constructor;

	function require(path) {
		try {
			exports.requireDepth += 1;
			return module.require(path);
		} finally {
			exports.requireDepth -= 1;
		}
	}

	function resolve(request, options) {
		validateString(request);
		return Module._resolveFilename(request, module, false, options);
	}

	require.resolve = resolve;

	function paths(request) {
		validateString(request);
		return Module._resolveLookupPaths(request, module, true);
	}

	resolve.paths = paths;

	require.main = process.mainModule;

	// Enable support to add extra extension types.
	require.extensions = Module._extensions;

	require.cache = Module._cache;

	return require;
};

const writeSync = (fd, buffer) => {
	const length = buffer.length;
	let offset = 0;
	do {
		const written = fs.writeSync(fd, buffer, offset, length);
		if (written === length) return;
		offset += written;
		length -= written;
	} while (true);
};

const readSync = (fd, buffer) => {
	const length = buffer.length;
	let offset = 0;
	do {
		const read = fs.readSync(fd, buffer, offset, length, null);
		if (read === length) return buffer;
		offset += read;
		length -= read;
	} while (true);
};

const cache = new Map();
const allVoos = [];

class Voo {
	constructor(dirname, rootFile) {
		this.rootFile = rootFile;
		this.filename = path.join(
			dirname,
			"." + path.basename(rootFile) + ".node-voo-cache"
		);
		this.created = Date.now() / 1000;
		this.started = 0;
		this.lifetime = 0;
		this.modules = new Map();
		this.scriptSource = undefined;
		this.script = undefined;
	}

	persist() {
		if (this.started) {
			this.lifetime += Date.now() - this.started;
		}
		let cachedData;
		let scriptSource;
		if (this.scriptSource) {
			scriptSource = Buffer.from(this.scriptSource, "utf-8");
			if (this.script) {
				cachedData = this.script.createCachedData();
			}
		}
		const fd = fs.openSync(this.filename, "w");
		const header = Buffer.allocUnsafe(24);
		header.writeInt32LE(1, 0, true); // version
		header.writeDoubleLE(this.created, 4, true);
		header.writeInt32LE(this.lifetime, 8, true);
		header.writeInt32LE(this.modules.size, 12, true);
		header.writeInt32LE(scriptSource ? scriptSource.length : 0, 16, true);
		header.writeInt32LE(cachedData ? cachedData.length : 0, 20, true);
		writeSync(fd, header);
		const moduleInfo = Buffer.allocUnsafe(this.modules.size * 8);
		const buffers = [moduleInfo];
		let pos = 0;
		for (const [filename, source] of this.modules) {
			const filenameBuffer = Buffer.from(filename, "utf-8");
			moduleInfo.writeInt32LE(filenameBuffer.length, pos);
			pos += 4;
			moduleInfo.writeInt32LE(source.length, pos);
			pos += 4;
			buffers.push(filenameBuffer, source);
		}
		for (const buffer of buffers) {
			writeSync(fd, buffer);
		}
		if (scriptSource) {
			writeSync(fd, scriptSource);
		}
		if (cachedData) {
			writeSync(fd, cachedData);
		}
		fs.closeSync(fd);
		if (log >= 2) {
			console.log(
				`node-voo ${this.filename} persisted ${this.modules.size} modules ${
					scriptSource ? Math.ceil(scriptSource.length / 104857.6) / 10 : 0
				} MiB Source Code ${
					cachedData ? Math.ceil(cachedData.length / 104857.6) / 10 : 0
				} MiB V8 Cached Data`
			);
		}
	}

	tryRestore(Module) {
		let fd;
		try {
			// Read cache file
			fd = fs.openSync(this.filename, "r");
			const header = readSync(fd, Buffer.allocUnsafe(24));
			if (header.readInt32LE(0, true) !== 1)
				throw new Error("Incorrect cache file version");
			this.created = header.readInt32LE(4, true);
			this.lifetime = header.readInt32LE(8, true);
			const numberOfModules = header.readInt32LE(12, true);
			const scriptSourceSize = header.readInt32LE(16, true);
			const cachedDataSize = header.readInt32LE(20, true);
			const modulesInfo = readSync(fd, Buffer.allocUnsafe(numberOfModules * 8));
			for (let i = 0; i < numberOfModules; i++) {
				const filenameLength = modulesInfo.readInt32LE(i * 8, true);
				const sourceLength = modulesInfo.readInt32LE(i * 8 + 4, true);
				const filename = readSync(
					fd,
					Buffer.allocUnsafe(filenameLength)
				).toString("utf-8");
				const source = readSync(fd, Buffer.allocUnsafe(sourceLength));
				this.modules.set(filename, source);
			}
			let scriptSource;
			if (scriptSourceSize > 0) {
				scriptSource = readSync(fd, Buffer.allocUnsafe(scriptSourceSize));
				this.scriptSource = scriptSource.toString("utf-8");
			} else {
				this.createScriptSource(Module);
			}
			let cachedData = undefined;
			if (cachedDataSize > 0) {
				cachedData = readSync(fd, Buffer.allocUnsafe(cachedDataSize));
			}

			this.script = new vm.Script(this.scriptSource, {
				cachedData,
				filename: this.filename + ".js",
				lineOffset: 0,
				displayErrors: true,
				importModuleDynamically: undefined
			});
			if (log >= 1 && this.script.cachedDataRejected) {
				console.warn(`node-voo ${this.filename} cachedData was rejected by v8`);
			}
			const result = this.script.runInThisContext();

			// File cache with data
			for (const [filename, source] of this.modules) {
				const fn = result["$" + filename];
				cache.set(filename, { source, fn });
			}

			if (log >= 2) {
				console.log(
					`node-voo ${this.filename} restored ${this.modules.size} modules ${
						scriptSource ? Math.ceil(scriptSource.length / 104857.6) / 10 : 0
					} MiB Source Code ${
						cachedData ? Math.ceil(cachedData.length / 104857.6) / 10 : 0
					} MiB V8 Cached Data`
				);
			}
		} catch (e) {
			if (fd) {
				try {
					fs.closeSync(fd);
				} catch (e) {}
			}
			if (e.code !== "ENOENT") {
				if (log >= 2) {
					console.log(`node-voo ${this.filename} failed to restore: ${e}`);
				}
			} else {
				if (log >= 2) {
					console.log(`node-voo ${this.filename} no cache file`);
				}
			}
		}
	}

	createScriptSource(Module) {
		// Create optimizes source with cached data
		this.scriptSource = `(function() {\nvar __node_voo_result = {};\n${Array.from(
			this.modules
		)
			.map(([filename, source]) => {
				return `__node_voo_result[${JSON.stringify(
					"$" + filename
				)}] = ${Module.wrap(stripShebang(stripBOM(source.toString("utf-8"))))}`;
			})
			.join("\n")}\nreturn __node_voo_result;\n})();`;
	}

	start() {
		this.started = Date.now();
		if (!noPersist) {
			allVoos.push(this);
			const startTimeout = () => {
				const persistIn = Math.min(
					Math.max(10000, this.lifetime * 2),
					60 * 60 * 1000
				);
				setTimeout(() => {
					this.persist();
					startTimeout;
				}, persistIn).unref();
			};
			startTimeout();
		}
	}

	track(filename, source) {
		if (source) {
			this.modules.set(filename, source);
			this.scriptSource = undefined;
		}
	}
}

if (!noPersist) {
	process.once("exit", () => {
		const start = Date.now();
		while (allVoos.length > 0) {
			const random = Math.floor(Math.random() * allVoos.length);
			const voo = allVoos[random];
			voo.persist();
			allVoos.splice(random, 1);
			if (Date.now() - start >= 100) break;
		}
		if (log >= 1) {
			if (allVoos.length === 0) {
				if (log >= 2) {
					console.log(`node-voo all Voos persisted in ${Date.now() - start}ms`);
				}
			} else {
				console.warn(
					`node-voo ${
						allVoos.length
					} Voos not persisted because time limit reached (took ${Date.now() -
						start}ms)`
				);
			}
		}
	});
}

let currentVoo = undefined;

require.extensions[".js"] = (module, filename) => {
	const newVoo = currentVoo === undefined;
	const dirname = path.dirname(filename);
	if (newVoo) {
		currentVoo = new Voo(dirname, filename);
		currentVoo.tryRestore(module.constructor);
	}
	try {
		let content;
		if (!cacheOnly) content = fs.readFileSync(filename);
		const cacheEntry = cache.get(filename);
		if (
			cacheEntry !== undefined &&
			(cacheOnly || Buffer.compare(cacheEntry.source, content) === 0)
		) {
			const require = makeRequireFunction(module);
			const exports = module.exports;
			currentVoo.track(filename);
			cacheEntry.fn.call(exports, exports, require, module, filename, dirname);
		} else {
			if (log >= 1 && cacheEntry !== undefined) {
				console.warn(`node-voo ${filename} Source in cache doesn't match`);
			}
			if (cacheOnly) content = fs.readFileSync(filename);
			currentVoo.track(filename, content);
			module._compile(stripBOM(content.toString("utf-8")), filename);
		}
		if (newVoo) {
			currentVoo.start();
		}
	} finally {
		if (newVoo) {
			currentVoo = undefined;
		}
	}
};
