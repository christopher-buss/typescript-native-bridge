//
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
// !!! THIS FILE IS AUTO-GENERATED - DO NOT EDIT !!!
// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
//
// Source: src/api/async/api.ts
// Regenerate: npm run generate (from _packages/native-preview)
//
/// <reference path="../node/node.ts" preserve="true" />
import { CompletionItemKind } from "#enums/completionItemKind";
import { DiagnosticCategory } from "#enums/diagnosticCategory";
import { ElementFlags } from "#enums/elementFlags";
import { NodeBuilderFlags } from "#enums/nodeBuilderFlags";
import { ObjectFlags } from "#enums/objectFlags";
import { SignatureFlags } from "#enums/signatureFlags";
import { SignatureKind } from "#enums/signatureKind";
import { SymbolFlags } from "#enums/symbolFlags";
import { TypeFlags } from "#enums/typeFlags";
import { TypePredicateKind } from "#enums/typePredicateKind";
import { ModifierFlags, } from "../../ast/index.js";
import { encodeNode, uint8ArrayToBase64, } from "../node/encoder.js";
import { decodeNode, getNodeId, parseNodeHandle, readParseOptionsKey, readSourceFileHash, RemoteSourceFile, } from "../node/node.js";
import { createGetCanonicalFileName, toPath, } from "../path.js";
import { resolveFileName, toUpdateSnapshotRequest, } from "../proto.js";
import { SourceFileCache } from "../sourceFileCache.js";
import { Client, } from "./client.js";
export { CompletionItemKind, DiagnosticCategory, ElementFlags, ModifierFlags, NodeBuilderFlags, ObjectFlags, SignatureFlags, SignatureKind, SymbolFlags, TypeFlags, TypePredicateKind };
export { documentURIToFileName, fileNameToDocumentURI } from "../path.js";
export class API {
    client;
    sourceFileCache;
    toPath;
    initialized = false;
    activeSnapshots = new Set();
    latestSnapshot;
    internal;
    constructor(options) {
        this.client = new Client(options);
        this.sourceFileCache = new SourceFileCache();
        this.internal = new InternalAPI(this.client, () => this.ensureInitialized());
    }
    /**
     * Create an API instance from an existing LSP connection's API session.
     * Use this when connecting to an API pipe provided by an LSP server via custom/initializeAPISession.
     */
    static fromLSPConnection(options) {
        const api = new API(options);
        api.ensureInitialized();
        return api;
    }
    ensureInitialized() {
        if (!this.initialized) {
            const response = this.client.apiRequest("initialize", null);
            const getCanonicalFileName = createGetCanonicalFileName(response.useCaseSensitiveFileNames);
            const currentDirectory = response.currentDirectory;
            this.toPath = (fileName) => toPath(fileName, currentDirectory, getCanonicalFileName);
            this.initialized = true;
        }
    }
    parseConfigFile(file) {
        this.ensureInitialized();
        return this.client.apiRequest("parseConfigFile", { file });
    }
    updateSnapshot(params) {
        this.ensureInitialized();
        const requestParams = toUpdateSnapshotRequest(params);
        const data = this.client.apiRequest("updateSnapshot", requestParams);
        // Retain cached source files from previous snapshot for unchanged files
        if (this.latestSnapshot) {
            this.sourceFileCache.retainForSnapshot(data.snapshot, this.latestSnapshot.id, data.changes);
            if (this.latestSnapshot.isDisposed()) {
                this.sourceFileCache.releaseSnapshot(this.latestSnapshot.id);
            }
        }
        const snapshot = new Snapshot(data, this.client, this.sourceFileCache, this.toPath, () => {
            this.activeSnapshots.delete(snapshot);
            if (snapshot !== this.latestSnapshot) {
                this.sourceFileCache.releaseSnapshot(snapshot.id);
            }
        });
        this.latestSnapshot = snapshot;
        this.activeSnapshots.add(snapshot);
        return snapshot;
    }
    close() {
        // Dispose all active snapshots
        for (const snapshot of [...this.activeSnapshots]) {
            snapshot.dispose();
        }
        // Release the latest snapshot's cache refs if still held
        if (this.latestSnapshot) {
            this.sourceFileCache.releaseSnapshot(this.latestSnapshot.id);
            this.latestSnapshot = undefined;
        }
        this.client.close();
        this.sourceFileCache.clear();
    }
    clearSourceFileCache() {
        this.sourceFileCache.clear();
    }
}
export class InternalAPI {
    client;
    ensureInitialized;
    /** @internal */
    constructor(client, ensureInitialized) {
        this.client = client;
        this.ensureInitialized = ensureInitialized;
    }
    startCPUProfile(dir) {
        this.ensureInitialized();
        this.client.apiRequest("startCPUProfile", { dir });
    }
    stopCPUProfile() {
        this.ensureInitialized();
        const result = this.client.apiRequest("stopCPUProfile", null);
        return result.file;
    }
    saveHeapProfile(dir) {
        this.ensureInitialized();
        const result = this.client.apiRequest("saveHeapProfile", { dir });
        return result.file;
    }
}
export class Snapshot {
    id;
    projectMap;
    toPath;
    client;
    disposed = false;
    onDispose;
    snapshotRegistry;
    constructor(data, client, sourceFileCache, toPath, onDispose) {
        this.id = data.snapshot;
        this.client = client;
        this.toPath = toPath;
        this.onDispose = onDispose;
        this.snapshotRegistry = new SnapshotObjectRegistry(client, this.id);
        this.projectMap = new Map();
        for (const projData of data.projects) {
            const project = new Project(projData, this.id, client, sourceFileCache, toPath, this.snapshotRegistry);
            this.projectMap.set(toPath(projData.configFileName), project);
        }
    }
    getProjects() {
        this.ensureNotDisposed();
        return [...this.projectMap.values()];
    }
    getProject(configFileName) {
        this.ensureNotDisposed();
        return this.projectMap.get(this.toPath(configFileName));
    }
    getDefaultProjectForFile(file) {
        this.ensureNotDisposed();
        const data = this.client.apiRequest("getDefaultProjectForFile", {
            snapshot: this.id,
            file,
        });
        if (!data)
            return undefined;
        return this.projectMap.get(this.toPath(data.configFileName));
    }
    [globalThis.Symbol.dispose]() {
        this.dispose();
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        for (const project of this.projectMap.values()) {
            project.dispose();
        }
        this.projectMap.clear();
        this.snapshotRegistry.clear();
        this.onDispose();
        this.client.apiRequest("release", { snapshot: this.id });
    }
    isDisposed() {
        return this.disposed;
    }
    ensureNotDisposed() {
        if (this.disposed) {
            throw new Error("Snapshot is disposed");
        }
    }
}
class SnapshotObjectRegistry {
    symbols = new Map();
    client;
    snapshotId;
    constructor(client, snapshotId) {
        this.client = client;
        this.snapshotId = snapshotId;
    }
    getOrCreateSymbol(data) {
        let symbol = this.symbols.get(data.id);
        if (!symbol) {
            symbol = new Symbol(data, this);
            this.symbols.set(data.id, symbol);
        }
        return symbol;
    }
    getSymbol(id) {
        return this.symbols.get(id);
    }
    clear() {
        this.symbols.clear();
    }
    /**
     * Fetch the full declaration payload for a symbol id (declarations +
     * valueDeclaration). Returns null if the symbol has no declarations. Used to
     * lazily upgrade light prefetch symbols; the registry is snapshot-scoped so
     * no project id is required.
     */
    fetchSymbolDeclarations(symbolId) {
        return this.client.apiRequest("getSymbolDeclarations", {
            snapshot: this.snapshotId,
            objectId: symbolId,
        });
    }
    /** Batch-upgrade light prefetch symbols with declaration payloads (one RPC). */
    hydrateSymbolDeclarations(symbolIds) {
        if (symbolIds.length === 0)
            return;
        const needIds = [];
        for (const id of symbolIds) {
            const sym = this.symbols.get(id);
            if (sym && !sym.hasDeclarationsResolved())
                needIds.push(id);
        }
        if (needIds.length === 0)
            return;
        const data = this.client.apiRequest("getSymbolsDeclarations", {
            snapshot: this.snapshotId,
            symbols: needIds,
        }) ?? [];
        for (let i = 0; i < needIds.length; i++) {
            const sym = this.symbols.get(needIds[i]);
            if (sym)
                sym.applyDeclarationPayload(data[i] ?? null);
        }
    }
    fetchSymbol(source, method, handle, projectId) {
        if (!handle)
            return undefined;
        const cached = this.getSymbol(handle);
        if (cached)
            return cached;
        const data = this.client.apiRequest(method, {
            snapshot: this.snapshotId,
            project: projectId,
            objectId: source.id,
        });
        if (!data)
            throw new Error(`${method} returned null symbol for ${source.constructor.name} ${source.id}`);
        return this.getOrCreateSymbol(data);
    }
    fetchSymbols(source, method, handles, projectId) {
        if (handles) {
            const result = new Array(handles.length);
            let allCached = true;
            for (let i = 0; i < handles.length; i++) {
                const cached = this.getSymbol(handles[i]);
                if (!cached) {
                    allCached = false;
                    break;
                }
                result[i] = cached;
            }
            if (allCached)
                return result;
        }
        const symbolData = this.client.apiRequest(method, {
            snapshot: this.snapshotId,
            project: projectId,
            objectId: source.id,
        });
        if (symbolData == null)
            return [];
        else
            return symbolData.map(data => this.getOrCreateSymbol(data));
    }
}
class ProjectObjectRegistry {
    client;
    snapshotId;
    projectId;
    snapshotRegistry;
    types = new Map();
    signatures = new Map();
    constructor(client, snapshotId, projectId, snapshotRegistry) {
        this.client = client;
        this.snapshotId = snapshotId;
        this.projectId = projectId;
        this.snapshotRegistry = snapshotRegistry;
    }
    getOrCreateSymbol(data) {
        return this.snapshotRegistry.getOrCreateSymbol(data);
    }
    getSymbol(id) {
        return this.snapshotRegistry.getSymbol(id);
    }
    hydrateSymbolDeclarations(symbolIds) {
        this.snapshotRegistry.hydrateSymbolDeclarations(symbolIds);
    }
    getOrCreateType(data) {
        let type = this.types.get(data.id);
        if (!type) {
            type = new TypeObject(data, this);
            this.types.set(data.id, type);
        }
        return type;
    }
    getType(id) {
        return this.types.get(id);
    }
    getOrCreateSignature(data) {
        let sig = this.signatures.get(data.id);
        if (!sig) {
            sig = new Signature(data, this);
            this.signatures.set(data.id, sig);
        }
        return sig;
    }
    getSignature(id) {
        return this.signatures.get(id);
    }
    clear() {
        this.types.clear();
        this.signatures.clear();
    }
    fetchType(source, method, handle) {
        if (handle !== false) {
            if (!handle)
                return undefined;
            const cached = this.getType(handle);
            if (cached)
                return cached;
        }
        const data = this.client.apiRequest(method, {
            snapshot: this.snapshotId,
            project: this.projectId,
            objectId: source.id,
        });
        if (!data)
            throw new Error(`${method} returned null type for ${source.constructor.name} ${source.id}`);
        return this.getOrCreateType(data);
    }
    fetchSymbol(source, method, handle) {
        return this.snapshotRegistry.fetchSymbol(source, method, handle, this.projectId);
    }
    fetchSignature(source, method, handle) {
        if (!handle)
            return undefined;
        const cached = this.getSignature(handle);
        if (cached)
            return cached;
        const data = this.client.apiRequest(method, {
            snapshot: this.snapshotId,
            project: this.projectId,
            objectId: source.id,
        });
        if (!data)
            throw new Error(`${method} returned null signature for ${source.constructor.name} ${source.id}`);
        return this.getOrCreateSignature(data);
    }
    fetchTypes(source, method, handles) {
        if (handles) {
            const result = new Array(handles.length);
            let allCached = true;
            for (let i = 0; i < handles.length; i++) {
                const cached = this.getType(handles[i]);
                if (!cached) {
                    allCached = false;
                    break;
                }
                result[i] = cached;
            }
            if (allCached)
                return result;
        }
        const typesData = this.client.apiRequest(method, {
            snapshot: this.snapshotId,
            project: this.projectId,
            objectId: source.id,
        });
        if (typesData == null)
            return [];
        else
            return typesData.map(data => this.getOrCreateType(data));
    }
    fetchSymbols(source, method, handles) {
        return this.snapshotRegistry.fetchSymbols(source, method, handles, this.projectId);
    }
}
export class Project {
    id;
    configFileName;
    compilerOptions;
    rootFiles;
    program;
    checker;
    emitter;
    client;
    constructor(data, snapshotId, client, sourceFileCache, toPath, snapshotRegistry) {
        this.id = data.id;
        this.configFileName = data.configFileName;
        this.compilerOptions = data.compilerOptions;
        this.rootFiles = data.rootFiles;
        this.client = client;
        this.program = new Program(snapshotId, this.id, client, sourceFileCache, toPath);
        const objectRegistry = new ProjectObjectRegistry(client, snapshotId, this.id, snapshotRegistry);
        this.checker = new Checker(snapshotId, this.id, client, objectRegistry);
        this.emitter = new Emitter(client);
    }
    dispose() {
        this.checker.dispose();
    }
}
export class Program {
    snapshotId;
    projectId;
    client;
    sourceFileCache;
    toPath;
    decoder = new TextDecoder();
    constructor(snapshotId, projectId, client, sourceFileCache, toPath) {
        this.snapshotId = snapshotId;
        this.projectId = projectId;
        this.client = client;
        this.sourceFileCache = sourceFileCache;
        this.toPath = toPath;
    }
    getSourceFile(file) {
        const fileName = resolveFileName(file);
        const path = this.toPath(fileName);
        // Check if we already have a retained cache entry for this (snapshot, project) pair
        const retained = this.sourceFileCache.getRetained(path, this.snapshotId, this.projectId);
        if (retained) {
            return retained;
        }
        // Fetch from server
        const binaryData = this.client.apiRequestBinary("getSourceFile", {
            snapshot: this.snapshotId,
            project: this.projectId,
            file,
        });
        if (!binaryData) {
            return undefined;
        }
        const view = new DataView(binaryData.buffer, binaryData.byteOffset, binaryData.byteLength);
        const contentHash = readSourceFileHash(view);
        const parseOptionsKey = readParseOptionsKey(view);
        // Create a new RemoteSourceFile and cache it (set returns existing if hash matches)
        const sourceFile = new RemoteSourceFile(binaryData, this.decoder);
        return this.sourceFileCache.set(path, sourceFile, parseOptionsKey, contentHash, this.snapshotId, this.projectId);
    }
    getSourceFileNames() {
        const data = this.client.apiRequest("getSourceFileNames", {
            snapshot: this.snapshotId,
            project: this.projectId,
        });
        return data ?? [];
    }
    /**
     * Get syntactic (parse) diagnostics for a specific file or all files.
     * @param file - Optional file to get diagnostics for. If omitted, returns diagnostics for all files.
     */
    getSyntacticDiagnostics(file) {
        const data = this.client.apiRequest("getSyntacticDiagnostics", {
            snapshot: this.snapshotId,
            project: this.projectId,
            ...(file !== undefined ? { file } : {}),
        });
        return data ?? [];
    }
    /**
     * Get binder diagnostics for a specific file or all files.
     * @param file - Optional file to get diagnostics for. If omitted, returns diagnostics for all files.
     */
    getBindDiagnostics(file) {
        const data = this.client.apiRequest("getBindDiagnostics", {
            snapshot: this.snapshotId,
            project: this.projectId,
            ...(file !== undefined ? { file } : {}),
        });
        return data ?? [];
    }
    /**
     * Get semantic (type-check) diagnostics for a specific file or all files.
     * @param file - Optional file to get diagnostics for. If omitted, returns diagnostics for all files.
     */
    getSemanticDiagnostics(file) {
        const data = this.client.apiRequest("getSemanticDiagnostics", {
            snapshot: this.snapshotId,
            project: this.projectId,
            ...(file !== undefined ? { file } : {}),
        });
        return data ?? [];
    }
    /**
     * Emit JS/declaration output for a file (or the whole program). Output files
     * are returned for the caller to write, so --noEmit and custom writeFile hosts
     * stay in control. `emitOnly`: 0=All, 1=Js, 2=Dts, 3=ForcedDts.
     */
    emit(options) {
        const data = this.client.apiRequest("emit", {
            snapshot: this.snapshotId,
            project: this.projectId,
            ...(options?.file !== undefined ? { file: options.file } : {}),
            ...(options?.emitOnly !== undefined ? { emitOnly: options.emitOnly } : {}),
            ...(options?.forceDtsEmit ? { forceDtsEmit: true } : {}),
        });
        return data ?? { emitSkipped: true };
    }
    /**
     * Get suggestion diagnostics for a specific file or all files.
     * @param file - Optional file to get diagnostics for. If omitted, returns diagnostics for all files.
     */
    getSuggestionDiagnostics(file) {
        const data = this.client.apiRequest("getSuggestionDiagnostics", {
            snapshot: this.snapshotId,
            project: this.projectId,
            ...(file !== undefined ? { file } : {}),
        });
        return data ?? [];
    }
    /**
     * Get declaration emit diagnostics for a specific file or all files.
     * @param file - Optional file to get diagnostics for. If omitted, returns diagnostics for all files.
     */
    getDeclarationDiagnostics(file) {
        const data = this.client.apiRequest("getDeclarationDiagnostics", {
            snapshot: this.snapshotId,
            project: this.projectId,
            ...(file !== undefined ? { file } : {}),
        });
        return data ?? [];
    }
    /**
     * Get program-wide diagnostics for the project, including compiler options diagnostics.
     */
    getProgramDiagnostics() {
        const data = this.client.apiRequest("getProgramDiagnostics", {
            snapshot: this.snapshotId,
            project: this.projectId,
        });
        return data ?? [];
    }
    /**
     * Get global (non-file-specific) semantic diagnostics for the project.
     */
    getGlobalDiagnostics() {
        const data = this.client.apiRequest("getGlobalDiagnostics", {
            snapshot: this.snapshotId,
            project: this.projectId,
        });
        return data ?? [];
    }
    /**
     * Get config file parsing diagnostics for the project.
     */
    getConfigFileParsingDiagnostics() {
        const data = this.client.apiRequest("getConfigFileParsingDiagnostics", {
            snapshot: this.snapshotId,
            project: this.projectId,
        });
        return data ?? [];
    }
}
export class Checker {
    snapshotId;
    projectId;
    client;
    objectRegistry;
    constructor(snapshotId, projectId, client, objectRegistry) {
        this.snapshotId = snapshotId;
        this.projectId = projectId;
        this.client = client;
        this.objectRegistry = objectRegistry;
    }
    dispose() {
        this.objectRegistry.clear();
    }
    getSymbolAtLocation(nodeOrNodes) {
        if (Array.isArray(nodeOrNodes)) {
            const data = this.client.apiRequest("getSymbolsAtLocations", {
                snapshot: this.snapshotId,
                project: this.projectId,
                locations: nodeOrNodes.map(node => getNodeId(node)),
            });
            return data.map(d => d ? this.objectRegistry.getOrCreateSymbol(d) : undefined);
        }
        const data = this.client.apiRequest("getSymbolAtLocation", {
            snapshot: this.snapshotId,
            project: this.projectId,
            location: getNodeId(nodeOrNodes),
        });
        return data ? this.objectRegistry.getOrCreateSymbol(data) : undefined;
    }
    getSymbolAtPosition(file, positionOrPositions) {
        if (typeof positionOrPositions === "number") {
            const data = this.client.apiRequest("getSymbolAtPosition", {
                snapshot: this.snapshotId,
                project: this.projectId,
                file,
                position: positionOrPositions,
            });
            return data ? this.objectRegistry.getOrCreateSymbol(data) : undefined;
        }
        const data = this.client.apiRequest("getSymbolsAtPositions", {
            snapshot: this.snapshotId,
            project: this.projectId,
            file,
            positions: positionOrPositions,
        });
        return data.map(d => d ? this.objectRegistry.getOrCreateSymbol(d) : undefined);
    }
    /** Batch-resolves symbols at every Identifier in a file (one RPC). Light symbol payloads. */
    getResolvedReferencesInFile(file, scope) {
        const data = this.client.apiRequest("getResolvedReferencesInFile", {
            snapshot: this.snapshotId,
            project: this.projectId,
            file,
            ...(scope ? { scope } : {}),
        });
        return data ?? { references: [], symbols: [] };
    }
    /** Spans of import/export alias declarations referenced as values (import elision). */
    getReferencedAliasDeclarations(file) {
        const data = this.client.apiRequest("getReferencedAliasDeclarations", {
            snapshot: this.snapshotId,
            project: this.projectId,
            file,
        });
        return data ?? [];
    }
    /** Register light symbols and return position → Symbol map for batch prefetch. */
    prefetchResolvedReferences(file, scope) {
        return this.prefetchResolvedReferencesWithScope(file, scope ?? "declarationNames");
    }
    prefetchResolvedReferencesWithScope(file, scope) {
        const data = this.getResolvedReferencesInFile(file, scope);
        const byId = new Map();
        for (const s of data.symbols) {
            byId.set(s.id, this.objectRegistry.getOrCreateSymbol(s));
        }
        // Eagerly hydrate declarations for all prefetched symbols in one RPC
        // so consumers reading symbol.declarations avoid N lazy fetches.
        this.objectRegistry.hydrateSymbolDeclarations(data.symbols.map(s => s.id));
        const byPos = new Map();
        for (const ref of data.references) {
            const sym = byId.get(ref.symbolId);
            if (ref.start != null)
                byPos.set(ref.start, sym);
            byPos.set(ref.position, sym);
        }
        return byPos;
    }
    getTypeOfSymbol(symbolOrSymbols) {
        if (Array.isArray(symbolOrSymbols)) {
            const data = this.client.apiRequest("getTypesOfSymbols", {
                snapshot: this.snapshotId,
                project: this.projectId,
                symbols: symbolOrSymbols.map(s => s.id),
            });
            return data.map(d => d ? this.objectRegistry.getOrCreateType(d) : undefined);
        }
        const data = this.client.apiRequest("getTypeOfSymbol", {
            snapshot: this.snapshotId,
            project: this.projectId,
            symbol: symbolOrSymbols.id,
        });
        return data ? this.objectRegistry.getOrCreateType(data) : undefined;
    }
    getDeclaredTypeOfSymbol(symbol) {
        const data = this.client.apiRequest("getDeclaredTypeOfSymbol", {
            snapshot: this.snapshotId,
            project: this.projectId,
            symbol: symbol.id,
        });
        return data ? this.objectRegistry.getOrCreateType(data) : undefined;
    }
    getReferencesToSymbolInFile(file, symbol) {
        const data = this.client.apiRequest("getReferencesToSymbolInFile", {
            snapshot: this.snapshotId,
            project: this.projectId,
            file,
            symbol: symbol.id,
        });
        return (data ?? []).map(h => new NodeHandle(h));
    }
    getReferencedSymbolsForNode(node, position) {
        const data = this.client.apiRequest("getReferencedSymbolsForNode", {
            snapshot: this.snapshotId,
            project: this.projectId,
            node: getNodeId(node),
            position,
        });
        return (data ?? []).map(entry => ({
            definition: new NodeHandle(entry.definition),
            symbol: entry.symbol ? this.objectRegistry.getOrCreateSymbol(entry.symbol) : undefined,
            references: (entry.references ?? []).map(h => new NodeHandle(h)),
        }));
    }
    getSignatureUsage(signatureDecl) {
        const data = this.client.apiRequest("getSignatureUsages", {
            snapshot: this.snapshotId,
            project: this.projectId,
            signatureDecl: getNodeId(signatureDecl),
        });
        return (data ?? []).map(entry => ({
            name: new NodeHandle(entry.name),
            call: entry.call ? new NodeHandle(entry.call) : undefined,
        }));
    }
    getCompletionsAtPosition(document, position, options) {
        const data = this.client.apiRequest("getCompletionsAtPosition", {
            snapshot: this.snapshotId,
            project: this.projectId,
            file: document,
            position,
            triggerCharacter: options?.triggerCharacter,
            includeSymbol: options?.includeSymbol,
        });
        if (!data)
            return undefined;
        return {
            isIncomplete: data.isIncomplete,
            entries: data.entries.map(e => ({
                ...e,
                symbol: e.symbol ? this.objectRegistry.getOrCreateSymbol(e.symbol) : undefined,
            })),
        };
    }
    getTypeAtLocation(nodeOrNodes) {
        if (Array.isArray(nodeOrNodes)) {
            const data = this.client.apiRequest("getTypeAtLocations", {
                snapshot: this.snapshotId,
                project: this.projectId,
                locations: nodeOrNodes.map(node => getNodeId(node)),
            });
            return data.map(d => d ? this.objectRegistry.getOrCreateType(d) : undefined);
        }
        const data = this.client.apiRequest("getTypeAtLocation", {
            snapshot: this.snapshotId,
            project: this.projectId,
            location: getNodeId(nodeOrNodes),
        });
        return data ? this.objectRegistry.getOrCreateType(data) : undefined;
    }
    getSignaturesOfType(type, kind) {
        const data = this.client.apiRequest("getSignaturesOfType", {
            snapshot: this.snapshotId,
            project: this.projectId,
            type: type.id,
            kind,
        });
        return data.map(d => this.objectRegistry.getOrCreateSignature(d));
    }
    getResolvedSignature(node) {
        const data = this.client.apiRequest("getResolvedSignature", {
            snapshot: this.snapshotId,
            project: this.projectId,
            location: getNodeId(node),
        });
        return data ? this.objectRegistry.getOrCreateSignature(data) : undefined;
    }
    getTypeAtPosition(file, positionOrPositions) {
        if (typeof positionOrPositions === "number") {
            const data = this.client.apiRequest("getTypeAtPosition", {
                snapshot: this.snapshotId,
                project: this.projectId,
                file,
                position: positionOrPositions,
            });
            return data ? this.objectRegistry.getOrCreateType(data) : undefined;
        }
        const data = this.client.apiRequest("getTypesAtPositions", {
            snapshot: this.snapshotId,
            project: this.projectId,
            file,
            positions: positionOrPositions,
        });
        return data.map(d => d ? this.objectRegistry.getOrCreateType(d) : undefined);
    }
    resolveName(name, meaning, location, excludeGlobals) {
        // Distinguish Node (has `kind`) from DocumentPosition (has `document` and `position`)
        const isNode = location && "kind" in location;
        const data = this.client.apiRequest("resolveName", {
            snapshot: this.snapshotId,
            project: this.projectId,
            name,
            meaning,
            location: isNode ? getNodeId(location) : undefined,
            file: !isNode && location ? location.document : undefined,
            position: !isNode && location ? location.position : undefined,
            excludeGlobals,
        });
        return data ? this.objectRegistry.getOrCreateSymbol(data) : undefined;
    }
    getResolvedSymbol(node) {
        const text = node.text;
        if (!text)
            return undefined;
        return this.resolveName(text, SymbolFlags.Value | SymbolFlags.ExportValue, node);
    }
    getContextualType(node) {
        const data = this.client.apiRequest("getContextualType", {
            snapshot: this.snapshotId,
            project: this.projectId,
            location: getNodeId(node),
        });
        return data ? this.objectRegistry.getOrCreateType(data) : undefined;
    }
    getBaseTypeOfLiteralType(type) {
        const data = this.client.apiRequest("getBaseTypeOfLiteralType", {
            snapshot: this.snapshotId,
            project: this.projectId,
            type: type.id,
        });
        return data ? this.objectRegistry.getOrCreateType(data) : undefined;
    }
    getNonNullableType(type) {
        const data = this.client.apiRequest("getNonNullableType", {
            snapshot: this.snapshotId,
            project: this.projectId,
            type: type.id,
        });
        return data ? this.objectRegistry.getOrCreateType(data) : undefined;
    }
    getNonOptionalType(type) {
        const data = this.client.apiRequest("getNonOptionalType", {
            snapshot: this.snapshotId,
            project: this.projectId,
            type: type.id,
        });
        return data ? this.objectRegistry.getOrCreateType(data) : undefined;
    }
    getTypeFromTypeNode(node) {
        const data = this.client.apiRequest("getTypeFromTypeNode", {
            snapshot: this.snapshotId,
            project: this.projectId,
            location: getNodeId(node),
        });
        return data ? this.objectRegistry.getOrCreateType(data) : undefined;
    }
    getWidenedType(type) {
        const data = this.client.apiRequest("getWidenedType", {
            snapshot: this.snapshotId,
            project: this.projectId,
            type: type.id,
        });
        return data ? this.objectRegistry.getOrCreateType(data) : undefined;
    }
    getParameterType(signature, index) {
        const data = this.client.apiRequest("getParameterType", {
            snapshot: this.snapshotId,
            project: this.projectId,
            signature: signature.id,
            index,
        });
        return data ? this.objectRegistry.getOrCreateType(data) : undefined;
    }
    isArrayLikeType(type) {
        return this.client.apiRequest("isArrayLikeType", {
            snapshot: this.snapshotId,
            project: this.projectId,
            type: type.id,
        });
    }
    isTypeAssignableTo(source, target) {
        return this.client.apiRequest("isTypeAssignableTo", {
            snapshot: this.snapshotId,
            project: this.projectId,
            source: source.id,
            target: target.id,
        });
    }
    getShorthandAssignmentValueSymbol(node) {
        const data = this.client.apiRequest("getShorthandAssignmentValueSymbol", {
            snapshot: this.snapshotId,
            project: this.projectId,
            location: getNodeId(node),
        });
        return data ? this.objectRegistry.getOrCreateSymbol(data) : undefined;
    }
    getTypeOfSymbolAtLocation(symbol, location) {
        const data = this.client.apiRequest("getTypeOfSymbolAtLocation", {
            snapshot: this.snapshotId,
            project: this.projectId,
            symbol: symbol.id,
            location: getNodeId(location),
        });
        return data ? this.objectRegistry.getOrCreateType(data) : undefined;
    }
    getIntrinsicType(method) {
        const data = this.client.apiRequest(method, {
            snapshot: this.snapshotId,
            project: this.projectId,
        });
        return this.objectRegistry.getOrCreateType(data);
    }
    getAnyType() {
        return this.getIntrinsicType("getAnyType");
    }
    getStringType() {
        return this.getIntrinsicType("getStringType");
    }
    getNumberType() {
        return this.getIntrinsicType("getNumberType");
    }
    getBooleanType() {
        return this.getIntrinsicType("getBooleanType");
    }
    getVoidType() {
        return this.getIntrinsicType("getVoidType");
    }
    getUndefinedType() {
        return this.getIntrinsicType("getUndefinedType");
    }
    getNullType() {
        return this.getIntrinsicType("getNullType");
    }
    getNeverType() {
        return this.getIntrinsicType("getNeverType");
    }
    getUnknownType() {
        return this.getIntrinsicType("getUnknownType");
    }
    getBigIntType() {
        return this.getIntrinsicType("getBigIntType");
    }
    getESSymbolType() {
        return this.getIntrinsicType("getESSymbolType");
    }
    getTrueType() {
        return this.getIntrinsicType("getTrueType");
    }
    getFalseType() {
        return this.getIntrinsicType("getFalseType");
    }
    getTypeOfAssignmentPattern(node) {
        const data = this.client.apiRequest("getTypeOfAssignmentPattern", {
            snapshot: this.snapshotId,
            project: this.projectId,
            location: getNodeId(node),
        });
        return data ? this.objectRegistry.getOrCreateType(data) : undefined;
    }
    getContextualTypeForObjectLiteralElement(node) {
        const data = this.client.apiRequest("getContextualTypeForObjectLiteralElement", {
            snapshot: this.snapshotId,
            project: this.projectId,
            location: getNodeId(node),
        });
        return data ? this.objectRegistry.getOrCreateType(data) : undefined;
    }
    getTypeOfPropertyOfType(type, name) {
        const data = this.client.apiRequest("getTypeOfPropertyOfType", {
            snapshot: this.snapshotId,
            project: this.projectId,
            type: type.id,
            name,
        });
        return data ? this.objectRegistry.getOrCreateType(data) : undefined;
    }
    typeToTypeNode(type, enclosingDeclaration, flags) {
        const binaryData = this.client.apiRequestBinary("typeToTypeNode", {
            snapshot: this.snapshotId,
            project: this.projectId,
            type: type.id,
            location: enclosingDeclaration ? getNodeId(enclosingDeclaration) : undefined,
            flags,
        });
        if (!binaryData)
            return undefined;
        return decodeNode(binaryData);
    }
    signatureToSignatureDeclaration(signature, kind, enclosingDeclaration, flags) {
        const binaryData = this.client.apiRequestBinary("signatureToSignatureDeclaration", {
            snapshot: this.snapshotId,
            project: this.projectId,
            signature: signature.id,
            kind,
            location: enclosingDeclaration ? getNodeId(enclosingDeclaration) : undefined,
            flags,
        });
        if (!binaryData)
            return undefined;
        return decodeNode(binaryData);
    }
    typeToString(type, enclosingDeclaration, flags) {
        return this.client.apiRequest("typeToString", {
            snapshot: this.snapshotId,
            project: this.projectId,
            type: type.id,
            location: enclosingDeclaration ? getNodeId(enclosingDeclaration) : undefined,
            flags,
        });
    }
    isContextSensitive(node) {
        return this.client.apiRequest("isContextSensitive", {
            snapshot: this.snapshotId,
            project: this.projectId,
            location: getNodeId(node),
        });
    }
    isArrayType(type) {
        return this.client.apiRequest("isArrayType", {
            snapshot: this.snapshotId,
            project: this.projectId,
            type: type.id,
        });
    }
    isTupleType(type) {
        return this.client.apiRequest("isTupleType", {
            snapshot: this.snapshotId,
            project: this.projectId,
            type: type.id,
        });
    }
    getReturnTypeOfSignature(signature) {
        const data = this.client.apiRequest("getReturnTypeOfSignature", {
            snapshot: this.snapshotId,
            project: this.projectId,
            signature: signature.id,
        });
        return data ? this.objectRegistry.getOrCreateType(data) : undefined;
    }
    getRestTypeOfSignature(signature) {
        const data = this.client.apiRequest("getRestTypeOfSignature", {
            snapshot: this.snapshotId,
            project: this.projectId,
            signature: signature.id,
        });
        return data ? this.objectRegistry.getOrCreateType(data) : undefined;
    }
    getTypePredicateOfSignature(signature) {
        const data = this.client.apiRequest("getTypePredicateOfSignature", {
            snapshot: this.snapshotId,
            project: this.projectId,
            signature: signature.id,
        });
        if (!data)
            return undefined;
        return {
            kind: data.kind,
            parameterIndex: data.parameterIndex,
            parameterName: data.parameterName,
            type: data.type ? this.objectRegistry.getOrCreateType(data.type) : undefined,
        };
    }
    /**
     * Get the base types of a class or interface type. A type with no base types
     * yields an empty array.
     */
    getBaseTypes(type) {
        const data = this.client.apiRequest("getBaseTypes", {
            snapshot: this.snapshotId,
            project: this.projectId,
            type: type.id,
        });
        return data ? data.map(d => this.objectRegistry.getOrCreateType(d)) : [];
    }
    getApparentType(type) {
        const data = this.client.apiRequest("getApparentType", {
            snapshot: this.snapshotId,
            project: this.projectId,
            type: type.id,
        });
        return data ? this.objectRegistry.getOrCreateType(data) : undefined;
    }
    getPropertiesOfType(type) {
        const data = this.client.apiRequest("getPropertiesOfType", {
            snapshot: this.snapshotId,
            project: this.projectId,
            type: type.id,
        });
        return data ? data.map(d => this.objectRegistry.getOrCreateSymbol(d)) : [];
    }
    getIndexInfosOfType(type) {
        const data = this.client.apiRequest("getIndexInfosOfType", {
            snapshot: this.snapshotId,
            project: this.projectId,
            type: type.id,
        });
        if (!data)
            return [];
        return data.map(d => ({
            keyType: this.objectRegistry.getOrCreateType(d.keyType),
            valueType: this.objectRegistry.getOrCreateType(d.valueType),
            isReadonly: d.isReadonly ?? false,
            declaration: d.declaration ? new NodeHandle(d.declaration) : undefined,
        }));
    }
    /**
     * Get the constraint of a type parameter (the `T` in `<U extends T>`), or
     * undefined if it has none.
     */
    getConstraintOfTypeParameter(type) {
        const data = this.client.apiRequest("getConstraintOfTypeParameter", {
            snapshot: this.snapshotId,
            project: this.projectId,
            type: type.id,
        });
        return data ? this.objectRegistry.getOrCreateType(data) : undefined;
    }
    getBaseConstraintOfType(type) {
        const data = this.client.apiRequest("getBaseConstraintOfType", {
            snapshot: this.snapshotId,
            project: this.projectId,
            type: type.id,
        });
        return data ? this.objectRegistry.getOrCreateType(data) : undefined;
    }
    getPropertyOfType(type, name) {
        const data = this.client.apiRequest("getPropertyOfType", {
            snapshot: this.snapshotId,
            project: this.projectId,
            type: type.id,
            name,
        });
        return data ? this.objectRegistry.getOrCreateSymbol(data) : undefined;
    }
    getConstantValue(node) {
        const data = this.client.apiRequest("getConstantValue", {
            snapshot: this.snapshotId,
            project: this.projectId,
            location: getNodeId(node),
        });
        return data ?? undefined;
    }
    getSignatureFromDeclaration(node) {
        const data = this.client.apiRequest("getSignatureFromDeclaration", {
            snapshot: this.snapshotId,
            project: this.projectId,
            location: getNodeId(node),
        });
        return data ? this.objectRegistry.getOrCreateSignature(data) : undefined;
    }
    getExportSpecifierLocalTargetSymbol(node) {
        const data = this.client.apiRequest("getExportSpecifierLocalTargetSymbol", {
            snapshot: this.snapshotId,
            project: this.projectId,
            location: getNodeId(node),
        });
        return data ? this.objectRegistry.getOrCreateSymbol(data) : undefined;
    }
    getAliasedSymbol(symbol) {
        const data = this.client.apiRequest("getAliasedSymbol", {
            snapshot: this.snapshotId,
            project: this.projectId,
            symbol: symbol.id,
        });
        return data ? this.objectRegistry.getOrCreateSymbol(data) : undefined;
    }
    getImmediateAliasedSymbol(symbol) {
        const data = this.client.apiRequest("getImmediateAliasedSymbol", {
            snapshot: this.snapshotId,
            project: this.projectId,
            symbol: symbol.id,
        });
        return data ? this.objectRegistry.getOrCreateSymbol(data) : undefined;
    }
    getExportsOfModule(symbol) {
        const data = this.client.apiRequest("getExportsOfModule", {
            snapshot: this.snapshotId,
            project: this.projectId,
            symbol: symbol.id,
        });
        return data ? data.map(d => this.objectRegistry.getOrCreateSymbol(d)) : [];
    }
    getMemberInModuleExports(symbol, name) {
        const data = this.client.apiRequest("getMemberInModuleExports", {
            snapshot: this.snapshotId,
            project: this.projectId,
            symbol: symbol.id,
            name,
        });
        return data ? this.objectRegistry.getOrCreateSymbol(data) : undefined;
    }
    getJsDocTagsOfSymbol(symbol) {
        const data = this.client.apiRequest("getJsDocTags", {
            snapshot: this.snapshotId,
            project: this.projectId,
            symbol: symbol.id,
        });
        return data ?? [];
    }
    getDocumentationCommentOfSymbol(symbol) {
        return this.client.apiRequest("getDocumentationComment", {
            snapshot: this.snapshotId,
            project: this.projectId,
            symbol: symbol.id,
        });
    }
    /**
     * Get the type arguments of a type reference (e.g. the `string` in `Array<string>`).
     */
    getTypeArguments(type) {
        const data = this.client.apiRequest("getTypeArguments", {
            snapshot: this.snapshotId,
            project: this.projectId,
            type: type.id,
        });
        return data ? data.map(d => this.objectRegistry.getOrCreateType(d)) : [];
    }
}
export class Emitter {
    client;
    constructor(client) {
        this.client = client;
    }
    printNode(node, options = {}) {
        const encoded = encodeNode(node);
        const base64 = uint8ArrayToBase64(encoded);
        return this.client.apiRequest("printNode", {
            data: base64,
            ...options,
        });
    }
}
// Remaps a raw tsgo SyntaxKind to the consumer's SyntaxKind. The tsgo and
// fork (drop-in `typescript`) SyntaxKind enums diverge by ~180 values, so a
// NodeHandle's kind — parsed straight from the wire handle string as the RAW
// tsgo kind — must be remapped before `ts.isXxx(handle)` type-guards (which
// compare against fork kind values) can fire correctly. RemoteNode.kind is
// already remapped via a prototype getter, but NodeHandle.kind is a
// constructor-set own property, so the remap has to happen here at
// construction time. The fork installs the hook once its remap table is built
// (see setNodeHandleKindRemap); when unset, kind passes through unchanged.
let _nodeHandleKindRemap;
/**
 * Install a kind-remap function applied to every NodeHandle's `kind` at
 * construction. Pass `undefined` to clear. Idempotent.
 */
