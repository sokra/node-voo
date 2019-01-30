const fs = require("fs");
const path = require("path");
const vm = require("vm");

const loglevel = process.env.NODE_VOO_LOGLEVEL;
const log = { $warning: 1, $info: 2, $verbose: 3 }["$" + loglevel] | 0;

const cacheOnly = !!process.env.NODE_VOO_CACHE_ONLY;
const noPersist = !!process.env.NODE_VOO_NO_PERSIST;
const persistLimit = +process.env.NODE_VOO_PERSIST_LIMIT || 100;

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
		this.timeout = undefined;
		this.currentModules = new Set();
		this.scriptSource = undefined;
		this.scriptSourceBuffer = undefined;
		this.script = undefined;
		this.restored = false;
	}

	persist() {
		this.mayRestructure();
		let cachedData;
		let scriptSource;
		if (this.scriptSource !== undefined) {
			if (this.started) {
				this.lifetime += Date.now() - this.started;
			}
			this.scriptSourceBuffer =
				this.scriptSourceBuffer || Buffer.from(this.scriptSource, "utf-8");
			scriptSource = this.scriptSourceBuffer;
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
		if (log >= 3) {
			console.log(
				`[node-voo] ${this.filename} persisted ${this.getInfo(cachedData)}`
			);
		}
	}

	tryRestore(Module) {
		try {
			// Read cache file
			const file = fs.readFileSync(this.filename);
			if (file.length < 24) throw new Error("Incorrect cache file size");
			if (file.readInt32LE(0, true) !== 1)
				throw new Error("Incorrect cache file version");
			this.created = file.readInt32LE(4, true);
			this.lifetime = file.readInt32LE(8, true);
			const numberOfModules = file.readInt32LE(12, true);
			const scriptSourceSize = file.readInt32LE(16, true);
			const cachedDataSize = file.readInt32LE(20, true);
			if (file.length < 24 + numberOfModules * 8)
				throw new Error("Incorrect cache file size");
			let pos = 24 + numberOfModules * 8;
			for (let i = 0; i < numberOfModules; i++) {
				const filenameLength = file.readInt32LE(24 + i * 8, true);
				const sourceLength = file.readInt32LE(28 + i * 8, true);
				const filename = file
					.slice(pos, pos + filenameLength)
					.toString("utf-8");
				pos += filenameLength;
				const source = file.slice(pos, pos + sourceLength);
				pos += sourceLength;
				this.modules.set(filename, source);
			}
			let scriptSourceBuffer;
			if (scriptSourceSize > 0) {
				scriptSourceBuffer = file.slice(pos, pos + scriptSourceSize);
				pos += scriptSourceSize;
				this.scriptSourceBuffer = scriptSourceBuffer;
				this.scriptSource = scriptSourceBuffer.toString("utf-8");
			} else {
				this.createScriptSource(Module);
			}
			let cachedData = undefined;
			if (cachedDataSize > 0) {
				cachedData = file.slice(pos, pos + cachedDataSize);
				pos += scriptSourceSize;
			}

			this.script = new vm.Script(this.scriptSource, {
				cachedData,
				filename: this.filename + ".js",
				lineOffset: 0,
				displayErrors: true,
				importModuleDynamically: undefined
			});
			if (log >= 1 && this.script.cachedDataRejected) {
				console.warn(
					`[node-voo] ${this.filename} cached data was rejected by v8`
				);
			}
			const result = this.script.runInThisContext();

			// File cache with data
			for (const [filename, source] of this.modules) {
				const fn = result["$" + filename];
				cache.set(filename, { source, fn });
			}

			this.restored = true;

			if (log >= 3) {
				console.log(
					`[node-voo] ${this.filename} restored ${this.getInfo(cachedData)}`
				);
			}
		} catch (e) {
			if (e.code !== "ENOENT") {
				if (log >= 1) {
					console.log(`[node-voo] ${this.filename} failed to restore: ${e}`);
				}
			} else {
				if (log >= 2) {
					console.log(`[node-voo] ${this.filename} no cache file`);
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
		this.scriptSourceBuffer = undefined;
	}

	mayRestructure() {
		if (this.currentModules !== undefined) {
			const removableModules = new Set();
			let removableSize = 0;
			for (const [filename, source] of this.modules) {
				if (!this.currentModules.has(filename)) {
					removableModules.add(filename);
					removableSize += source.length;
				}
			}
			if (removableSize > 10240 || removableModules.size > 100) {
				if (log >= 2) {
					console.log(
						`[node-voo] ${this.filename} restructured Voo ${
							removableModules.size
						} modules (${Math.ceil(removableSize / 1024)} kiB) removed`
					);
				}
				for (const filename of removableModules) {
					this.modules.delete(filename);
				}
				this.scriptSource = undefined;
				this.scriptSourceBuffer = undefined;
				this.lifetime = 0;
				this.currentModules = undefined;
			} else if (log >= 3 && removableModules.size > 0) {
				console.log(
					`[node-voo] ${this.filename} restructuring not worth it: ${
						removableModules.size
					} modules (${Math.ceil(removableSize / 102.4) /
						10} kiB) could be removed`
				);
			}
		}
	}

	flipCoin() {
		if (this.lifetime === 0) return true;
		this.mayRestructure();
		const runtime = Date.now() - this.started;
		const p = runtime / this.lifetime;
		return Math.random() < p;
	}

	start() {
		this.started = Date.now();
		if (!noPersist) {
			if (this.scriptSource === undefined) {
				this.persist();
			} else {
				allVoos.push(this);
				this.updateTimeout();
			}
		}
	}

	updateTimeout() {
		if (this.timeout) {
			clearTimeout(this.timeout);
		}
		const persistIn = Math.min(Math.max(10000, this.lifetime), 60 * 60 * 1000);
		this.timeout = setTimeout(() => {
			this.persist();
			if (this.scriptSource !== undefined) {
				this.updateTimeout();
			}
		}, persistIn);
		this.timeout.unref();
	}

	canAdd(filename) {
		return !this.restored || this.modules.has(filename);
	}

	track(filename, source) {
		if (source) {
			this.modules.set(filename, source);
			this.scriptSource = undefined;
			this.scriptSourceBuffer = undefined;
			this.lifetime = 0;
		}
		this.currentModules.add(filename);
	}

	getInfo(cachedData) {
		const formatTime = t => {
			if (t > 2000) {
				return `${Math.floor(t / 1000)}s`;
			} else if (t > 500) {
				return `${Math.floor(t / 100) / 10}s`;
			} else {
				return `${t}ms`;
			}
		};
		const formatSize = s => {
			if (s > 1024 * 1024) {
				return `${Math.floor(s / 1024 / 102.4) / 10} MiB`;
			} else if (s > 10240) {
				return `${Math.floor(s / 1024)} kiB`;
			} else {
				return `${Math.floor(s / 102.4) / 10} kiB`;
			}
		};
		if (cachedData === undefined) {
			return `[unoptimized] ${this.modules.size} modules`;
		} else {
			return `[optimized for ${formatTime(this.lifetime)}] ${
				this.modules.size
			} modules ${formatSize(
				this.scriptSourceBuffer.length
			)} Source Code ${formatSize(cachedData.length)} Cached Data`;
		}
	}
}

if (!noPersist) {
	process.on("exit", () => {
		let n = 0;
		const start = Date.now();
		while (allVoos.length > 0) {
			const random = Math.floor(Math.random() * allVoos.length);
			const voo = allVoos[random];
			if (voo.flipCoin()) {
				voo.persist();
				n++;
			}
			allVoos.splice(random, 1);
			if (Date.now() - start >= persistLimit) break;
		}
		if (log >= 1) {
			if (allVoos.length === 0) {
				if (log >= 3 && n > 0) {
					console.log(
						`[node-voo] ${n} Voos persisted in ${Date.now() - start}ms`
					);
				}
			} else {
				console.warn(
					`[node-voo] ${
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
	const newVoo = currentVoo === undefined || !currentVoo.canAdd(filename);
	const dirname = path.dirname(filename);
	let oldVoo;
	if (newVoo) {
		oldVoo = currentVoo;
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
			if (log >= 2 && cacheEntry !== undefined) {
				console.warn(`[node-voo] ${filename} has changed`);
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
			currentVoo = oldVoo;
		}
	}
};
