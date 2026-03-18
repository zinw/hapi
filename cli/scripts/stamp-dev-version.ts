/**
 * Stamps a dev version into cli/package.json by appending the git commit hash.
 *
 * Usage:
 *   bun run scripts/stamp-dev-version.ts          # stamps version, e.g. 0.16.1-dev+aa3d679
 *   bun run scripts/stamp-dev-version.ts --restore # restores original version
 *
 * Designed to wrap a build step:
 *   stamp-dev-version → build:exe → stamp-dev-version --restore
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(scriptDir, '..', 'package.json');

function getGitShortHash(): string {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
}

function isDirty(): boolean {
    const status = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
    return status.length > 0;
}

function readPackageJson(): { raw: string; parsed: Record<string, unknown> } {
    const raw = readFileSync(packageJsonPath, 'utf-8');
    return { raw, parsed: JSON.parse(raw) };
}

function writeVersion(pkg: Record<string, unknown>, version: string): void {
    pkg.version = version;
    writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
}

const args = process.argv.slice(2);
const isRestore = args.includes('--restore');

const { parsed: pkg } = readPackageJson();
const currentVersion = pkg.version as string;

if (isRestore) {
    // Strip dev suffix: 0.16.1-dev+aa3d679 → 0.16.1
    const base = currentVersion.replace(/-dev\+.*$/, '');
    if (base !== currentVersion) {
        writeVersion(pkg, base);
        console.log(`[stamp-dev-version] restored: ${currentVersion} → ${base}`);
    } else {
        console.log(`[stamp-dev-version] already clean: ${currentVersion}`);
    }
} else {
    // Skip if already stamped
    if (currentVersion.includes('-dev+')) {
        console.log(`[stamp-dev-version] already stamped: ${currentVersion}`);
        process.exit(0);
    }
    const hash = getGitShortHash();
    const dirty = isDirty() ? '.dirty' : '';
    const devVersion = `${currentVersion}-dev+${hash}${dirty}`;
    writeVersion(pkg, devVersion);
    console.log(`[stamp-dev-version] stamped: ${currentVersion} → ${devVersion}`);
}