export function setNodeHandleKindRemap(remap) {
    _nodeHandleKindRemap = remap;
}
export class NodeHandle {
    index;
    kind;
    path;
    constructor(handle) {
        const parsed = parseNodeHandle(handle);
        this.index = parsed.index;
        this.kind = (_nodeHandleKindRemap ? _nodeHandleKindRemap(parsed.kind) : parsed.kind);
        this.path = parsed.path;
    }
    /**
     * Resolve this handle to the actual AST node by fetching the source file
     * from the given project and looking up the node by index.
     */
    resolve(project) {
        const sourceFile = project.program.getSourceFile(this.path);
        if (!sourceFile) {
            return undefined;
        }
        return sourceFile.getOrCreateNodeAtIndex(this.index);
    }
}
export class Symbol {
    objectRegistry;
    id;
    name;
    flags;
    checkFlags;
    _parentId;
    _parentOverride;
    exportSymbol;
    // Declarations are lazy: "light" prefetch symbols (getResolvedReferencesInFile)
    // carry only id/name/flags to keep the per-file payload small, so the wire
    // data omits the declarations entirely. When a consumer reads `.declarations`
    // / `.valueDeclaration` on such a symbol (e.g. the scope manager building
    // variable defs for no-func-assign), fetch the full set on demand by id.
    // Full responses (newSymbolResponse) include the declaration fields up front,
    // in which case no follow-up request is made.
    _declarations;
    _valueDeclaration;
    _declarationsResolved;
    constructor(data, objectRegistry) {
        this.objectRegistry = objectRegistry;
        this.id = data.id;
        this.name = data.name;
        this.flags = data.flags;
        this.checkFlags = data.checkFlags;
        // A response that carries either declaration field is "full" — record
        // the declarations and skip the lazy fetch. A light response omits both;
        // defer until first access.
        if (data.declarations !== undefined || data.valueDeclaration !== undefined) {
            this._declarations = (data.declarations ?? []).map(d => new NodeHandle(d));
            this._valueDeclaration = data.valueDeclaration ? new NodeHandle(data.valueDeclaration) : undefined;
            this._declarationsResolved = true;
        }
        else {
            this._declarations = undefined;
            this._valueDeclaration = undefined;
            this._declarationsResolved = false;
        }
        if (data.parent !== undefined)
            this._parentId = data.parent;
        if (data.exportSymbol !== undefined)
            this.exportSymbol = data.exportSymbol;
    }
    ensureDeclarations() {
        if (this._declarationsResolved)
            return;
        this._declarationsResolved = true;
        const data = this.objectRegistry.fetchSymbolDeclarations(this.id);
        this.applyDeclarationPayload(data);
    }
    /** @internal Used by batch hydrate after prefetch. */
    hasDeclarationsResolved() {
        return this._declarationsResolved;
    }
    /** @internal Apply full or empty declaration payload from RPC. */
    applyDeclarationPayload(data) {
        this._declarationsResolved = true;
        if (data) {
            this._declarations = (data.declarations ?? []).map(d => new NodeHandle(d));
            this._valueDeclaration = data.valueDeclaration ? new NodeHandle(data.valueDeclaration) : undefined;
        }
        else {
            this._declarations = [];
            this._valueDeclaration = undefined;
        }
    }
    get declarations() {
        this.ensureDeclarations();
        return this._declarations ?? [];
    }
    get valueDeclaration() {
        this.ensureDeclarations();
        return this._valueDeclaration;
    }
    getParent() {
        return this.parent;
    }
    // TS API contract: `.parent` is the containing Symbol. The wire format
    // carries a raw SymbolID; resolve lazily through the registry (cached).
    get parent() {
        if (this._parentOverride !== undefined) return this._parentOverride;
        if (this._parentId === undefined) return undefined;
        return this.objectRegistry.fetchSymbol(this, "getParentOfSymbol", this._parentId);
    }
    set parent(value) {
        this._parentOverride = value;
    }
    getMembers() {
        return this.objectRegistry.fetchSymbols(this, "getMembersOfSymbol");
    }
    getExports() {
        return this.objectRegistry.fetchSymbols(this, "getExportsOfSymbol");
    }
    // TS API contract: symbol.exports is a Map of export name -> Symbol.
    // Consumers do identity compares against it (flamework simplifyUnion:
    // `memberType.symbol === enumSymbol.exports.get(name)`), so entries must
    // be the same registry singletons other APIs return.
    get exports() {
        if (this._exportsMap) return this._exportsMap;
        let syms;
        try { syms = this.getExports() ?? []; } catch { syms = []; }
        const map = new Map();
        for (const s of syms) map.set(s.escapedName ?? s.name, s);
        this._exportsMap = map;
        return map;
    }
    set exports(value) {
        this._exportsMap = value;
    }
    // TS API contract: symbol.members mirrors exports for member tables.
    get members() {
        if (this._membersMap) return this._membersMap;
        let syms;
        try { syms = this.getMembers() ?? []; } catch { syms = []; }
        const map = new Map();
        for (const s of syms) map.set(s.escapedName ?? s.name, s);
        this._membersMap = map;
        return map;
    }
    set members(value) {
        this._membersMap = value;
    }
    getExportSymbol() {
        if (!this.exportSymbol)
            return this;
        return this.objectRegistry.fetchSymbol(this, "getExportSymbolOfSymbol", this.exportSymbol);
    }
    getJsDocTags(checker) {
        return checker.getJsDocTagsOfSymbol(this);
    }
    getDocumentationComment(checker) {
        return checker.getDocumentationCommentOfSymbol(this);
    }
}
class TypeObject {
    objectRegistry;
    id;
    flags;
    objectFlags;
    symbol;
    value;
    intrinsicName;
    isThisType;
    freshType;
    regularType;
    target;
    typeParameters;
    outerTypeParameters;
    localTypeParameters;
    aliasTypeArguments;
    aliasSymbol;
    elementFlags;
    fixedLength;
    readonly;
    texts;
    objectType;
    indexType;
    checkType;
    extendsType;
    baseType;
    substConstraint;
    trueType; // false if not yet loaded
    falseType; // false if not yet loaded
    constructor(data, objectRegistry) {
        this.objectRegistry = objectRegistry;
        this.id = data.id;
        this.flags = data.flags;
        if (data.objectFlags !== undefined)
            this.objectFlags = data.objectFlags;
        if (data.symbol !== undefined)
            this.symbol = data.symbol;
        if (data.value != null) {
            // BigInt literal values are serialized as decimal strings (e.g. "-123") because
            // JSON cannot represent bigint. Decode them back into a real bigint here.
            this.value = (data.flags & TypeFlags.BigIntLiteral) ? BigInt(data.value) : data.value;
        }
        if (data.intrinsicName !== undefined)
            this.intrinsicName = data.intrinsicName;
        if (data.isThisType !== undefined)
            this.isThisType = data.isThisType;
        if (data.freshType !== undefined)
            this.freshType = data.freshType;
        if (data.regularType !== undefined)
            this.regularType = data.regularType;
        if (data.target !== undefined)
            this.target = data.target;
        this.typeParameters = data.typeParameters ?? [];
        this.outerTypeParameters = data.outerTypeParameters ?? [];
        this.localTypeParameters = data.localTypeParameters ?? [];
        this.aliasTypeArguments = data.aliasTypeArguments ?? [];
        if (data.aliasSymbol !== undefined)
            this.aliasSymbol = data.aliasSymbol;
        if (data.elementFlags !== undefined)
            this.elementFlags = data.elementFlags;
        if (data.fixedLength !== undefined)
            this.fixedLength = data.fixedLength;
        if (data.readonly !== undefined)
            this.readonly = data.readonly;
        if (data.texts !== undefined)
            this.texts = data.texts;
        if (data.objectType !== undefined)
            this.objectType = data.objectType;
        if (data.indexType !== undefined)
            this.indexType = data.indexType;
        if (data.checkType !== undefined)
            this.checkType = data.checkType;
        if (data.extendsType !== undefined)
            this.extendsType = data.extendsType;
        if (data.baseType !== undefined)
            this.baseType = data.baseType;
        if (data.substConstraint !== undefined)
            this.substConstraint = data.substConstraint;
        this.trueType = false;
        this.falseType = false;
    }
    getSymbol() {
        return this.objectRegistry.fetchSymbol(this, "getSymbolOfType", this.symbol);
    }
    getAliasSymbol() {
        return this.objectRegistry.fetchSymbol(this, "getAliasSymbolOfType", this.aliasSymbol);
    }
    getTarget() {
        return this.objectRegistry.fetchType(this, "getTargetOfType", this.target);
    }
    getFreshType() {
        return this.objectRegistry.fetchType(this, "getFreshTypeOfType", this.freshType);
    }
    getRegularType() {
        return this.objectRegistry.fetchType(this, "getRegularTypeOfType", this.regularType);
    }
    getTypes() {
        // Only union, intersection, and template literal types have constituent
        // types; any other kind has none, so return undefined rather than sending
        // a request the server cannot satisfy.
        if (!(this.flags & (TypeFlags.UnionOrIntersection | TypeFlags.TemplateLiteral))) {
            return undefined;
        }
        return this.objectRegistry.fetchTypes(this, "getTypesOfType");
    }
    getTypeParameters() {
        return this.objectRegistry.fetchTypes(this, "getTypeParametersOfType", this.typeParameters);
    }
    getOuterTypeParameters() {
        return this.objectRegistry.fetchTypes(this, "getOuterTypeParametersOfType", this.outerTypeParameters);
    }
    getLocalTypeParameters() {
        return this.objectRegistry.fetchTypes(this, "getLocalTypeParametersOfType", this.localTypeParameters);
    }
    getAliasTypeArguments() {
        return this.objectRegistry.fetchTypes(this, "getAliasTypeArgumentsOfType", this.aliasTypeArguments);
    }
    getObjectType() {
        return this.objectRegistry.fetchType(this, "getObjectTypeOfType", this.objectType);
    }
    getIndexType() {
        return this.objectRegistry.fetchType(this, "getIndexTypeOfType", this.indexType);
    }
    getCheckType() {
        return this.objectRegistry.fetchType(this, "getCheckTypeOfType", this.checkType);
    }
    getExtendsType() {
        return this.objectRegistry.fetchType(this, "getExtendsTypeOfType", this.extendsType);
    }
    getBaseType() {
        return this.objectRegistry.fetchType(this, "getBaseTypeOfType", this.baseType);
    }
    getConstraint() {
        return this.objectRegistry.fetchType(this, "getConstraintOfType", this.substConstraint);
    }
    getTrueType() {
        const result = this.objectRegistry.fetchType(this, "getTrueTypeOfConditionalType", this.trueType);
        this.trueType = result.id;
        return result;
    }
    getFalseType() {
        const result = this.objectRegistry.fetchType(this, "getFalseTypeOfConditionalType", this.falseType);
        this.falseType = result.id;
        return result;
    }
    isUnionType() {
        return isUnionType(this);
    }
    isIntersectionType() {
        return isIntersectionType(this);
    }
    isObjectType() {
        return isObjectType(this);
    }
    isIntrinsicType() {
        return isIntrinsicType(this);
    }
    isLiteralType() {
        return isLiteralType(this);
    }
    isStringLiteralType() {
        return isStringLiteralType(this);
    }
    isNumberLiteralType() {
        return isNumberLiteralType(this);
    }
    isBigIntLiteralType() {
        return isBigIntLiteralType(this);
    }
    isBooleanLiteralType() {
        return isBooleanLiteralType(this);
    }
    isTypeReference() {
        return isTypeReference(this);
    }
    isTupleType() {
        return isTupleType(this);
    }
    // Stock TupleType.combinedFlags = OR of elementFlags. Consumers gate
    // fixed-arity emit on `target.combinedFlags & ElementFlags.Variable`
    // (roblox-ts) — leaving it undefined turns rest-element tuples into
    // "fixed" ones.
    get combinedFlags() {
        if (this.elementFlags === undefined) return undefined;
        let combined = 0;
        for (const f of this.elementFlags) combined |= f;
        return combined;
    }
    isIndexType() {
        return isIndexType(this);
    }
    isIndexedAccessType() {
        return isIndexedAccessType(this);
    }
    isConditionalType() {
        return isConditionalType(this);
    }
    isSubstitutionType() {
        return isSubstitutionType(this);
    }
    isTemplateLiteralType() {
        return isTemplateLiteralType(this);
    }
    isStringMappingType() {
        return isStringMappingType(this);
    }
    isTypeParameter() {
        return isTypeParameter(this);
    }
}
export function isUnionType(type) {
    return (type.flags & TypeFlags.Union) !== 0;
}
export function isIntersectionType(type) {
    return (type.flags & TypeFlags.Intersection) !== 0;
}
export function isObjectType(type) {
    return (type.flags & TypeFlags.Object) !== 0;
}
export function isIntrinsicType(type) {
    return (type.flags & TypeFlags.Intrinsic) !== 0;
}
export function isLiteralType(type) {
    return (type.flags & TypeFlags.Literal) !== 0;
}
export function isStringLiteralType(type) {
    return (type.flags & TypeFlags.StringLiteral) !== 0;
}
export function isNumberLiteralType(type) {
    return (type.flags & TypeFlags.NumberLiteral) !== 0;
}
export function isBigIntLiteralType(type) {
    return (type.flags & TypeFlags.BigIntLiteral) !== 0;
}
export function isBooleanLiteralType(type) {
    return (type.flags & TypeFlags.BooleanLiteral) !== 0;
}
export function isTypeReference(type) {
    return isObjectType(type) && (type.objectFlags & ObjectFlags.Reference) !== 0;
}
export function isTupleType(type) {
    return isObjectType(type) && (type.objectFlags & ObjectFlags.Tuple) !== 0;
}
export function isIndexType(type) {
    return (type.flags & TypeFlags.Index) !== 0;
}
export function isIndexedAccessType(type) {
    return (type.flags & TypeFlags.IndexedAccess) !== 0;
}
export function isConditionalType(type) {
    return (type.flags & TypeFlags.Conditional) !== 0;
}
export function isSubstitutionType(type) {
    return (type.flags & TypeFlags.Substitution) !== 0;
}
export function isTemplateLiteralType(type) {
    return (type.flags & TypeFlags.TemplateLiteral) !== 0;
}
export function isStringMappingType(type) {
    return (type.flags & TypeFlags.StringMapping) !== 0;
}
export function isTypeParameter(type) {
    return (type.flags & TypeFlags.TypeParameter) !== 0;
}
export class Signature {
    flags;
    objectRegistry;
    id;
    declaration;
    typeParameters;
    target;
    // Raw parameter symbol ids from the wire; resolved lazily by the
    // `parameters` getter. ts.Signature.parameters is an array of Symbol
    // objects (and ts-api-utils / rules read `signature.parameters[idx]`
    // directly, then pass it to checker.getTypeOfSymbolAtLocation), so exposing
    // raw ids here makes those callers send `undefined` as the symbol id and
    // the bridge reject it as an "empty symbol handle". Resolve to Symbols.
    _parameterIds;
    _parameters;
    _thisParameterId;
    _thisParameter;
    constructor(data, objectRegistry) {
        this.id = data.id;
        this.flags = data.flags;
        this.objectRegistry = objectRegistry;
        this.declaration = data.declaration ? new NodeHandle(data.declaration) : undefined;
        this.typeParameters = data.typeParameters ?? [];
        this._parameterIds = data.parameters ?? [];
        // Raw symbol id from the wire; resolved lazily by the `thisParameter`
        // getter. ts.Signature.thisParameter is a Symbol object — consumers
        // (roblox-ts method-vs-callback classification) read
        // `signature.thisParameter?.valueDeclaration` directly.
        this._thisParameterId = data.thisParameter;
        this.target = data.target;
    }
    get thisParameter() {
        if (this._thisParameter === undefined) {
            this._thisParameter = this._thisParameterId
                ? (this.objectRegistry.fetchSymbol(this, "getThisParameterOfSignature", this._thisParameterId) ?? null)
                : null;
        }
        return this._thisParameter ?? undefined;
    }
    get parameters() {
        if (this._parameters === undefined) {
            this._parameters = this.objectRegistry.fetchSymbols(this, "getParametersOfSignature", this._parameterIds);
        }
        return this._parameters;
    }
    getTypeParameters() {
        return this.objectRegistry.fetchTypes(this, "getTypeParametersOfSignature", this.typeParameters);
    }
    getParameters() {
        return this.parameters;
    }
    getThisParameter() {
        return this.objectRegistry.fetchSymbol(this, "getThisParameterOfSignature", this.thisParameter);
    }
    getTarget() {
        return this.objectRegistry.fetchSignature(this, "getTargetOfSignature", this.target);
    }
    get hasRestParameter() {
        return (this.flags & SignatureFlags.HasRestParameter) !== 0;
    }
    get isConstruct() {
        return (this.flags & SignatureFlags.Construct) !== 0;
    }
    get isAbstract() {
        return (this.flags & SignatureFlags.Abstract) !== 0;
    }
}
//# sourceMappingURL=api.js.map