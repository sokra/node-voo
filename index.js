const fs = require("fs");
const path = require("path");
const vm = require("vm");
const url = require("url");
const Module = require("module");

const HEADER_SIZE = 32;
const FORMAT_VERSION = 3;

const loglevel = process.env.NODE_VOO_LOGLEVEL;
const log = { $warning: 1, $info: 2, $verbose: 3 }["$" + loglevel] | 0;

const trustYarn = !!process.env.NODE_VOO_YARN;
const trustNpm = !!process.env.NODE_VOO_NPM;
const cacheOnly = !!process.env.NODE_VOO_CACHE_ONLY;
const noPersist = !!process.env.NODE_VOO_NO_PERSIST;
const persistLimit = +process.env.NODE_VOO_PERSIST_LIMIT || 100;
const tempDir = process.env.NODE_VOO_TEMP_DIRECTORY
	? path.resolve(process.env.NODE_VOO_TEMP_DIRECTORY)
	: path.join(require("os").tmpdir(), "node-voo");
const cacheDir = process.env.NODE_VOO_CACHE_DIRECTORY
	? path.resolve(process.env.NODE_VOO_CACHE_DIRECTORY)
	: tempDir;

if (log >= 3) {
	console.log(`[node-voo] enabled (cache directory: ${cacheDir})`);
}

try {
	fs.mkdirSync(tempDir, { recursive: true });
} catch (e) {}

try {
	fs.mkdirSync(cacheDir, { recursive: true });
} catch (e) {}

const HASH_LENGTH = 13;
const hashBuf = Buffer.allocUnsafe(HASH_LENGTH);
const getHash = (str) => {
	hashBuf.fill(0);
	let x = 0;
	for (let i = 0; i < str.length; i++) {
		const c = str.charCodeAt(i);
		hashBuf[x] += c;
		x = (x + i + c) % HASH_LENGTH;
	}
	return hashBuf;
};

// Find root node_modules
let myBase, myNodeModules;
const dirnameMatch =
	/((?:\/\.config\/yarn\/|\\Yarn\\Data\\)(?:link|global)|\/usr\/local\/lib|\\nodejs)?[/\\]node_modules[/\\]/.exec(
		__dirname
	);
if (dirnameMatch && !dirnameMatch[1]) {
	myBase = __dirname.slice(0, dirnameMatch.index);
	if (fs.existsSync(path.join(myBase, "package.json"))) {
		myNodeModules = path.join(myBase, "node_modules");
	}
}
if (!myNodeModules) {
	let last;
	myBase = process.cwd();
	while (myBase !== last) {
		if (fs.existsSync(path.join(myBase, "package.json"))) break;
		last = myBase;
		myBase = path.dirname(myBase);
	}
	myNodeModules = path.join(myBase, "node_modules");
}

// Read integrity file
let nodeModulesIntegrity;
if (trustNpm && myNodeModules) {
	try {
		nodeModulesIntegrity = Buffer.from(
			getHash(fs.readFileSync(path.join(myBase, "package-lock.json"), "utf-8"))
		);
	} catch (e) {}
}
if (trustYarn && myNodeModules) {
	try {
		nodeModulesIntegrity = Buffer.from(
			getHash(
				fs.readFileSync(path.join(myNodeModules, ".yarn-integrity"), "utf-8")
			)
		);
	} catch (e) {}
}

const stripBOM = (content) => {
	if (content.charCodeAt(0) === 0xfeff) {
		content = content.slice(1);
	}
	return content;
};

