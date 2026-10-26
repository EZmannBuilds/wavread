// Runs an Edge Function's own index.ts under node:test.
//
// The functions are TypeScript written for Supabase's Deno runtime, so this
// does what that runtime does, and no more: it strips the type annotations
// (node's own stripTypeScriptTypes), drops the import lines, and runs the
// result in a fresh context where the imports are supplied instead —
// _shared/mod.ts run the same way, the function's own .mjs helpers, a
// Deno.serve that hands the handler back, and the service client replaced by
// whatever the test passes (tests/support/fake-db.mjs). The code that runs is
// the code that deploys; only its surroundings are stand-ins.
//
// `supported` is false on a node without stripTypeScriptTypes (before 22.13),
// and the tests using this skip there.

import { readFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import vm from 'node:vm';
import { allowOriginFor, clientAddressFrom, keyedDigest } from '../../supabase/functions/_shared/callers.mjs';
import { affiliateCodeFromLabel, campaignSource } from '../../supabase/functions/_shared/labels.mjs';

export const supported = typeof nodeModule.stripTypeScriptTypes === 'function';

function script(path) {
  const source = readFileSync(path, 'utf8')
    .replace(/^(?:import|export)\s[^;]*?\sfrom\s+["'][^"']+["'];[ \t]*$/gm, '')
    .replace(/^export\s+(?=(?:async\s+)?function\s|const\s|interface\s)/gm, '');
  // The stripper announces itself as experimental on every call.
  const warn = process.emitWarning;
  process.emitWarning = () => {};
  try {
    return nodeModule.stripTypeScriptTypes(source);
  } finally {
    process.emitWarning = warn;
  }
}

// path: the function's index.ts. db: the service client every
// serviceClient() call returns. imports: the function's own imports beyond
// mod.ts, by name. env: what Deno.env.get answers. createClient: stands in for
// the jsr import, for functions that build a user-scoped client.
export function loadEdgeFunction(path, { db, imports = {}, env = {}, createClient } = {}) {
  let handler = null;
  const context = vm.createContext({
    console, crypto, TextEncoder, TextDecoder, Request, Response, Headers, URL, URLSearchParams,
    AbortSignal, setTimeout, clearTimeout, btoa, atob,
    Deno: { env: { get: (name) => env[name] }, serve: (fn) => { handler = fn; } },
    allowOriginFor, clientAddressFrom, hmacHex: keyedDigest, affiliateCodeFromLabel, campaignSource,
    createClient: createClient ?? (() => { throw new Error('this function was given no createClient'); }),
  });
  vm.runInContext(script('supabase/functions/_shared/mod.ts'), context);
  context.serviceClient = () => db;
  Object.assign(context, imports);
  vm.runInContext(script(path), context);
  return { handler, context };
}
