/** Loads Plaid's Link script on demand and opens it. No redirect URI: OAuth banks open a popup. */

interface PlaidHandler {
  open(): void;
  destroy(): void;
}

interface PlaidMetadata {
  institution: { institution_id: string; name: string } | null;
}

declare global {
  interface Window {
    Plaid?: {
      create(config: {
        token: string;
        onSuccess(publicToken: string, metadata: PlaidMetadata): void;
        onExit(error: { error_code?: string; display_message?: string } | null): void;
      }): PlaidHandler;
    };
  }
}

const SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  loading ??= new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = SCRIPT;
    el.onload = () => resolve();
    el.onerror = () => {
      loading = null;
      reject(new Error("Could not load Plaid Link. Check your connection."));
    };
    document.head.appendChild(el);
  });
  return loading;
}

export interface LinkOutcome {
  publicToken: string;
  institution: { id: string; name: string } | null;
}

/** Resolves with the public token, or null if the user closed Link. */
export async function openLink(token: string): Promise<LinkOutcome | null> {
  await loadScript();
  return new Promise((resolve, reject) => {
    const handler = window.Plaid!.create({
      token,
      onSuccess(publicToken, metadata) {
        handler.destroy();
        const i = metadata.institution;
        resolve({ publicToken, institution: i ? { id: i.institution_id, name: i.name } : null });
      },
      onExit(error) {
        handler.destroy();
        if (error?.error_code) reject(new Error(error.display_message ?? error.error_code));
        else resolve(null);
      },
    });
    handler.open();
  });
}
