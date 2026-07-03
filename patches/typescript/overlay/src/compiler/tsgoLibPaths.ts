// Map tsgo bundled lib paths (bundled:///libs/lib.es5.d.ts) to the fork's
// on-disk lib/ tree so tsserver ScriptInfo keys match real files.

/* eslint-disable @typescript-eslint/no-require-imports */

const BUNDLED_LIB_PREFIX = "bundled:///libs/";

let _path: typeof import("path") | undefined;
function nodePath(): typeof import("path") {
    return (_path ??= require("path") as typeof import("path"));
}

let _tnbPackageRoot: string | undefined;
export function getTnbPackageRoot(): string {
    return (_tnbPackageRoot ??= nodePath().resolve(__dirname, ".."));
}

let _tnbLibDir: string | undefined;
function getTnbLibDir(): string {
    return (_tnbLibDir ??= nodePath().join(getTnbPackageRoot(), "lib"));
}

export function isBundledLibPath(fileName: string): boolean {
    return fileName.startsWith(BUNDLED_LIB_PREFIX);
}

export function bundledLibPathToHostPath(bundledPath: string): string {
    const libFile = bundledPath.slice(BUNDLED_LIB_PREFIX.length);
    return nodePath().join(getTnbLibDir(), libFile);
}

// These helpers are hit once per file per overlay sync (and per RPC path
// mapping), so each is memoized on its input string. Entries are tiny
// path strings; the maps are capped defensively against pathological
// callers generating unbounded distinct paths.
const MEMO_CAP = 200_000;
function memoized(fn: (fileName: string) => string | undefined): (fileName: string) => string | undefined {
    const cache = new Map<string, string | undefined>();
    return fileName => {
        if (cache.has(fileName)) return cache.get(fileName);
        const result = fn(fileName);
        if (cache.size < MEMO_CAP) cache.set(fileName, result);
        return result;
    };
}

const _hostPathToBundledLibPath = memoized(fileName => {
    if (isBundledLibPath(fileName)) return fileName;
    const path = nodePath();
    const libDir = getTnbLibDir();
    const normalized = path.normalize(fileName);
    if (!normalized.startsWith(libDir + path.sep) && normalized !== libDir) return undefined;
    const rel = path.relative(libDir, normalized).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..")) return undefined;
    // tsgo's bundled:///libs/ only contains lib.*.d.ts. Other files under lib/
    // (typescript.d.ts, tsc.js, etc.) are real on-disk files that tsgo resolves
    // as host paths — mapping them to bundled:/// would make tsgo fail to find them.
    if (!/^lib\.[^/]+\.d\.ts$/i.test(rel)) return undefined;
    return BUNDLED_LIB_PREFIX + rel;
});
export function hostPathToBundledLibPath(fileName: string): string | undefined {
    return _hostPathToBundledLibPath(fileName);
}

export function toHostFileName(fileName: string): string {
    return isBundledLibPath(fileName) ? bundledLibPathToHostPath(fileName) : fileName;
}

const _resolveAbsoluteHostFileName = memoized(fileName => {
    const mapped = toHostFileName(fileName);
    const path = nodePath();
    const normalized = mapped.replace(/\\/g, "/");
    if (path.isAbsolute(normalized)) {
        return path.normalize(normalized);
    }
    return undefined;
});

/** Normalize host file paths — tsserver may use cwd-relative paths for project files. */
export function resolveHostFileName(fileName: string, host?: { getCurrentDirectory?: () => string }): string {
    const absolute = _resolveAbsoluteHostFileName(fileName);
    if (absolute !== undefined) return absolute;
    // Relative path — cwd-dependent, so resolved per call (rare: tsserver only).
    const path = nodePath();
    const normalized = toHostFileName(fileName).replace(/\\/g, "/");
    const cwd = host?.getCurrentDirectory?.() ?? process.cwd();
    return path.normalize(path.resolve(cwd, normalized));
}

const _toTsgoFileName = memoized(fileName => {
    const mapped = hostPathToBundledLibPath(fileName);
    if (mapped) return mapped;
    // tsgo expects forward-slash paths; Windows host SourceFiles carry
    // backslash fileNames, which the Go URI parser treats as relative.
    return fileName.replace(/\\/g, "/");
});
export function toTsgoFileName(fileName: string): string {
    if (typeof fileName !== "string") return fileName;
    return _toTsgoFileName(fileName)!;
}

export function isHostLibFile(fileName: string): boolean {
    if (isBundledLibPath(fileName)) return true;
    const path = nodePath();
    const libDir = getTnbLibDir();
    const normalized = path.normalize(fileName);
    return normalized.startsWith(libDir + path.sep) && /lib\.[^/]+\.d\.ts$/i.test(normalized);
}
