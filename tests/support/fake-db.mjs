// An in-memory stand-in for the service-role Supabase client, for running the
// Edge Functions' own code under node:test (tests/support/edge-runtime.mjs).
//
// It answers the query-builder calls those functions make — select / insert /
// upsert / update with eq, neq, is, gt, maybeSingle, single — against plain
// arrays, and holds the constraints a function could trip on: the unique
// indexes the migrations define (as 23505) and the entitlement checks from
// migration 20261026120000 (as 23514). The RPCs are mirrors of their SQL so a
// function can be run end to end; the SQL itself is tested against a real
// Postgres in tests/trial-db.test.mjs.

import { randomUUID } from 'node:crypto';

const active = (row, now = Date.now()) =>
  !row.revoked_at && (!row.expires_at || Date.parse(row.expires_at) > now);

// The partial unique indexes and checks, as predicates over a candidate row
// and the rows already there.
const UNIQUE = {
  accounts: [(a, b) => a.email === b.email, (a, b) => a.auth_user_id && a.auth_user_id === b.auth_user_id],
  purchases: [(a, b) => a.stripe_checkout_session_id === b.stripe_checkout_session_id],
  entitlements: [
    // entitlements_one_active_idx
    (a, b) => !a.revoked_at && !b.revoked_at && a.source !== 'trial' && b.source !== 'trial'
      && a.tester_id === b.tester_id && a.entitlement === b.entitlement
      && (a.build_version ?? '') === (b.build_version ?? ''),
    // entitlements_one_trial_ever_idx
    (a, b) => a.source === 'trial' && b.source === 'trial' && a.tester_id === b.tester_id,
  ],
  devices: [(a, b) => a.token_hash === b.token_hash],
};

const CHECKS = {
  entitlements: [
    (r) => ['purchase', 'grant', 'trial'].includes(r.source),
    (r) => (r.source === 'trial') === (r.expires_at != null),
    (r) => r.expires_at == null || Date.parse(r.expires_at) > Date.parse(r.granted_at),
    (r) => r.source !== 'trial' || (r.build_version == null && r.purchase_id == null),
  ],
};

let sequence = 0;
const DEFAULTS = {
  accounts: () => ({ tester_id: randomUUID(), status: 'active', auth_user_id: null, free_updates: false }),
  purchases: () => ({ id: ++sequence, status: 'paid', refunded_at: null }),
  entitlements: () => ({ id: ++sequence, granted_at: new Date().toISOString(), revoked_at: null,
    expires_at: null, build_version: null, purchase_id: null }),
  devices: () => ({ id: ++sequence, revoked_at: null, linked_at: new Date().toISOString(), label: null }),
};

