# node-voo

Source Caching for Node.js

- Creates v8 cache data for executed javascript files.
- Groups javascript files that are used together. (These groups are called "Voo"s.)
- Stores a cache file into the systems temp directory.
- Puts lazy required files into separate cache files.
- Learns which modules are required conditionally and puts them into separate cache files.
- Improves startup speed of node.js applications after a few runs

## How it works

The first run captures used modules and source code. It groups modules together.
The cache file contains a list of modules with source code.

The second run loads the modules from cache and creates a single source code for all modules of the group.
This source code is executed and modules are served from this groups source code.
The single source code and v8 cached data is added to the cache file.

The 3rd run loads the single source code and v8 cached data from the cache and restores compiled code from it.
This run uses optimized code which was generated on the second run.

Note that code might get reoptimized when captured type info changes. When this happens cache files are updated.

When the process exits, Voos are persisted by a probablilty process until the time limit has reached (default 100ms).
The probablilty process ensures that all Voos get eventually persisted without increasing the exit delay too much.
As the lifetime of the Voo increases, the probablility of persisting decreases.

Voos are also persisted everytime their lifetime has doubled (minimum 10s, maximum 1h).

## Usage

```js
require("node-voo");
require("<real-entry>");
```

## Command Line

```sh
yarn add node-voo
yarn node-voo --yarn <real-entry> <arguments>
```

-or-

```sh
npm install -g node-voo
node-voo --npm <real-entry> <arguments>
```

-or-

```sh
yarn global add node-voo
node-voo <real-entry> <arguments>
```

-or-

```sh
NODE_OPTIONS="-r node-voo" node <real-entry> <arguments>
```

(\*nix only)

-or-

```sh
set NODE_OPTIONS=-r node-voo
node <real-entry> <arguments>
```

(windows only, stays active for all futures `node` calls too)

-or-

```sh
export NODE_OPTIONS="-r node-voo"
node <real-entry> <arguments>
```

(\*nix only, , stays active for all futures `node` calls too)

-or-

```sh
node -r node-voo <real-entry> <arguments>
```

(doesn't capture child processes)

-or-

```sh
npx node-voo <real-entry> <arguments>
```

(npx has a performance overhead)

## Options

It's possible to pass options via environment variables:

- `NODE_VOO_YARN=true`: Trust `node_modules/.yarn-integrity` to agressively cache resolving and modules in node_modules. Requirements:
  - Only use Yarn.
  - Do not modify files in node_modules manually.
- `NODE_VOO_NPM=true`: Trust `package-lock.json` to agressively cache resolving and modules in node_modules. Requirements:
  - Only use Npm.
  - Do not modify files in node_modules manually.
  - Do not run node-voo between changes to `package-lock.json` and `npm i`. i. e. when switching branches, etc.
- `NODE_VOO_LOGLEVEL=warning`: Display warnings on console when
  - cached data was rejected by v8
  - not all Voos can be persisted due to time limit
  - cache can't be restore due to an error
  - cache can't be persisted due to an error
- `NODE_VOO_LOGLEVEL=info`: Display warnings and info on console when
  - any warning from above occurs
  - cache can't be used because source file changed
  - cache file was not found and will probably be created
  - a unoptimized Voo is restored (including count info)
  - a Voo is reorganized due to detected conditional requires
- `NODE_VOO_LOGLEVEL=verbose`: Display warnings and info on console when
  - any warning or info from above occurs
  - a Voo could be reorganized but it's not worth it due to minor difference
  - a Voo is restored (including count and size info)
  - a Voo is persisted (including count and size info)
  - the process exit and all Voos are persisted (including timing info)
- `NODE_VOO_CACHE_ONLY=true`: Always use the cache and never check if real files have changed. Also allows to cache resolving.
- `NODE_VOO_NO_PERSIST=true`: Never persist Voos (Use only when cache files already reached the optimum)
- `NODE_VOO_PERSIST_LIMIT=<number>`: Time limit in milliseconds, how long node-voo persists Voos on process exit

When using the CLI it's also possible to pass some options with argument:

- `node-voo --yarn` = `NODE_VOO_YARN`
- `node-voo --npm` = `NODE_VOO_NPM`
- `node-voo --cache-only` = `NODE_VOO_CACHE_ONLY`
- `node-voo --no-persist` = `NODE_VOO_NO_PERSIST`
- `node-voo --warning` = `NODE_VOO_LOGLEVEL=warning`
- `node-voo --info` = `NODE_VOO_LOGLEVEL=info`
- `node-voo --verbose` = `NODE_VOO_LOGLEVEL=verbose`

Performance hints:

- Use `yarn` resp. `npm` optimization via `NODE_VOO_YARN` resp. `NODE_VOO_NPM` to enable caching for resolving.
- Code has to run a few times to reach performance optimum.
