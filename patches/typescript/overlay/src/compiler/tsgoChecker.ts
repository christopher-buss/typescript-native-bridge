// tsgo checker adapter — backs Program.getTypeChecker() with the typescript-go
// in-process NAPI bridge, while keeping the rest of the tsserver /
// LanguageService / namespace surface intact.
//
// Heavy deps (koffi, vendored native-preview under vendor/) are require()'d on first use.
//
// The adapter builds a tsgo project from the Program's configFilePath,
// then routes checker queries by (fileName, position) — the same file
// content and offsets as the real TS Program (Phase 1: plain .ts, disk
// content === Program content). Type/Symbol objects come from tsgo and
// get prototype-patched to quack like ts.Type / ts.Symbol so rule code
// that reads .flags / .symbol / calls .getSymbol() / .isUnion() etc.
// keeps working.

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */

import * as ts from "./_namespaces/ts.js";
import { bindSourceFile } from "./binder.js";
import { createSourceFile } from "./parser.js";
import { SyntaxKind, SymbolFlags, NodeFlags, JSDocParsingMode, type Path } from "./types.js";
import { installTsgoBackedSourceFileLoader, inferScriptKind, createSkeletonSourceFile, getTsgoBackedSourceFile } from "./tsgoBackedSourceFile.js";
import { getTnbPackageRoot, isBundledLibPath, isHostLibFile, resolveHostFileName, toHostFileName, toTsgoFileName } from "./tsgoLibPaths.js";

// ── Module-level bridge deps (shared across all createTsgoChecker calls) ──
// koffi.struct() registers type names globally, so the struct definition must
// happen exactly once even when multiple Program instances each create a tsgo
// checker.
let _koffi: any;
let _sync: any;
let _bridgeFns: any;
/** Thin program from createTsgoProgram — wired after getOrCreateSourceFile exists. */
let _hostProgramRef: { getSourceFile?: (fileName: string) => any | undefined } | undefined;
/** TNB_DEBUG dynamic API audit: unknown program/checker property reads, logged once each. */
const _loggedUnknownProps = new Set<string>();

/** Vendored @typescript/native-preview at vendor/native-preview/. */
function getNativePreviewDir(): string {
    const path = require("path") as typeof import("path");
    const fs = require("fs") as typeof import("fs");
    const dir = path.join(getTnbPackageRoot(), "vendor", "native-preview");
    const syncApi = path.join(dir, "dist", "api", "sync", "api.js");
    if (!fs.existsSync(syncApi)) {
        throw new Error(
            `tsgoChecker: vendored native-preview not found at ${dir}\n` +
            `  Build it: npm run build:js`,
        );
    }
    return dir;
}

function loadBridgeDeps(): void {
    if (_koffi) return;
    const path = require("path") as typeof import("path");
    const fs = require("fs") as typeof import("fs");
    _koffi = require("koffi");

    const nativePreviewDir = getNativePreviewDir();
    // sync API is CJS-compatible even though the package is "type": "module".
    _sync = require(path.join(nativePreviewDir, "dist", "api", "sync", "api.js"));

    // Bridge lives at <tnb>/native/bridge.<ext> next to lib/ and vendor/.
    const ext = process.platform === "darwin" ? "dylib" : process.platform === "win32" ? "dll" : "so";
    const libName = `bridge.${ext}`;
    const packageRoot = getTnbPackageRoot();
    const libPath = path.join(packageRoot, "native", libName);
    const devBridge = path.join(packageRoot, "typescript-go", "bridge", libName);
    const resolvedBridge = fs.existsSync(libPath) ? libPath : devBridge;
    if (!fs.existsSync(resolvedBridge)) {
        throw new Error(
            `tsgoChecker: bridge shared library not found (tried ${libPath}, ${devBridge})\n` +
            `  Build it: npm run build:bridge`,
        );
    }
    // The cgo bridge embeds the Go runtime into this Node process. Go's
    // signal-based async preemption (SIGURG) collides with Node's fatal-signal
    // handler: SIGURG gets routed into node::SignalExit -> ResetStdio, which
    // storms tcsetattr/ioctl on a TTY until the CPU is pinned and the process
    // won't even die on SIGTERM. GODEBUG is read by the Go runtime at dlopen,
    // so disable async preemption before _koffi.load arms its signal handler.
    if (!/(?:^|,)asyncpreemptoff=1(?:,|$)/.test(process.env.GODEBUG ?? "")) {
        process.env.GODEBUG = process.env.GODEBUG
            ? `${process.env.GODEBUG},asyncpreemptoff=1`
            : "asyncpreemptoff=1";
    }
    const lib = _koffi.load(resolvedBridge);
    _bridgeFns = {
        BridgeNewSession: lib.func("char *BridgeNewSession(char *cwd)"),
        BridgeCall: lib.func("char *BridgeCall(int64_t session, char *method, char *paramsJson)"),
        BridgeDisposeSession: lib.func("void BridgeDisposeSession(int64_t session)"),
        BridgeBinary: _koffi.struct("BridgeBinary", { data: "void *", len: "int64_t" }),
        BridgeCallBinary: lib.func("BridgeBinary BridgeCallBinary(int64_t session, char *method, char *paramsJson)"),
    };
}

// Module-level session pool — one koffi BridgeClient + tsgo API per process,
// shared across all Programs. Projects are cached per tsconfig path.
let _client: any;
let _api: any;
let _sourceFileCache: any;
const _projectCache = new Map<string, any>();

// One-shot banner, printed the first time the tsgo bridge is engaged, so users
// can always tell their tooling is running on the fork. No banner means stock
// `typescript` is in use (the override didn't take effect).
let _tnbDebugAnnounced = false;
// Overlay content collected by createTsgoProgram from the host (before
// ensureProject runs). In thin-createProgram mode, program.getSourceFiles()
// is empty, so ensureProject reads from this instead.
let _pendingOverlays: any[] | undefined;
let _pendingExtraFileExtensions: any[] | undefined;
let _pendingReferencedProjects: string[] | undefined;
/** Last extraFileExtensions sent to tsgo — reused when syncing late host overlays. */
let _lastExtraFileExtensions: any[] | undefined;
/** Host context for incremental overlay sync (Volar virtual TS after createProgram). */
let _overlayHostCtx: { host: any; options: any; configFilePath: string } | undefined;
let _languageServiceHost: any | undefined;
/**
 * True once any host-bound SourceFile has been bound via ensureHostSourceFileBound.
 * Host-bound navigation refinement (resolveHostExportDefaultSymbol /
 * remapSymbolDeclarationsToHost) only changes behavior for host-bound symbols, so
 * when no host-bound file exists (e.g. pure-TS lint via tsslint CLI, where tsgo
 * RemoteSourceFiles are never host-bound) the per-call refinement can be skipped
 * entirely — it would just iterate declarations and bail at getHostSf.
 */
let _hasHostBoundFiles = false;

/** @internal */
export function tnbSetLanguageServiceHost(host: any): void {
    _languageServiceHost = host;
}

/** Host script content for tsgo overlay — LS host SSOT, compilerHost fallback at createProgram. */
function getHostScriptContentForOverlay(fileName: string, options: any, compilerHost?: any) {
    return getHostScriptContent(hostForOverlaySync() ?? compilerHost, fileName, options);
}

function hostForOverlaySync(): any {
    return _languageServiceHost ?? _overlayHostCtx?.host;
}

/** Active checker query depth — skip updateSnapshot while > 0 (avoids LS reentrancy). */
let _checkerQueryDepth = 0;
/** Host text last pushed to tsgo per file — skip redundant updateSnapshot. */
const _syncedOverlayContentByFile = new Map<string, string>();
// Files whose host snapshot text was verified to match disk (no overlay
// needed), keyed on the exact text instance/content. Skips the per-sync
// disk read+compare in shouldSendHostOverlay for unchanged files.
const _overlayCleanTextByFile = new Map<string, string>();
// collectTsgoOpenFileNames enumerates the full LS host file list and, for
// rbxtsc's transformer-watcher host, getScriptFileNames() stats every file.
// The open-file set only changes when a client opens a new file, so the
// resolved list is cached per host and recomputed only when a requested
// file falls outside it (or a content push rotates the snapshot).
let _collectedOpenFilesCache: { host: unknown; names: string[]; set: Set<string> } | undefined;
const _globalDiagnosticsCache = new WeakMap<object, readonly any[]>();
// Files already registered as open in the current tsgo snapshot. Snapshot
// rotation invalidates object registries (Symbol/Type identity!), so
// pushHostOverlayToTsgo must NOT bump the snapshot unless there is genuinely
// new content or a newly opened file. Consumers (roblox-ts MacroManager)
// hold symbols across the whole compile phase and compare them by identity
// against per-file query results.
const _tsgoOpenedFiles = new Set<string>();

// Overlay-path cache: only files missing on disk are fed to tsgo as overlays
// (typically Volar virtual documents).
const _overlayDiskExistsCache = new Map<string, boolean>();
// tsgo's case-sensitivity flag — skeleton SFs must use the same path format
// (lowercased on case-insensitive FS) as tsgo RemoteSourceFiles, otherwise
// BuilderState's fileInfos keys (from getSourceFiles skeletons) won't match
// updateShapeSignature's lookup (from getSourceFile tsgo-backed SFs).
let _tsgoUseCaseSensitive = true;
// Refs set by ensureProject so NodeHandle prototype hooks can route to the
// currently-active project (scope manager reads `declaration.getSourceFile()`
// on tsgo NodeHandles, which need the project to resolve).
const _currentProjectRef: { project: any } = { project: undefined };
let _nodeHandlePatched = false;

// ── Profiling (active only when TSGO_PROFILE=1) ──
const _stats = {
    projectLoadMs: 0,
    projectsLoaded: 0,
    parentSetMs: 0,
    parentSetFiles: 0,
    queryCount: 0,
    queryMs: 0,
    getTypeCount: 0,
    getTypeMs: 0,
    getSymCount: 0,
    getSymMs: 0,
    getSymHitCount: 0,
    getSymRpcCount: 0,
    symPrefetchMs: 0,
    symPrefetchFiles: 0,
    symPrefetchRefs: 0,
    indexBuildMs: 0,
    indexBuildCount: 0,
    rpcCount: 0,
    rpcMs: 0,
    rpcByMethod: new Map<string, { count: number; ms: number }>() as Map<string, { count: number; ms: number }>,
    printed: false,
};
let _tsgoLoadStart = 0;
function fileExistsOnDisk(fileName: string): boolean {
    let exists = _overlayDiskExistsCache.get(fileName);
    if (exists === undefined) {
        try {
            const fs = require("fs") as typeof import("fs");
            exists = fs.existsSync(fileName);
        } catch {
            exists = false;
        }
        _overlayDiskExistsCache.set(fileName, exists);
    }
    return exists;
}
/** Collect absolute paths for all open LS files — incl. client-only roots not in getScriptFileNames. */
function collectTsgoOpenFileNames(syncHost: any, extra?: Iterable<string>): string[] {
    const names = new Set<string>();
    const add = (fn: string) => {
        if (typeof fn === "string" && fn.length) names.add(resolveHostFileName(fn, syncHost));
    };
    if (extra) {
        for (const fn of extra) add(fn);
    }
    const scriptNames = syncHost?.getScriptFileNames?.();
    if (scriptNames) {
        for (const fn of scriptNames) add(fn);
    }
    const ps = syncHost?.projectService;
    if (ps?.openFiles?.forEach && syncHost.projectService === ps) {
        // tsserver Project — include open client tabs not listed in config roots.
        ps.openFiles.forEach((_root: string, path: string) => {
            const info = ps.getScriptInfoForPath(path);
            if (!info?.isScriptOpen()) return;
            const inProject = info.containingProjects?.includes?.(syncHost);
            const hasSnapshot = !!syncHost.getScriptSnapshot?.(info.fileName);
            if (!inProject && !hasSnapshot) return;
            add(info.fileName);
        });
    }
    return [...names];
}

/** @internal Extend createProgram rootNames with open client files (e.g. unsaved foo.ts). */
export function tnbCollectOpenRootFileNames(host: any): string[] {
    return collectTsgoOpenFileNames(host);
}
function readDiskText(fileName: string): string | undefined {
    try {
        const fs = require("fs") as typeof import("fs");
        return fs.readFileSync(fileName, "utf8");
    } catch {
        return undefined;
    }
}
function isOverlayCandidatePath(fileName: string): boolean {
    if (isBundledLibPath(fileName)) return false;
    return !fileName.includes("/lib.") && !fileName.includes("/node_modules/");
}
/** Resolve tsconfig path for tsgo — relative paths from tsserver use the host cwd. */
function resolveTsconfigPath(configFilePath: string, host?: { getCurrentDirectory?: () => string }): string {
    const path = require("path") as typeof import("path");
    const normalized = configFilePath.replace(/\\/g, "/");
    if (path.isAbsolute(normalized)) {
        return path.normalize(normalized).replace(/\\/g, "/");
    }
    const cwd = host?.getCurrentDirectory?.() ?? process.cwd();
    return path.normalize(path.resolve(cwd, normalized)).replace(/\\/g, "/");
}
/** Host script text — prefers getScriptSnapshot (host SSOT) over readFile. */
function getHostScriptContent(host: any, fileName: string, options: any): { text: string; scriptKind: number; fromHost: boolean } | undefined {
    let scriptKind = inferScriptKind(fileName);
    const snap = host?.getScriptSnapshot?.(fileName);
    if (snap) {
        const text = snap.getText(0, snap.getLength());
        scriptKind = resolveLanguageServiceScriptKind(host, fileName, fileName, /*fromHostSnapshot*/ true);
        return { text, scriptKind, fromHost: true };
    }
    const sf = host?.getSourceFile?.(fileName, options.target ?? 99);
    if (sf && typeof sf.text === "string") {
        if (typeof sf.scriptKind === "number") scriptKind = sf.scriptKind;
        else scriptKind = resolveLanguageServiceScriptKind(host, fileName, fileName, /*fromHostSnapshot*/ true);
        return { text: sf.text, scriptKind, fromHost: true };
    }
    const text = host?.readFile?.(fileName);
    if (typeof text === "string") return { text, scriptKind, fromHost: false };
    return undefined;
}

/** Match tsc / LS default: skip full JSDoc parse in .ts unless needed for type errors. */
function resolveJsDocParsingMode(host: any): JSDocParsingMode {
    // Stock createSourceFile defaults to ParseAll. ParseForTypeErrors drops
    // plain JSDoc tags (no {@link}) in .d.ts — flamework's `@metadata macro`
    // markers vanish and user macros silently stop transforming.
    return host?.jsDocParsingMode ?? JSDocParsingMode.ParseAll;
}

function hostSourceFileOptions(languageVersion: number, host: any) {
    return { languageVersion, jsDocParsingMode: resolveJsDocParsingMode(host) };
}

/** Parse host snapshot into a full TS SourceFile for Language Service (safe during LS). */
function sourceFileFromHostSnapshot(host: any, hostFileName: string, requestFileName: string, languageTarget: number): any | undefined {
    const snap = host?.getScriptSnapshot?.(requestFileName) ?? host?.getScriptSnapshot?.(hostFileName);
    if (!snap) return undefined;
    const text = snap.getText(0, snap.getLength());
    if (!text.length) return undefined;
    const scriptKind = resolveLanguageServiceScriptKind(host, requestFileName, hostFileName, /*fromHostSnapshot*/ true);
    const sf = createSourceFile(hostFileName, text, hostSourceFileOptions(languageTarget, host), /*setParentNodes*/ true, scriptKind);
    return attachHostSourceFileMetadata(sf, hostFileName);
}

