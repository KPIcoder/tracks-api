// esbuild.config.js
import { build } from 'esbuild';
import path from 'path';
import { nodeExternalsPlugin } from 'esbuild-node-externals';
import {fileURLToPath} from "node:url";

const entryFile = path.resolve(process.cwd(), 'src/index.ts'); // adjust to your actual entry point

build({
    entryPoints: [entryFile],
    bundle: true,
    platform: 'node',
    target: 'node22',
    outfile: 'dist/index.js',
    sourcemap: true,
    format: 'esm',
    plugins: [nodeExternalsPlugin()],
    banner: {
        js: 'import { createRequire } from "module"; const require = createRequire(import.meta.url);'
    },
    loader: {
        '.ts': 'ts',
    },
    resolveExtensions: ['.ts', '.js'],
}).catch(() => process.exit(1));
