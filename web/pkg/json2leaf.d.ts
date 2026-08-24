/* tslint:disable */
/* eslint-disable */

export class TrigramIndex {
    free(): void;
    [Symbol.dispose](): void;
    add(id: string, text: string): void;
    constructor();
    search(query: string, limit: number): string;
}

export function jsonToDot(name: string, input: string, config_json?: string | null): string;

export function jsonToInsertSql(name: string, input: string, config_json?: string | null): string;

export function jsonToSql(name: string, input: string, config_json?: string | null): string;

export function mapJson(name: string, input: string, config_json?: string | null): string;

export function mapJsonCompact(name: string, input: Uint8Array, config_json?: string | null): Uint8Array;

export function mapXml(name: string, input: string, config_json?: string | null): string;

export function mapXmlCompact(name: string, input: Uint8Array, config_json?: string | null): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_trigramindex_free: (a: number, b: number) => void;
    readonly jsonToDot: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly jsonToInsertSql: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly jsonToSql: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly mapJson: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly mapJsonCompact: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly mapXml: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly mapXmlCompact: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly trigramindex_add: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly trigramindex_new: () => number;
    readonly trigramindex_search: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