/** Ensure host SourceFiles expose stable path metadata for LS + module path completion. */
function attachHostSourceFileMetadata(sf: any, hostFileName: string): any {
    sf.fileName = hostFileName;
    sf.originalFileName = hostFileName;
    sf.path = hostFileName as Path;
    sf.resolvedPath = hostFileName as Path;
    if (!sf.imports) sf.imports = [];
    if (!sf.moduleAugmentations) sf.moduleAugmentations = [];
    if (!("version" in sf)) {
        try { Object.defineProperty(sf, "version", { value: "1", writable: true, configurable: true, enumerable: false }); } catch {}
    }
    return sf;
}
function hostHasScriptSnapshot(host: any, requestFileName: string, hostFileName: string): boolean {
    return !!(host?.getScriptSnapshot?.(requestFileName) ?? host?.getScriptSnapshot?.(hostFileName));
}
/** Bind host-parsed SourceFiles for LS (export map, scope) — tsgo skips the TS binder. */
function ensureHostSourceFileBound(sf: any, options: any): void {
    if (!sf || sf.__tnbHostBound) return;
    if (sf.symbol !== undefined) { sf.__tnbHostBound = true; return; }
    try { bindSourceFile(sf, options); } catch { /* best-effort */ }
    sf.__tnbHostBound = true;
}
function isReservedExportMemberName(name: string): boolean {
    return name.length >= 2 && name.charCodeAt(0) === 95 /* _ */ && name.charCodeAt(1) === 95 && name.charCodeAt(2) !== 95;
}
function exportMemberKey(symbol: any): string | undefined {
    const key = (symbol?.escapedName ?? symbol?.name) as string | undefined;
    return key && !isReservedExportMemberName(key) ? key : undefined;
}
function collectNamedExportsFromModuleSymbol(moduleSymbol: any): any[] {
    if (!moduleSymbol?.exports) return [];
    const result: any[] = [];
    moduleSymbol.exports.forEach((exported: any, key: string) => {
        if (!key || isReservedExportMemberName(key)) return;
        result.push(exported);
    });
    return result;
}
function moduleSymbolSourceFileName(moduleSymbol: any): string | undefined {
    return moduleSymbol?.declarations?.[0]?.getSourceFile?.()?.fileName;
}
function isModuleDefaultExportMemberName(name: string | undefined): boolean {
    return name === "default" || name === "export=";
}
function hostDefaultExportSymbolForFile(fileName: string, getHostSf: (fileName: string) => any | undefined): any | undefined {
    const sf = getHostSf(fileName);
    if (!sf) return undefined;
    const vlsDecl = findHostVlsExportDeclaration(sf);
    if (vlsDecl?.symbol) return vlsDecl.symbol;
    const exp = findHostExportDefaultStatement(sf);
    if (exp?.symbol) return exp.symbol;
    return undefined;
}
/** Resolve alias chain on host-bound symbols (bindSourceFile), before tsgo RPC. */
function resolveHostAliasedSymbol(symbol: any): any {
    if (!symbol) return symbol;
    if (!(symbol.flags & SymbolFlags.Alias)) return symbol;
    const seen = new Set<any>();
    let current = symbol;
    while (current && (current.flags & SymbolFlags.Alias) && !seen.has(current)) {
        seen.add(current);
        const target = current.target;
        if (!target || target === current) break;
        current = target;
    }
    return current ?? symbol;
}
function symbolDeclarationsAreFileLevelOnly(symbol: any): boolean {
    const decls = symbol?.declarations;
    if (!decls?.length) return false;
    return decls.every((d: any) => d.kind === SyntaxKind.SourceFile || d.kind === SyntaxKind.ModuleDeclaration);
}
function findHostExportDefaultStatement(sf: any): any | undefined {
    if (!sf?.__tnbHostBound) return undefined;
    for (const stmt of sf.statements ?? []) {
        if (stmt.kind === SyntaxKind.ExportAssignment && !stmt.isExportEquals) {
            return stmt;
        }
    }
    return undefined;
}
function findHostVlsExportDeclaration(sf: any): any | undefined {
    if (!sf?.__tnbHostBound) return undefined;
    for (const stmt of sf.statements ?? []) {
        if (stmt.kind !== SyntaxKind.VariableStatement) continue;
        for (const decl of stmt.declarationList?.declarations ?? []) {
            const name = decl.name?.escapedName ?? decl.name?.text;
            if (name === "__VLS_export") return decl;
        }
    }
    return undefined;
}
function isExportDefaultStubExpression(expr: any): boolean {
    return expr?.kind === SyntaxKind.AsExpression
        && expr.expression?.kind === SyntaxKind.ObjectLiteralExpression;
}
/** Anchor node for default export in host-bound virtual snapshot (codegen const or ExportAssignment). */
function findHostDefaultExportAnchor(sf: any): any | undefined {
    const vlsDecl = findHostVlsExportDeclaration(sf);
    if (vlsDecl?.initializer) return vlsDecl.initializer;
    const exp = findHostExportDefaultStatement(sf);
    if (exp) {
        const expr = exp.expression ?? exp;
        if (!isExportDefaultStubExpression(expr)) return expr;
    }
    return undefined;
}
function spanFromHostNode(sf: any, node: any): { start: number; length: number } | undefined {
    if (!node || !sf) return undefined;
    const start = node.getStart?.(sf);
    const end = node.getEnd?.(sf);
    if (typeof start === "number" && typeof end === "number" && end > start) {
        return { start, length: end - start };
    }
    return undefined;
}
function hostDefaultExportDefinitionSpan(sf: any): { start: number; length: number } | undefined {
    if (!sf?.__tnbHostBound) return undefined;
    const vlsDecl = findHostVlsExportDeclaration(sf);
    const exp = findHostExportDefaultStatement(sf);
    if (vlsDecl?.initializer && exp) {
        const start = exp.getStart?.(sf);
        let end = vlsDecl.initializer.getEnd?.(sf);
        const stmt = vlsDecl.parent?.parent;
        if (stmt?.kind === SyntaxKind.VariableStatement) {
            end = Math.max(end ?? 0, stmt.getEnd?.(sf) ?? 0);
        }
        const text = sf.text ?? "";
        while (typeof end === "number" && end < text.length && /[\t \n\r]/.test(text[end])) {
            end++;
        }
        if (typeof start === "number" && typeof end === "number" && end > start) {
            return { start, length: end - start };
        }
    }
    const anchor = findHostDefaultExportAnchor(sf);
    if (anchor) return spanFromHostNode(sf, anchor);
    if (exp) return spanFromHostNode(sf, exp);
    return undefined;
}
/** tsgo module/file symbols → host bindSourceFile default-export symbol. */
function resolveHostExportDefaultSymbol(symbol: any, getHostSf: (fileName: string) => any | undefined): any {
    if (!symbol) return symbol;
    // Swap only true module symbols (a SourceFile declaration) to the host
    // default-export symbol. A `declare namespace X` value symbol also has
    // file-level-only declarations, but swapping it hands checker consumers
    // the `default` ALIAS symbol — getAliasedSymbol results regress to
    // non-values and roblox-ts elides live imports.
    if (symbolDeclarationsAreFileLevelOnly(symbol)
        && symbol.declarations.some((d: any) => d.kind === SyntaxKind.SourceFile)) {
        const fileName = symbol.declarations?.[0]?.getSourceFile?.()?.fileName;
        if (fileName) {
            const hostSym = hostDefaultExportSymbolForFile(fileName, getHostSf);
            if (hostSym) return hostSym;
        }
    }
    const memberName = (symbol.escapedName ?? symbol.name) as string | undefined;
    if (isModuleDefaultExportMemberName(memberName)) {
        const fileName = moduleSymbolSourceFileName(symbol.parent)
            ?? symbol.declarations?.[0]?.getSourceFile?.()?.fileName;
        if (fileName) {
            const hostSym = hostDefaultExportSymbolForFile(fileName, getHostSf);
            if (hostSym) return hostSym;
        }
    }
    return symbol;
}
function tryGetTargetSymbol(symbol: any): any | undefined {
    if (!symbol) return undefined;
    let target: any;
    let next = symbol;
    const seen = new Set<any>();
    while (next && !seen.has(next)) {
        seen.add(next);
        const t = next.target;
        if (!t || t === next) break;
        target = t;
        next = t;
    }
    return target;
}
function getImmediateRootSymbolsForNavigation(symbol: any): any[] | undefined {
    if (!symbol) return undefined;
    if (symbol.flags & SymbolFlags.Transient) {
        const target = tryGetTargetSymbol(symbol);
        return target ? [target] : undefined;
    }
    return undefined;
}
let _globalThisSentinelSymbol: any;
function getGlobalThisSentinelSymbol(): any {
    if (!_globalThisSentinelSymbol) {
        _globalThisSentinelSymbol = {
            escapedName: "globalThis",
            name: "globalThis",
            flags: SymbolFlags.Module,
            declarations: [],
            getDeclarations: () => [],
            getName: () => "globalThis",
            getEscapedName: () => "globalThis",
        };
    }
    return _globalThisSentinelSymbol;
}
function resolveNameOnHostBoundAst(name: string, location: any): any | undefined {
    if (!location || typeof location.getStart !== "function") return undefined;
    const sf = location.getSourceFile?.();
    if (!sf?.__tnbHostBound) return undefined;
    const unescaped = typeof name === "string" && name.charCodeAt(0) === 95 /* _ */
        ? name
        : name;
    if (location.kind === SyntaxKind.Identifier && location.text === unescaped) {
        return getHostBoundSymbolAtLocation(location);
    }
    return undefined;
}
function declarationNeedsHostRemap(decl: any): boolean {
    const sf = decl?.getSourceFile?.();
    return !!(sf && !sf.__tnbHostBound);
}
/** Deepest host-bound AST node containing `pos` (Language Service snapshot coords). */
function findHostNodeAtPosition(sf: any, pos: number): any | undefined {
    if (!sf?.__tnbHostBound || typeof pos !== "number") return undefined;
    let best: any;
    function visit(node: any): void {
        if (pos < node.getStart(sf) || pos >= node.getEnd(sf)) return;
        best = node;
        ts.forEachChild(node, visit);
    }
    visit(sf);
    return best;
}
function findHostNodeAtLineCharacter(hostSf: any, remoteSf: any, pos: number): any | undefined {
    if (!hostSf?.__tnbHostBound || !remoteSf || typeof pos !== "number") return undefined;
    try {
        const { line, character } = remoteSf.getLineAndCharacterOfPosition(pos);
        const hostPos = hostSf.getPositionOfLineAndCharacter(line, character);
        return findHostNodeAtPosition(hostSf, hostPos);
    } catch {
        return undefined;
    }
}
function findHostModuleScopedDeclaration(hostSf: any, escapedName: string): any | undefined {
    if (!hostSf?.__tnbHostBound || !escapedName) return undefined;
    for (const stmt of hostSf.statements ?? []) {
        switch (stmt.kind) {
            case SyntaxKind.VariableStatement:
                for (const decl of stmt.declarationList?.declarations ?? []) {
                    const name = decl.name?.escapedName ?? decl.name?.text;
                    if (name === escapedName) return decl;
                }
                break;
            case SyntaxKind.FunctionDeclaration:
            case SyntaxKind.ClassDeclaration:
            case SyntaxKind.InterfaceDeclaration:
            case SyntaxKind.TypeAliasDeclaration:
            case SyntaxKind.EnumDeclaration:
                if ((stmt.name?.escapedName ?? stmt.name?.text) === escapedName) return stmt;
                break;
            case SyntaxKind.ExportDeclaration:
                for (const el of stmt.exportClause?.elements ?? []) {
                    const name = el.name?.escapedName ?? el.name?.text;
                    if (name === escapedName) return el;
                }
                break;
        }
    }
    return undefined;
}
function symbolMatchesMeaning(symbol: any, meaning: number): boolean {
    if (!symbol || !meaning) return false;
    const exportFlags = symbol.exportSymbol?.flags ?? 0;
    return (((symbol.flags ?? 0) | exportFlags) & meaning) !== 0;
}
function copyScopeSymbolsFromTable(table: any, meaning: number, out: Map<string, any>): void {
    if (!table) return;
    const add = (sym: any) => {
        if (!symbolMatchesMeaning(sym, meaning)) return;
        const id = sym.escapedName ?? sym.name;
        if (id && !out.has(String(id))) out.set(String(id), sym);
    };
    if (typeof table.forEach === "function") {
        table.forEach((sym: any) => add(sym));
        return;
    }
    if (typeof table.values === "function") {
        for (const sym of table.values()) add(sym);
    }
}
/** bindSourceFile locals/exports walk — tsgo has no getSymbolsInScope RPC yet. */
function getHostSymbolsInScope(location: any, meaning: number): any[] {
    if (!location?.getSourceFile?.()?.__tnbHostBound) return [];
    if (location.flags & NodeFlags.InWithStatement) return [];
    const symbols = new Map<string, any>();
    let node = location;
    while (node) {
        if (node.locals) {
            copyScopeSymbolsFromTable(node.locals, meaning, symbols);
        }
        switch (node.kind) {
            case SyntaxKind.SourceFile: {
                const sf = node;
                if (sf.externalModuleIndicator || sf.commonJsModuleIndicator) {
                    copyScopeSymbolsFromTable(sf.symbol?.exports, meaning, symbols);
                }
                break;
            }
            case SyntaxKind.ModuleDeclaration:
                copyScopeSymbolsFromTable(node.symbol?.exports, meaning, symbols);
                break;
            case SyntaxKind.EnumDeclaration:
                copyScopeSymbolsFromTable(node.symbol?.exports, meaning & SymbolFlags.EnumMember, symbols);
                break;
        }
        node = node.parent;
    }
    symbols.delete("this");
    return [...symbols.values()];
}
function remapDeclarationToHost(decl: any, getHostSf: (fileName: string) => any | undefined): any {
    if (!decl || !declarationNeedsHostRemap(decl)) return decl;
    if (decl.kind === SyntaxKind.SourceFile) {
        const fileName = decl.fileName;
        if (typeof fileName !== "string" || !fileName.length) return decl;
        return getHostSf(fileName) ?? decl;
    }
    const remoteSf = decl.getSourceFile?.();
    const fileName = remoteSf?.fileName;
    if (typeof fileName !== "string" || !fileName.length) return decl;
    const hostSf = getHostSf(fileName);
    if (!hostSf) return decl;
    const pos = decl.getStart?.(remoteSf);
    let hostNode = typeof pos === "number" ? findHostNodeAtPosition(hostSf, pos) : undefined;
    if (!hostNode && typeof pos === "number") {
        hostNode = findHostNodeAtLineCharacter(hostSf, remoteSf, pos);
    }
    if (!hostNode) {
        const name = decl.symbol?.escapedName ?? decl.symbol?.name
            ?? decl.name?.escapedName ?? decl.name?.text;
        if (name) hostNode = findHostModuleScopedDeclaration(hostSf, String(name));
    }
    if (!hostNode) return decl;
    // findHostNodeAtPosition returns the deepest node at pos — for declarations
    // with leading modifiers (`declare interface X`) that's the modifier token,
    // for name positions it's the Identifier. Prefer the enclosing node whose
    // kind matches the remote declaration.
    if (typeof decl.kind === "number" && hostNode.kind !== decl.kind) {
        let enclosing: any = hostNode;
        while (enclosing && enclosing.kind !== decl.kind) enclosing = enclosing.parent;
        if (enclosing) hostNode = enclosing;
    }
    if (hostNode.kind === SyntaxKind.Identifier && hostNode.parent?.symbol?.declarations) {
        const parent = hostNode.parent;
        if (parent.name === hostNode || parent.propertyName === hostNode) {
            return parent;
        }
    }
    return hostNode;
}
/** tsgo RemoteSourceFile declarations → host bindSourceFile nodes for LS navigation. */
function remapSymbolDeclarationsToHost(symbol: any, getHostSf: (fileName: string) => any | undefined): any {
    if (!symbol?.declarations?.length) return symbol;
    let changed = false;
    const mapped = symbol.declarations.map((decl: any) => {
        const next = remapDeclarationToHost(decl, getHostSf);
        if (next !== decl) changed = true;
        return next;
    });
    if (!changed) return symbol;
    // `declarations` on tsgo symbols is a prototype accessor without a setter —
    // plain assignment is a silent no-op in sloppy mode. defineProperty shadows
    // it with an own data property.
    try {
        Object.defineProperty(symbol, "declarations", { value: mapped, writable: true, configurable: true, enumerable: true });
    } catch {
        // tsgo symbol objects may be read-only; best-effort only.
    }
    try {
        const valueDecl = symbol.valueDeclaration;
        if (valueDecl) {
            const mappedValueDecl = remapDeclarationToHost(valueDecl, getHostSf);
            if (mappedValueDecl !== valueDecl) {
                Object.defineProperty(symbol, "valueDeclaration", { value: mappedValueDecl, writable: true, configurable: true, enumerable: true });
            }
        }
    } catch {
        // best-effort only
    }
    return symbol;
}
function refineHostNavigationSymbol(symbol: any, getHostSf: (fileName: string) => any | undefined): any {
    if (!symbol) return symbol;
    let refined = resolveHostExportDefaultSymbol(symbol, getHostSf);
    refined = remapSymbolDeclarationsToHost(refined, getHostSf);
    return refined;
}
function isCrossFileImportExportName(node: any): boolean {
    const parent = node?.parent;
    if (!parent) return false;
    return (
        (parent.kind === SyntaxKind.ImportSpecifier && parent.name === node)
        || (parent.kind === SyntaxKind.ExportSpecifier && parent.name === node)
        || (parent.kind === SyntaxKind.ImportClause && parent.name === node)
    );
}
/** Host file-reference definitions: span in virtual snapshot for Volar position mappers. */
export function tnbDefinitionSpanForHostFileReference(targetFile: any): { start: number; length: number } | undefined {
    return hostDefaultExportDefinitionSpan(targetFile);
}
/** Host-bound declaration → virtual snapshot span (e.g. __VLS_export initializer). */
export function tnbHostExportDefinitionTextSpan(declaration: any): { start: number; length: number } | undefined {
    if (!declaration) return undefined;
    const sf = declaration.getSourceFile?.();
    if (!sf?.__tnbHostBound) return undefined;
    const combined = hostDefaultExportDefinitionSpan(sf);
    if (combined) return combined;
    if (declaration.kind === SyntaxKind.SourceFile) {
        return tnbDefinitionSpanForHostFileReference(sf);
    }
    if (declaration.kind === SyntaxKind.ExportAssignment && !declaration.isExportEquals) {
        return spanFromHostNode(sf, declaration);
    }
    return undefined;
}
/** Symbol from host-bound AST when tsgo position RPC misses (LS path). */
function getHostBoundSymbolAtLocation(node: any): any | undefined {
    const sf = node?.getSourceFile?.();
    if (!sf?.__tnbHostBound) return undefined;
    const parent = node.parent;
    if (parent) {
        switch (parent.kind) {
            case SyntaxKind.ImportSpecifier:
            case SyntaxKind.ExportSpecifier:
            case SyntaxKind.ImportClause:
            case SyntaxKind.BindingElement:
            case SyntaxKind.VariableDeclaration:
            case SyntaxKind.FunctionDeclaration:
            case SyntaxKind.ClassDeclaration:
            case SyntaxKind.TypeParameter:
            case SyntaxKind.Parameter:
            case SyntaxKind.PropertyDeclaration:
            case SyntaxKind.MethodDeclaration:
            case SyntaxKind.EnumMember:
                if (parent.name === node) return parent.symbol;
                break;
        }
    }
    return node.symbol;
}
/** ScriptKind for LS parse — host.getScriptKind is SSOT for snapshot overlays. */
function resolveLanguageServiceScriptKind(
    host: any,
    requestFileName: string,
    hostFileName: string,
    fromHostSnapshot = false,
): number {
    const fromHost = host?.getScriptKind?.(requestFileName) ?? host?.getScriptKind?.(hostFileName);
    if (fromHost === ts.ScriptKind.TS || fromHost === ts.ScriptKind.TSX
        || fromHost === ts.ScriptKind.JS || fromHost === ts.ScriptKind.JSX) {
        return fromHost;
    }
    // Snapshot text without a host getScriptKind: trust the extension when it is
    // a known script kind (.tsx snapshots still contain JSX and must parse as TSX).
    // Unknown extensions (.vue, .mdx — Volar virtual TS) fall back to TS below.
    const inferred = inferScriptKind(hostFileName);
    if (fromHostSnapshot && inferred === ts.ScriptKind.JSON) {
        // JSON path carrying embedded TS snapshot text (Volar) — keep TS.
        return ts.ScriptKind.TS;
    }
    return inferred;
}
/** Overlay when host snapshot text differs from disk (or file is absent on disk). */
function shouldSendHostOverlay(fileName: string, hostText: string): boolean {
    if (!isOverlayCandidatePath(fileName)) return false;
    if (!fileExistsOnDisk(fileName)) return true;
    const disk = readDiskText(fileName);
    return disk !== hostText;
}
function convertTsgoDiagnostic(d: any, getSourceFile: (fileName: string) => any): any {
    return {
        file: d.fileName ? getSourceFile(toHostFileName(d.fileName)) : undefined,
        start: d.pos,
        length: (d.end ?? d.pos) - d.pos,
        messageText: d.text,
        category: d.category,
        code: d.code,
        reportsUnnecessary: d.reportsUnnecessary,
        reportsDeprecated: d.reportsDeprecated,
        relatedInformation: d.relatedInformation?.map((r: any) => convertTsgoDiagnostic(r, getSourceFile)),
    };
}
function mapTsgoDiagnostics(raw: readonly any[] | undefined, getSourceFile: (fileName: string) => any): readonly any[] {
    if (!raw?.length) return [];
    return raw.map(d => convertTsgoDiagnostic(d, getSourceFile));
}
/** Extra extensions for tsgo when the project contains non-TS root files (.vue, …). */
function collectExtraFileExtensions(fileNames: Iterable<string>, options: any): any[] | undefined {
    // Explicit opt-out in tsconfig must be respected (tsgo mirrors this).
    if (options?.allowArbitraryExtensions === false) return undefined;
    const builtin = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"]);
    const exts = new Set<string>();
    for (const fn of fileNames) {
        if (typeof fn !== "string") continue;
        const dot = fn.lastIndexOf(".");
        if (dot < 0) continue;
        const ext = fn.slice(dot).toLowerCase();
        if (!builtin.has(ext)) exts.add(ext);
    }
    if (!exts.size) return undefined;
    // ScriptKind.Deferred — include extension in all project contexts.
    return [...exts].map(extension => ({ extension, scriptKind: 7 }));
}
function _profRpc(method: string, ms: number): void {
    if (process.env.TSGO_PROFILE !== "1") return;
    _stats.rpcCount++;
    _stats.rpcMs += ms;
    let b = _stats.rpcByMethod.get(method);
    if (!b) { b = { count: 0, ms: 0 }; _stats.rpcByMethod.set(method, b); }
    b.count++;
    b.ms += ms;
}
function _maybePrintStats(): void {
    if (_stats.printed) return;
    _stats.printed = true;
    const topRpc = [..._stats.rpcByMethod.entries()]
        .sort((a, b) => b[1].ms - a[1].ms)
        .slice(0, 5)
        .map(([m, v]) => `${m}=${v.count}/${v.ms.toFixed(0)}ms`)
        .join(" ");
    process.stderr.write(
        `[tsgo-profile] projectsLoaded=${_stats.projectsLoaded} projectLoadMs=${_stats.projectLoadMs}` +
        ` parentSet=${_stats.parentSetFiles}/${_stats.parentSetMs.toFixed(0)}ms` +
        ` symPrefetch=${_stats.symPrefetchFiles}/${_stats.symPrefetchRefs}refs/${_stats.symPrefetchMs.toFixed(0)}ms` +
        ` queries=${_stats.queryCount} queryMs=${_stats.queryMs.toFixed(0)}` +
        ` getType=${_stats.getTypeCount}/${_stats.getTypeMs.toFixed(0)}ms` +
        ` getSym=${_stats.getSymCount}/${_stats.getSymMs.toFixed(0)}ms` +
        ` symHit=${_stats.getSymHitCount} symRpc=${_stats.getSymRpcCount}` +
        ` indexBuild=${_stats.indexBuildCount}/${_stats.indexBuildMs.toFixed(0)}ms` +
        ` rpc=${_stats.rpcCount}/${_stats.rpcMs.toFixed(0)}ms` +
        (topRpc ? ` topRpc={${topRpc}}` : "") +
        `\n`,
    );
}
if (process.env.TSGO_PROFILE === "1") {
    process.on("exit", _maybePrintStats);
}

/** @internal — read profiling counters for fork-perf-bench harness. */
export function getTsgoProfileStats(): Readonly<typeof _stats> {
    return _stats;
}

// ── Enum remapping: tsgo enum values → fork enum values, generated BY NAME ──
// The fork and tsgo enums (SyntaxKind, NodeFlags, ObjectFlags, …) assign
// DIFFERENT numeric values to most members. Any raw tsgo value handed to JS
// consumers (typescript-estree / @typescript-eslint rules) without translation
// is silently wrong. Rather than hand-maintained numeric tables, every
// tsgo→fork map below is DERIVED AT RUNTIME from the two enum definitions,
// matched by member name. This has three properties we want:
//   • identical enums produce an identity map automatically — the no-op case
//     needs no special-casing (e.g. ModifierFlags is left untouched);
//   • a submodule bump that shifts values is absorbed with zero code edits;
//   • the tools/check-enum-remap.mjs CI guard asserts the boundary stays
//     complete (divergent + exposed enums must be remapped here or exempt).
//
// Sources at runtime:
//   • fork enums — the runtime enum objects on the `ts` namespace. The fork
//     compiles with preserveConstEnums, so SyntaxKind/NodeFlags/ObjectFlags
//     exist as name→value objects (the same objects Debug.format* reads);
//   • tsgo enums — the native-preview generated enum modules (dist/enums/*).

// Lazily-required tsgo enum objects (native-preview dist). Resolved from the
// vendored copy under vendor/native-preview/.
let _tsgoEnums: { SyntaxKind: any; NodeFlags: any; ObjectFlags: any } | undefined;
function loadTsgoEnums(): { SyntaxKind: any; NodeFlags: any; ObjectFlags: any } {
    if (_tsgoEnums) return _tsgoEnums;
    const path = require("path") as typeof import("path");
    const enumsDir = path.join(getNativePreviewDir(), "dist", "enums");
    const load = (file: string, name: string) => require(path.join(enumsDir, file))[name];
    _tsgoEnums = {
        SyntaxKind: load("syntaxKind.js", "SyntaxKind"),
        NodeFlags: load("nodeFlags.js", "NodeFlags"),
        ObjectFlags: load("objectFlags.js", "ObjectFlags"),
    };
    return _tsgoEnums;
}

// Forward (name→value) numeric entries of a runtime enum object, in declaration
// order. A transpiled numeric enum also carries reverse (value→name) entries;
// the `typeof v === "number"` filter keeps only the forward ones, and
// non-integer string keys preserve insertion (declaration) order, so the FIRST
// name seen for a value is the canonical member.
function enumForwardEntries(enumObj: any): Array<[string, number]> {
    const out: Array<[string, number]> = [];
    if (!enumObj) return out;
    for (const name in enumObj) {
        const v = enumObj[name];
        if (typeof v === "number") out.push([name, v]);
    }
    return out;
}

const _isPow2 = (v: number): boolean => v !== 0 && (v & (v - 1)) === 0;

// Build a scalar tsgo→fork value map by member name. First name wins per tsgo
// value, so a canonical kind (declared first) beats trailing marker aliases
// (FirstX/LastX) that reuse the same value. Identity entries are omitted, so
// the map is empty for an identical enum and remapKind becomes a pass-through.
function buildScalarRemapByName(tsgoEnum: any, forkEnum: any): Map<number, number> {
    const remap = new Map<number, number>();
    const seen = new Set<number>();
    for (const [name, tsgoVal] of enumForwardEntries(tsgoEnum)) {
        if (seen.has(tsgoVal)) continue;
        seen.add(tsgoVal);
        const forkVal = forkEnum?.[name];
        if (typeof forkVal === "number" && forkVal !== tsgoVal) remap.set(tsgoVal, forkVal);
    }
    return remap;
}

// Build [tsgoBit, forkBit] pairs for single-bit flags present (by name) in BOTH
// enums. First name wins per tsgo bit, so the canonical flag beats later
// aliases that repurpose the same bit (e.g. NodeFlags.OptionalChain over the
// trailing NestedNamespace alias). tsgo-only bits (no fork member of that name)
// are dropped so they don't light up an unrelated fork bit; identical enums
// yield identity-only pairs, making remapFlagsByPairs a no-op.
function buildFlagPairsByName(tsgoEnum: any, forkEnum: any): Array<[number, number]> {
    const pairs: Array<[number, number]> = [];
    const seen = new Set<number>();
    for (const [name, tsgoVal] of enumForwardEntries(tsgoEnum)) {
        if (!_isPow2(tsgoVal) || seen.has(tsgoVal)) continue;
        seen.add(tsgoVal);
        const forkVal = forkEnum?.[name];
        if (typeof forkVal === "number" && _isPow2(forkVal)) pairs.push([tsgoVal, forkVal]);
    }
    return pairs;
}

function remapFlagsByPairs(tsgoFlags: number, pairs: ReadonlyArray<readonly [number, number]>): number {
    let out = 0;
    for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];
        if (tsgoFlags & pair[0]) out |= pair[1];
    }
    return out;
}

// ── SyntaxKind remap (tsgo → fork), by member name ──
// `node.kind` (and the scalar SyntaxKind token getters operator/token/…) are
// read straight off the tsgo blob as RAW tsgo kinds; estree/`ts.isXxx`
// type-guards compare against fork kind values. The fork has extra kinds that
// shift later values, so the maps differ by ~200 members — all derived here.
let _kindRemap: Map<number, number> | undefined;
let _kindRemapApplied = false;

function buildKindRemap(): Map<number, number> {
    const tsgo = loadTsgoEnums();
    return buildScalarRemapByName(tsgo.SyntaxKind, (ts as any).SyntaxKind);
}

function remapKind(tsgoKind: number): number {
    if (!_kindRemap) return tsgoKind;
    return _kindRemap.get(tsgoKind) ?? tsgoKind;
}

// ── NodeFlags remap (tsgo bit layout → fork bit layout), by member name ──
// `node.flags` is read off the binary blob and consumed by estree
// (OptionalChain) and rules (Ambient/AwaitContext/…), compared against fork
// `ts.NodeFlags.*`. The bit layouts diverge (e.g. tsgo OptionalChain bit5 vs
// fork bit6, tsgo Ambient bit23 vs fork bit25), so the per-bit map is derived
// by name. Distinct flags values are few, so a memo keeps the per-read cost to
// one Map lookup.
let _nodeFlagsPairs: ReadonlyArray<readonly [number, number]> | undefined;
const _nodeFlagsRemapCache = new Map<number, number>();

