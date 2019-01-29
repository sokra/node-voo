#!/usr/bin/env node

process.argv.splice(1, 1);
require("./index");
require(require("path").resolve(process.cwd(), process.argv[1]));
