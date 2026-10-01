import type {
  Capability,
  CredentialStore,
  ProviderId,
  Scope,
  Selection,
  SelectionStore,
  UsageLedger,
  UsageRecord,
} from "@byoki/core";

type Timed<T> = { value: T; expiresAt: number };

/**
 * Per-visitor memory store for the public demo.
 * Keys are plaintext only inside this process, scoped by tenant and user, and dropped when the session expires.
 * Nothing here is written to disk or to logs.
 */
export type VisitorMemory = {
  credentials: CredentialStore;
  selections: SelectionStore;
  ledger: UsageLedger;
  activate(scope: Scope, expiresAt: number): void;
  forget(scope: Scope): void;
  prune(now?: number): void;
};

const MAX_VISITORS = 2_000;

function scopeId(scope: Scope): string {
  return `${scope.tenantId}\u0000${scope.userId}`;
}

function recordKey(scope: Scope, extra: string): string {
  return `${scopeId(scope)}\u0000${extra}`;
}

export function createVisitorMemory(now: () => number = Date.now): VisitorMemory {
  const expiry = new Map<string, number>();
  const keys = new Map<string, Timed<string>>();
  const selections = new Map<string, Timed<Selection>>();
  const ledger: Array<Timed<UsageRecord>> = [];

  function forget(scope: Scope): void {
    const id = scopeId(scope);
    expiry.delete(id);
    const prefix = `${id}\u0000`;
    for (const key of keys.keys()) {
      if (key.startsWith(prefix)) keys.delete(key);
    }
    for (const key of selections.keys()) {
      if (key.startsWith(prefix)) selections.delete(key);
    }
    for (let index = ledger.length - 1; index >= 0; index -= 1) {
      const row = ledger[index];
      if (row && row.value.tenantId === scope.tenantId && row.value.userId === scope.userId) {
        ledger.splice(index, 1);
      }
    }
  }

  function prune(at = now()): void {
    for (const [id, expiresAt] of expiry) {
      if (expiresAt <= at) {
        const [tenantId, userId] = id.split("\u0000");
        if (tenantId && userId) forget({ tenantId, userId });
      }
    }
  }

  function live(scope: Scope, at = now()): boolean {
    const expiresAt = expiry.get(scopeId(scope));
    return expiresAt !== undefined && expiresAt > at;
  }

  function activate(scope: Scope, expiresAt: number): void {
    prune();
    if (expiresAt <= now()) {
      forget(scope);
      return;
    }
    const id = scopeId(scope);
    if (!expiry.has(id) && expiry.size >= MAX_VISITORS) {
      let oldestId = "";
      let oldest = Number.POSITIVE_INFINITY;
      for (const [candidate, candidateExp] of expiry) {
        if (candidateExp < oldest) {
          oldest = candidateExp;
          oldestId = candidate;
        }
      }
      if (oldestId) {
        const [tenantId, userId] = oldestId.split("\u0000");
        if (tenantId && userId) forget({ tenantId, userId });
      }
    }
    expiry.set(id, expiresAt);
  }

  const credentials: CredentialStore = {
    async put(scope, provider, plaintextKey) {
      if (!live(scope)) return;
      const expiresAt = expiry.get(scopeId(scope));
      if (expiresAt === undefined) return;
      keys.set(recordKey(scope, provider), { value: plaintextKey, expiresAt });
    },
    async get(scope, provider) {
      if (!live(scope)) return null;
      return keys.get(recordKey(scope, provider))?.value ?? null;
    },
    async delete(scope, provider) {
      keys.delete(recordKey(scope, provider));
    },
    async has(scope, provider) {
      if (!live(scope)) return false;
      return keys.has(recordKey(scope, provider));
    },
  };

  const selectionStore: SelectionStore = {
    async get(scope, capability) {
      if (!live(scope)) return null;
      return selections.get(recordKey(scope, capability))?.value ?? null;
    },
    async put(scope, selection) {
      if (!live(scope)) return;
      const expiresAt = expiry.get(scopeId(scope));
      if (expiresAt === undefined) return;
      selections.set(recordKey(scope, selection.capability), { value: selection, expiresAt });
    },
    async list(scope) {
      if (!live(scope)) return [];
      const prefix = `${scopeId(scope)}\u0000`;
      const rows: Selection[] = [];
      for (const [key, timed] of selections) {
        if (key.startsWith(prefix)) rows.push(timed.value);
      }
      return rows;
    },
  };

  const usage: UsageLedger = {
    async append(record) {
      const scope = { tenantId: record.tenantId, userId: record.userId };
      if (!live(scope)) return;
      const expiresAt = expiry.get(scopeId(scope));
      if (expiresAt === undefined) return;
      ledger.push({ value: record, expiresAt });
    },
    async query(scope, range) {
      if (!live(scope)) return [];
      return ledger
        .filter(
          (row) =>
            row.value.tenantId === scope.tenantId &&
            row.value.userId === scope.userId &&
            row.value.time >= range.from &&
            row.value.time < range.to,
        )
        .map((row) => row.value);
    },
  };

  return { credentials, selections: selectionStore, ledger: usage, activate, forget, prune };
}

export type { Capability, ProviderId };