function nodeFlagsPairs(): ReadonlyArray<readonly [number, number]> {
    if (!_nodeFlagsPairs) {
        const tsgo = loadTsgoEnums();
        _nodeFlagsPairs = buildFlagPairsByName(tsgo.NodeFlags, (ts as any).NodeFlags);
    }
    return _nodeFlagsPairs;
}

function remapNodeFlags(tsgoFlags: number): number {
    if (!tsgoFlags) return 0;
    const cached = _nodeFlagsRemapCache.get(tsgoFlags);
    if (cached !== undefined) return cached;
    const out = remapFlagsByPairs(tsgoFlags, nodeFlagsPairs());
    _nodeFlagsRemapCache.set(tsgoFlags, out);
    return out;
}

// ── ObjectFlags remap (tsgo bit layout → fork bit layout), by member name ──
// Low bits (Class…CouldContainTypeVariables) are identical and map to
// themselves; the high cache bits diverge. The one that reaches consumers is
// InstantiationExpressionType (no-misused-spread reads
// `type.objectFlags & ts.ObjectFlags.InstantiationExpressionType`) — tsgo bit24
// vs fork bit23. Derived by name, so each tsgo bit lands on its fork-named home.
let _objectFlagsPairs: ReadonlyArray<readonly [number, number]> | undefined;
const _objectFlagsRemapCache = new Map<number, number>();

function objectFlagsPairs(): ReadonlyArray<readonly [number, number]> {
    if (!_objectFlagsPairs) {
        const tsgo = loadTsgoEnums();
        _objectFlagsPairs = buildFlagPairsByName(tsgo.ObjectFlags, (ts as any).ObjectFlags);
    }
    return _objectFlagsPairs;
}

function remapObjectFlags(tsgoFlags: number): number {
    if (!tsgoFlags) return 0;
    const cached = _objectFlagsRemapCache.get(tsgoFlags);
    if (cached !== undefined) return cached;
    const out = remapFlagsByPairs(tsgoFlags, objectFlagsPairs());
    _objectFlagsRemapCache.set(tsgoFlags, out);
    return out;
}

function patchRemoteNodeKinds(sampleNode: any): void {
    if (_kindRemapApplied) return;
    _kindRemapApplied = true;
    _kindRemap = buildKindRemap();
    if (_kindRemap.size === 0 || !sampleNode) return;

    // Patch the kind getter to remap tsgo→fork kind values for external
    // consumers (lazy-estree, ts.forEachChild, ts.isXxx). tsgo internal
    // methods use _rawKind (patched in node.generated.js) which always
    // returns the raw tsgo kind, so they are unaffected.
    //
    // `operator` (Prefix/PostfixUnaryExpression) and `keywordToken`
    // (MetaProperty) are scalar SyntaxKind token values, not child nodes, and
    // are emitted as raw tsgo kinds just like `kind`. typescript-estree reads
    // them directly (e.g. getTextForTokenKind(node.operator) when converting
    // UpdateExpression); without remapping, the off-by-one tsgo enum makes
    // `++`→`%` (mis-typed as UnaryExpression → no-unused-expressions) and
    // `--`→`++` (wrong-direction UpdateExpression → for-direction). Remap them
    // on whichever proto owns each getter (they live on different prototypes:
    // `kind` on RemoteNodeBase, `operator`/`keywordToken` on RemoteNode).
    const patchKindGetter = (name: string) => {
        let proto: any = Object.getPrototypeOf(sampleNode);
        while (proto && proto !== Object.prototype) {
            const desc = Object.getOwnPropertyDescriptor(proto, name);
            if (desc?.get) {
                const origGet = desc.get;
                Object.defineProperty(proto, name, {
                    configurable: true,
                    get(this: any) {
                        const v = origGet.call(this);
                        return typeof v === "number" ? remapKind(v) : v;
                    },
                });
                return;
            }
            proto = Object.getPrototypeOf(proto);
        }
    };
    patchKindGetter("kind");
    patchKindGetter("operator");
    patchKindGetter("keywordToken");
    // `token` is a scalar SyntaxKind on HeritageClause (Extends/Implements) and
    // ImportAttributes (Assert/With), emitted as a raw tsgo kind. typescript-
    // estree reads `heritageClause.token === ts.SyntaxKind.ExtendsKeyword` /
    // `ImplementsKeyword` to split a class's superClass vs implements; with the
    // off-by-one tsgo enum the comparison never matches, so both clauses are
    // dropped from the ESTree output.
    patchKindGetter("token");
    // `keyword` (ModuleDeclaration namespace/module) and `phaseModifier`
    // (ImportClause type/defer) are the remaining scalar SyntaxKind getters in
    // the node decoder. They currently return keyword-token kinds that happen
    // to be identical across both enums (so remapKind is a no-op for them), but
    // we remap them anyway: it keeps EVERY exposed SyntaxKind-scalar field
    // boundary-translated, so a future submodule bump that shifts those values
    // can't silently regress. (The check-enum-remap.mjs guard enforces this.)
    patchKindGetter("keyword");
    patchKindGetter("phaseModifier");

    // `node.flags` is a raw tsgo NodeFlags value read off the binary blob (see
    // remapNodeFlags above). Remap it for external consumers; tsgo internal
    // dispatchers read `_rawFlags` (patched in node.generated.ts) so they keep
    // the raw value.
    const patchFlagsGetter = () => {
        let proto: any = Object.getPrototypeOf(sampleNode);
        while (proto && proto !== Object.prototype) {
            const desc = Object.getOwnPropertyDescriptor(proto, "flags");
            if (desc?.get) {
                const origGet = desc.get;
                Object.defineProperty(proto, "flags", {
                    configurable: true,
                    get(this: any) {
                        const v = origGet.call(this);
                        return typeof v === "number" ? remapNodeFlags(v) : v;
                    },
                });
                return;
            }
            proto = Object.getPrototypeOf(proto);
        }
    };
    patchFlagsGetter();
}

// ── Thin tsgo-backed Program ──
// Replaces the full TS createProgram pipeline with a lightweight object that
// delegates source files + type checking to tsgo. Skips file resolution,
// module resolution, source-file creation, and path processing (~576ms on
// self-lint). tsgo resolves files from the tsconfig; host content is fed via
// overlay RPC so tsgo doesn't double-read from disk.