// seed: rows by table. rpcs: extra or replacement RPCs, each called with
// (args, tables) and answering the data, or { error } to fail.
export function fakeDatabase(seed = {}, { rpcs: extra = {} } = {}) {
  const tables = { accounts: [], purchases: [], entitlements: [], devices: [], link_codes: [], builds: [] };
  for (const [name, rows] of Object.entries(seed)) {
    tables[name] = rows.map((row) => ({ ...(DEFAULTS[name]?.() ?? {}), ...row }));
  }
  const authUsers = [];
  const calls = [];

  const account = (testerId) => tables.accounts.find((a) => a.tester_id === testerId);

  // Mirrors of the SQL, for running a function end to end.
  const rpcs = {
    has_build_access({ account: testerId, build }) {
      const owner = account(testerId);
      const row = tables.builds.find((b) => b.id === build);
      if (!owner || owner.status !== 'active' || !row) return false;
      return owner.free_updates || tables.entitlements.some((e) => e.tester_id === testerId
        && e.entitlement === 'early_build' && active(e)
        && (e.build_version == null || e.build_version === row.version));
    },
    account_standing({ account: testerId, install = null }) {
      const owner = account(testerId);
      if (!owner) return null;
      const trial = tables.entitlements.find((e) => e.tester_id === testerId && e.source === 'trial');
      const linked = tables.devices.filter((d) => d.tester_id === testerId && !d.revoked_at);
      return {
        owned: owner.free_updates || tables.entitlements.some((e) => e.tester_id === testerId
          && e.entitlement === 'early_build' && e.source !== 'trial' && active(e)),
        trial: trial ? (active(trial) ? 'active' : 'ended') : null,
        trial_expires_at: trial?.expires_at ?? null,
        linked_devices: new Set(linked.map((d) => d.install_id)).size,
        install_linked: install != null && linked.some((d) => d.install_id === install),
      };
    },
  };

  // Whether `row` may be stored; `replacing` is the row it would update.
  function write(table, row, replacing = null) {
    const existing = tables[table];
    if ((CHECKS[table] ?? []).some((check) => !check(row))) return { code: '23514' };
    if ((UNIQUE[table] ?? []).some((clash) => existing.some((other) => other !== replacing && clash(row, other)))) {
      return { code: '23505' };
    }
    return null;
  }

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.op = 'select';
      this.wantRows = false;
      this.mode = 'many';
    }
    select(columns = '*') { this.columns = columns; this.wantRows = true; return this; }
    insert(payload) { this.op = 'insert'; this.payload = payload; return this; }
    upsert(payload, options = {}) { this.op = 'upsert'; this.payload = payload; this.options = options; return this; }
    update(patch) { this.op = 'update'; this.payload = patch; return this; }
    eq(column, value) { this.filters.push((r) => r[column] === value); return this; }
    neq(column, value) { this.filters.push((r) => r[column] !== value); return this; }
    is(column, value) { this.filters.push((r) => (r[column] ?? null) === value); return this; }
    gt(column, value) { this.filters.push((r) => r[column] > value); return this; }
    order() { return this; }
    limit() { return this; }
    maybeSingle() { this.mode = 'maybe'; return this; }
    single() { this.mode = 'single'; return this; }
    then(resolve, reject) { return Promise.resolve().then(() => this.run()).then(resolve, reject); }

    shape(rows) {
      const withJoins = rows.map((row) => (/accounts\s*\(/.test(this.columns ?? '')
        ? { ...row, accounts: account(row.tester_id) ?? null } : { ...row }));
      if (this.mode === 'many') return { data: this.wantRows ? withJoins : null, error: null };
      if (withJoins.length > 1) return { data: null, error: { code: 'PGRST116' } };
      if (this.mode === 'single' && withJoins.length === 0) return { data: null, error: { code: 'PGRST116' } };
      return { data: withJoins[0] ?? null, error: null };
    }

    run() {
      calls.push({ table: this.table, op: this.op, payload: this.payload });
      const rows = tables[this.table];
      if (this.op === 'select') return this.shape(rows.filter((r) => this.filters.every((f) => f(r))));
      if (this.op === 'insert' || this.op === 'upsert') {
        const added = [];
        for (const payload of [].concat(this.payload)) {
          const row = { ...(DEFAULTS[this.table]?.() ?? {}), ...payload };
          if (this.op === 'upsert' && this.options.ignoreDuplicates
              && rows.some((other) => other[this.options.onConflict] === row[this.options.onConflict])) continue;
          const error = write(this.table, row);
          if (error) return { data: null, error };
          rows.push(row);
          added.push(row);
        }
        return this.wantRows ? this.shape(added) : { data: null, error: null };
      }
      if (this.op === 'update') {
        const matched = rows.filter((r) => this.filters.every((f) => f(r)));
        for (const row of matched) {
          const error = write(this.table, { ...row, ...this.payload }, row);
          if (error) return { data: null, error };
          Object.assign(row, this.payload);
        }
        return this.wantRows ? this.shape(matched) : { data: null, error: null };
      }
      throw new Error(`unsupported operation ${this.op}`);
    }
  }

  return {
    tables,
    authUsers,
    calls,
    from: (table) => new Query(table),
    async rpc(name, args) {
      calls.push({ rpc: name, args });
      const fn = extra[name] ?? rpcs[name];
      if (!fn) return { data: null, error: { code: 'PGRST202' } };
      const data = await fn(args, tables);
      return data?.error ? { data: null, error: data.error } : { data, error: null };
    },
    auth: {
      admin: {
        async createUser({ email }) {
          if (authUsers.some((u) => u.email === email)) return { data: { user: null }, error: { code: 'email_exists' } };
          const user = { id: randomUUID(), email };
          authUsers.push(user);
          return { data: { user }, error: null };
        },
        async generateLink({ email }) {
          return { data: { user: authUsers.find((u) => u.email === email) ?? null }, error: null };
        },
      },
    },
    storage: {
      from: () => ({
        createSignedUrl: async (path, seconds) => ({ data: { signedUrl: `https://storage.example/${path}?expires=${seconds}` }, error: null }),
      }),
    },
  };
}

export const DAY_MS = 24 * 3600 * 1000;
export const daysFromNow = (days) => new Date(Date.now() + days * DAY_MS).toISOString();
