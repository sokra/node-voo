#!/usr/bin/env node

process.argv.splice(1, 1);
const index = require.resolve("./index");
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ""} -r "${index}"`;
require(index);
if (process.argv.length > 1) {
	require(require("path").resolve(process.cwd(), process.argv[1]));
} else {
	require("repl").start();
}
