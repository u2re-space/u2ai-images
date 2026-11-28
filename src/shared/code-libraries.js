/**
 * @file src/shared/code-libraries.js
 * @module shared/code-libraries
 * @purpose The libraries of the house, reachable from the code of the model.
 *
 *   The sandbox of Code Mode has no `import`: the realm of `node:vm` cannot load a module
 *   at all. The libraries live in the worker thread — the host of the sandbox — and the
 *   program reaches them through **named calls** over a facade.
 *
 *   The facade is the whole API of every library, and it stays safe because of one rule:
 *   **nothing of the host crosses the border**. The program names a call and gives plain
 *   data; the host runs it and answers with plain data. A native handle — a canvas, a
 *   document, a session — never leaves the host: it stays in a table, and the program holds
 *   an opaque id for it.
 *
 *   That rule is the whole security story. A host object inside the realm is an escape
 *   hatch (`hostObj.constructor.constructor('return process')()` walks straight out), and a
 *   realm function handed to the host is harmless. The border therefore carries data both
 *   ways and nothing else.
 *
 *   The libraries are optional: a package without them still works, and the facade says
 *   what is there.
 *
 * @depends none
 * @usedBy shared/code-mode, agent/code-mode
 * @exports LIBRARY_NAMES, libraryCatalog, createLibraryBridge, libraryAvailable
 * @ai.tags house, code-mode, libraries, canvas, magick, openvector
 * @ai.hint io
 */

/**
 * The libraries the house knows.
 *
 * Each one is loaded lazily and only when the package really has it: the wasm of
 * ImageMagick is a big file, and a package without it must not pay for it.
 */
export const LIBRARY_NAMES = Object.freeze(['canvas', 'magick', 'openvector']);

/**
 * The modules behind the names, and the way each of them is loaded.
 *
 * `openvector` and `canvas` are native: they are loaded with a plain import. The wasm of
 * ImageMagick needs its binary, so it is initialized here — once, and only when the
 * package really has it.
 */
const LOADERS = Object.freeze({
    canvas: async () => await import('canvas'),
    magick: async () => await loadMagick(),
    openvector: async () => await import('openvector'),
});

/**
 * Load the wasm of ImageMagick and initialize it.
 *
 * The wasm is a big file: it is read once, and the initialization is done once. A package
 * without the wasm still works — the library is simply not there.
 *
 * @returns {Promise<object|null>}
 */
async function loadMagick() {
    try {
        const module = await import('@imagemagick/magick-wasm');
        const wasmUrl = import.meta.resolve(process.arch === 'x64'
            ? '@imagemagick/magick-wasm/x64/magick.wasm'
            : '@imagemagick/magick-wasm/magick.wasm');
        const init = process.arch === 'x64'
            ? module.initializeImageMagickx64
            : module.initializeImageMagick;
        if (typeof init !== 'function') return null;
        const { readFile } = await import('node:fs/promises');
        await init(await readFile(new URL(wasmUrl)));
        return module;
    } catch {
        return null;
    }
}

/**
 * Call a member of a library, with or without `new`.
 *
 * A class cannot be called without `new`, and the check is not the source of the function:
 * a **native** class does not say `class`, it says `function CoreSession() { [native code] }`.
 * The source of a native class also cannot be told from the source of a native function by
 * reading it, and a native class does not even throw when it is called without `new` — it
 * answers with an object that has nothing in it.
 *
 * So the honest test is the **prototype**: a plain function may be called and may be used
 * with `new`; a class refuses `new` of its prototype without a `new` of the class itself.
 * The bridge tries the plain call, and when the answer is an object that carries no
 * prototype of its own — a broken native class — the call is made again with a `new`.
 *
 * @param {Function} fn the member
 * @param {object} owner the object the member belongs to
 * @param {unknown[]} args the arguments of the call
 * @returns {Promise<unknown>}
 */
