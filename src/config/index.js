/**
 * @file src/config/index.js
 * @module config/index
 * @purpose The loader of the configuration of the image CLI.
 *
 * Precedence: defaults < ~/.ai-image/config.json < --config file < AI_IMAGE_*
 * environment < the flags of the command. After the merge the placeholders are
 * expanded, the primary backend is chosen, the config is validated and the
 * paths of the home directory are attached.
 * @exports loadConfig, ensureConfigFile, redactConfig, resolveBackend
 * @ai.tags config
 * @ai.hint keep
 */

import { fromEnv, envConfigPath } from './env.js';
import { isRecord } from './merge.js';
import { KiB } from './constants.js';
import { defaultConfigText } from './defaults.js';
import { readConfigFile, writeConfigFile, expandPlaceholders, mergeSources } from './parser.js';
import { defaultHome, homeConfigFile, resolveConfigPath, ensureHomeDir } from './paths.js';
import { validateConfig } from './validate.js';

/**
 * The key of one backend entry: inline, the named environment variable, or
 * nothing when the whole list is keyless.
 * @param {object} item
 * @param {object} env
 * @returns {string|null}
 */
function keyOf(item, env) {
    if (typeof item?.apiKey === 'string' && item.apiKey.trim()) return item.apiKey.trim();
    if (typeof item?.env === 'string' && item.env) {
        const value = env[item.env];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
}

/**
 * Pick the primary backend: the first entry with a URL that also has a key
 * (inline, the named environment variable, or none when the whole list is
 * keyless).
 * @param {object[]} backends
 * @param {object} env
 * @returns {{ primary: object|null, apiKey: string|null }}
 */
export function resolveBackend(backends, env = process.env) {
    const list = Array.isArray(backends) ? backends : [];
    const withURL = list.filter((item) => isRecord(item) && typeof item.baseURL === 'string' && item.baseURL.trim());
    const primary = withURL.find((item) => keyOf(item, env)) ?? withURL[0] ?? null;
    return { primary, apiKey: primary ? keyOf(primary, env) : null };
}

/**
 * The hosts of one pool that can serve a request: the ones that have a key,
 * or all of them when the whole pool is keyless.
 * @param {object[]} pool
 * @param {object} env
 * @returns {string[]}
 */
function usableUrls(pool, env) {
    const list = Array.isArray(pool) ? pool : [];
    const withURL = list.filter((item) => isRecord(item) && typeof item.baseURL === 'string' && item.baseURL.trim());
    const withKey = withURL.filter((item) => keyOf(item, env));
    const usable = withKey.length ? withKey : withURL;
    return usable.map((item) => item.baseURL.replace(/\/+$/, ''));
}

/**
 * The fields the user set: the file, the environment and the flags.
 *
 * The loader needs to tell a value of the user from the default of the
 * package: an explicitly chosen picture model is the choice of the user and
 * the purpose routing must not override it.
 * @param {...object} sources
 * @returns {{ top: string[], image: string[] }}
 */
function explicitFields(...sources) {
    const top = new Set();
    const image = new Set();
    for (const source of sources) {
        if (!isRecord(source)) continue;
        for (const [key, value] of Object.entries(source)) {
            top.add(key);
            if (key === 'image' && isRecord(value)) {
                for (const field of Object.keys(value)) image.add(field);
            }
        }
    }
    return { top: [...top], image: [...image] };
}

/**
 * Resolve the effective configuration.
 * @param {{ configPath?: string|null, overrides?: object, env?: object, cwd?: string, ensureHome?: boolean }} [options]
 * @returns {Promise<object>}
 */
export async function loadConfig({ configPath = null, overrides = {}, env = process.env, cwd = process.cwd(), ensureHome = true } = {}) {
    const home = defaultHome(env);
    const homeConfig = await readConfigFile(homeConfigFile(home), { optional: true });
    const explicitPath = resolveConfigPath(configPath ?? envConfigPath(env), cwd);
    const fileConfig = explicitPath ? await readConfigFile(explicitPath) : {};

    let config = mergeSources(homeConfig, fileConfig, fromEnv(env), overrides);
    config = await expandPlaceholders(config, {
        env,
        root: cwd,
        maxBytes: Number.isSafeInteger(config.limits?.maxFileReadBytes) ? config.limits.maxFileReadBytes : 256 * KiB,
    });

    const text = resolveBackend(config.backends, env);
    if (text.primary) {
        config.baseURL = text.primary.baseURL;
        if (text.apiKey) config.apiKey = text.apiKey;
    }
    const images = resolveBackend(config.imagesBackends, env);
    config.primaryBackend = text.primary;
    config.primaryImagesBackend = images.primary;
    config.backendUrls = [...new Set([
        ...usableUrls(config.backends, env),
        ...usableUrls(config.imagesBackends, env),
    ])];
    config.explicit = explicitFields(homeConfig, fileConfig, fromEnv(env), overrides);

    config.home = home;
    config.configFiles = [homeConfigFile(home), ...(explicitPath ? [explicitPath] : [])];

    validateConfig(config);
    if (ensureHome) await ensureHomeDir(home);
    return config;
}

/**
 * Seed the home config file when it does not exist yet.
 * @param {object} [env]
 * @returns {Promise<{ created: boolean, file: string }>}
 */
export async function ensureConfigFile(env = process.env) {
    const home = defaultHome(env);
    const file = homeConfigFile(home);
    try {
        await readConfigFile(file, { optional: false });
        return { created: false, file };
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    await writeConfigFile(file, JSON.parse(defaultConfigText()));
    return { created: true, file };
}

/**
 * A copy of the config with the secrets shortened, safe to print.
 * @param {object} config
 * @returns {object}
 */
export function redactConfig(config) {
    const short = (value) => (typeof value === 'string' && value.length > 6 ? `${value.slice(0, 3)}…${value.slice(-2)}` : value ? '…' : null);
    const out = structuredClone(config);
    if (out.apiKey) out.apiKey = short(out.apiKey);
    for (const branch of ['backends', 'imagesBackends']) {
        if (Array.isArray(out[branch])) {
            for (const item of out[branch]) {
                if (item && typeof item === 'object' && item.apiKey) item.apiKey = short(item.apiKey);
            }
        }
    }
    return out;
}