/** @internal */
export function createTsgoProgram(
    rootNames: readonly string[],
    options: any,
    host: any,
    projectReferences?: readonly any[],
    configFileParsingDiagnostics?: readonly any[],
): any {
    let configFilePath = options.configFilePath as string;
    if (!configFilePath) {
        throw new Error("createTsgoProgram: options.configFilePath is required");
    }
    configFilePath = resolveTsconfigPath(configFilePath, host);
    options.configFilePath = configFilePath;
    const configDiags = configFileParsingDiagnostics ?? [];

    // Host script text captured once at createProgram time (safe to call
    // host.getSourceFile here — program does not exist yet; Volar injects
    // virtual TS for .vue via getSourceFile). Reused by getOrCreateSourceFile
    // for skeleton text / diagnostic line maps without re-entering getSourceFile.
    const hostContentByFile = new Map<string, { text: string; scriptKind: number; fromHost?: boolean }>();
    /** Parsed host SourceFiles captured during createProgram (Volar virtual .vue TS). */
    const parsedHostSourceFiles = new Map<string, any>();

    // Collect host file content for tsgo overlays — makes the fork host the
    // single source of truth. Uses getSourceFile when present (vue-tsc / Volar
    // inject virtual TS for .vue); falls back to readFile. Only sends content
    // that differs from disk (or is missing on disk); unchanged on-disk .ts is
    // read by tsgo itself.
    const overlays: any[] = [];
    const trackedHostFiles = new Set<string>();
    const names = new Set<string>();
    const lsHost = _languageServiceHost ?? host;
    {
        for (const fn of rootNames) {
            if (typeof fn === "string") names.add(fn);
        }
        for (const resolvedFn of collectTsgoOpenFileNames(lsHost)) {
            names.add(resolvedFn);
        }
        for (const fn of names) {
            trackedHostFiles.add(fn);
            const resolvedFn = resolveHostFileName(fn, host);
            if (!isOverlayCandidatePath(fn)) continue;
            const content = getHostScriptContentForOverlay(resolvedFn, options, host);
            if (!content) continue;
            hostContentByFile.set(resolvedFn, content);
            // Only parse host AST for true overlays (content differs from disk —
            // Volar virtual .vue TS, unsaved edits). Pure disk lint skips this
            // and uses tsgo-backed single-parse instead.
            if (!shouldSendHostOverlay(resolvedFn, content.text)) continue;
            const snapSf = sourceFileFromHostSnapshot(_languageServiceHost ?? host, resolvedFn, fn, options.target ?? 99);
            if (snapSf?.statements?.length) {
                parsedHostSourceFiles.set(resolvedFn, snapSf);
            }
            overlays.push({ fileName: resolvedFn, content: content.text, scriptKind: content.scriptKind });
        }
    }
    // TNB_HOST_SOURCE_FILES=1: always materialize real host-parsed SourceFiles
    // instead of tsgo RemoteSourceFile skeletons. Required by consumers that run
    // custom transformers over the program AST (e.g. transpilers like roblox-ts):
    // factory.update* calls mutate NodeArrays, and remote skeleton arrays expose
    // getter-only pos/end.
    const preferHostSourceFiles = overlays.length > 0
        || parsedHostSourceFiles.size > 0
        || !!(lsHost as any)?.projectService
        || process.env.TNB_HOST_SOURCE_FILES === "1";
    _pendingOverlays = overlays.length > 0 ? overlays : undefined;
    _pendingExtraFileExtensions = collectExtraFileExtensions(names, options);
    _lastExtraFileExtensions = _pendingExtraFileExtensions;
    _overlayHostCtx = { host: _languageServiceHost ?? host, options, configFilePath };
    _hasHostBoundFiles = preferHostSourceFiles;
    // Mirror Volar proxyCreateProgram: extra extensions require allowArbitraryExtensions
    // for module resolution / auto-import in .vue virtual TS.
    if (_pendingExtraFileExtensions?.length && options.allowArbitraryExtensions !== false) {
        options.allowArbitraryExtensions = true;
    }

    // Collect referenced project paths for tsgo to open alongside the main
    // project — tsgo needs all referenced tsconfigs to resolve imports
    // across project boundaries (the full TS createProgram does this via
    // projectReferences; the thin path uses tsgo's openProjects).
    if (projectReferences && projectReferences.length > 0) {
        _pendingReferencedProjects = projectReferences
            .map((ref: any) => resolveTsconfigPath(ref.path as string, host))
            .filter((p: string) => typeof p === "string" && p.length > 0);
    } else {
        _pendingReferencedProjects = undefined;
    }

    // Eagerly create the tsgo project (shared bridge client, kind remap, etc.)
    // by calling createTsgoChecker which sets up ensureProject + overlays.
    // We pass a minimal program-like object that createTsgoChecker can use
    // to get configFilePath + getSourceFiles (for overlay content collection).
    const thinProgramForChecker = {
        getCompilerOptions: () => options,
        getSourceFiles: () => [] as any[],
    };

    // tsserver/Volar open files incrementally (e.g. foo.vue before fixture.vue).
    // Always refresh the tsgo snapshot so overlays match the latest host content.
    _projectCache.delete(configFilePath);

    const checker = createTsgoChecker(thinProgramForChecker as any);

    // The tsgo project is now created (ensureProject ran inside createTsgoChecker).
    // Access it via the module-level cache.
    const project = _projectCache.get(configFilePath);

    // Build a thin Program object that delegates to the tsgo project.
    const getTsgoSourceFileNames = () => project?.program?.getSourceFileNames?.() ?? [];
    const getSourceFileNames = () => getTsgoSourceFileNames().map(toHostFileName);
    const tsgoGetSourceFile = (fileName: string) => project?.program?.getSourceFile?.(toTsgoFileName(fileName));

    // Helper: create a proper TS SourceFile shell (with path/resolvedPath/etc.)
    // from host content, then wrap it with the tsgo RemoteSourceFile AST via
    // getTsgoBackedSourceFile. BuilderProgram and other TS infrastructure
    // need path/resolvedPath/version on source files.
    const sfCache = new Map<string, any>();

    const hostForLs = () => _languageServiceHost ?? host;

    const fileHasHostSourceContent = (name: string, hostFileName: string): boolean => {
        const ls = hostForLs();
        return hostHasScriptSnapshot(ls, name, hostFileName)
            || hostContentByFile.has(hostFileName)
            || parsedHostSourceFiles.has(hostFileName);
    };

    /** Host-parsed AST for Language Service — never tsgo RemoteSourceFile. */
    const getLanguageServiceSourceFile = (hostFileName: string, requestFileName: string): any | undefined => {
        const ls = hostForLs();
        const parsed = parsedHostSourceFiles.get(hostFileName);
        if (parsed?.statements?.length) {
            return attachHostSourceFileMetadata(parsed, hostFileName);
        }

        const fromSnap = sourceFileFromHostSnapshot(ls, hostFileName, requestFileName, options.target ?? 99);
        if (fromSnap) return fromSnap;

        const hasSnapshot = hostHasScriptSnapshot(ls, requestFileName, hostFileName);
        const content = hostContentByFile.get(hostFileName);
        if (content?.text && (!hasSnapshot || content.fromHost)) {
            const scriptKind = resolveLanguageServiceScriptKind(ls, requestFileName, hostFileName, hasSnapshot);
            const sf = createSourceFile(hostFileName, content.text, hostSourceFileOptions(options.target ?? 99, ls), /*setParentNodes*/ true, scriptKind);
            return attachHostSourceFileMetadata(sf, hostFileName);
        }

        if (!hasSnapshot) {
            // Compile hosts (vs tsserver LanguageServiceHosts) may not expose
            // readFile; fall back to sys so disk files still host-parse.
            const disk = ls?.readFile?.(hostFileName) ?? ts.sys?.readFile?.(hostFileName);
            if (typeof disk === "string" && disk.length) {
                const sf = createSourceFile(hostFileName, disk, hostSourceFileOptions(options.target ?? 99, ls), /*setParentNodes*/ true, inferScriptKind(hostFileName));
                return attachHostSourceFileMetadata(sf, hostFileName);
            }
        }

        return undefined;
    };

    const createBoundHostSourceFile = (hostFileName: string, requestFileName: string, text: string): any | undefined => {
        if (!text.length) return undefined;
        const ls = hostForLs();
        const scriptKind = resolveLanguageServiceScriptKind(ls, requestFileName, hostFileName, /*fromHostSnapshot*/ true);
        const sf = attachHostSourceFileMetadata(
            createSourceFile(hostFileName, text, hostSourceFileOptions(options.target ?? 99, ls), /*setParentNodes*/ true, scriptKind),
            hostFileName,
        );
        ensureHostSourceFileBound(sf, options);
        return sf;
    };

    // Program.getSourceFile must be case/separator-insensitive like stock TS:
    // builder state hands back lowercase canonical paths, and fabricating a
    // second SourceFile with the queried casing splits the AST identity.
    let _canonicalNameMap: Map<string, string> | undefined;
    let _canonicalNameMapSize = -1;
    const canonicalizeProgramFileName = (fileName: string): string => {
        if (typeof fileName !== "string" || !fileName.length) return fileName;
        const slashed = fileName.replace(/\\/g, "/");
        const lower = slashed.toLowerCase();
        // Rebuild on miss when the program grew — consumers (transformers)
        // resolve module paths before the tsgo project exists, and a map
        // memoized against an empty/partial file list would otherwise let
        // un-normalized (backslash) names through, creating DUPLICATE host
        // SourceFiles whose binder symbols never match the canonical file's.
        if (!_canonicalNameMap || !_canonicalNameMap.has(lower)) {
            const names = getSourceFileNames();
            if (names.length !== _canonicalNameMapSize) {
                _canonicalNameMap = new Map();
                _canonicalNameMapSize = names.length;
                for (const name of names) {
                    _canonicalNameMap.set(name.replace(/\\/g, "/").toLowerCase(), name);
                }
            }
        }
        // Slash-normalized fallback: host TS uses forward slashes everywhere,
        // so a raw backslash name must never become a SourceFile cache key.
        return _canonicalNameMap?.get(lower) ?? slashed;
    };

    // Cache-identity key: pnpm reaches the same file through both the
    // node_modules SYMLINK path (host module resolution) and the .pnpm
    // REALPATH (tsgo file names). Two host SourceFiles for one file break
    // every declaration-identity compare, so key the SF cache by realpath.
    const _realPathKeyByFile = new Map<string, string>();
    const realPathCacheKey = (fileName: string): string => {
        const cached = _realPathKeyByFile.get(fileName);
        if (cached !== undefined) return cached;
        let key = fileName;
        try {
            key = (require("fs") as typeof import("fs")).realpathSync.native(fileName);
        } catch { /* virtual/nonexistent file — identity by given name */ }
        _realPathKeyByFile.set(fileName, key);
        return key;
    };

    const getOrCreateSourceFile = (rawFileName: string): any => {
        if (typeof rawFileName !== "string" || !rawFileName.length) return undefined;
        const fileName = canonicalizeProgramFileName(rawFileName);
        const hostFileName = resolveHostFileName(fileName, host);
        const scriptVersion = host?.getScriptVersion?.(fileName)
            ?? host?.getScriptVersion?.(hostFileName)
            ?? "1";
        const cacheKey = `${realPathCacheKey(hostFileName)}@${scriptVersion}`;
        if (sfCache.has(cacheKey)) return sfCache.get(cacheKey);

        // Language Service token walks need real TS AST (getChildren + parent).
        // tsgo RemoteSourceFile is for checker RPC only — never expose it here.
        // Pure disk lint (no overlay, no tsserver) uses tsgo-backed skeletons below.
        if (preferHostSourceFiles && !isHostLibFile(hostFileName)) {
            const ls = hostForLs();
            const hostSf = getLanguageServiceSourceFile(hostFileName, fileName);
            if (hostSf) {
                ensureHostSourceFileBound(hostSf, options);
                sfCache.set(cacheKey, hostSf);
                return hostSf;
            }
            if (hostHasScriptSnapshot(ls, fileName, hostFileName)) {
                const snap = ls?.getScriptSnapshot?.(fileName) ?? ls?.getScriptSnapshot?.(hostFileName);
                const text = snap
                    ? snap.getText(0, snap.getLength())
                    : (hostContentByFile.get(hostFileName)?.text ?? "");
                const hostSf = createBoundHostSourceFile(hostFileName, fileName, text);
                if (hostSf) {
                    sfCache.set(cacheKey, hostSf);
                    return hostSf;
                }
                const scriptKind = resolveLanguageServiceScriptKind(ls, fileName, hostFileName, /*fromHostSnapshot*/ true);
                const sf = attachHostSourceFileMetadata(
                    createSkeletonSourceFile(hostFileName, text, options.target ?? 99, scriptKind),
                    hostFileName,
                );
                sfCache.set(cacheKey, sf);
                return sf;
            }
        }

        const hostContent = hostContentByFile.get(hostFileName);
        const text = hostContent?.text ?? host?.readFile?.(hostFileName) ?? "";
        const scriptKind = hostContent?.scriptKind ?? inferScriptKind(hostFileName);
        const sf = createSkeletonSourceFile(hostFileName, text, options.target ?? 99, scriptKind);
        const anySf = sf as any;
        anySf.version = "1";
        const backed = getTsgoBackedSourceFile(anySf);
        const result = backed ?? anySf;
        if (result && !("version" in result)) {
            try { Object.defineProperty(result, "version", { value: "1", writable: true, configurable: true, enumerable: false }); } catch {}
        }
        if (result && result !== anySf) {
            try {
                if (result.resolvedPath === undefined) {
                    Object.defineProperty(result, "resolvedPath", { value: hostFileName, writable: true, configurable: true });
                }
                if (result.originalFileName === undefined) {
                    Object.defineProperty(result, "originalFileName", { value: hostFileName, writable: true, configurable: true });
                }
            } catch {}
        }
        sfCache.set(cacheKey, result);
        return result;
    };

    // Writable skeleton SourceFiles for diagnostics — Volar vue-tsc mutates
    // diagnostic.file.text during span remapping; tsgo RemoteSourceFile.text is read-only.
    const diagnosticSfCache = new Map<string, any>();
    const getDiagnosticSourceFile = (fileName: string): any => {
        if (diagnosticSfCache.has(fileName)) return diagnosticSfCache.get(fileName);
        const hostContent = hostContentByFile.get(fileName);
        const text = hostContent?.text ?? host?.readFile?.(fileName) ?? "";
        const scriptKind = hostContent?.scriptKind ?? inferScriptKind(fileName);
        const sf = createSkeletonSourceFile(fileName, text, options.target ?? 99, scriptKind);
        diagnosticSfCache.set(fileName, sf);
        return sf;
    };

    // Lightweight skeleton stub (no tsgo RPC) for getSourceFiles() —
    // BuilderProgram iterates all files for state creation but only needs
    // version + referencedFiles (metadata), not the AST. Returning the
    // skeleton avoids 1693 eager getSourceFile RPCs; only the ~700 files
    // the files actually linted pay the RPC via getSourceFile(fileName).
    const lightSfCache = new Map<string, any>();
    const getOrCreateLightSourceFile = (rawFileName: string): any => {
        const fileName = canonicalizeProgramFileName(rawFileName);
        const hostFileName = toHostFileName(fileName);
        if (lightSfCache.has(hostFileName)) return lightSfCache.get(hostFileName);
        // Metadata-only SourceFile stub: no host.readFile, no computeLineStarts,
        // no AST. BuilderProgram state creation only needs these fields to key
        // fileInfos and to ask for referenced/imported files (empty here).
        // tsserver getScriptInfos() requires ScriptInfo for every returned file;
        // default libs are not opened as ScriptInfo — exclude them here.
        const tsgoPath = hostFileName;
        const sf: any = {
            kind: SyntaxKind.SourceFile,
            fileName: hostFileName,
            path: tsgoPath,
            resolvedPath: tsgoPath,
            originalFileName: hostFileName,
            text: "",
            version: "1",
            languageVersion: options.target ?? 99,
            languageVariant: 0,
            scriptKind: inferScriptKind(hostFileName),
            isDeclarationFile: hostFileName.endsWith(".d.ts"),
            hasNoDefaultLib: false,
            referencedFiles: [],
            typeReferenceDirectives: [],
            libReferenceDirectives: [],
            amdDependencies: [],
            moduleAugmentations: [],
            imports: [],
            ambientModuleNames: [],
            parseDiagnostics: [],
            bindDiagnostics: [],
            commentDirectives: [],
            lineMap: [0],
            getLineStarts: () => [0],
            getLineAndCharacterOfPosition: () => ({ line: 0, character: 0 }),
            getPositionOfLineAndCharacter: () => 0,
            forEachChild: () => undefined,
        };
        // Stock program contract: getSourceFiles() entries carry full ASTs.
        // Transformers (flamework's information pass) walk every program file
        // via forEachChild — an empty `statements` array silently hides every
        // class/decorator in the project. Keep the stub cheap for metadata
        // consumers (BuilderProgram state) but materialize the real host
        // SourceFile on first AST access.
        let upgradedSf: any;
        const upgrade = () => {
            if (upgradedSf === undefined) upgradedSf = getOrCreateSourceFile(hostFileName) ?? null;
            return upgradedSf;
        };
        Object.defineProperty(sf, "statements", {
            configurable: true,
            get() { return upgrade()?.statements ?? []; },
        });
        Object.defineProperty(sf, "endOfFileToken", {
            configurable: true,
            get() { return upgrade()?.endOfFileToken ?? { kind: SyntaxKind.EndOfFileToken, pos: 0, end: 0 }; },
        });
        lightSfCache.set(hostFileName, sf);
        return sf;
    };

    const tsgoFileArg = (fileName: string | undefined) => fileName ? toTsgoFileName(fileName) : fileName;

    // ── Symlink cache (pnpm reverse-mapping) ──
    // Transpilers (roblox-ts guessVirtualPath) reverse-map realpaths under
    // node_modules/.pnpm back to the virtual node_modules/<pkg> path. Stock TS
    // fills the cache from module resolutions; the thin program resolves in
    // tsgo, so build the equivalent by scanning node_modules symlink/junction
    // entries on the cwd ancestor chain (mirrors module resolution lookup).
    let _symlinkCache: any;
    const buildSymlinkCache = (): any => {
        const path = require("path") as typeof import("path");
        const fs = require("fs") as typeof import("fs");
        const currentDirectory = host?.getCurrentDirectory?.() ?? process.cwd();
        const getCanonicalFileName = ts.createGetCanonicalFileName(host?.useCaseSensitiveFileNames?.() ?? false);
        const cache = ts.createSymlinkCache(currentDirectory, getCanonicalFileName);
        let linkCount = 0;
        const addLink = (linkPath: string) => {
            let real: string;
            try { real = fs.realpathSync(linkPath); } catch { return; }
            const normalizedReal = real.replace(/\\/g, "/");
            const normalizedLink = path.resolve(linkPath).replace(/\\/g, "/");
            if (getCanonicalFileName(normalizedReal) === getCanonicalFileName(normalizedLink)) return;
            cache.setSymlinkedDirectory(normalizedLink, {
                real: ts.ensureTrailingDirectorySeparator(normalizedReal),
                realPath: ts.ensureTrailingDirectorySeparator(ts.toPath(normalizedReal, currentDirectory, getCanonicalFileName)),
            });
            linkCount++;
        };
        const scanNodeModules = (nmDir: string) => {
            let entries: string[];
            try { entries = fs.readdirSync(nmDir); } catch { return; }
            for (const entry of entries) {
                if (entry.startsWith(".")) continue;
                const full = `${nmDir}/${entry}`;
                if (entry.startsWith("@")) {
                    let scoped: string[];
                    try { scoped = fs.readdirSync(full); } catch { continue; }
                    for (const pkg of scoped) addLink(`${full}/${pkg}`);
                } else {
                    addLink(full);
                }
            }
        };
        let dir = path.resolve(currentDirectory);
        while (true) {
            scanNodeModules(path.join(dir, "node_modules").replace(/\\/g, "/"));
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
        if (process.env.TNB_DEBUG === "1") {
            console.error(`[TNB] symlink cache: ${linkCount} symlinked node_modules dirs`);
        }
        return cache;
    };

    // ── On-demand module resolution (getResolvedModule) ──
    // Stock programs record per-file resolutions during createProgram; tsgo
    // owns those. Resolve lazily with the same options + a shared cache so
    // consumers (getSourceFileFromModuleSpecifier) see equivalent results.
    let _jsModuleResolutionCache: any;
    const resolvedModuleMemo = new Map<string, any>();
    const resolveModuleForProgram = (sourceFile: any, moduleName: string, mode: any): any => {
        const containingFile = sourceFile?.fileName;
        if (!containingFile || typeof moduleName !== "string") return undefined;
        const memoKey = `${containingFile}|${moduleName}|${mode ?? ""}`;
        if (resolvedModuleMemo.has(memoKey)) return resolvedModuleMemo.get(memoKey);
        const currentDirectory = host?.getCurrentDirectory?.() ?? process.cwd();
        if (!_jsModuleResolutionCache) {
            _jsModuleResolutionCache = ts.createModuleResolutionCache(
                currentDirectory,
                ts.createGetCanonicalFileName(host?.useCaseSensitiveFileNames?.() ?? false),
                options,
            );
        }
        const resolutionHost = typeof host?.fileExists === "function" ? host : ts.sys;
        const result = ts.resolveModuleName(moduleName, containingFile, options, resolutionHost, _jsModuleResolutionCache, /*redirectedReference*/ undefined, mode);
        resolvedModuleMemo.set(memoKey, result);
        return result;
    };

    let _commonSourceDirectory: string | undefined;
    const thinProgram: any = {
        // Marks this as a tsgo-backed program: its SourceFiles come straight from
        // tsgo and are never acquired via the LanguageService document registry.
        // LanguageService.cleanupSemanticCache uses this to skip the (otherwise
        // mandatory) releaseDocumentWithKey pass, which would fault on the missing
        // registry bucket and abort ConfiguredProject.close mid-teardown.
        isTsgoBackedProgram: true,
        getRootFileNames: () => collectTsgoOpenFileNames(_languageServiceHost ?? host, rootNames as string[]),
        getCompilerOptions: () => options,
        getSourceFileNames,
        getSourceFile: (fileName: string) => getOrCreateSourceFile(fileName),
        // BuilderProgram mostly calls getSourceFileByPath while constructing
        // fileInfos / dependency state. It only needs source-file metadata
        // there, not the AST. Returning a light stub avoids eager
        // RemoteSourceFile materialisation for every program file.
        // Host-overlay / open files must use the full SourceFile so
        // toLineColumnOffset (go-to-definition span conversion) sees real line maps.
        getSourceFileByPath: (path: any) => {
            const pathStr = String(path);
            const hostFileName = toHostFileName(pathStr);
            if (fileHasHostSourceContent(pathStr, hostFileName)) {
                return getOrCreateSourceFile(pathStr);
            }
            return getOrCreateLightSourceFile(pathStr);
        },
        getSourceFiles: () => {
            const names = getSourceFileNames();
            const result: any[] = [];
            for (const name of names) {
                if (isHostLibFile(name)) continue;
                const hostFileName = toHostFileName(name);
                const sf = fileHasHostSourceContent(name, hostFileName)
                    ? getOrCreateSourceFile(name)
                    : getOrCreateLightSourceFile(name);
                if (sf) result.push(sf);
            }
            return result;
        },
        getTypeChecker: () => checker,
        getConfigFileParsingDiagnostics: () => configDiags,
        getOptionsDiagnostics: () => [],
        getSemanticDiagnostics: (sourceFile?: any) => {
            const raw = sourceFile?.fileName
                ? project?.program?.getSemanticDiagnostics?.(tsgoFileArg(sourceFile.fileName))
                : project?.program?.getSemanticDiagnostics?.();
            return mapTsgoDiagnostics(raw, getDiagnosticSourceFile);
        },
        getSyntacticDiagnostics: (sourceFile?: any) => {
            const raw = sourceFile?.fileName
                ? project?.program?.getSyntacticDiagnostics?.(tsgoFileArg(sourceFile.fileName))
                : project?.program?.getSyntacticDiagnostics?.();
            return mapTsgoDiagnostics(raw, getDiagnosticSourceFile);
        },
        // Global diagnostics are program-wide and immutable per snapshot, but
        // ts.getPreEmitDiagnostics re-requests them for every file — cache per
        // tsgo project instance (rotations swap the instance).
        getGlobalDiagnostics: () => {
            const prog = project?.program;
            if (!prog) return [];
            let cached = _globalDiagnosticsCache.get(prog);
            if (!cached) {
                cached = mapTsgoDiagnostics(prog.getGlobalDiagnostics?.(), getDiagnosticSourceFile);
                _globalDiagnosticsCache.set(prog, cached);
            }
            return cached;
        },
        getSuggestionDiagnostics: (sourceFile?: any) => {
            const raw = sourceFile?.fileName
                ? project?.program?.getSuggestionDiagnostics?.(tsgoFileArg(sourceFile.fileName))
                : project?.program?.getSuggestionDiagnostics?.();
            return mapTsgoDiagnostics(raw, getDiagnosticSourceFile);
        },
        getDeclarationDiagnostics: (sourceFile?: any) => {
            const raw = sourceFile?.fileName
                ? project?.program?.getDeclarationDiagnostics?.(tsgoFileArg(sourceFile.fileName))
                : project?.program?.getDeclarationDiagnostics?.();
            return mapTsgoDiagnostics(raw, getDiagnosticSourceFile);
        },
        getDiagnostics: () => [],
        getBindAndCheckDiagnostics: (sourceFile?: any) => {
            const synRaw = sourceFile?.fileName
                ? project?.program?.getSyntacticDiagnostics?.(tsgoFileArg(sourceFile.fileName))
                : project?.program?.getSyntacticDiagnostics?.();
            const semRaw = sourceFile?.fileName
                ? project?.program?.getSemanticDiagnostics?.(tsgoFileArg(sourceFile.fileName))
                : project?.program?.getSemanticDiagnostics?.();
            return [
                ...mapTsgoDiagnostics(synRaw, getDiagnosticSourceFile),
                ...mapTsgoDiagnostics(semRaw, getDiagnosticSourceFile),
            ];
        },
        getProgramDiagnostics: () => mapTsgoDiagnostics(project?.program?.getProgramDiagnostics?.(), getDiagnosticSourceFile),
        getMissingFilePaths: () => [],
        getFilesByNameMap: () => new Map(),
        getClassifiableNames: () => new Set(),
        // Real commonSourceDirectory: API consumers (e.g. transpilers computing
        // output paths) walk ancestor directories from this value — an empty
        // string sends them into an unterminated `join(dir, "..")` loop.
        getCommonSourceDirectory: () => {
            if (_commonSourceDirectory === undefined) {
                const currentDirectory = host?.getCurrentDirectory?.() ?? process.cwd();
                _commonSourceDirectory = ts.getCommonSourceDirectory(
                    options,
                    () => getSourceFileNames()
                        .filter((f: string) => !isHostLibFile(f) && !ts.isDeclarationFileName(f))
                        .map((f: string) => toHostFileName(f)),
                    currentDirectory,
                    ts.createGetCanonicalFileName(host?.useCaseSensitiveFileNames?.() ?? false),
                );
            }
            return _commonSourceDirectory;
        },
        getCurrentDirectory: () => host?.getCurrentDirectory?.() ?? process.cwd(),
        // Emit-path helpers (sourceFileMayBeEmitted et al. treat the program as
        // an EmitHost): the Proxy fallback would return undefined from these,
        // which crashes canonical-path comparisons downstream.
        useCaseSensitiveFileNames: () => host?.useCaseSensitiveFileNames?.() ?? false,
        getCanonicalFileName: (fileName: string) =>
            ts.createGetCanonicalFileName(host?.useCaseSensitiveFileNames?.() ?? false)(fileName),
        // Emit via tsgo: the Go emitter produces the output text, which we write
        // through the caller's writeFile (or the host's) so --noEmit, Volar output
        // redirection, and build-mode writeFile wrapping stay in the host's control.
        // emitBuildInfo returns a well-formed (skipped) result: the `tsc -b` /
        // `vue-tsc -b` solution builder reads `.emitSkipped` off it, and the Proxy's
        // no-op fallback would otherwise yield `undefined` and crash.
        emit: (targetSourceFile?: any, writeFile?: any, _ct?: any, emitOnlyDtsFiles?: boolean, _customTransformers?: any, forceDtsEmit?: boolean) => {
            // Respect --noEmit: never produce output during a type-check-only run.
            // tsgo parses options from the tsconfig on disk and may not see the CLI
            // flag, so gate here on the JS-side compiler options.
            if (options.noEmit && !forceDtsEmit) {
                return { emitSkipped: true, diagnostics: [], emittedFiles: [], sourceMaps: [] };
            }
            // DocumentIdentifier wire format is plain path string or { uri }, not { fileName }.
            const file = targetSourceFile?.fileName ? tsgoFileArg(targetSourceFile.fileName) : undefined;
            const emitOnly = forceDtsEmit ? 3 : (emitOnlyDtsFiles ? 2 : undefined);
            const res = project?.program?.emit?.({ file, emitOnly, forceDtsEmit: !!forceDtsEmit });
            const outputs = res?.outputFiles ?? [];
            const write = typeof writeFile === "function" ? writeFile : host?.writeFile?.bind(host);
            const emittedFiles: string[] = [];
            const sourceFiles = targetSourceFile ? [targetSourceFile] : undefined;
            for (const o of outputs) {
                if (write) write(o.fileName, o.text, !!o.writeByteOrderMark, undefined, sourceFiles);
                emittedFiles.push(o.fileName);
            }
            return {
                emitSkipped: res?.emitSkipped ?? false,
                diagnostics: mapTsgoDiagnostics(res?.diagnostics, getDiagnosticSourceFile),
                emittedFiles,
                sourceMaps: [],
            };
        },
        emitBuildInfo: () => ({ emitSkipped: true, diagnostics: [] }),
        isSourceFileFromExternalLibrary: () => false,
        isSourceFileDefaultLibrary: (sf: any) => {
            const fn = sf?.fileName ?? "";
            return fn.includes("/lib.") || fn.includes("/node_modules/");
        },
        getBuildInfo: () => undefined,
        getSourceFileFromReference: () => undefined,
        getFileIncludeReasons: () => new Map(),
        getModuleResolutionCache: () => undefined,
        getSymlinkCache: () => (_symlinkCache ??= buildSymlinkCache()),
        getModeForUsageLocation: (file: any, usage: any) => (ts as any).getModeForUsageLocation(file, usage, options),
        getResolvedModule: (sourceFile: any, moduleName: string, mode: any) => resolveModuleForProgram(sourceFile, moduleName, mode),
        redirectTargetsMap: new Map(),
        getGlobalTypingsCacheLocation: () => undefined,
        // BuilderProgram support
        structureIsChanged: () => false,
        getFilesWithInvalidatedResolutions: () => new Set(),
        forEachResolvedModule: (_callback: any) => { /* tsgo program owns module resolutions */ },
        forEachResolvedTypeReferenceDirective: (_callback: any) => {},
        getAutomaticTypeDirectiveResolutions: () => new Map(),
    };

    _hostProgramRef = thinProgram;

    return new Proxy(thinProgram, {
        get(target: any, prop: string | symbol, receiver: any) {
            if (prop in target) return Reflect.get(target, prop, receiver);
            // Unknown methods: return no-op to avoid crashes
            if (typeof prop !== "string") return undefined;
            if (process.env.TNB_DEBUG === "1" && !_loggedUnknownProps.has(`program.${prop}`)) {
                _loggedUnknownProps.add(`program.${prop}`);
                console.error(`[TNB] thin program: unknown property read: ${prop}`);
            }
            return (..._args: any[]) => undefined;
        },
        has: (target: any, p) => p in target,
        ownKeys: () => Object.keys(thinProgram),
        getOwnPropertyDescriptor: (target: any, p) => Object.getOwnPropertyDescriptor(target, p),
    });
}

function installNodeHandleHooks(s: any): void {
    if (_nodeHandlePatched) return;
    // Patch kind remapping using a sample RemoteSourceFile from the project.
    // Done here (not at module load) because we need a tsgo instance to walk
    // the prototype chain — the classes aren't exported by the sync API.
    const NodeHandle = s.NodeHandle;
    if (!NodeHandle?.prototype) return;
    const proto = NodeHandle.prototype;
    _nodeHandlePatched = true;
    // Resolve the handle to its full tsgo RemoteNode once, caching on the
    // instance so repeat reads skip the resolve() walk.
    const resolveSelf = (self: any): any => {
        if (self._resolvedNode === undefined) {
            const project = _currentProjectRef.project;
            self._resolvedNode = project ? (self.resolve(project) ?? null) : null;
        }
        return self._resolvedNode;
    };
    // NodeHandle.getSourceFile() — scope manager calls this on declaration
    // handles to check if a symbol is from a lib file. Short-circuit to
    // project.program.getSourceFile(path) without full Node materialisation.
    if (typeof proto.getSourceFile !== "function") {
        proto.getSourceFile = function () {
            const project = _currentProjectRef.project;
            if (!project) return undefined;
            return project.program.getSourceFile(this.path);
        };
    }
    // NodeHandle.fileName — module symbols' valueDeclaration can be a
    // SourceFile handle; transpilers (roblox-ts createImportExpression) read
    // `.fileName` off it to map import paths. Only SourceFile-kind handles
    // expose it, matching stock (other nodes have no fileName).
    if (!Object.getOwnPropertyDescriptor(proto, "fileName")) {
        Object.defineProperty(proto, "fileName", {
            configurable: true,
            get() {
                if (this.kind !== SyntaxKind.SourceFile || !this.path) return undefined;
                return toHostFileName(String(this.path));
            },
        });
    }
    // NodeHandle.parent — rule code reads `.parent` on declarations. Resolve
    // the handle to a full tsgo Node, then read its parent.
    if (!Object.getOwnPropertyDescriptor(proto, "parent")) {
        Object.defineProperty(proto, "parent", {
            configurable: true,
            get() { return resolveSelf(this)?.parent; },
        });
    }
    // Position methods — a bare NodeHandle only carries {index, kind, path}.
    // When a full symbol's `declarations` (NodeHandles) are materialised to
    // ESTree (compat-eslint's lazy-estree `range(tn)` calls tn.getStart()/
    // getEnd()/getFullStart()), the handle would throw `getStart is not a
    // function`. The prefetch path uses light symbols (no declarations) and
    // never hits this, but the on-demand / lib-file fallback resolves full
    // symbols whose declaration handles DO get materialised. Delegate every
    // position accessor to the resolved RemoteNode so declaration → ESTree
    // conversion produces correct ranges instead of crashing.
    for (const m of ["getStart", "getEnd", "getFullStart", "getWidth", "getText", "getLeadingTriviaWidth", "getFullWidth"]) {
        if (typeof proto[m] !== "function") {
            proto[m] = function (...args: any[]) {
                const n = resolveSelf(this);
                return n && typeof n[m] === "function" ? n[m](...args) : undefined;
            };
        }
    }
    for (const p of ["pos", "end"]) {
        if (!Object.getOwnPropertyDescriptor(proto, p)) {
            Object.defineProperty(proto, p, {
                configurable: true,
                get() { return resolveSelf(this)?.[p]; },
            });
        }
    }
    // Structural-field delegation — a bare NodeHandle only carries
    // {index, kind, path}. Rules read declaration fields off symbol
    // declarations/valueDeclaration directly (e.g. no-base-to-string's
    // isSymbolToPrimitiveMethod reads `node.name`, then `.expression`,
    // `.text`; await-thenable reads `param.valueDeclaration.dotDotDotToken`).
    // Without these, the field is `undefined` and the rule crashes
    // (`Cannot read properties of undefined (reading 'kind')`). Delegate every
    // named child accessor (and a few scalar fields) to the resolved
    // RemoteNode, which exposes them with already-remapped child kinds.
    const STRUCTURAL_FIELDS = [
        "argument", "argumentExpression", "arguments", "assertsModifier", "asteriskToken",
        "attributes", "awaitModifier", "block", "body", "caseBlock", "catchClause", "checkType",
        "children", "className", "clauses", "closingElement", "closingFragment", "colonToken",
        "comment", "condition", "constraint", "declarationList", "declarations", "defaultType",
        "dotDotDotToken", "elements", "elementType", "elseStatement", "endOfFileToken",
        "equalsGreaterThanToken", "equalsToken", "exclamationToken", "exportClause", "expression",
        "exprName", "extendsType", "falseType", "finallyBlock", "head", "heritageClauses",
        "importClause", "incrementor", "indexType", "initializer", "jsdocPropertyTags", "label",
        "left", "literal", "members", "modifiers", "moduleReference", "moduleSpecifier", "name",
        "namedBindings", "nameExpression", "namespace", "nameType", "objectAssignmentInitializer",
        "objectType", "openingElement", "openingFragment", "operand", "operatorToken",
        "parameterName", "parameters", "postfixToken", "properties", "propertyName", "qualifier",
        "questionDotToken", "questionToken", "readonlyToken", "right", "statement", "statements",
        "tag", "tagName", "tags", "template", "templateSpans", "thenStatement", "thisArg",
        "trueType", "tryBlock", "tupleNameSource", "type", "typeArguments", "typeExpression",
        "typeName", "typeParameter", "typeParameters", "types", "value", "variableDeclaration",
        "whenFalse", "whenTrue",
        // Scalar fields rules read directly off declaration nodes.
        "text", "flags", "modifierFlags", "operator", "keywordToken", "isExportEquals",
    ];
    for (const f of STRUCTURAL_FIELDS) {
        if (!Object.getOwnPropertyDescriptor(proto, f)) {
            Object.defineProperty(proto, f, {
                configurable: true,
                get() { return resolveSelf(this)?.[f]; },
            });
        }
    }
    // getChildren / forEachChild — some rules walk declaration subtrees.
    for (const m of ["getChildren", "forEachChild", "getChildCount", "getFirstToken", "getLastToken"]) {
        if (typeof proto[m] !== "function") {
            proto[m] = function (...args: any[]) {
                const n = resolveSelf(this);
                return n && typeof n[m] === "function" ? n[m](...args) : undefined;
            };
        }
    }
    // Remap NodeHandle.kind from raw tsgo SyntaxKind to fork SyntaxKind. The
    // kind is a constructor-set own property (a prototype getter would be
    // shadowed), so the native-preview NodeHandle constructor applies a remap
    // hook we install here. RemoteNode.kind is remapped via patchRemoteNodeKinds;
    // this keeps NodeHandle.kind consistent so `ts.isXxx(handle)` type-guards
    // (which compare against fork kind values) fire correctly.
    if (!_kindRemap) _kindRemap = buildKindRemap();
    if (typeof s.setNodeHandleKindRemap === "function") {
        s.setNodeHandleKindRemap(remapKind);
    }
}

/* @internal */
export function createTsgoChecker(program: any): any {
    const options = program.getCompilerOptions();
    let configFilePath = options.configFilePath as string | undefined;
    if (!configFilePath) {
        throw new Error("tsgoChecker: program has no configFilePath — tsgo NAPI backend requires a tsconfig path");
    }
    configFilePath = resolveTsconfigPath(configFilePath);
    options.configFilePath = configFilePath;

    let koffi = _koffi;
    let sync = _sync;
    let bridgeFns = _bridgeFns;
    let project: any;

    // ── NAPI bridge client ───────────────────────────────────────────

    function toCStr(s: string): Buffer {
        return Buffer.from(s + "\0", "utf8");
    }

    function parseEnvelope(str: string | null): any {
        if (str == null) throw new Error("tsgoChecker: bridge returned null");
        const env = JSON.parse(str);
        if (!env.ok) throw new Error(env.error || "tsgoChecker: unknown bridge error");
        return env.data ?? null;
    }

    class BridgeClient {
        private handle: number;
        private handleBigInt: bigint;
        private methodCStr = new Map<string, Buffer>();
        private scratch = Buffer.alloc(256);

        constructor(cwd: string) {
            this.handle = Number(parseEnvelope(bridgeFns.BridgeNewSession(toCStr(cwd))));
            this.handleBigInt = BigInt(this.handle);
        }

        private toCStrScratch(s: string): Buffer {
            const need = Buffer.byteLength(s, "utf8") + 1;
            if (need > this.scratch.length) {
                this.scratch = Buffer.alloc(need * 2);
            }
            const written = this.scratch.write(s, 0, "utf8");
            this.scratch[written] = 0;
            return this.scratch.subarray(0, need);
        }

        apiRequest(method: string, params: any): any {
            const t0 = process.env.TSGO_PROFILE === "1" ? Date.now() : 0;
            const paramsJson = params == null ? null : JSON.stringify(params);
            let mc = this.methodCStr.get(method);
            if (!mc) { mc = toCStr(method); this.methodCStr.set(method, mc); }
            const str = bridgeFns.BridgeCall(
                this.handleBigInt, mc,
                paramsJson == null ? null : this.toCStrScratch(paramsJson),
            );
            const result = parseEnvelope(str);
            if (process.env.TSGO_PROFILE === "1") _profRpc(method, Date.now() - t0);
            return result;
        }

        apiRequestBinary(method: string, params: any): Uint8Array | undefined {
            const t0 = process.env.TSGO_PROFILE === "1" ? Date.now() : 0;
            const paramsJson = params == null ? null : JSON.stringify(params);
            let mc = this.methodCStr.get(method);
            if (!mc) { mc = toCStr(method); this.methodCStr.set(method, mc); }
            const res = bridgeFns.BridgeCallBinary(
                this.handleBigInt, mc,
                paramsJson == null ? null : this.toCStrScratch(paramsJson),
            );
            if (process.env.TSGO_PROFILE === "1") _profRpc(method, Date.now() - t0);
            const len = Number(res.len);
            if (len <= 0 || res.data == null) return undefined;
            // Decode straight into a Uint8Array (single copy out of the reused C
            // buffer). The default disposition materialises a len-element JS
            // Array of numbers and then needs a second Buffer.from copy — the
            // JS-Array boxing dominates for large AST blobs (full source text +
            // node table). "Typed" skips it (~3-4x faster decode on dify/web:
            // getSourceFile copy ~200ms -> ~55ms).
            return koffi.decode(res.data, koffi.array("uint8_t", len, "Typed")) as Uint8Array;
        }

        close(): void {
            try { bridgeFns.BridgeDisposeSession(BigInt(this.handle)); } catch { /* best-effort */ }
        }
    }

    // ── Mini source-file cache (nested-map port from napi-client.js) ──
    class MiniSourceFileCache {
        private bySnap = new Map<any, Map<any, Map<string, any>>>();
        private paths = new Set<string>();

        getRetained(p: string, snapshotId: any, projectId: any): any {
            const byProj = this.bySnap.get(snapshotId);
            if (!byProj) return undefined;
            const byPath = byProj.get(projectId);
            if (!byPath) return undefined;
            return byPath.get(p);
        }
        set(p: string, file: any, _key: any, _hash: any, snapshotId: any, projectId: any): any {
            let byProj = this.bySnap.get(snapshotId);
            if (!byProj) { byProj = new Map(); this.bySnap.set(snapshotId, byProj); }
            let byPath = byProj.get(projectId);
            if (!byPath) { byPath = new Map(); byProj.set(projectId, byPath); }
            if (!byPath.has(p)) { byPath.set(p, file); this.paths.add(p); }
            return byPath.get(p);
        }
        retainForSnapshot() {}
        releaseSnapshot() {}
        clear() { this.bySnap.clear(); this.paths.clear(); }
        has(p: string) { return this.paths.has(p); }
    }

    function ensureProject(): any {
        if (project) return project;

        // Return cached project for this tsconfig if already created.
        const cached = _projectCache.get(configFilePath!);
        if (cached) {
            project = cached;
            koffi = _koffi; sync = _sync; bridgeFns = _bridgeFns;
            _currentProjectRef.project = project;
            patchSymbolProto(sync);
            patchSignatureProto(sync);
            installNodeHandleHooks(sync);
            return project;
        }

        loadBridgeDeps();
        koffi = _koffi; sync = _sync; bridgeFns = _bridgeFns;
        if (process.env.TSGO_PROFILE === "1") _tsgoLoadStart = Date.now();

        // Create the shared bridge session + API once per process.
        if (!_client) {
            const cwd = process.cwd();
            _client = new BridgeClient(cwd);
            const init = _client.apiRequest("initialize", null) || {};
            if (!_tnbDebugAnnounced) {
                _tnbDebugAnnounced = true;
                const tty = !!(process.stderr as any).isTTY;
                const c = tty ? "\u001b[32m" : ""; // green foreground, no background
                const off = tty ? "\u001b[0m" : "";
                const text = "\u2705  TNB ACTIVE \u2014 \`typescript\` is the tsgo-backed fork";
                const inner = 57; // 2 left pad + 53 text cols (✅ = 2) + 2 right pad
                const top = "\u250c" + "\u2500".repeat(inner) + "\u2510";
                const bottom = "\u2514" + "\u2500".repeat(inner) + "\u2518";
                process.stderr.write(
                    `\n${c}${top}${off}\n`
                    + `${c}\u2502${off}  ${text}  ${c}\u2502${off}\n`
                    + `${c}${bottom}${off}\n\n`,
                );
            }
            const useCaseSensitive = !!init.useCaseSensitiveFileNames;
            _tsgoUseCaseSensitive = useCaseSensitive;
            const toPath = (f: string) => useCaseSensitive ? f : f.toLowerCase();
            _sourceFileCache = new MiniSourceFileCache();

            _api = {
                updateSnapshot(params: any) {
                    // Go's file-URI parser requires forward slashes; Windows
                    // host paths arrive backslashed. Normalize every wire path.
                    const toWirePath = (f: any) => (typeof f === "string" ? f.replace(/\\/g, "/") : f);
                    const { openProject, openProjects, openFiles, openFilesWithContent, ...rest } = params || {};
                    const merged = openProject != null ? [openProject, ...(openProjects || [])] : openProjects;
                    const wireParams = {
                        ...rest,
                        ...(merged != null ? { openProjects: merged.map(toWirePath) } : {}),
                        ...(openFiles ? { openFiles: openFiles.map(toWirePath) } : {}),
                        ...(openFilesWithContent
                            ? { openFilesWithContent: openFilesWithContent.map((e: any) => ({ ...e, fileName: toWirePath(e.fileName) })) }
                            : {}),
                    };
                    const data = _client.apiRequest("updateSnapshot", wireParams);
                    const onDispose = () => {};
                    return new sync.Snapshot(data, _client, _sourceFileCache, toPath, onDispose);
                },
                close() {
                    try { _client.close(); } catch {}
                    _sourceFileCache.clear();
                },
            };
        }

        // Collect host file content to feed as tsgo overlays — makes the fork
        // host the single source of truth (avoids tsgo double disk read, and
        // enables Volar virtual TS content injection for .vue/.mdx). Only user
        // files are overlaid; lib/node_modules files are read from disk by tsgo
        // (unchanged content, avoids serializing megabytes of lib.d.ts).
        // _pendingOverlays is pre-collected from the host by createTsgoProgram
        // (only files missing on disk — typically Volar virtual documents).
        const openFilesWithContent: any[] = [];
        if (_pendingOverlays) {
            openFilesWithContent.push(..._pendingOverlays);
            _pendingOverlays = undefined;
        }

        const extraFileExtensions = _pendingExtraFileExtensions;
        _pendingExtraFileExtensions = undefined;
        if (extraFileExtensions) _lastExtraFileExtensions = extraFileExtensions;

        const syncHost = hostForOverlaySync() ?? _overlayHostCtx?.host;
        const openFiles = syncHost ? collectTsgoOpenFileNames(syncHost) : [];
        const snapshot: any = _api.updateSnapshot({
            openProject: configFilePath!,
            ...(openFiles.length > 0 ? { openFiles } : {}),
            ...(openFilesWithContent.length > 0 ? { openFilesWithContent } : {}),
            ...(extraFileExtensions ? { extraFileExtensions } : {}),
        });
        // Record what this snapshot already holds so later per-file
        // pushHostOverlayToTsgo calls can no-op instead of rotating the
        // snapshot (rotation breaks Symbol/Type object identity).
        _tsgoOpenedFiles.clear();
        for (const f of openFiles) _tsgoOpenedFiles.add(f);
        for (const f of openFilesWithContent) {
            _tsgoOpenedFiles.add(f.fileName);
            _syncedOverlayContentByFile.set(f.fileName, f.content);
        }
        _pendingReferencedProjects = undefined;
        project = snapshot.getProject(configFilePath!);
        if (!project) {
            throw new Error(`tsgoChecker: project not found for ${configFilePath}`);
        }
        _projectCache.set(configFilePath!, project);
        _currentProjectRef.project = project;
        patchSymbolProto(sync);
        patchSignatureProto(sync);
        installNodeHandleHooks(sync);
        // Patch kind remapping using a sample source file from the tsgo project.
        const fileNames = project.program.getSourceFileNames?.() ?? [];
        if (fileNames.length > 0) {
            const sampleSf = project.program.getSourceFile(fileNames[0]);
            if (sampleSf) patchRemoteNodeKinds(sampleSf);
        }
        // tsgo supplies the AST via the getSourceFile wrapper (dense nodes carry
        // parent pointers from the blob), so no real-TS parent wiring is needed.
        installTsgoBackedSourceFileLoader(() => project);
        if (process.env.TSGO_PROFILE === "1") {
            _stats.projectLoadMs += Date.now() - _tsgoLoadStart;
            _stats.projectsLoaded++;
        }
        return project;
    }

    // ── Position → tsgo Node finder (cached per file) ────────────────
    const tsgoSfCache = new Map<string, any>();
    const nodeAtPosCache = new Map<string, Map<string, any>>();
    // Symbol cache keyed by (fileName, end-offset) — the fast path for
    // getSymbolAtLocation, which resolves the vast majority of the ~30k
    // scope-manager identifier queries without touching the node index.
    const symByPos = new Map<string, Map<number, any>>();
    const symPrefetched = new Set<string>();
    /** Per-file cache misses before batch prefetch — sparse files stay on direct RPC. */
    const symMissCountByFile = new Map<string, number>();
    const symPrefetchMissThreshold = (() => {
        const n = Number(process.env.TSGO_SYM_PREFETCH_THRESHOLD ?? "32");
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 32;
    })();
    const symCacheFileName = (fileName: string): string => {
        const h = _overlayHostCtx?.host ?? _languageServiceHost;
        return resolveHostFileName(fileName, h);
    };
    const getSymFileCache = (fileName: string, create = false): Map<number, any> | undefined => {
        const key = symCacheFileName(fileName);
        let fc = symByPos.get(key);
        if (!fc && create) {
            fc = new Map();
            symByPos.set(key, fc);
        }
        return fc;
    };
    const probeSymCache = (fileName: string, start: number, end: number): { found: boolean; sym: any } => {
        const fc = getSymFileCache(fileName);
        if (!fc) return { found: false, sym: undefined };
        if (fc.has(start)) return { found: true, sym: fc.get(start) };
        if (fc.has(end)) return { found: true, sym: fc.get(end) };
        if (end > start && fc.has(end - 1)) return { found: true, sym: fc.get(end - 1) };
        return { found: false, sym: undefined };
    };
    const isIdentifierLikeNode = (node: any): boolean => {
        const k = node.kind;
        return k === SyntaxKind.Identifier || k === SyntaxKind.PrivateIdentifier;
    };
    const isModuleSpecifierStringLiteral = (node: any): boolean => {
        if (node?.kind !== SyntaxKind.StringLiteral) return false;
        const p = node.parent;
        if (!p) return false;
        switch (p.kind) {
            case SyntaxKind.ImportDeclaration:
            case SyntaxKind.ExportDeclaration:
                return p.moduleSpecifier === node;
            case SyntaxKind.ExternalModuleReference:
                return p.expression === node;
            default:
                return false;
        }
    };
    const isPrefetchCoveredNode = (node: any): boolean =>
        isIdentifierLikeNode(node) || isModuleSpecifierStringLiteral(node);
    const storeSymCache = (fileName: string, start: number, end: number, sym: any): void => {
        const fc = getSymFileCache(fileName, true)!;
        fc.set(start, sym);
        if (end !== start) fc.set(end, sym);
        if (end > start) fc.set(end - 1, sym);
    };
    // refineNavSymbol memo: the same symbol is refined once even when queried
    // from many reference sites (e.g. 100 refs to `foo`). Keyed by symbol
    // object identity (tsgo symbols are id-keyed singletons via objectRegistry;
    // host-bound symbols are real TS symbol objects). Cleared on snapshot
    // refresh alongside symByPos.
    const refinedSymBySym = new WeakMap<any, any>();
    // Files where prefetchResolvedReferences ran — skip expensive node-tree
    // fallback on cache miss; prefetch + getSymbolAtPosition is enough.
    const symPrefetchPopulated = new Set<string>();
    // Wide-node getSymbolAtLocation results, keyed `${getStart}:${end}:${kind}`
    // per file — kept OUT of symByPos so wide spans can never collide with a
    // narrow token sharing a start/end position.
    const wideSymCache = new Map<string, Map<string, any>>();
    // Per-file index: start position → all tsgo nodes that start there.
    // Built once per file via a single AST walk, after which every
    // findTsgoNodeAtPosition call is an O(1) map lookup + a tiny kind/end
    // filter. This replaces the old per-query full AST walk that dominated
    // wall time (~8s → ~2s) — the hot path issues thousands of
    // getTypeAtLocation / getSymbolAtLocation queries per file.
    const nodeIndexCache = new Map<string, Map<number, any[]>>();

    function resolveTsgoModuleSymbol(moduleSymbol: any, hostFileName: string): any {
        pushHostOverlayToTsgo(hostFileName);
        const tsgoChecker = project.checker;
        const tsgoFile = toTsgoFileName(hostFileName);
        if (typeof tsgoChecker.getSymbolAtPosition === "function") {
            try {
                const sym = tsgoChecker.getSymbolAtPosition(tsgoFile, 0);
                if (sym) return sym;
            } catch { /* host-bound module */ }
        }
        return moduleSymbol;
    }

    function resolveHostModuleNamedExports(hostFileName: string): any[] {
        const host = hostForOverlaySync() ?? _overlayHostCtx?.host;
        const options = _overlayHostCtx?.options;
        if (!host || !options || !isOverlayCandidatePath(hostFileName)) return [];
        pushHostOverlayToTsgo(hostFileName);
        const snapSf = sourceFileFromHostSnapshot(host, hostFileName, hostFileName, options.target ?? 99);
        if (!snapSf) return [];
        ensureHostSourceFileBound(snapSf, options);
        return collectNamedExportsFromModuleSymbol(snapSf.symbol);
    }

    function resolveModuleSymbolForExports(moduleSymbol: any): any {
        if (moduleSymbol?.exports) return moduleSymbol;
        // Only FILE module symbols resolve through their source file; a
        // namespace symbol declared in that file must keep its own identity
        // (its exports are the namespace members, not the file's).
        if (!moduleSymbol?.declarations?.some?.((d: any) => d.kind === SyntaxKind.SourceFile)) return moduleSymbol;
        const hostFileName = moduleSymbolSourceFileName(moduleSymbol);
        return hostFileName ? resolveTsgoModuleSymbol(moduleSymbol, hostFileName) : moduleSymbol;
    }

    function forEachNamedExport(tsgoChecker: any, moduleSymbol: any, cb: (symbol: any, key: string) => void): void {
        let fromExports = collectNamedExportsFromModuleSymbol(moduleSymbol);
        if (!fromExports.length) {
            const hostFileName = moduleSymbolSourceFileName(moduleSymbol);
            if (hostFileName) fromExports = resolveHostModuleNamedExports(hostFileName);
        }
        if (fromExports.length) {
            for (const exported of fromExports) {
                const key = exportMemberKey(exported);
                if (key) cb(exported, key);
            }
            return;
        }
        if (typeof moduleSymbol?.id !== "number" || moduleSymbol.id === 0) return;
        if (typeof tsgoChecker.getExportsOfModule !== "function") return;
        for (const sym of tsgoChecker.getExportsOfModule(moduleSymbol) ?? []) {
            const key = exportMemberKey(sym);
            if (key) cb(sym, key);
        }
    }

    function forEachExportEqualsProperties(tsgoChecker: any, moduleSymbol: any, cb: (symbol: any, key: string) => void): void {
        let exportEquals = moduleSymbol;
        try {
            exportEquals = tsgoChecker.resolveExternalModuleSymbol?.(moduleSymbol) ?? moduleSymbol;
        } catch { return; }
        if (exportEquals === moduleSymbol) return;
        let exportEqualsType: any;
        try { exportEqualsType = tsgoChecker.getTypeOfSymbol?.(exportEquals); } catch { return; }
        if (!exportEqualsType) return;
        for (const sym of tsgoChecker.getPropertiesOfType?.(exportEqualsType) ?? []) {
            const key = exportMemberKey(sym);
            if (key) cb(sym, key);
        }
    }

    function forEachExportAndPropertyOfModuleWorker(moduleSymbol: any, cb: (symbol: any, key: string) => void): void {
        ensureProject();
        const mod = resolveModuleSymbolForExports(moduleSymbol);
        const tsgoChecker = project.checker;
        forEachNamedExport(tsgoChecker, mod, cb);
        forEachExportEqualsProperties(tsgoChecker, mod, cb);
    }

    /** Push all open host files that need overlay into tsgo (single updateSnapshot). */
    function pushHostOverlayToTsgo(requestedFileName?: string): void {
        if (_checkerQueryDepth > 0) return;
        ensureProject();
        const ctx = _overlayHostCtx;
        if (!ctx || !_api) return;
        const syncHost = hostForOverlaySync();
        if (!syncHost) return;

        let openFiles: string[];
        const collectCached = _collectedOpenFilesCache;
        if (
            collectCached
            && collectCached.host === syncHost
            && (!requestedFileName || collectCached.set.has(resolveHostFileName(requestedFileName, syncHost)))
        ) {
            openFiles = collectCached.names;
        } else {
            openFiles = collectTsgoOpenFileNames(syncHost, requestedFileName ? [requestedFileName] : undefined);
            _collectedOpenFilesCache = { host: syncHost, names: openFiles, set: new Set(openFiles) };
        }
        const openFilesWithContent: { fileName: string; content: string; scriptKind: number }[] = [];
        for (const hostFileName of openFiles) {
            if (!isOverlayCandidatePath(hostFileName)) continue;
            const content = getHostScriptContent(syncHost, hostFileName, ctx.options);
            if (!content?.text) continue;
            // Cheap in-memory guards first: an unchanged snapshot (already
            // synced as an overlay, or verified clean against disk) must not
            // pay the shouldSendHostOverlay stat+read on every sync.
            if (_syncedOverlayContentByFile.get(hostFileName) === content.text) continue;
            if (_overlayCleanTextByFile.get(hostFileName) === content.text) continue;
            const hostOnly = !fileExistsOnDisk(hostFileName);
            const inTsgo = !!project?.program?.getSourceFile?.(toTsgoFileName(hostFileName));
            if (!hostOnly && inTsgo && !shouldSendHostOverlay(hostFileName, content.text)) {
                _overlayCleanTextByFile.set(hostFileName, content.text);
                continue;
            }
            openFilesWithContent.push({ fileName: hostFileName, content: content.text, scriptKind: content.scriptKind });
        }
        if (!openFiles.length && !openFilesWithContent.length) return;
        // No new content and nothing newly opened → the current snapshot
        // already covers this request. Skipping the updateSnapshot keeps the
        // snapshot (and its Symbol/Type object registries) stable, which
        // identity-based consumers (roblox-ts macro symbols) rely on.
        if (openFilesWithContent.length === 0 && openFiles.every(f => _tsgoOpenedFiles.has(f))) return;

        const snapshot: any = _api.updateSnapshot({
            openProject: ctx.configFilePath,
            ...(openFiles.length > 0 ? { openFiles } : {}),
            openFilesWithContent,
            ...(_lastExtraFileExtensions ? { extraFileExtensions: _lastExtraFileExtensions } : {}),
        });
        const refreshed = snapshot.getProject(ctx.configFilePath);
        if (!refreshed) return;
        project = refreshed;
        _projectCache.set(ctx.configFilePath, refreshed);
        _currentProjectRef.project = refreshed;
        installTsgoBackedSourceFileLoader(() => project);
        for (const f of openFiles) _tsgoOpenedFiles.add(f);
        for (const f of openFilesWithContent) {
            _tsgoOpenedFiles.add(f.fileName);
            _syncedOverlayContentByFile.set(f.fileName, f.content);
            _overlayCleanTextByFile.delete(f.fileName);
            tsgoSfCache.delete(f.fileName);
            nodeIndexCache.delete(f.fileName);
            nodeAtPosCache.delete(f.fileName);
        }
        // Only invalidate symbol/type caches when host content actually changed.
        // openFiles-only snapshot bumps (disk lint prefetch) must not wipe
        // symByPos between per-file batch prefetches.
        if (openFilesWithContent.length === 0) return;
        if (process.env.TNB_DEBUG === "1") {
            console.error(`[TNB] snapshot rotated with ${openFilesWithContent.length} content change(s) — symbols held across this point lose identity`);
        }
        _collectedOpenFilesCache = undefined;
        _referencedAliasSpansByFile.clear();
        symByPos.clear();
        wideSymCache.clear();
        symPrefetched.clear();
        symPrefetchPopulated.clear();
        symMissCountByFile.clear();
        nodeTypeCache.clear();
        typeOfSymbolCache.clear();
        propertiesCache.clear();
        propertyByNameCache.clear();
        propertyBulkLoaded.clear();
        signaturesByKindCache.clear();
        baseTypesCache.clear();
    }

    function getTsgoSourceFile(fileName: string): any {
        const hostFileName = toHostFileName(fileName);
        if (tsgoSfCache.has(hostFileName)) return tsgoSfCache.get(hostFileName);
        pushHostOverlayToTsgo(hostFileName);
        const proj = _currentProjectRef.project ?? ensureProject();
        let sf = proj.program.getSourceFile(toTsgoFileName(hostFileName));
        if (!sf) {
            // Host module resolution keeps the node_modules SYMLINK path
            // (pnpm: node_modules/@scope/pkg -> .pnpm/...); tsgo stores the
            // realpath. Retry through the filesystem's canonical name.
            try {
                const real = (require("fs") as typeof import("fs")).realpathSync.native(hostFileName);
                if (real && real !== hostFileName) {
                    sf = proj.program.getSourceFile(toTsgoFileName(real));
                }
            } catch { /* nonexistent path — fall through */ }
        }
        if (!sf && process.env.TNB_DEBUG === "1") {
            console.error(`[TNB] getTsgoSourceFile MISS: tried=${toTsgoFileName(hostFileName)}`);
        }
        tsgoSfCache.set(hostFileName, sf);
        return sf;
    }

    // Stock returns type properties in DECLARATION order (binder symbol-table
    // insertion); tsgo returns them sorted by name. Consumers derive
    // position-sensitive output from enumeration order (flamework assigns
    // network wire ids by array index), so re-sort by declaration position.
    // Symbols without declarations keep their relative order at the end.
    function orderPropsLikeStock(props: readonly any[]): any[] {
        // Refine every property symbol (in-place declaration remap to host
        // AST) — transformers compare `prop.declarations[0]` against
        // declarations reached via getSymbolAtLocation, which are refined.
        for (const p of props) {
            try { refineNavSymbol(p); } catch { /* best-effort */ }
        }
        const keyed = Array.from(props, (p: any, i: number) => {
            const decl = p?.valueDeclaration ?? p?.declarations?.[0];
            const file = decl?.getSourceFile?.()?.fileName ?? "";
            const pos = typeof decl?.pos === "number" ? decl.pos : -1;
            return { p, i, hasDecl: !!decl, file, pos };
        });
        keyed.sort((a, b) => {
            if (a.hasDecl !== b.hasDecl) return a.hasDecl ? -1 : 1;
            if (!a.hasDecl) return a.i - b.i;
            if (a.file !== b.file) return a.file < b.file ? -1 : 1;
            if (a.pos !== b.pos) return a.pos - b.pos;
            return a.i - b.i;
        });
        return keyed.map(k => k.p);
    }

    function buildNodeIndex(fileName: string, sf: any): Map<number, any[]> | undefined {
        const cached = nodeIndexCache.get(fileName);
        if (cached) return cached;
        const t0 = process.env.TSGO_PROFILE === "1" ? Date.now() : 0;
        const idx = new Map<number, any[]>();
        nodeIndexCache.set(fileName, idx);
        const visit = (node: any) => {
            const start = typeof node.getStart === "function" ? node.getStart() : node.pos;
            if (typeof start === "number") {
                let bucket = idx.get(start);
                if (!bucket) { bucket = []; idx.set(start, bucket); }
                bucket.push(node);
            }
            if (typeof node.forEachChild === "function") {
                node.forEachChild(visit);
            }
        };
        if (sf) visit(sf);
        if (process.env.TSGO_PROFILE === "1") { _stats.indexBuildMs += Date.now() - t0; _stats.indexBuildCount++; }
        return idx;
    }

    function ensureFileSymbolsPrefetched(fileName: string): void {
        const cacheName = symCacheFileName(fileName);
        if (symPrefetched.has(cacheName)) return;
        pushHostOverlayToTsgo(fileName);
        const activeProject = _currentProjectRef.project ?? project;
        const t0 = process.env.TSGO_PROFILE === "1" ? Date.now() : 0;
        let byPos: Map<number, any>;
        if (typeof activeProject?.checker?.prefetchResolvedReferences === "function") {
            byPos = activeProject.checker.prefetchResolvedReferences(toTsgoFileName(fileName), "allIdentifiers");
        } else {
            return;
        }
        symPrefetched.add(cacheName);
        const fileCache = getSymFileCache(cacheName, true)!;
        for (const [pos, sym] of byPos) {
            fileCache.set(pos, sym);
        }
        symPrefetchPopulated.add(cacheName);
        if (process.env.TSGO_PROFILE === "1") {
            _stats.symPrefetchFiles++;
            _stats.symPrefetchRefs += byPos.size;
            _stats.symPrefetchMs += Date.now() - t0;
        }
    }

    // ── Emit-resolver backing (import elision + JSX factory entities) ──
    const _referencedAliasSpansByFile = new Map<string, Set<string> | undefined>();
    function getReferencedAliasSpans(fileName: string): Set<string> | undefined {
        const cacheName = symCacheFileName(fileName);
        if (_referencedAliasSpansByFile.has(cacheName)) return _referencedAliasSpansByFile.get(cacheName);
        ensureProject();
        pushHostOverlayToTsgo(fileName);
        const activeProject = _currentProjectRef.project ?? project;
        let spans: Set<string> | undefined;
        if (typeof activeProject?.checker?.getReferencedAliasDeclarations === "function") {
            const entries = activeProject.checker.getReferencedAliasDeclarations(toTsgoFileName(fileName)) ?? [];
            spans = new Set(entries.map((e: any) => `${e.pos}:${e.end}`));
            // Also key by local binding name: transpilers reprint the source
            // between check and emit (transformer pipelines), shifting every
            // position after the first textual change — the name survives.
            for (const e of entries) {
                if (e.name) spans.add(`n:${e.name}`);
            }
        }
        _referencedAliasSpansByFile.set(cacheName, spans);
        return spans;
    }
    const _jsxEntityCache = new Map<string, any>();
    function getParsedJsxEntity(configured: string | undefined, fallback: string): any {
        const text = typeof configured === "string" && configured.length ? configured : fallback;
        if (_jsxEntityCache.has(text)) return _jsxEntityCache.get(text);
        const entity = (ts as any).parseIsolatedEntityName?.(text, options.target ?? 99);
        _jsxEntityCache.set(text, entity);
        return entity;
    }

    function findTsgoNodeAtPosition(fileName: string, pos: number, expectedKind?: number, expectedEnd?: number, strict = false): any {
        const cacheKey = expectedKind != null
            ? `${pos}:${expectedEnd ?? -1}:${expectedKind}${strict ? ":s" : ""}`
            : `${pos}`;
        let fileCache = nodeAtPosCache.get(fileName);
        if (fileCache) {
            const hit = fileCache.get(cacheKey);
            if (hit !== undefined) return hit;
        } else {
            fileCache = new Map();
            nodeAtPosCache.set(fileName, fileCache);
        }

        const sf = getTsgoSourceFile(fileName);
        // Strict mode: only an exact kind+end match qualifies — no kind-only,
        // no deepest-at-position, no source-file fallback. Position-derived
        // approximations answer queries for a DIFFERENT node than the caller
        // asked about (module symbol for a satisfies-expression, trailing
        // token for a wide span), which faithful callers must never see.
        let result: any = strict ? undefined : sf;
        if (sf) {
            const idx = buildNodeIndex(fileName, sf);
            const bucket = idx?.get(pos);
            if (bucket && bucket.length) {
                let bestWithKind: any = undefined;
                let bestWithKindAndEnd: any = undefined;
                for (const node of bucket) {
                    if (expectedKind != null && node.kind === expectedKind) {
                        if (!bestWithKind) bestWithKind = node;
                        if (expectedEnd != null) {
                            const end = typeof node.getEnd === "function" ? node.getEnd() : node.end;
                            if (end === expectedEnd) {
                                bestWithKindAndEnd = node;
                                break;
                            }
                        }
                    }
                }
                // Children are pushed after their parent in pre-order
                // traversal, so the last entry sharing a start position is
                // the innermost (deepest) node — matches the old "deepest
                // containing" fallback semantics.
                result = strict
                    ? bestWithKindAndEnd
                    : bestWithKindAndEnd ?? bestWithKind ?? bucket[bucket.length - 1];
            }
        }
        fileCache.set(cacheKey, result);
        return result;
    }

    // Symbol-taking RPCs need a tsgo registry handle (`symbol.id`). Host binder
    // symbols (from host-parsed + bound SourceFiles) have none — map them to
    // the tsgo symbol via a declaration position.
    const tsgoSymbolByHostSymbol = new Map<any, any>();
    function toTsgoSymbol(symbol: any): any {
        // Remote (tsgo registry) symbols pass through. `symbol.id` presence is
        // NOT a valid discriminator — TS's getSymbolId stamps numeric ids onto
        // host binder symbols too.
        if (!symbol || (_sync?.Symbol && symbol instanceof _sync.Symbol)) return symbol;
        const cached = tsgoSymbolByHostSymbol.get(symbol);
        if (cached !== undefined) return cached;
        let result: any = symbol;
        for (const decl of symbol.declarations ?? []) {
            const sf = decl?.getSourceFile?.();
            if (!sf?.__tnbHostBound) continue;
            const target = decl.name ?? decl;
            if (typeof target.getStart !== "function") continue;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, target.getStart(sf), target.kind, target.getEnd(sf));
            if (!tsgoNode) {
                if (process.env.TNB_DEBUG === "1") {
                    console.error(`[TNB] toTsgoSymbol: no tsgo node for ${symbol.name ?? symbol.escapedName} at ${sf.fileName}:${target.getStart(sf)} kind=${target.kind}`);
                }
                continue;
            }
            try {
                const sym = project.checker.getSymbolAtLocation(tsgoNode);
                if (sym) { result = sym; break; }
                if (process.env.TNB_DEBUG === "1") {
                    console.error(`[TNB] toTsgoSymbol: tsgo node found but no symbol for ${symbol.name ?? symbol.escapedName} (node kind=${tsgoNode.kind})`);
                }
            } catch (e: any) { /* try next declaration */
                if (process.env.TNB_DEBUG === "1") {
                    console.error(`[TNB] toTsgoSymbol: RPC fault for ${symbol.name ?? symbol.escapedName}: ${e?.message}`);
                }
            }
        }
        tsgoSymbolByHostSymbol.set(symbol, result);
        return result;
    }

    // ── Type / Symbol prototype patches ──────────────────────────────
    let typeProtoPatched = false;
    let symbolProtoPatched = false;

    function getTypePrototype(sample: any): any {
        let proto = Object.getPrototypeOf(sample);
        while (proto && Object.getPrototypeOf(proto) !== Object.prototype) {
            proto = Object.getPrototypeOf(proto);
        }
        return proto ?? undefined;
    }

    function installTypePredicates(target: any, s: any): void {
        if (typeof target.isUnionOrIntersection === "function") return;
        // NOTE: don't check `target.flags` here — when target is a prototype,
        // `flags` lives on instances, not the proto. The `has` closures read
        // `this.flags` at call time, so they work on instances regardless.
        const TF = s.TypeFlags;
        const has = (flag: number) => function (this: any) { return (this.flags & flag) !== 0; };
        if (!target.isStringLiteral) target.isStringLiteral = has(TF.StringLiteral);
        if (!target.isNumberLiteral) target.isNumberLiteral = has(TF.NumberLiteral);
        if (!target.isBooleanLiteral) target.isBooleanLiteral = has(TF.BooleanLiteral);
        if (!target.isBigIntLiteral) target.isBigIntLiteral = has(TF.BigIntLiteral);
        if (!target.isEnumLiteral) target.isEnumLiteral = has(TF.EnumLiteral);
        if (!target.isLiteral) target.isLiteral = has(TF.StringLiteral | TF.NumberLiteral | TF.BigIntLiteral | TF.BooleanLiteral);
        if (!target.isUnion) target.isUnion = has(TF.Union);
        if (!target.isIntersection) target.isIntersection = has(TF.Intersection);
        if (!target.isUnionOrIntersection) target.isUnionOrIntersection = has(TF.UnionOrIntersection ?? (TF.Union | TF.Intersection));
        if (!target.isTypeParameter) target.isTypeParameter = has(TF.TypeParameter);
        if (!target.isClassOrInterface) target.isClassOrInterface = () => false;
        if (!target.isClass) target.isClass = () => false;
        if (!target.isIndexType) target.isIndexType = has(TF.Index);
        if (!target.getFlags) target.getFlags = function () { return this.flags; };
        if (!target.isNullableType) target.isNullableType = has((TF.Null ?? 0) | (TF.Undefined ?? 0));
    }

    function patchTypeProto(sample: any, s: any): void {
        const proto = getTypePrototype(sample);
        if (!proto || typeProtoPatched) {
            installTypePredicates(sample, s);
            return;
        }
        typeProtoPatched = true;
        installTypePredicates(proto, s);
        if (!Object.getOwnPropertyDescriptor(proto, "types")) {
            Object.defineProperty(proto, "types", {
                configurable: true,
                get() {
                    if (this.__tsgoTypesMemo !== undefined) return this.__tsgoTypesMemo;
                    const types = this.getTypes ? this.getTypes() : undefined;
                    if (types) for (const c of types) fixupType(c);
                    this.__tsgoTypesMemo = types;
                    return types;
                },
            });
        }
        // Stock ts.Type carries an internal `checker` backref; transpiler
        // tooling (rbxts-transformer-flamework guard generation) calls
        // `type.checker.getTrueType()` etc. directly. Route to the adapter
        // proxy so those calls hit the same tsgo-backed surface.
        if (!Object.getOwnPropertyDescriptor(proto, "checker")) {
            Object.defineProperty(proto, "checker", {
                configurable: true,
                get() { return checkerProxyRef; },
            });
        }
        // Stock TS exposes `typeArguments` on TypeReference objects as a
        // prototype getter delegating to checker.getTypeArguments (compat
        // shim). Consumers (rbxts-transformer-flamework tuple intrinsics)
        // read it as a data property — mirror the getter here. Non-reference
        // types (no `target`) return undefined, matching stock's absence.
        if (!Object.getOwnPropertyDescriptor(proto, "typeArguments")) {
            Object.defineProperty(proto, "typeArguments", {
                configurable: true,
                get() {
                    if (this.target === undefined || this.target === null) return undefined;
                    if (this.__tsgoTypeArgsMemo !== undefined) return this.__tsgoTypeArgsMemo;
                    const proj = _currentProjectRef.project;
                    if (!proj) return undefined;
                    let args: any;
                    try { args = proj.checker.getTypeArguments(this); } catch { return undefined; }
                    if (args) fixupType(args);
                    this.__tsgoTypeArgsMemo = args;
                    return args;
                },
            });
        }
        // `resolvedTypeArguments` is the TS-internal already-resolved variant
        // consumers read directly (flamework buildGuardFromType tuple branch:
        // `type.resolvedTypeArguments ?? []` — empty means t.strictArray()
        // guards with no element validators).
        if (!Object.getOwnPropertyDescriptor(proto, "resolvedTypeArguments")) {
            Object.defineProperty(proto, "resolvedTypeArguments", {
                configurable: true,
                get() { return this.typeArguments; },
            });
        }
        // getCallSignatures / getConstructSignatures — delegate to checker's
        // getSignaturesOfType. Short-circuit for primitive/literal types.
        const TF = s.TypeFlags;
        const SK = s.SignatureKind;
        const noSigMask = (TF.Never ?? 0) | (TF.Undefined ?? 0) | (TF.Null ?? 0) | (TF.Void ?? 0) |
            (TF.StringLiteral ?? 0) | (TF.NumberLiteral ?? 0) | (TF.BooleanLiteral ?? 0) |
            (TF.BigIntLiteral ?? 0) | (TF.EnumLiteral ?? 0) | (TF.TemplateLiteral ?? 0) |
            (TF.StringMapping ?? 0) | (TF.UniqueESSymbol ?? 0) | (TF.Enum ?? 0);
        if (!proto.getCallSignatures) {
            proto.getCallSignatures = function () {
                if (typeof this.flags === "number" && (this.flags & noSigMask) !== 0) return [];
                const sigs = getSignaturesCached(this, SK.Call);
                return sigs ?? [];
            };
        }
        if (!proto.getConstructSignatures) {
            proto.getConstructSignatures = function () {
                if (typeof this.flags === "number" && (this.flags & noSigMask) !== 0) return [];
                return getSignaturesCached(this, SK.Construct);
            };
        }
        // getProperties / getProperty / getApparentProperties — delegate to
        // checker.getPropertiesOfType. Rule code reads these directly off
        // Type objects (e.g. no-unnecessary-type-assertion's hasSameProperties).
        if (!proto.getProperties) {
            proto.getProperties = function () {
                const proj = _currentProjectRef.project;
                if (!proj) return [];
                return memoGet(propertiesCache, this, () => orderPropsLikeStock(proj.checker.getPropertiesOfType(this) ?? []));
            };
        }
        if (!proto.getProperty) {
            proto.getProperty = function (name: string) {
                return resolvePropertyOfType(this, name);
            };
        }
        if (!proto.getApparentProperties) {
            proto.getApparentProperties = function () {
                return this.getProperties();
            };
        }
        if (!proto.getBaseTypes) {
            proto.getBaseTypes = function () {
                return getBaseTypesCached(this);
            };
        }
        if (!proto.getNonNullableType) {
            proto.getNonNullableType = function () {
                const proj = _currentProjectRef.project;
                if (!proj) return this;
                const t = proj.checker.getNonNullableType(this);
                if (t) fixupType(t);
                return t ?? this;
            };
        }
        if (!proto.getNonOptionalType) {
            proto.getNonOptionalType = function () {
                const proj = _currentProjectRef.project;
                if (!proj) return this;
                const checker = proj.checker;
                if (typeof checker.getNonOptionalType === "function") {
                    const t = checker.getNonOptionalType(this);
                    if (t) fixupType(t);
                    return t ?? this;
                }
                // Stock getNonOptionalType only strips the checker-internal
                // optional-chain marker; it does NOT remove `| undefined` from
                // ordinary types. The marker never crosses the tsgo wire, so
                // identity is the faithful fallback — the previous
                // getNonNullableType fallback over-stripped undefined and sent
                // consumers down definitely-object paths (roblox-ts emitted
                // table.clone(x) for spreads of possibly-undefined x).
                return this;
            };
        }
        // getConstraint — delegate to checker.getConstraintOfTypeParameter for
        // type parameters; other constrained kinds (conditional, indexed
        // access, index, template literal) resolve through the base
        // constraint like stock getConstraintOfType. Transpilers rely on this
        // to classify e.g. `A extends B ? IterableFunction<X> : IterableFunction<Y>`.
        // Unions/intersections resolve too: stock getBaseConstraintOfType maps
        // `T | undefined` (T a type parameter) to `Constraint | undefined` —
        // roblox-ts isPossiblyType relies on that to avoid worst-case
        // truthiness emit for constrained type parameters.
        const constrainedMask = (TF.Conditional ?? 0) | (TF.IndexedAccess ?? 0) | (TF.Index ?? 0)
            | (TF.TemplateLiteral ?? 0) | (TF.StringMapping ?? 0) | (TF.Substitution ?? 0)
            | (TF.Union ?? 0) | (TF.Intersection ?? 0);
        const constraintMemo = new WeakMap<any, any>();
        // The sync API's own getConstraint only resolves Substitution
        // constraints — wrap it (do NOT feature-detect: it exists but is
        // incomplete for stock Type.getConstraint semantics).
        {
            const origGetConstraint = proto.getConstraint;
            proto.getConstraint = function () {
                const proj = _currentProjectRef.project;
                if (!proj) return origGetConstraint ? origGetConstraint.call(this) : undefined;
                if (typeof this.flags === "number" && (this.flags & TF.TypeParameter) !== 0) {
                    const t = proj.checker.getConstraintOfTypeParameter(this);
                    if (t) fixupType(t);
                    return t;
                }
                if (typeof this.flags === "number" && (this.flags & constrainedMask) !== 0
                    && typeof proj.checker.getBaseConstraintOfType === "function") {
                    if (constraintMemo.has(this)) return constraintMemo.get(this);
                    try {
                        const t = proj.checker.getBaseConstraintOfType(this);
                        if (t && t !== this) {
                            fixupType(t);
                            constraintMemo.set(this, t);
                            return t;
                        }
                        constraintMemo.set(this, undefined);
                    } catch { constraintMemo.set(this, undefined); }
                }
                return origGetConstraint ? origGetConstraint.call(this) : undefined;
            };
        }
        // getNumberIndexType / getStringIndexType — rule code (no-for-in-array's
        // isArrayLike, ts-api-utils' rest-param handling) reads these directly
        // off Type objects. Resolve via the checker's index infos: find the
        // info whose key type matches Number/String and return its value type.
        // Falls back to the apparent type so inherited index signatures resolve.
        const indexTypeOfKind = (self: any, keyFlag: number): any => {
            const proj = _currentProjectRef.project;
            if (!proj || !self) return undefined;
            const pick = (t: any): any => {
                const infos = proj.checker.getIndexInfosOfType(t) ?? [];
                for (const info of infos) {
                    const kt = info?.keyType;
                    if (kt && typeof kt.flags === "number" && (kt.flags & keyFlag) !== 0) {
                        const vt = info.valueType;
                        if (vt) fixupType(vt);
                        return vt;
                    }
                }
                return undefined;
            };
            const direct = pick(self);
            if (direct !== undefined) return direct;
            try {
                const apparent = proj.checker.getApparentType(self);
                if (apparent && apparent !== self) {
                    if (apparent) fixupType(apparent);
                    return pick(apparent);
                }
            } catch { /* best-effort */ }
            return undefined;
        };
        if (!proto.getNumberIndexType) {
            proto.getNumberIndexType = function () { return indexTypeOfKind(this, TF.Number); };
        }
        if (!proto.getStringIndexType) {
            proto.getStringIndexType = function () { return indexTypeOfKind(this, TF.String); };
        }
    }

    // ── Signature prototype patch ────────────────────────────────────
    let signatureProtoPatched = false;
    function patchSignatureProto(s: any): void {
        if (signatureProtoPatched) return;
        const SignatureCtor = s.Signature;
        if (!SignatureCtor?.prototype) return;
        const proto = SignatureCtor.prototype;
        signatureProtoPatched = true;
        // getReturnType — delegate to checker.getReturnTypeOfSignature + fixup.
        if (!proto.getReturnType) {
            proto.getReturnType = function () {
                const proj = _currentProjectRef.project;
                if (!proj) return undefined;
                const t = proj.checker.getReturnTypeOfSignature(this);
                if (t) fixupType(t);
                return t;
            };
        }
        // getDeclaration — tsgo stores it as `this.declaration` (a NodeHandle).
        if (!proto.getDeclaration) {
            proto.getDeclaration = function () { return this.declaration; };
        }
    }

    function patchSymbolProto(s: any): void {
        if (symbolProtoPatched) return;
        const SymbolCtor = s.Symbol;
        if (!SymbolCtor?.prototype) return;
        const proto = SymbolCtor.prototype;
        symbolProtoPatched = true;
        if (!proto.getName) proto.getName = function () { return this.name; };
        if (!proto.getEscapedName) proto.getEscapedName = function () { return this.name; };
        if (!proto.getFlags) proto.getFlags = function () { return this.flags; };
        if (!proto.getDeclarations) proto.getDeclarations = function () { return this.declarations; };
        if (!Object.getOwnPropertyDescriptor(proto, "escapedName")) {
            Object.defineProperty(proto, "escapedName", { configurable: true, get() { return this.name; } });
        }
    }

    // Resolve raw type-ID properties on TypeObject to full TypeObject
    // instances. tsgo stores IDs (numbers) in fields like `aliasTypeArguments`,
    // `target`, `typeParameters`, etc. Rule code reads these directly and
    // expects Type objects, so we eagerly resolve them via the corresponding
    // getter methods (which read the raw IDs before we overwrite them).
    const TYPE_ARRAY_PROPS: [string, string][] = [
        ["aliasTypeArguments", "getAliasTypeArguments"],
        ["typeParameters", "getTypeParameters"],
        ["outerTypeParameters", "getOuterTypeParameters"],
        ["localTypeParameters", "getLocalTypeParameters"],
    ];
    const TYPE_SINGLE_PROPS: [string, string][] = [
        ["target", "getTarget"],
        ["freshType", "getFreshType"],
        ["regularType", "getRegularType"],
        ["objectType", "getObjectType"],
        ["indexType", "getIndexType"],
        ["checkType", "getCheckType"],
        ["extendsType", "getExtendsType"],
        ["baseType", "getBaseType"],
    ];

    function resolveRawTypeProps(obj: any): void {
        for (const [prop, method] of TYPE_ARRAY_PROPS) {
            const raw = obj[prop];
            if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "number") {
                try {
                    const resolved = obj[method]();
                    if (resolved) { fixupType(resolved); obj[prop] = resolved; }
                } catch { /* best-effort */ }
            }
        }
        for (const [prop, method] of TYPE_SINGLE_PROPS) {
            const raw = obj[prop];
            if (typeof raw === "number") {
                try {
                    const resolved = obj[method]();
                    if (resolved) { fixupType(resolved); obj[prop] = resolved; }
                } catch { /* best-effort */ }
            }
        }
    }

    function fixupType(t: any): any {
        if (Array.isArray(t)) { for (const i of t) fixupType(i); return t; }
        if (t && typeof t === "object") {
            const obj = t;
            if (!obj.__tsgoFixupDone) {
                obj.__tsgoFixupDone = true;
                // Remap tsgo ObjectFlags bit layout → fork layout before the
                // value reaches consumers (e.g. no-misused-spread reads
                // `type.objectFlags & ts.ObjectFlags.InstantiationExpressionType`).
                if (typeof obj.objectFlags === "number") {
                    obj.objectFlags = remapObjectFlags(obj.objectFlags);
                }
                if (typeof obj.aliasSymbol === "number" && typeof obj.getAliasSymbol === "function") {
                    try { obj.aliasSymbol = obj.getAliasSymbol(); } catch { obj.aliasSymbol = undefined; }
                }
                if (typeof obj.getSymbol === "function") {
                    try { const sym = obj.getSymbol(); if (sym) obj.symbol = sym; } catch { /* best-effort */ }
                }
                // Remap symbol/aliasSymbol declarations to host AST nodes IN
                // PLACE (identity-preserving). Transformers compare
                // `symA.declarations[0] === symB.declarations[0]` across
                // symbols obtained from different APIs (module exports = host
                // binder symbols, type symbols = tsgo registry symbols) — both
                // sides must converge on the same host declaration objects.
                if (obj.aliasSymbol && typeof obj.aliasSymbol === "object") {
                    try { refineNavSymbol(obj.aliasSymbol); } catch { /* best-effort */ }
                }
                if (obj.symbol && typeof obj.symbol === "object") {
                    try { refineNavSymbol(obj.symbol); } catch { /* best-effort */ }
                }
                resolveRawTypeProps(obj);
                // tsgo may expose `aliasTypeArguments: []` on reference/array
                // types. Rule helpers (no-unnecessary-type-assertion's
                // containsAny) use `type.aliasTypeArguments ??
                // checker.getTypeArguments(type)` — an empty array is
                // truthy for ?? so getTypeArguments is never consulted and
                // `any[]` is misclassified as not containing `any`.
                const aliasArgs = obj.aliasTypeArguments;
                if (Array.isArray(aliasArgs) && aliasArgs.length === 0) {
                    try {
                        const resolved = typeof obj.getAliasTypeArguments === "function"
                            ? obj.getAliasTypeArguments()
                            : undefined;
                        if (Array.isArray(resolved) && resolved.length > 0) {
                            fixupType(resolved);
                            obj.aliasTypeArguments = resolved;
                        }
                        else {
                            delete obj.aliasTypeArguments;
                        }
                    }
                    catch {
                        delete obj.aliasTypeArguments;
                    }
                }
            }
            patchTypeProto(obj, sync);
        }
        return t;
    }

    // ── Caches ───────────────────────────────────────────────────────
    const nodeTypeCache = new Map<any, any>();
    const typeOfSymbolCache = new Map<any, any>();
    const propertiesCache = new Map<any, any>();
    // Per-type name→property map, built lazily from the memoized
    // getPropertiesOfType result. Collapses N getPropertyOfType(name)
    // RPCs into 1 getPropertiesOfType RPC + JS lookup per type.
    const propertyByNameCache = new Map<any, Map<string, any>>();
    // Per-type signature cache keyed by SignatureKind. Unifies the proto
    // (type.getCallSignatures/getConstructSignatures) and adapter
    // (checker.getSignaturesOfType) paths onto one RPC per (type, kind).
    const signaturesByKindCache = new Map<any, Map<number, readonly any[]>>();
    // Per-type base-types cache. Unifies proto (type.getBaseTypes) and adapter
    // (checker.getBaseTypes) onto one RPC per type.
    const baseTypesCache = new Map<any, readonly any[]>();
    // Types for which getPropertiesOfType was used to bulk-fill propertyByNameCache.
    const propertyBulkLoaded = new Set<any>();

    const memoGet = <K, V>(cache: Map<K, V>, key: K, compute: () => V): V => {
        if (cache.has(key)) return cache.get(key)!;
        const v = compute();
        cache.set(key, v);
        return v;
    };

    const resolvePropertyOfType = (type: any, name: string): any => {
        const proj = _currentProjectRef.project;
        if (!proj || !type) return undefined;
        let byName = propertyByNameCache.get(type);
        if (!byName) {
            byName = new Map<string, any>();
            propertyByNameCache.set(type, byName);
        }
        if (byName.has(name)) return byName.get(name);
        // One getPropertiesOfType RPC per type replaces many getPropertyOfType RPCs.
        if (!propertyBulkLoaded.has(type)) {
            propertyBulkLoaded.add(type);
            const props = memoGet(propertiesCache, type, () => orderPropsLikeStock(proj.checker.getPropertiesOfType(type) ?? []));
            for (const p of props) {
                if (p?.name) byName.set(p.name, p);
            }
            if (byName.has(name)) return byName.get(name);
        }
        let direct = proj.checker.getPropertyOfType(type, name);
        if (direct) {
            try { direct = refineNavSymbol(direct); } catch { /* best-effort */ }
        }
        byName.set(name, direct);
        return direct;
    };

    const getSignaturesCached = (type: any, kind: number): readonly any[] => {
        const proj = _currentProjectRef.project;
        if (!proj) return [];
        let byKind = signaturesByKindCache.get(type);
        if (!byKind) { byKind = new Map(); signaturesByKindCache.set(type, byKind); }
        const hit = byKind.get(kind);
        if (hit !== undefined) return hit;
        const r = proj.checker.getSignaturesOfType(type, kind) ?? [];
        byKind.set(kind, r);
        return r;
    };

    const getBaseTypesCached = (type: any): readonly any[] => {
        const proj = _currentProjectRef.project;
        if (!proj) return [];
        return memoGet(baseTypesCache, type, () => proj.checker.getBaseTypes(type) ?? []);
    };

    // ── Node-based type computation (port from tsgo-backend.js) ──────
    // Handles assertion expressions, call expressions, and property access
    // specially — these are the cases where getTypeAtPosition diverges from
    // getTypeAtLocation(tsgoNode).
    function computeGetTypeAtLocation(tsgoNode: any): any {
        const k = tsgoNode.kind;
        // AsExpression / TypeAssertion / Satisfies — return the asserted type
        // from the type annotation, not the inner expression type.
        if ((k === SyntaxKind.AsExpression
            || k === SyntaxKind.TypeAssertionExpression
            || k === SyntaxKind.SatisfiesExpression)
            && tsgoNode.type) {
            const t = project.checker.getTypeFromTypeNode(tsgoNode.type);
            if (t) fixupType(t);
            return t;
        }
        // CallExpression / NewExpression — resolve signature → return type,
        // with fallbacks to getTypeAtLocation + getSignaturesOfType.
        // Dynamic `import(...)` calls resolve to the checker's synthetic
        // any-signature — their real type (Promise<typeof import(...)>) only
        // comes from the plain node query below.
        if ((k === SyntaxKind.CallExpression || k === SyntaxKind.NewExpression)
            && tsgoNode.expression?.kind !== SyntaxKind.ImportKeyword) {
            try {
                const sig = project.checker.getResolvedSignature(tsgoNode);
                if (sig) {
                    const t = project.checker.getReturnTypeOfSignature(sig);
                    if (t) { fixupType(t); return t; }
                }
            } catch { /* fall through */ }
            try {
                const funcType = project.checker.getTypeAtLocation(tsgoNode);
                if (funcType) {
                    fixupType(funcType);
                    const sigs = project.checker.getSignaturesOfType(funcType, sync.SignatureKind.Call);
                    if (sigs && sigs.length > 0) {
                        const t = project.checker.getReturnTypeOfSignature(sigs[0]);
                        if (t) { fixupType(t); return t; }
                    }
                }
            } catch { /* fall through */ }
        }
        // PropertyAccessExpression — use getTypeAtPosition at the node END (not
        // start) for correct resolution; the end lands on the property name so
        // the type resolves correctly.
        //
        // ElementAccessExpression deliberately falls through to the default
        // node-based getTypeAtLocation below: its END position is the `]`
        // token, where getTypeAtPosition resolves to `any` (or the wrong
        // contextual type), dropping the `| undefined` that
        // noUncheckedIndexedAccess adds to indexed element access. That made
        // `arr[i]!` non-null assertions look unnecessary (false-positive
        // no-unnecessary-type-assertion). getTypeAtLocation(node) resolves the
        // indexed-access element type (incl. `| undefined`) correctly.
        if (k === SyntaxKind.PropertyAccessExpression) {
            const sfPath = tsgoNode.getSourceFile?.()?.fileName;
            if (sfPath) {
                const t = project.checker.getTypeAtPosition(toTsgoFileName(sfPath), tsgoNode.end);
                if (t) { fixupType(t); return t; }
            }
        }
        // NonNullExpression — inner type with non-nullable wrapper.
        if (k === SyntaxKind.NonNullExpression) {
            const inner = tsgoNode.expression;
            if (inner) {
                const innerT = computeGetTypeAtLocation(inner);
                if (innerT) return project.checker.getNonNullableType(innerT);
            }
        }
        // Default — node-based getTypeAtLocation.
        const t = project.checker.getTypeAtLocation(tsgoNode);
        if (t) fixupType(t);
        return t;
    }

    // ── Build adapter object ─────────────────────────────────────────
    const getHostBoundSf = (fileName: string): any | undefined => {
        const getSourceFile = _hostProgramRef?.getSourceFile ?? program.getSourceFile;
        const sf = getSourceFile?.(fileName);
        if (!sf?.__tnbHostBound) return undefined;
        return sf;
    };
    const refineNavSymbol = (sym: any) => {
        if (!sym) return sym;
        if (!_hasHostBoundFiles) return sym;
        const cached = refinedSymBySym.get(sym);
        if (cached !== undefined) return cached;
        const refined = refineHostNavigationSymbol(sym, getHostBoundSf);
        refinedSymBySym.set(sym, refined);
        return refined;
    };

    let checkerProxyRef: any;

    // Signature consumers (flamework transformUserMacro) read JSDoc metadata
    // via ts.getJSDocTags(signature.getDeclaration()) and match parameter
    // symbols — both need host AST nodes, not tsgo remote nodes. Mutates the
    // signature in place (identity-preserving, same as refineNavSymbol).
    const refinedSignatures = new WeakSet<any>();
    const refineSignatureForHost = (sig: any) => {
        if (!sig || !_hasHostBoundFiles || refinedSignatures.has(sig)) return sig;
        refinedSignatures.add(sig);
        try {
            const decl = sig.declaration;
            if (decl) {
                const mapped = remapDeclarationToHost(decl, getHostBoundSf);
                if (mapped !== decl) {
                    Object.defineProperty(sig, "declaration", { value: mapped, writable: true, configurable: true, enumerable: true });
                }
            }
        } catch { /* best-effort */ }
        for (const p of sig.parameters ?? []) {
            try { refineNavSymbol(p); } catch { /* best-effort */ }
        }
        return sig;
    };

    const adapter: any = {
        // ── Node-based hot queries (find tsgo node → use tsgo's own API) ──
        getTypeAtLocation(node: any): any {
            ensureProject();
            const sf = node.getSourceFile?.();
            if (!sf) return undefined;
            if (!(node.pos >= 0) || !(node.end >= 0)) return undefined;
            return memoGet(nodeTypeCache, node, () => {
                const t0 = process.env.TSGO_PROFILE === "1" ? Date.now() : 0;
                const tsgoNode = findTsgoNodeAtPosition(sf.fileName, node.getStart(sf), node.kind, node.getEnd(sf));
                if (!tsgoNode) { if (process.env.TSGO_PROFILE === "1") { const d = Date.now() - t0; _stats.queryCount++; _stats.queryMs += d; _stats.getTypeCount++; _stats.getTypeMs += d; } return undefined; }
                const r = computeGetTypeAtLocation(tsgoNode);
                if (process.env.TSGO_PROFILE === "1") { const d = Date.now() - t0; _stats.queryCount++; _stats.queryMs += d; _stats.getTypeCount++; _stats.getTypeMs += d; }
                return r;
            });
        },
        getSymbolAtLocation(node: any): any {
            ensureProject();
            const sf = node.getSourceFile?.();
            if (!sf) return undefined;
            // component-meta: getSymbolAtLocation(sourceFile) must return the
            // file's module symbol (sf.symbol), not a tsgo position hit on the
            // first statement (e.g. __VLS_export) which lacks the default export.
            if (node.kind === SyntaxKind.SourceFile && sf.symbol) {
                // Return the module symbol directly. Do NOT write symByPos here:
                // this whole-file symbol has no single span, and caching it under
                // position 0 would poison lookups for any real node at pos 0.
                // This branch already short-circuits every SourceFile query, so a
                // cache is unnecessary anyway.
                // Do not refineNavSymbol here — resolveHostExportDefaultSymbol would
                // replace the module symbol with the __VLS_export const, breaking
                // getExportsOfModule (component-meta needs the module + default export).
                return sf.symbol;
            }
            const t0 = process.env.TSGO_PROFILE === "1" ? Date.now() : 0;
            // Trivia-skipped start: querying at node.pos lands on whitespace,
            // where tsgo's position probe resolves the PRECEDING token (e.g.
            // the `default` keyword's alias symbol for the identifier in
            // `export default X` — stock returns X's variable symbol).
            let start = typeof node.pos === "number" ? node.pos : node.getStart(sf);
            if (typeof node.getStart === "function" && typeof start === "number" && start >= 0) {
                start = node.getStart(sf);
            }
            const end = typeof node.end === "number" ? node.end : node.getEnd(sf);
            // Synthetic (transformer-created) nodes have pos/end -1 — they
            // exist in no snapshot, and position RPCs reject negative
            // positions. Stock returns the binder backdoor (node.symbol,
            // usually undefined for synthetics).
            if (!(start >= 0) || !(end >= 0)) {
                return node.symbol;
            }
            const cacheName = symCacheFileName(sf.fileName);
            const recordHit = () => {
                if (process.env.TSGO_PROFILE === "1") {
                    const d = Date.now() - t0;
                    _stats.getSymCount++;
                    _stats.getSymMs += d;
                    _stats.getSymHitCount++;
                }
            };
            const recordRpc = () => {
                if (process.env.TSGO_PROFILE === "1") {
                    const d = Date.now() - t0;
                    _stats.getSymCount++;
                    _stats.getSymMs += d;
                    _stats.getSymRpcCount++;
                }
            };
            // Position probes and the start/end/end-1 symbol cache are only
            // sound for narrow tokens. A wide node (satisfies expression,
            // object literal, call expression) shares its `end` with its own
            // trailing token, so both the cache probe and the end-1 re-probe
            // alias it to that token's symbol (e.g. the `T` of
            // `{...} satisfies T`) — stock returns undefined for most wide
            // kinds, and transpilers branch on that (roblox-ts
            // transformExportAssignment drops the statement when a non-value
            // symbol comes back).
            const narrowKind = node.kind === SyntaxKind.Identifier
                || node.kind === SyntaxKind.PrivateIdentifier
                || node.kind === SyntaxKind.StringLiteral
                || node.kind === SyntaxKind.NoSubstitutionTemplateLiteral
                || node.kind === SyntaxKind.NumericLiteral
                || node.kind === SyntaxKind.ThisKeyword
                || node.kind === SyntaxKind.SuperKeyword;
            if (!narrowKind && node.kind !== SyntaxKind.SourceFile) {
                // Wide nodes resolve ONLY through an exact tsgo node match
                // (kind+end at the trivia-skipped start) followed by the
                // faithful node-based RPC. No positional fallbacks: a strict
                // miss means "no symbol", matching stock.
                const wideStart = start;
                const wideKey = `${wideStart}:${end}:${node.kind}`;
                let fileWide = wideSymCache.get(cacheName);
                if (fileWide && fileWide.has(wideKey)) {
                    recordHit();
                    return refineNavSymbol(fileWide.get(wideKey));
                }
                const tsgoNode = findTsgoNodeAtPosition(sf.fileName, wideStart, node.kind, end, /*strict*/ true);
                let sym: any = tsgoNode ? project.checker.getSymbolAtLocation(tsgoNode) : undefined;
                if (!sym && _hasHostBoundFiles) {
                    sym = getHostBoundSymbolAtLocation(node);
                }
                sym = refineNavSymbol(sym);
                if (!fileWide) {
                    fileWide = new Map();
                    wideSymCache.set(cacheName, fileWide);
                }
                fileWide.set(wideKey, sym);
                recordRpc();
                return sym;
            }
            const resolveSymbolRpc = (): any => {
                const tsgoFile = toTsgoFileName(sf.fileName);
                let sym: any = project.checker.getSymbolAtPosition(tsgoFile, start);
                // The end-1 re-probe compensates for leading trivia on narrow
                // tokens.
                if (!sym && end > start && narrowKind) {
                    sym = project.checker.getSymbolAtPosition(tsgoFile, end - 1);
                }
                if (!sym && !symPrefetchPopulated.has(cacheName)) {
                    const tsgoNode = findTsgoNodeAtPosition(sf.fileName, start, node.kind, end);
                    if (tsgoNode) {
                        sym = project.checker.getSymbolAtLocation(tsgoNode);
                    }
                }
                if (!sym && _hasHostBoundFiles) {
                    sym = getHostBoundSymbolAtLocation(node);
                }
                sym = refineNavSymbol(sym);
                storeSymCache(cacheName, start, end, sym);
                recordRpc();
                return sym;
            };
            let cached = probeSymCache(cacheName, start, end);
            if (cached.found) {
                recordHit();
                // Prefetched entries are stored raw — remap declarations to host
                // lazily on first read (refineNavSymbol memoizes per symbol).
                return refineNavSymbol(cached.sym);
            }
            const missCount = (symMissCountByFile.get(cacheName) ?? 0) + 1;
            symMissCountByFile.set(cacheName, missCount);
            // Sparse files: direct per-position RPC until miss density justifies
            // one whole-file prefetch (break-even ~32 × 12µs vs one batch walk).
            if (!symPrefetched.has(cacheName) && missCount < symPrefetchMissThreshold) {
                return resolveSymbolRpc();
            }
            if (!symPrefetched.has(cacheName)) {
                ensureFileSymbolsPrefetched(sf.fileName);
            }
            cached = probeSymCache(cacheName, start, end);
            if (cached.found) {
                recordHit();
                return refineNavSymbol(cached.sym);
            }
            // allIdentifiers prefetch is exhaustive for covered sites with a
            // resolved symbol; absent from the map means no symbol.
            if (symPrefetchPopulated.has(cacheName) && isPrefetchCoveredNode(node)) {
                storeSymCache(cacheName, start, end, undefined);
                recordHit();
                return undefined;
            }
            // Host-bound fast path only applies when host-bound files exist
            // (Volar LS); pure-TS lint never enters this branch.
            if (_hasHostBoundFiles) {
                const isImportExportName = isCrossFileImportExportName(node);
                const preferHostSymbol = sf.__tnbHostBound && !isImportExportName;
                if (preferHostSymbol) {
                    const hostSym = getHostBoundSymbolAtLocation(node);
                    if (hostSym) {
                        const refined = refineNavSymbol(hostSym);
                        storeSymCache(cacheName, start, end, refined);
                        if (process.env.TSGO_PROFILE === "1") {
                            const d = Date.now() - t0;
                            _stats.getSymCount++;
                            _stats.getSymMs += d;
                        }
                        return refined;
                    }
                }
            }
            return resolveSymbolRpc();
        },
        getTypeOfSymbolAtLocation(symbol: any, location: any): any {
            ensureProject();
            const sf = location.getSourceFile?.();
            if (!sf) return undefined;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, location.getStart(sf), location.kind, location.getEnd(sf));
            // Host-binder symbols (bound host SourceFiles, e.g. transpiler
            // class transforms passing node.symbol) have no tsgo handle —
            // remap through their declarations before the RPC, which faults
            // server-side on an empty symbol handle.
            const rpcSymbol = toTsgoSymbol(symbol);
            const hasHandle = rpcSymbol && typeof rpcSymbol.id === "number" && rpcSymbol.id > 0;
            if (tsgoNode && hasHandle) {
                const t = project.checker.getTypeOfSymbolAtLocation(rpcSymbol, tsgoNode);
                if (t) fixupType(t);
                return t;
            }
            // Auto-import completion entries may query export symbols at virtual-doc
            // locations where the host AST node has no tsgo mirror yet.
            if (hasHandle && typeof project.checker.getTypeOfSymbol === "function") {
                const t = project.checker.getTypeOfSymbol(rpcSymbol);
                if (t) fixupType(t);
                return t;
            }
            // Symbol can't cross the bridge — approximate with the type at
            // the queried location (matches for declaration nodes, the only
            // callers that reach here with host-only symbols).
            if (tsgoNode) {
                return adapter.getTypeAtLocation(location);
            }
            return undefined;
        },
        getContextualType(node: any): any {
            ensureProject();
            const sf = node.getSourceFile?.();
            if (!sf) return undefined;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, node.getStart(sf), node.kind, node.getEnd(sf));
            if (!tsgoNode) return undefined;
            const t = project.checker.getContextualType(tsgoNode);
            if (t) fixupType(t);
            return t;
        },
        getResolvedSignature(node: any): any {
            ensureProject();
            const sf = node.getSourceFile?.();
            if (!sf) return undefined;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, node.getStart(sf), node.kind, node.getEnd(sf));
            if (!tsgoNode) return undefined;
            return refineSignatureForHost(project.checker.getResolvedSignature(tsgoNode));
        },
        getSignatureFromDeclaration(declaration: any): any {
            ensureProject();
            const sf = declaration.getSourceFile?.();
            if (!sf) return undefined;
            if (!(declaration.pos >= 0) || !(declaration.end >= 0)) return undefined;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, declaration.getStart(sf), declaration.kind, declaration.getEnd(sf));
            if (!tsgoNode) return undefined;
            try {
                return refineSignatureForHost(project.checker.getSignatureFromDeclaration(tsgoNode));
            } catch { return undefined; }
        },
        // Needed by computeGetTypeAtLocation for AsExpression handling.
        getTypeFromTypeNode(typeNode: any): any {
            ensureProject();
            const t = project.checker.getTypeFromTypeNode(typeNode);
            if (t) fixupType(t);
            return t;
        },

        // ── Type/Symbol-object queries ──
        getTypeOfSymbol(symbol: any): any {
            if (!symbol) return undefined;
            ensureProject();
            return memoGet(typeOfSymbolCache, symbol, () => {
                const t = project.checker.getTypeOfSymbol(toTsgoSymbol(symbol));
                if (t) fixupType(t);
                return t;
            });
        },
        getDeclaredTypeOfSymbol(symbol: any): any {
            if (!symbol) return undefined;
            ensureProject();
            const t = project.checker.getDeclaredTypeOfSymbol(toTsgoSymbol(symbol));
            if (t) fixupType(t);
            return t;
        },
        // Symbol-only queries the scope manager uses — see delegation in the
        // stubs section below (getShorthandAssignmentValueSymbol etc.).

        typeToString(type: any, _enclosing?: any, flags?: number): string {
            ensureProject();
            return project.checker.typeToString(type, undefined, flags);
        },
        getPropertiesOfType(type: any): readonly any[] {
            ensureProject();
            if (!type) return [];
            return memoGet(propertiesCache, type, () => orderPropsLikeStock(project.checker.getPropertiesOfType(type) ?? []));
        },
        getPropertyOfType(type: any, name: string): any {
            ensureProject();
            return resolvePropertyOfType(type, name);
        },
        getSignaturesOfType(type: any, kind: number): readonly any[] {
            ensureProject();
            if (!type) return [];
            return getSignaturesCached(type, kind);
        },
        getNonNullableType(type: any): any {
            ensureProject();
            const t = project.checker.getNonNullableType(type);
            if (t) fixupType(t);
            return t;
        },
        getNonOptionalType(type: any): any {
            ensureProject();
            if (!type) return type;
            const checker = project.checker;
            if (typeof checker.getNonOptionalType === "function") {
                const t = checker.getNonOptionalType(type);
                if (t) fixupType(t);
                return t ?? type;
            }
            // No tsgo RPC: identity, NOT getNonNullableType — stock only
            // strips the optional-chain marker (never on the wire), while
            // getNonNullableType removes `| undefined` and flips emit branches
            // (see proto.getNonOptionalType).
            return type;
        },
        getBaseTypes(type: any): readonly any[] {
            ensureProject();
            if (!type) return [];
            return getBaseTypesCached(type);
        },
        isTypeAssignableTo(source: any, target: any): boolean {
            ensureProject();
            if (!source || !target) return false;
            return project.checker.isTypeAssignableTo(source, target);
        },
        getReturnTypeOfSignature(signature: any): any {
            ensureProject();
            const t = project.checker.getReturnTypeOfSignature(signature);
            if (t) fixupType(t);
            return t;
        },
        getBaseConstraintOfType(type: any): any {
            ensureProject();
            const TF = sync.TypeFlags;
            if (type && (type.flags & TF.TypeParameter) !== 0) {
                const t = project.checker.getConstraintOfTypeParameter(type);
                if (t) fixupType(t);
                return t;
            }
            return undefined;
        },
        getIndexInfosOfType(type: any): readonly any[] {
            ensureProject();
            if (!type) return [];
            const infos = project.checker.getIndexInfosOfType(type) ?? [];
            // Stock ts.IndexInfo names the value type `type`; the sync API
            // uses `valueType`. Alias so consumers reading `info.type`
            // (rbxts-transformer-flamework map guards) see the stock shape.
            for (const info of infos) {
                if (info.keyType) fixupType(info.keyType);
                if (info.valueType) fixupType(info.valueType);
                if (info.type === undefined) info.type = info.valueType;
            }
            return infos;
        },
        getTypeArguments(type: any): readonly any[] {
            ensureProject();
            if (!type) return [];
            const args = project.checker.getTypeArguments(type);
            if (args) fixupType(args);
            return args ?? [];
        },
        getWidenedType(type: any): any {
            ensureProject();
            if (!type) return type;
            const t = project.checker.getWidenedType(type);
            if (t) fixupType(t);
            return t;
        },
        forEachExportAndPropertyOfModule(moduleSymbol: any, cb: (symbol: any, key: string) => void): void {
            forEachExportAndPropertyOfModuleWorker(moduleSymbol, cb);
        },
        getExportsOfModule(moduleSymbol: any): readonly any[] {
            if (!moduleSymbol) return [];
            // Stock getExportsOfModule resolves an `export =` module through
            // resolveExternalModuleSymbol first: `export = Namespace` modules
            // report the NAMESPACE's members, not the export= alias itself.
            // Transpilers iterate these symbols and match their declarations
            // against host statements, so results must also be host-refined.
            const followExportEquals = (exports: any[]): any[] => {
                if (exports.length !== 1) return exports;
                const only = exports[0];
                const name = only?.escapedName ?? only?.name;
                if (name !== "export=") return exports;
                const resolved = adapter.getAliasedSymbol(only);
                if (!resolved || resolved === only) return exports;
                const memberExports = collectNamedExportsFromModuleSymbol(resolved);
                if (memberExports.length) return memberExports;
                if (typeof resolved.id === "number" && resolved.id !== 0) {
                    try {
                        return Array.from(project.checker.getExportsOfModule(resolved) ?? []);
                    } catch { /* fall through */ }
                }
                return exports;
            };
            // Converge on tsgo registry singletons (per-snapshot id-keyed) so
            // `moduleExport === type.aliasSymbol`-style identity compares in
            // transformers hold; refineNavSymbol then remaps declarations to
            // host AST nodes IN PLACE for declaration-identity compares.
            const refineAll = (exports: readonly any[]): any[] =>
                Array.from(exports, (e: any) => refineNavSymbol(toTsgoSymbol(e)));
            // File-level export fallbacks apply only to true FILE module
            // symbols. A `namespace X` symbol also declares inside that file —
            // falling back would report the FILE's exports (e.g. `default`)
            // instead of the namespace members, and roblox-ts then skips every
            // `_container.member = member` export assignment.
            const isFileModuleSymbol = !!moduleSymbol.declarations?.some?.((d: any) => d.kind === SyntaxKind.SourceFile);
            let hostExports = collectNamedExportsFromModuleSymbol(moduleSymbol);
            if (!hostExports.length && isFileModuleSymbol) {
                const hostFileName = moduleSymbolSourceFileName(moduleSymbol);
                if (hostFileName) hostExports = resolveHostModuleNamedExports(hostFileName);
            }
            if (hostExports.length) {
                ensureProject();
                return refineAll(followExportEquals(hostExports));
            }
            ensureProject();
            const mod = resolveModuleSymbolForExports(moduleSymbol);
            const resolvedExports = collectNamedExportsFromModuleSymbol(mod);
            if (resolvedExports.length) {
                return refineAll(followExportEquals(resolvedExports));
            }
            if (typeof mod?.id === "number" && mod.id !== 0) {
                try {
                    return refineAll(followExportEquals(Array.from(project.checker.getExportsOfModule(mod) ?? [])));
                } catch {
                    return [];
                }
            }
            return [];
        },

        // ── Transpiler surface (roblox-ts) ──
        // Stock checker compares against its synthetic undefinedSymbol /
        // argumentsSymbol by identity. tsgo symbols cross the bridge by value,
        // so identify them structurally: both are checker-synthesized (no
        // declarations anywhere in the program).
        isUndefinedSymbol(symbol: any): boolean {
            return !!symbol
                && (symbol.name ?? symbol.escapedName) === "undefined"
                && !symbol.valueDeclaration
                && !(symbol.declarations?.length);
        },
        isArgumentsSymbol(symbol: any): boolean {
            return !!symbol
                && (symbol.name ?? symbol.escapedName) === "arguments"
                && !symbol.valueDeclaration
                && !(symbol.declarations?.length);
        },
        getConstantValue(node: any): string | number | undefined {
            ensureProject();
            const sf = node?.getSourceFile?.();
            if (!sf) return undefined;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, node.getStart(sf), node.kind, node.getEnd(sf));
            if (!tsgoNode) return undefined;
            return project.checker.getConstantValue(tsgoNode);
        },
        getTypeOfAssignmentPattern(node: any): any {
            ensureProject();
            const sf = node?.getSourceFile?.();
            if (!sf) return undefined;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, node.getStart(sf), node.kind, node.getEnd(sf));
            if (tsgoNode && typeof project.checker.getTypeOfAssignmentPattern === "function") {
                const t = project.checker.getTypeOfAssignmentPattern(tsgoNode);
                if (t) { fixupType(t); return t; }
            }
            return adapter.getTypeAtLocation(node);
        },
        getContextualTypeForObjectLiteralElement(node: any): any {
            ensureProject();
            const sf = node?.getSourceFile?.();
            if (!sf) return undefined;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, node.getStart(sf), node.kind, node.getEnd(sf));
            if (!tsgoNode || typeof project.checker.getContextualTypeForObjectLiteralElement !== "function") return undefined;
            const t = project.checker.getContextualTypeForObjectLiteralElement(tsgoNode);
            if (t) fixupType(t);
            return t;
        },
        getTypeOfPropertyOfType(type: any, name: string): any {
            ensureProject();
            if (!type || typeof project.checker.getTypeOfPropertyOfType !== "function") return undefined;
            const t = project.checker.getTypeOfPropertyOfType(type, name);
            if (t) fixupType(t);
            return t;
        },
        getIndexTypeOfType(type: any, kind: number): any {
            ensureProject();
            if (!type) return undefined;
            const TF = sync.TypeFlags;
            const wantFlag = kind === 1 ? TF.Number : TF.String;
            const infos = project.checker.getIndexInfosOfType(type) ?? [];
            for (const info of infos) {
                if (info.keyType?.flags & wantFlag) {
                    if (info.valueType) fixupType(info.valueType);
                    return info.valueType;
                }
            }
            return undefined;
        },
        // Module-specifier resolution fallback: callers (roblox-ts
        // getSourceFileFromModuleSpecifier) try getSymbolAtLocation first and
        // fall back to ts.resolveModuleName themselves when this is undefined.
        resolveExternalModuleName: (_moduleSpecifier: any) => undefined,

        // ── Diagnostics — empty for PoC ──
        getSuggestionDiagnostics(): readonly any[] { return []; },
        getGlobalDiagnostics(): readonly any[] { return []; },
        getDiagnostics(): readonly any[] { return []; },
        getAmbientModules(): readonly any[] { return []; },

        // ── Stubs ──
        getSymbolsInScope(location: any, meaning: number): any[] {
            if (!location) return [];
            const sf = location.getSourceFile?.();
            if (sf?.__tnbHostBound) {
                return getHostSymbolsInScope(location, meaning).map(refineNavSymbol);
            }
            ensureProject();
            const tsgoNode = sf
                ? findTsgoNodeAtPosition(sf.fileName, location.getStart(sf), location.kind, location.getEnd(sf))
                : undefined;
            const tsgoGet = project.checker.getSymbolsInScope;
            if (tsgoNode && typeof tsgoGet === "function") {
                try {
                    return (tsgoGet.call(project.checker, tsgoNode, meaning) ?? []).map(refineNavSymbol);
                } catch { /* host-only */ }
            }
            return [];
        },
        getExportSpecifierLocalTargetSymbol(node: any): any {
            ensureProject();
            const sf = node.getSourceFile?.();
            if (!sf) return undefined;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, node.getStart(sf), node.kind, node.getEnd(sf));
            if (!tsgoNode) return undefined;
            try {
                return refineNavSymbol(project.checker.getExportSpecifierLocalTargetSymbol(tsgoNode));
            } catch { return undefined; }
        },
        getShorthandAssignmentValueSymbol(node: any): any {
            ensureProject();
            const sf = node.getSourceFile?.();
            if (!sf) return undefined;
            const tsgoNode = findTsgoNodeAtPosition(sf.fileName, node.getStart(sf), node.kind, node.getEnd(sf));
            if (!tsgoNode) return undefined;
            try {
                return refineNavSymbol(project.checker.getShorthandAssignmentValueSymbol(tsgoNode));
            } catch { return undefined; }
        },
        getAliasedSymbol(symbol: any): any {
            ensureProject();
            if (!symbol) return symbol;
            const SF = sync.SymbolFlags;
            if (!(symbol.flags & SF.Alias)) {
                return refineNavSymbol(symbol);
            }
            // Host binder aliases carry no resolved `.target` (alias
            // resolution is checker work) — resolve export-assignment aliases
            // (`export default X`, `export = X`) through their declaration's
            // expression so skipAlias reaches the value symbol like stock.
            const resolveViaDeclaration = (alias: any): any => {
                const decl = alias?.declarations?.[0];
                if (decl?.kind === SyntaxKind.ExportAssignment && decl.expression) {
                    const target = adapter.getSymbolAtLocation(decl.expression);
                    if (target && target !== alias) return target;
                }
                return alias;
            };
            // Host binder alias symbols (LS route prefers host symbols) have
            // no tsgo handle — map through the declaration position first so
            // the full-chain RPC resolution below applies to them too. Symbol
            // registry membership (instanceof), not `id` presence, decides
            // RPC eligibility: ts.getSymbolId stamps numeric ids onto host
            // binder symbols too.
            const isRegistrySymbol = (s: any) => !!(_sync?.Symbol && s instanceof _sync.Symbol);
            let rpcSymbol = symbol;
            if (!isRegistrySymbol(rpcSymbol)) {
                const mapped = toTsgoSymbol(rpcSymbol);
                if (isRegistrySymbol(mapped)) rpcSymbol = mapped;
            }
            try {
                // Stock getAliasedSymbol resolves the FULL alias chain; the
                // tsgo RPC can stop one hop short on multi-hop chains (default
                // import -> `default` alias -> `export =` target), leaving the
                // Alias flag set — value-ness checks then elide live imports.
                // Iterate to a fixpoint, interleaving RPC hops with
                // declaration hops (an RPC-returned `default`/`export=` alias
                // stalls the RPC but its ExportAssignment declaration still
                // names the target) and host `.target` hops.
                const traceAlias = process.env.TNB_DEBUG === "1" && (symbol.escapedName === "Iris" || symbol.name === "Iris");
                let current = rpcSymbol;
                const seen = new Set<any>([current]);
                while (current && (current.flags & SF.Alias)) {
                    let next: any;
                    if (isRegistrySymbol(current)) {
                        try { next = project.checker.getAliasedSymbol(current); } catch { next = undefined; }
                    } else {
                        const mapped = toTsgoSymbol(current);
                        if (isRegistrySymbol(mapped) && mapped !== current && !seen.has(mapped)) next = mapped;
                    }
                    if (traceAlias) console.error(`[TNB-ALIAS] hop rpc: cur=${current.escapedName}#${current.id} f=${current.flags} reg=${isRegistrySymbol(current)} -> ${next ? `${next.escapedName}#${next.id} f=${next.flags}` : "none"}`);
                    if (!next || next === current || seen.has(next)) {
                        try { refineNavSymbol(current); } catch { /* best-effort */ }
                        const viaDecl = resolveViaDeclaration(current);
                        if (traceAlias) console.error(`[TNB-ALIAS] hop decl: declKind=${current.declarations?.[0]?.kind} nDecls=${current.declarations?.length} -> ${viaDecl !== current ? `${viaDecl?.escapedName} f=${viaDecl?.flags}` : "none"}`);
                        next = viaDecl !== current && !seen.has(viaDecl) ? viaDecl : undefined;
                    }
                    if (!next) {
                        const viaTarget = current.target;
                        next = viaTarget && viaTarget !== current && !seen.has(viaTarget) ? viaTarget : undefined;
                    }
                    if (!next) break;
                    seen.add(next);
                    current = next;
                }
                if (traceAlias) console.error(`[TNB-ALIAS] done: ${current?.escapedName} f=${current?.flags} progressed=${current !== symbol}`);
                if (current && current !== symbol) return refineNavSymbol(current);
                const resolved = resolveHostAliasedSymbol(symbol);
                if (resolved !== symbol) return refineNavSymbol(resolved);
                return refineNavSymbol(resolveViaDeclaration(symbol));
            } catch {
                const resolved = resolveHostAliasedSymbol(symbol);
                if (resolved !== symbol) return refineNavSymbol(resolved);
                return refineNavSymbol(resolveViaDeclaration(symbol));
            }
        },
        getImmediateAliasedSymbol(symbol: any): any {
            ensureProject();
            if (!symbol) return symbol;
            const SF = sync.SymbolFlags;
            if (!(symbol.flags & SF.Alias)) return refineNavSymbol(symbol);
            if (typeof symbol.id !== "number") {
                const target = symbol.target;
                return refineNavSymbol(target && target !== symbol ? target : symbol);
            }
            try {
                return refineNavSymbol(project.checker.getImmediateAliasedSymbol(symbol) ?? symbol);
            } catch {
                const target = symbol.target;
                return refineNavSymbol(target && target !== symbol ? target : symbol);
            }
        },
        tryGetMemberInModuleExports(memberName: any, moduleSymbol: any): any {
            if (moduleSymbol?.exports) {
                const sym = moduleSymbol.exports.get(memberName);
                return sym ? refineNavSymbol(sym) : undefined;
            }
            ensureProject();
            try {
                return refineNavSymbol(project.checker.tryGetMemberInModuleExports(memberName, moduleSymbol));
            } catch { return undefined; }
        },
        resolveExternalModuleSymbol(moduleSymbol: any): any {
            ensureProject();
            if (moduleSymbol?.exports) {
                try {
                    const resolved = project.checker.resolveExternalModuleSymbol(moduleSymbol);
                    if (resolved) return refineNavSymbol(resolved);
                } catch { /* host-bound module */ }
                return refineNavSymbol(moduleSymbol);
            }
            try {
                return refineNavSymbol(project.checker.resolveExternalModuleSymbol(moduleSymbol) ?? moduleSymbol);
            } catch { return refineNavSymbol(moduleSymbol); }
        },
        // Merging is a TS-specific concern; tsgo symbols are already merged.
        getMergedSymbol: (s: any) => s,
        getRootSymbols(symbol: any): any[] {
            if (!symbol) return [];
            const immediate = getImmediateRootSymbolsForNavigation(symbol);
            if (immediate?.length) {
                return immediate.flatMap(s => adapter.getRootSymbols(s));
            }
            return [refineNavSymbol(symbol)];
        },
        getDefinitionSpanForDeclaration(declaration: any): { start: number; length: number } | undefined {
            return tnbHostExportDefinitionTextSpan(declaration);
        },
        // Emit resolver — transpilers (roblox-ts) consume import-elision facts
        // and JSX factory entities from it; back those with tsgo. Other members
        // stay stubbed (the lint path doesn't emit).
        getEmitResolver: () => ({
            getExternalModuleIndicator: () => false,
            isReferencedAliasDeclaration: (node: any) => {
                const sf = node?.getSourceFile?.();
                if (!sf?.fileName) return true;
                // Synthetic nodes (transformer-injected imports, pos -1) can
                // never match content spans; stock getParseTreeNode fails for
                // them and isReferencedAliasDeclaration defaults to true.
                if (typeof node.pos !== "number" || node.pos < 0 || node.end < 0) return true;
                const spans = getReferencedAliasSpans(sf.fileName);
                if (!spans) return true;
                if (spans.has(`${node.pos}:${node.end}`)) return true;
                const name = node.name?.text ?? (node.kind === SyntaxKind.ImportClause ? node.name?.text : undefined);
                return name != null && spans.has(`n:${name}`);
            },
            getJsxFactoryEntity: () => getParsedJsxEntity(options.jsxFactory, "React.createElement"),
            getJsxFragmentFactoryEntity: () => getParsedJsxEntity(options.jsxFragmentFactory, "React.Fragment"),
        }),
        resolveName(name: string, location: any, meaning: number, excludeGlobals?: boolean): any {
            ensureProject();
            let tsgoLocation: any = location;
            if (location && typeof location.getStart === "function") {
                const sf = location.getSourceFile?.();
                if (sf?.fileName) {
                    const tsgoNode = findTsgoNodeAtPosition(
                        sf.fileName,
                        location.getStart(sf),
                        location.kind,
                        location.getEnd(sf),
                    );
                    if (tsgoNode) tsgoLocation = tsgoNode;
                }
            }
            // SymbolFlags.All is -1 (all bits); the Go side rejects negative
            // meaning masks. Substitute the explicit every-meaning union.
            let rpcMeaning = meaning;
            if (typeof rpcMeaning !== "number" || rpcMeaning < 0) {
                rpcMeaning = SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Namespace | SymbolFlags.Alias;
            }
            try {
                const sym = project.checker.resolveName(name, rpcMeaning, tsgoLocation, excludeGlobals);
                if (sym) return refineNavSymbol(sym);
            } catch {
                // fall through to host-bound AST
            }
            const hostSym = refineNavSymbol(resolveNameOnHostBoundAst(name, location) ?? undefined);
            if (hostSym) return hostSym;
            // `globalThis` is a synthetic checker symbol, not a declared name —
            // tsgo's resolveName can't produce it. Return a stable sentinel so
            // consumers that resolve it eagerly (identity checks against use
            // sites) can initialize.
            if (name === "globalThis") return getGlobalThisSentinelSymbol();
            return undefined;
        },

        // ── Counts (for getProgramDiagnostics etc.) ──
        getNodeCount: () => 0,
        getIdentifierCount: () => 0,
        getSymbolCount: () => 0,
        getTypeCount: () => 0,
        getInstantiationCount: () => 0,
        getRelationCacheSizes: () => ({ assignable: 0, identity: 0, subtype: 0, strictSubtype: 0 }),

        // Stock TypeChecker: callback receives the checker proxy (see checker.ts).
        // Vue references → getQuickInfoAtPosition → SymbolDisplay uses this API.
        runWithCancellationToken(_token: any, callback: (checker: any) => any): any {
            return callback(checkerProxyRef);
        },
    };

    // Proxy: unknown methods → lazily forward to tsgo checker if it has them,
    // else return a no-op that yields undefined / [] (feature-detect friendly;
    // many callers iterate the result, so returning a callable is safer than
    // undefined).
    // Eagerly create the tsgo project so program.getSourceFile() can return
    // tsgo-backed files before any checker method is invoked by rules.
    ensureProject();

    const wrapCheckerCall = <T extends (...args: any[]) => any>(fn: T): T => {
        return ((...args: any[]) => {
            _checkerQueryDepth++;
            try {
                return fn(...args);
            } finally {
                _checkerQueryDepth--;
            }
        }) as T;
    };

    checkerProxyRef = new Proxy(adapter, {
        get(target: any, prop: string | symbol, receiver: any) {
            if (prop in target) {
                const val = Reflect.get(target, prop, receiver);
                if (typeof val === "function") return wrapCheckerCall(val.bind(target));
                return val;
            }
            if (typeof prop !== "string") return undefined;
            ensureProject();
            if (typeof project.checker[prop] === "function") {
                return wrapCheckerCall(project.checker[prop].bind(project.checker));
            }
            // Unknown method — return a no-op so `checker.foo()` doesn't throw.
            // Most callers feature-detect or iterate; returning undefined from
            // the call covers both `if (x)` and `for (const i of x ?? [])`.
            if (process.env.TNB_DEBUG === "1" && !_loggedUnknownProps.has(`checker.${prop}`)) {
                _loggedUnknownProps.add(`checker.${prop}`);
                console.error(`[TNB] checker adapter: unknown property read: ${prop}`);
            }
            return (..._args: any[]) => undefined;
        },
        has(target: any, p) { return p in target; },
    });
    return checkerProxyRef;
}