async function callMember(fn, owner, args) {
    // The source of a class of JavaScript says `class`: that one is known.
    let source = '';
    try {
        source = Function.prototype.toString.call(fn);
    } catch {
        source = '';
    }
    if (/^\s*class[\s{]/.test(source)) {
        return new fn(...args);
    }
    const value = await fn.apply(owner, args);
    // A native class called without `new` answers with an empty object: it has no
    // prototype of its own, and it has no constructor. A plain object the library meant
    // to return has the prototype of `Object`.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const proto = Object.getPrototypeOf(value);
        if (proto === null) {
            // The answer of a broken native class. The real one is made with a `new`.
            return new fn(...args);
        }
    }
    return value;
}

/**
 * The library that is loaded, and the module behind it.
 *
 * The load is done once per name: the wasm of ImageMagick takes seconds, and a program
 * that calls it ten times must not pay ten times.
 */
const loaded = new Map();

/**
 * The module of a library, when the package has it.
 *
 * @param {string} name the name of the library
 * @returns {Promise<object|null>} the module, or null when the library is not there
 * @exports
 * @ai.hint io
 */
export async function libraryModule(name) {
    const key = String(name ?? '').trim();
    if (!LIBRARY_NAMES.includes(key)) return null;
    if (loaded.has(key)) return loaded.get(key);
    const loader = LOADERS[key];
    if (!loader) return null;
    const promise = (async () => {
        try {
            return await loader();
        } catch {
            // The package does not have the library, or the native build is missing.
            return null;
        }
    })();
    loaded.set(key, promise);
    const module = await promise;
    return module;
}

/**
 * Is a library usable in this installation?
 *
 * @param {string} name the name of the library
 * @returns {Promise<boolean>}
 * @exports
 * @ai.hint io
 */
export async function libraryAvailable(name) {
    return Boolean(await libraryModule(name));
}

/**
 * The catalogue of the libraries: what the program may call.
 *
 * The catalogue names the libraries and the operations each of them offers. It is the
 * answer to «what can I do here», and it is asked of the host, never built inside the
 * realm.
 *
 * @returns {Promise<Array<{ name: string, available: boolean, operations: string[] }>>}
 * @exports
 * @ai.hint io
 */
export async function libraryCatalog() {
    const out = [];
    for (const name of LIBRARY_NAMES) {
        const module = await libraryModule(name);
        out.push({
            name,
            available: Boolean(module),
            operations: module ? operationsOf(module) : [],
        });
    }
    return out;
}

/**
 * The operations a module offers: its functions and its classes, by name.
 *
 * The classes are there too: a class is a way to make an object, and the program needs
 * `new` to make one. The names of the constructor and of the prototype are the same
 * word, so the catalogue lists them once.
 *
 * @param {object} module the module of the library
 * @returns {string[]}
 * @ai.hint pure
 */
function operationsOf(module) {
    const names = new Set();
    for (const key of Object.keys(module ?? {})) {
        if (key === 'default') continue;
        names.add(key);
    }
    return [...names].sort();
}

/**
 * Is a value a plain object — data, and not a native handle?
 *
 * A plain object is built from `Object` or from nothing at all: it has a prototype of
 * `Object.prototype` or no prototype. A native object — a canvas, a document, a session —
 * has a prototype of its own, and it must not cross the border.
 *
 * @param {unknown} value the value
 * @returns {boolean}
 * @ai.hint pure
 */
