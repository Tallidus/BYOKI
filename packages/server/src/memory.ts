import type { CredentialStore, ProviderId, Scope, Selection, SelectionStore, UsageLedger, UsageRecord, Capability } from "@byoki/core";

function scopeKey(scope: Scope, extra: string): string {
  return `${scope.tenantId}\u0000${scope.userId}\u0000${extra}`;
}

export function createMemoryCredentialStore(): CredentialStore {
  const keys = new Map<string, string>();
  return {
    async put(scope, provider, plaintextKey) {
      keys.set(scopeKey(scope, provider), plaintextKey);
    },
    async get(scope, provider) {
      return keys.get(scopeKey(scope, provider)) ?? null;
    },
    async delete(scope, provider) {
      keys.delete(scopeKey(scope, provider));
    },
    async has(scope, provider) {
      return keys.has(scopeKey(scope, provider));
    },
  };
}

export function createMemorySelectionStore(): SelectionStore {
  const rows = new Map<string, Selection>();
  return {
    async get(scope, capability) {
      return rows.get(scopeKey(scope, capability)) ?? null;
    },
    async put(scope, selection) {
      rows.set(scopeKey(scope, selection.capability), selection);
    },
    async list(scope) {
      const prefix = `${scope.tenantId}\u0000${scope.userId}\u0000`;
      return [...rows.entries()].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value);
    },
  };
}

export function createMemoryLedger(): UsageLedger & { all(): UsageRecord[] } {
  const rows: UsageRecord[] = [];
  return {
    async append(record) {
      rows.push(record);
    },
    async query(scope, range) {
      return rows.filter(
        (row) =>
          row.tenantId === scope.tenantId &&
          row.userId === scope.userId &&
          row.time >= range.from &&
          row.time < range.to,
      );
    },
    all() {
      return rows;
    },
  };
}

export type { Capability, ProviderId, Scope };