const stripShebang = (content) => {
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

const makeRequireFunction = (module) => {
	const Module = module.constructor;

	function require(path) {
		return module.require(path);
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

const readInfoAndData = (file, start, count, valueFn, targetMap) => {
	let pos = start + count * 8;
	for (let i = 0; i < count; i++) {
		const keyLength = file.readInt32LE(start + i * 8, true);
		const valueLength = file.readInt32LE(start + 4 + i * 8, true);
		const key = file.slice(pos, pos + keyLength).toString("utf-8");
		pos += keyLength;
		const value = valueFn(file.slice(pos, pos + valueLength));
		pos += valueLength;
		targetMap.set(key, value);
	}
	return pos;
};

const writeInfoAndData = (fd, map, valueFn) => {
	const info = Buffer.allocUnsafe(map.size * 8);
	const buffers = [info];
	let pos = 0;
	for (const [key, value] of map) {
		const keyBuffer = Buffer.from(key, "utf-8");
		const valueBuffer = valueFn(value);
		info.writeInt32LE(keyBuffer.length, pos);
		pos += 4;
		info.writeInt32LE(valueBuffer.length, pos);
		pos += 4;
		buffers.push(keyBuffer, valueBuffer);
	}
	for (const buffer of buffers) {
		writeSync(fd, buffer);
	}
};

const resolveCache = new Map();
const moduleToVoo = new Map();
const allVoos = [];
let uniqueId = process.pid + "";
try {
	uniqueId += "-" + require("worker_threads").threadId;
} catch (e) {}

class Voo {
	constructor(name) {
		this.name = name;
		this.hash = getHash(name).toString("hex");
		this.filename = path.join(cacheDir, this.hash);
		this.created = Date.now() / 1000;
		this.started = 0;
		this.lifetime = 0;
		this.modules = new Map();
		this.resolve = new Map();
		this.timeout = undefined;
		this.currentModules = new Set();
		this.scriptSource = undefined;
		this.scriptSourceBuffer = undefined;
		this.script = undefined;
		this.restored = false;
		this.integrityMatches = false;
		this.cache = new Map();
	}

	persist() {
		const tempFile = path.join(tempDir, this.hash + "~" + uniqueId);
		try {
			this.mayRestructure();
			let cachedData;
			let scriptSource;
			if (this.scriptSource !== undefined) {
				if (this.started) {
					const now = Date.now();
					this.lifetime += now - this.started;
					this.started = now;
				}
				this.scriptSourceBuffer =
					this.scriptSourceBuffer || Buffer.from(this.scriptSource, "utf-8");
				scriptSource = this.scriptSourceBuffer;
				if (this.script) {
					cachedData = this.script.createCachedData();
				}
			}
			const fd = fs.openSync(tempFile, "w");
			const header = Buffer.allocUnsafe(HEADER_SIZE);
			const nameBuffer = Buffer.from(this.name, "utf-8");
			header.writeInt32LE(FORMAT_VERSION, 0, true);
			header.writeDoubleLE(this.created, 4, true);
			header.writeInt32LE(this.lifetime, 8, true);
			header.writeInt32LE(nameBuffer.length, 12, true);
			header.writeInt32LE(this.modules.size, 16, true);
			header.writeInt32LE(scriptSource ? scriptSource.length : 0, 20, true);
			header.writeInt32LE(cachedData ? cachedData.length : 0, 24, true);
			header.writeInt32LE(this.resolve.size, 28, true);
			writeSync(fd, header);
			writeSync(fd, nameBuffer);
			writeSync(
				fd,
				nodeModulesIntegrity || Buffer.allocUnsafe(HASH_LENGTH).fill(0)
			);
			writeInfoAndData(fd, this.modules, (v) => v);
			if (scriptSource) {
				writeSync(fd, scriptSource);
			}
			if (cachedData) {
				writeSync(fd, cachedData);
			}
			writeInfoAndData(fd, this.resolve, (str) => Buffer.from(str, "utf-8"));
			fs.closeSync(fd);
			try {
				fs.unlinkSync(this.filename);
			} catch (e) {}
			try {
				fs.renameSync(tempFile, this.filename);
			} catch (e) {}
			if (log >= 3) {
				console.log(
					`[node-voo] ${this.name} persisted ${this.getInfo(cachedData)}`
				);
			}
		} catch (e) {
			try {
				fs.unlinkSync(tempFile);
			} catch (e) {}
			if (log >= 1) {
				console.log(`[node-voo] ${this.name} failed to persist: ${e.stack}`);
			}
		}
	}

	tryRestore(Module) {
		try {
			// Read cache file
			const file = fs.readFileSync(this.filename);
			if (file.length < HEADER_SIZE)
				throw new Error("Incorrect cache file size");
			if (file.readInt32LE(0, true) !== FORMAT_VERSION)
				throw new Error("Incorrect cache file version");
			this.created = file.readInt32LE(4, true);
			this.lifetime = file.readInt32LE(8, true);
			const nameSize = file.readInt32LE(12, true);
			const numberOfModules = file.readInt32LE(16, true);
			const scriptSourceSize = file.readInt32LE(20, true);
			const cachedDataSize = file.readInt32LE(24, true);
			const numberOfResolveEntries = file.readInt32LE(28, true);
			let pos = HEADER_SIZE;
			const name = file.slice(pos, pos + nameSize).toString("utf-8");
			pos += nameSize;
			if (name !== this.name) {
				throw new Error("Hash conflict");
			}
			let integrityMatches = cacheOnly;
			if (!integrityMatches && nodeModulesIntegrity) {
				const hash = file.slice(pos, pos + HASH_LENGTH);
				integrityMatches = Buffer.compare(hash, nodeModulesIntegrity) === 0;
			}
			pos += HASH_LENGTH;
			pos = readInfoAndData(file, pos, numberOfModules, (v) => v, this.modules);
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
				pos += cachedDataSize;
			}
			if (cacheOnly || integrityMatches) {
				readInfoAndData(
					file,
					pos,
					numberOfResolveEntries,
					(buf) => buf.toString("utf-8"),
					this.resolve
				);
				this.integrityMatches = true;
			} else if (numberOfResolveEntries > 0) {
				this.lifetime = 0;
			}

			this.script = new vm.Script(this.scriptSource, {
				cachedData,
				filename: this.filename + ".js",
				lineOffset: 0,
				displayErrors: true,
				importModuleDynamically: undefined,
			});
			if (log >= 1 && this.script.cachedDataRejected) {
				console.warn(`[node-voo] ${this.name} cached data was rejected by v8`);
				this.lifetime = 0;
			}
			const result = this.script.runInThisContext();

			// File cache with data
			if (this.modules.size === 1) {
				const filename = this.modules.keys().next().value;
				this.cache.set(filename, result);
			} else {
				for (const filename of this.modules.keys()) {
					const fn = result["$" + filename];
					this.cache.set(filename, fn);
				}
			}

			for (const [key, result] of this.resolve) {
				resolveCache.set(key, result);
			}

			this.restored = true;
			this.started = Date.now();

			if (log >= 2) {
				if (cachedData === undefined || log >= 3) {
					console.log(
						`[node-voo] ${this.name} restored ${this.getInfo(cachedData)}`
					);
				}
			}
		} catch (e) {
			if (e.code !== "ENOENT") {
				if (log >= 1) {
					console.log(
						`[node-voo] ${this.name} (${this.filename}) failed to restore: ${e.stack}`
					);
				}
			} else {
				if (log >= 2) {
					console.log(`[node-voo] ${this.name} no cache file`);
				}
			}
		}
	}

	createScriptSource(Module) {
		// Create optimizes source with cached data
		if (this.modules.size === 1) {
			const source = this.modules.values().next().value;
			this.scriptSource = Module.wrap(
				stripShebang(stripBOM(source.toString("utf-8")))
			);
		} else {
			this.scriptSource = `(function() {\nvar __node_voo_result = {};\n${Array.from(
				this.modules
			)
				.map(([filename, source]) => {
					return `__node_voo_result[${JSON.stringify(
						"$" + filename
					)}] = ${Module.wrap(
						stripShebang(stripBOM(source.toString("utf-8")))
					)}`;
				})
				.join("\n")}\nreturn __node_voo_result;\n})();`;
		}
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
						`[node-voo] ${this.name} restructured Voo ${
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
					`[node-voo] ${this.name} restructuring not worth it: ${
						removableModules.size
					} modules (${
						Math.ceil(removableSize / 102.4) / 10
					} kiB) could be removed`
				);
			}
		}
	}

	flipCoin() {
		if (this.lifetime === 0 || this.started === 0) return true;
		this.mayRestructure();
		const runtime = Date.now() - this.started;
		const p = runtime / this.lifetime;
		return Math.random() < p;
	}

	start() {
		if (this.started === 0) {
			this.started = Date.now();
		}
		if (!noPersist) {
			allVoos.push(this);
			if (this.scriptSource !== undefined) {
				this.updateTimeout();
			}
		}
	}

	updateTimeout() {
		if (this.timeout) {
			clearTimeout(this.timeout);
		}
		const persistIn = Math.min(Math.max(1000, this.lifetime), 60 * 60 * 1000);
		this.timeout = setTimeout(() => {
			this.persist();
			if (this.scriptSource !== undefined) {
				this.updateTimeout();
			}
		}, persistIn);
		this.timeout.unref();
	}

	has(filename) {
		return this.modules.has(filename);
	}

	isValid(filename) {
		if (cacheOnly) return true;
		if (this.integrityMatches && filename.startsWith(myNodeModules))
			return true;
		try {
			return (
				Buffer.compare(
					this.modules.get(filename),
					fs.readFileSync(filename)
				) === 0
			);
		} catch (e) {
			return false;
		}
	}

	track(filename) {
		this.currentModules.add(filename);
	}

	addModule(filename, source) {
		this.modules.set(filename, source);
		this.scriptSource = undefined;
		this.scriptSourceBuffer = undefined;
		this.lifetime = 0;
	}

	addResolve(key, result) {
		this.resolve.set(key, result);
		this.lifetime = 0;
	}

	getInfo(cachedData) {
		const formatTime = (t) => {
			if (t > 2000) {
				return `${Math.floor(t / 1000)}s`;
			} else if (t > 500) {
				return `${Math.floor(t / 100) / 10}s`;
			} else {
				return `${t}ms`;
			}
		};
		const formatSize = (s) => {
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
			)} Source Code ${formatSize(cachedData.length)} Cached Data ${
				this.resolve.size
			} Resolve Entries`;
		}
	}
}

if (!noPersist) {
	process.on("exit", () => {
		for (const voo of currentVoos) {
			allVoos.push(voo);
		}
		currentVoos.length = 0;

		let n = 0;
		const voos = allVoos.filter((voo) => voo.flipCoin());
		const start = Date.now();
		while (voos.length > 0) {
			const random = Math.floor(Math.random() * voos.length);
			const voo = voos[random];
			voo.persist();
			n++;
			voos.splice(random, 1);
			if (Date.now() - start >= persistLimit) break;
		}
		if (log >= 1) {
			if (voos.length === 0) {
				if (log >= 3 && n > 0) {
					console.log(
						`[node-voo] ${n} Voos persisted in ${Date.now() - start}ms`
					);
				}
			} else {
				console.warn(
					`[node-voo] ${
						voos.length
					} Voos not persisted because time limit reached (took ${
						Date.now() - start
					}ms)`
				);
			}
		}
	});
}

let currentVoos = [];

require.extensions[".js"] = (module, filename) => {
	let newVoo = false;
	let currentVoo;
	let content;
	let contentString;
	if (currentVoos.length === 0) {
		if (
			/\bimport\b/.test(
				(contentString = (content = fs.readFileSync(filename)).toString(
					"utf-8"
				))
			)
		) {
			// This can't be cached
			module._compile(stripBOM(contentString), filename);
			return;
		}
		currentVoo = new Voo(filename);
		currentVoo.tryRestore(module.constructor);
		currentVoos.push(currentVoo);
		newVoo = true;
	} else {
		for (const voo of currentVoos) {
			if (voo.has(filename)) {
				currentVoo = voo;
				break;
			}
		}
		if (currentVoo === undefined) {
			if (
				(contentString = (content = fs.readFileSync(filename)).toString(
					"utf-8"
				)).includes("import")
			) {
				// This can't be cached
				module._compile(stripBOM(contentString), filename);
				return;
			}
			const lastVoo = currentVoos[currentVoos.length - 1];
			if (!lastVoo.restored) {
				currentVoo = lastVoo;
			} else {
				currentVoo = new Voo(lastVoo.hash + "|" + filename);
				currentVoo.tryRestore(module.constructor);
				currentVoos.push(currentVoo);
			}
		}
	}
	try {
		moduleToVoo.set(module, currentVoo);
		currentVoo.track(filename);
		const cacheEntry = currentVoo.cache.get(filename);
		if (cacheEntry !== undefined && currentVoo.isValid(filename)) {
			const dirname = path.dirname(filename);
			const require = makeRequireFunction(module);
			const exports = module.exports;
			cacheEntry.call(exports, exports, require, module, filename, dirname);
		} else {
			if (log >= 2 && cacheEntry !== undefined) {
				console.warn(`[node-voo] ${filename} has changed`);
			}
			if (content === undefined) {
				content = fs.readFileSync(filename);
				contentString = content.toString("utf-8");
			}
			currentVoo.addModule(filename, content);
			module._compile(stripBOM(contentString), filename);
		}
		if (newVoo) {
			for (const voo of currentVoos) {
				voo.start();
			}
		}
	} finally {
		if (newVoo) {
			currentVoos.length = 0;
		}
	}
};

if (nodeModulesIntegrity || cacheOnly) {
	const cacheableModules = new WeakMap();

	const originalResolveFilename = Module._resolveFilename;
	Module._resolveFilename = (request, parent, isMain, options) => {
		if (isMain || !parent || !parent.filename) {
			return originalResolveFilename(request, parent, isMain, options);
		}
		if (!cacheOnly) {
			let cacheable = cacheableModules.get(parent);
			if (cacheable === undefined) {
				cacheable = parent.filename.startsWith(myNodeModules);
				cacheableModules.set(parent, cacheable);
			}
			if (!cacheable) {
				return originalResolveFilename(request, parent, isMain, options);
			}
		}
		const key = request + path.dirname(parent.filename);
		const cacheEntry = resolveCache.get(key);
		if (cacheEntry !== undefined) {
			return cacheEntry;
		}
		const result = originalResolveFilename(request, parent, isMain, options);
		if (!cacheOnly) {
			const resultCacheable = result.startsWith(myNodeModules);
			if (!resultCacheable) {
				return result;
			}
		}
		resolveCache.set(key, result);
		const voo = moduleToVoo.get(parent);
		if (voo !== undefined) {
			voo.addResolve(key, result);
		}

		return result;
	};
}