function isPlainObject(value) {
    if (!value || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * The names of the facilities of the host.
 *
 * The facilities travel as **names**: the functions behind them live in the parent, and a
 * function is not data — it cannot ride along in the spec of the sandbox.
 *
 * @param {string[]|object|null} facilities the names, or a map of them
 * @returns {string[]}
 * @ai.hint pure
 */
function facilityNames(facilities) {
    if (Array.isArray(facilities)) {
        return facilities.map((item) => String(item ?? '').trim()).filter(Boolean);
    }
    if (facilities && typeof facilities === 'object') {
        return Object.keys(facilities).map((item) => String(item).trim()).filter(Boolean);
    }
    return [];
}

/**
 * The bridge between the program and the libraries.
 *
 * The bridge is the host side of the facade. It holds the table of the handles, runs the
 * calls and serializes the answers. The program never sees a module, a class or an
 * instance.
 *
 * The bridge also holds the **facilities** of the host: the things the house has and the
 * libraries do not — the API of the pictures, for one. A facility is called by name, the
 * same way a library is, and it answers with plain data.
 *
 * @param {{ libraries?: string[], maxHandles?: number, facilities?: object }} [options]
 *   `libraries` names the libraries the program may use; by default, all of them.
 *   `facilities` is a map of the calls the host offers: `{ name: async (args) => data }`.
 * @returns {{ call: Function, catalog: Function, release: Function, handles: number }}
 * @exports
 * @ai.hint io
 */
export function createLibraryBridge({ libraries = null, maxHandles = 256, facilities = null, onFacility = null } = {}) {    /** @type {Map<string, object>} */
    const handles = new Map();
    const wanted = Array.isArray(libraries) && libraries.length
        ? libraries.map((item) => String(item ?? '').trim()).filter(Boolean)
        : [...LIBRARY_NAMES];
    let counter = 0;

    /**
     * The id of a handle, and the handle itself.
     * @param {object} value
     * @returns {string}
     */
    const keep = (value) => {
        counter += 1;
        const id = `h${counter}`;
        handles.set(id, value);
        // The table is bounded: a program that makes handles forever must not eat the
        // memory of the host.
        while (handles.size > maxHandles) {
            const oldest = handles.keys().next().value;
            if (oldest === undefined) break;
            handles.delete(oldest);
        }
        return id;
    };

    /**
     * The answer of a call, as plain data.
     *
     * A native handle never leaves the host: it becomes an id. Everything else is
     * serialized, and what cannot be serialized becomes a short note.
     *
     * @param {unknown} value the value the library returned
     * @returns {unknown} the plain data of the answer
     */
    const plain = (value) => {
        if (value === null || value === undefined) return null;
        const kind = typeof value;
        if (kind === 'string' || kind === 'number' || kind === 'boolean') return value;
        if (kind === 'bigint') return String(value);
        if (kind === 'function') return '[function]';
        if (kind === 'symbol') return String(value);
        if (value instanceof Uint8Array) return { bytes: Buffer.from(value).toString('base64') };
        if (value instanceof ArrayBuffer) return { bytes: Buffer.from(new Uint8Array(value)).toString('base64') };
        if (Buffer.isBuffer(value)) return { bytes: value.toString('base64') };
        if (Array.isArray(value)) return value.slice(0, 256).map((item) => plain(item));
        if (value instanceof Date) return value.toISOString();
        // A native object — a canvas, a document, a session — stays on this side.
        if (typeof value === 'object') {
            if (typeof value.toBase64 === 'function') {
                // The session of the wasm hands its bytes over in base64.
                try {
                    return { bytes: String(value.toBase64()) };
                } catch {
                    /* The object is not a picture after all. */
                }
            }
            // A **plain** object is data, not a handle: the answer of a facility is one,
            // and it must reach the program as it is.
            if (isPlainObject(value)) {
                const out = {};
                for (const [key, item] of Object.entries(value)) {
                    out[key] = plain(item);
                }
                return out;
            }
            // The id of the handle is the id itself, so the program can use it in the path
            // of the next call without unwrapping it.
            return keep(value);
        }
        return null;
    };

    /**
     * The target of a call: a library, or a handle of the table.
     *
     * @param {string} path the path of the call
     * @returns {{ target: object|null, name: string, handle: string|null }}
     */
    const targetOf = (path) => {
        const text = String(path ?? '').trim();
        if (!text) return { target: null, name: '', handle: null };
        const dot = text.indexOf('.');
        if (dot < 0) return { target: null, name: text, handle: null };
        const head = text.slice(0, dot);
        const name = text.slice(dot + 1);
        if (handles.has(head)) {
            return { target: handles.get(head), name, handle: head };
        }
        return { target: null, name: text, handle: null };
    };

    return {
        /**
         * The number of the handles the table holds.
         * @returns {number}
         */
        handles: () => handles.size,

        /**
         * The catalogue of the libraries.
         * @returns {Promise<object[]>}
         */
        catalog: async () => {
            const out = [];
            for (const name of wanted) {
                const module = await libraryModule(name);
                out.push({
                    name,
                    available: Boolean(module),
                    operations: module ? operationsOf(module) : [],
                });
            }
            // The facilities of the host: the things the house has and the libraries do
            // not — the API of the pictures, for one.
            for (const name of facilityNames(facilities).sort()) {
                out.push({ name, available: true, operations: [], facility: true });
            }
            return out;
        },

        /**
         * Run one call of the program.
         *
         * The path names the library and the member: `canvas.createCanvas`, or the member
         * of a handle the program made earlier: `h3.toDataURL`.
         *
         * @param {string} path the path of the call
         * @param {string} argsJson the arguments of the call, as JSON
         * @returns {Promise<string>} the answer, as JSON
         */
        call: async (path, argsJson) => {
            const text = String(path ?? '').trim();
            if (!text) {
                return JSON.stringify({ ok: false, error: 'the call names nothing' });
            }
            let args = [];
            try {
                const parsed = JSON.parse(String(argsJson ?? '[]'));
                args = Array.isArray(parsed) ? parsed : [parsed];
            } catch {
                args = [];
            }
            // The bytes of the picture travel as base64: a native module wants a `Buffer`,
            // and a `Buffer` is not plain data.
            args = args.map((item) => (item && typeof item === 'object' && typeof item.bytes === 'string'
                ? Buffer.from(item.bytes, 'base64')
                : item));
            const { target, name, handle } = targetOf(text);
            try {
                // A call on a facility of the host: the API of the pictures, for one. The
                // facility is named like a library, and it travels to the parent — the
                // function behind it lives there, not in this thread.
                if (facilityNames(facilities).includes(text)) {
                    if (typeof onFacility !== 'function') {
                        return JSON.stringify({ ok: false, error: `There is no facility named ${text}.` });
                    }
                    const value = await onFacility(text, args[0] ?? {});
                    return JSON.stringify({ ok: true, value: plain(value) });
                }
                // A call on a handle: the member of the object the program made.
                if (target) {
                    const member = target[name];
                    if (typeof member !== 'function') {
                        // A member that is not a call is a value: the program may read it.
                        if (member === undefined || member === null) {
                            return JSON.stringify({ ok: false, error: `the handle has no member named ${name}` });
                        }
                        return JSON.stringify({ ok: true, value: plain(member), handle });
                    }
                    const value = await callMember(member, target, args);
                    return JSON.stringify({ ok: true, value: plain(value), handle });
                }
                // A call on a library: `canvas.createCanvas` or `magick.ImageMagick.read`.
                const dot = text.indexOf('.');
                if (dot < 0) {
                    return JSON.stringify({ ok: false, error: 'the call names no member' });
                }
                const library = text.slice(0, dot);
                if (!wanted.includes(library)) {
                    return JSON.stringify({ ok: false, error: `the library ${library} is not available here` });
                }
                const module = await libraryModule(library);
                if (!module) {
                    return JSON.stringify({ ok: false, error: `the library ${library} is not installed` });
                }
                const member = text.slice(dot + 1);
                const parts = member.split('.');
                let owner = module;
                for (const part of parts.slice(0, -1)) {
                    owner = owner?.[part];
                    if (owner === undefined || owner === null) break;
                }
                const last = parts[parts.length - 1];
                const fn = owner?.[last];
                if (typeof fn !== 'function') {
                    // A member that is not a call is a value: a constant, a version, a
                    // setting of the library. The program may read it.
                    if (fn === undefined || fn === null) {
                        return JSON.stringify({ ok: false, error: `the library ${library} has no member named ${member}` });
                    }
                    return JSON.stringify({ ok: true, value: plain(fn) });
                }
                // A class cannot be called without `new`: the call itself tells.
                const value = await callMember(fn, owner, args);
                return JSON.stringify({ ok: true, value: plain(value) });
            } catch (error) {
                return JSON.stringify({
                    ok: false,
                    error: error?.message ?? String(error),
                });
            }
        },

        /**
         * Let go of every handle.
         * @returns {void}
         */
        release: () => { handles.clear(); },
    };
}
