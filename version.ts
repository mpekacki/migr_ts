import fs from 'fs';
import path from 'path';

/**
 * The version of the running build.
 *
 * The bundle is self-contained and ships on its own - there is no package.json
 * next to it to read - so build.mjs substitutes the version in at build time
 * through esbuild's `define`. Running from source (ts-node, jest) leaves the
 * placeholder an undeclared identifier, and the version comes off disk instead.
 */
declare const __MIGR_TS_VERSION__: string;

function versionFromPackageJson(): string {
    try {
        const pkgPath = path.join(__dirname, 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
        return pkg.version ?? 'unknown';
    } catch {
        return 'unknown';
    }
}

export const VERSION: string =
    typeof __MIGR_TS_VERSION__ === 'string' ? __MIGR_TS_VERSION__ : versionFromPackageJson();
