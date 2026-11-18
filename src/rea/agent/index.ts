/**
 * REA in-process agent entry — the bundle frida-compile builds from this
 * file and `ProcessInjector` loads into the target.
 *
 * Wires the crypto/traffic harvester and the evasion engine together and
 * announces itself on the bus so the host knows the agent is live.
 *
 * This file runs inside the target process. It must only use GumJS globals
 * (Module, Interceptor, send, Java, ObjC, ...) — no Node.js APIs, no
 * imports of host-side code.
 */
import { MemoryCryptoHarvester } from './crypto-harvester.js';
import { UniversalEvasionEngine } from './evasion-engine.js';

const harvester = new MemoryCryptoHarvester();
harvester.startHarvesting();

const evasion = new UniversalEvasionEngine();
evasion.activateAllBypasses();

send({ type: 'AGENT_READY', modules: ['crypto-harvester', 'evasion-engine'] });
