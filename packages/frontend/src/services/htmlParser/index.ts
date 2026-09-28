/**
 * HTML parser module.
 *
 * Responsible for converting raw HTML into an editable document
 * model and back. Per project policy, this module MUST NOT use
 * regex to modify HTML — it uses the browser's DOMParser and DOM
 * APIs, which are standards-compliant and safe.
 *
 * Two implementations live here:
 *   - scanner.ts   (Milestone 3) — read-only element detection.
 *   - parser.ts    (Milestone 4) — parse / serialize / in-memory edits.
 */

export * from './scanner';
export * from './parser';
