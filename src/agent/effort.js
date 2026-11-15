/**
 * @file src/agent/effort.js
 * @module agent/effort
 * @purpose The reasoning effort of a role: the effort of the role itself, the effort of the
 *          default role, or the effort of the run.
 * @exports effortFor
 * @ai.tags agent, effort
 * @ai.hint pure
 */

/**
 * The effort a role works at.
 *
 * The chain is short: the effort of the role, the effort of `roles.default`, the effort of the
 * run (`reasoning.effort`). The first one that is set wins; the rest keep their own.
 * @param {{ config?: object|null, role?: string|null }} request
 * @returns {string|null} the level of the effort
 * @exports
 * @ai.hint pure
 */
export function effortFor({ config = null, role = null } = {}) {
    const roles = config?.roles ?? {};
    const own = role ? roles[role]?.effort ?? null : null;
    const wanted = own ?? roles.default?.effort ?? config?.reasoning?.effort ?? null;
    return typeof wanted === 'string' && wanted.trim() ? wanted.trim() : null;
}
