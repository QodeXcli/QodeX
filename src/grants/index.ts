/**
 * Standing grants — permissions the human gives QodeX ahead of time
 * ("from now on you may reply to my emails"). See store.ts for who may create
 * them (human surfaces only — never a tool) and mail-scope.ts for exactly what a
 * 'mail-reply' grant covers.
 */

export * from './paths.js';
export * from './store.js';
export * from './received.js';
export * from './mail-scope.js';
