import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  CredentialStore,
  ProviderId,
  Selection,
  SelectionStore,
  UsageLedger,
  UsageRecord,
} from "@byoki/core";
import { decryptString, encryptString } from "./crypto.js";

type SecretRecord = {
  tenantId: string;
  userId: string;
  provider: ProviderId;
  iv: string;
  tag: string;
  ciphertext: string;
};

type FileShape = {
  credentials: SecretRecord[];
  selections: Array<Selection & { tenantId: string; userId: string }>;
  ledger: UsageRecord[];
};

const empty = (): FileShape => ({ credentials: [], selections: [], ledger: [] });

/**
 * Development store. Credentials are encrypted with AES-256-GCM.
 * The master key comes from the host environment and is never written to the file.
 * Production hosts should implement CredentialStore with their own secrets manager.
 */
export function createEncryptedFileStore(filePath: string, masterKey: Buffer) {
  let chain: Promise<unknown> = Promise.resolve();

  function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function read(): Promise<FileShape> {
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as FileShape;
      return {
        credentials: parsed.credentials ?? [],
        selections: parsed.selections ?? [],
        ledger: parsed.ledger ?? [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return empty();
      }
      throw error;
    }
  }

  async function write(data: FileShape): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const temp = `${filePath}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(data), "utf8");
    await rename(temp, filePath);
  }

  const credentials: CredentialStore = {
    async put(scope, provider, plaintextKey) {
      await exclusive(async () => {
        const data = await read();
        const sealed = encryptString(plaintextKey, masterKey);
        const next = data.credentials.filter(
          (row) => !(row.tenantId === scope.tenantId && row.userId === scope.userId && row.provider === provider),
        );
        next.push({ tenantId: scope.tenantId, userId: scope.userId, provider, ...sealed });
        await write({ ...data, credentials: next });
      });
    },
    async get(scope, provider) {
      const data = await read();
      const row = data.credentials.find(
        (item) => item.tenantId === scope.tenantId && item.userId === scope.userId && item.provider === provider,
      );
      if (!row) return null;
      return decryptString(row, masterKey);
    },
    async delete(scope, provider) {
      await exclusive(async () => {
        const data = await read();
        await write({
          ...data,
          credentials: data.credentials.filter(
            (row) => !(row.tenantId === scope.tenantId && row.userId === scope.userId && row.provider === provider),
          ),
        });
      });
    },
    async has(scope, provider) {
      const data = await read();
      return data.credentials.some(
        (row) => row.tenantId === scope.tenantId && row.userId === scope.userId && row.provider === provider,
      );
    },
  };

  const selections: SelectionStore = {
    async get(scope, capability) {
      const data = await read();
      const row = data.selections.find(
        (item) => item.tenantId === scope.tenantId && item.userId === scope.userId && item.capability === capability,
      );
      if (!row) return null;
      return { capability: row.capability, provider: row.provider, modelId: row.modelId };
    },
    async put(scope, selection) {
      await exclusive(async () => {
        const data = await read();
        const next = data.selections.filter(
          (row) =>
            !(row.tenantId === scope.tenantId && row.userId === scope.userId && row.capability === selection.capability),
        );
        next.push({ ...selection, tenantId: scope.tenantId, userId: scope.userId });
        await write({ ...data, selections: next });
      });
    },
    async list(scope) {
      const data = await read();
      return data.selections
        .filter((row) => row.tenantId === scope.tenantId && row.userId === scope.userId)
        .map((row) => ({ capability: row.capability, provider: row.provider, modelId: row.modelId }));
    },
  };

  const ledger: UsageLedger = {
    async append(record) {
      await exclusive(async () => {
        const data = await read();
        await write({ ...data, ledger: [...data.ledger, record] });
      });
    },
    async query(scope, range) {
      const data = await read();
      return data.ledger.filter(
        (row) =>
          row.tenantId === scope.tenantId &&
          row.userId === scope.userId &&
          row.time >= range.from &&
          row.time < range.to,
      );
    },
  };

  return { credentials, selections, ledger };
}

export type EncryptedFileStore = ReturnType<typeof createEncryptedFileStore>;

/**
 * Production credential stores use a secrets manager or envelope encryption
 * with keys managed outside the application process. Implement CredentialStore.
 * Do not store plaintext keys in application databases or logs.
 */
export type ProductionCredentialStore = CredentialStore & {
  readonly kind: "production";
};

export function assertProductionStore(store: ProductionCredentialStore): ProductionCredentialStore {
  if (store.kind !== "production") {
    throw new Error("Expected a production credential store.");
  }
  return store;
}
