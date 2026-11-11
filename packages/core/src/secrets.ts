/** Where secrets live. The Keychain locally; Worker secrets in a hosted future. */
export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export const SECRET_CLIENT_ID = "plaid-client-id";
export const secretNameForEnv = (env: PlaidEnv) => `plaid-secret-${env}`;
export const tokenNameForConnection = (connectionId: string) => `plaid-token-${connectionId}`;

export type PlaidEnv = "sandbox" | "production";

export function createMemorySecretStore(initial: Record<string, string> = {}): SecretStore {
  const map = new Map(Object.entries(initial));
  return {
    get: async (name) => map.get(name) ?? null,
    set: async (name, value) => void map.set(name, value),
    delete: async (name) => void map.delete(name),
  };
}
