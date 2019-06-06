#!/usr/bin/env node

let i = 2;
w: while (i < process.argv.length) {
	switch (process.argv[i++]) {
		case "--yarn":
			process.env.NODE_VOO_YARN = "true";
			break;
		case "--npm":
			process.env.NODE_VOO_NPM = "true";
			break;
		case "--cache-only":
			process.env.NODE_VOO_CACHE_ONLY = "true";
			break;
		case "--no-persist":
			process.env.NODE_VOO_NO_PERSIST = "true";
			break;
		case "--warning":
			process.env.NODE_VOO_LOGLEVEL = "warning";
			break;
		case "--info":
			process.env.NODE_VOO_LOGLEVEL = "info";
			break;
		case "--verbose":
			process.env.NODE_VOO_LOGLEVEL = "verbose";
			break;
		default:
			break w;
	}
}
process.argv.splice(1, Math.max(1, i - 2));
const index = require.resolve("./index");
const old = process.env.NODE_OPTIONS || "";
process.env.NODE_OPTIONS = `${old} -r ${JSON.stringify(index)}`;
require(index);
if (process.argv.length > 1) {
	require(require("path").resolve(process.cwd(), process.argv[1]));
} else {
	require("repl").start();
}
