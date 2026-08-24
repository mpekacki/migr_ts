// Bundles main.ts into a single self-contained JS file (no node_modules needed
// at runtime). Usage: node build.mjs --outfile=bundle.js
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const outfile = (args.find(a => a.startsWith('--outfile=')) || '--outfile=bundle.js').slice('--outfile='.length);

// terminal-kit's entry point (lib/termkit.js) pulls in its submodules through
// `lazyness`, which calls require() with a runtime-computed path - esbuild
// cannot follow that, so the bundle throws "Cannot find module './Rect.js'".
// The package ships lib/termkit-no-lazy-require.js for exactly this case: same
// exports, all requires static. Redirect both the package entry and the
// internal `require('./termkit.js')` calls to it.
const noLazyTermkit = require.resolve('terminal-kit/lib/termkit-no-lazy-require.js');

const terminalKitNoLazyRequire = {
    name: 'terminal-kit-no-lazy-require',
    setup(build) {
        build.onResolve({ filter: /^terminal-kit$/ }, () => ({ path: noLazyTermkit }));
        build.onResolve({ filter: /(^|[\\/])termkit\.js$/ }, args => (
            args.importer.includes('terminal-kit') ? { path: noLazyTermkit } : undefined
        ));
    },
};

await build({
    entryPoints: ['main.ts'],
    bundle: true,
    outfile,
    platform: 'node',
    // terminal-kit/lib/termconfig is required dynamically, so esbuild pulls in
    // every file of that directory - including an extension-less README that it
    // would otherwise try to parse as JS.
    loader: { '': 'empty' },
    plugins: [terminalKitNoLazyRequire],
});
