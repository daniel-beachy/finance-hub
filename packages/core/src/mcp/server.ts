import { InvalidInput, NotFound } from "../errors.ts";
import { type McpContext, TOOLS } from "./tools.ts";

/**
 * The `finance-hub` MCP server's protocol layer: JSON-RPC 2.0 messages in,
 * responses out. The host (`fh mcp`) moves the messages over stdio, one per
 * line. Kept free of any transport so tests call `handle` directly.
 */

export const SERVER_NAME = "finance-hub";
export const SERVER_VERSION = "0.5.0";
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `Finance Hub is the user's own ledger: bank, card and investment accounts synced from Plaid and file imports into a local database.
Money is integer cents everywhere; negative is money out of an account. Dates are YYYY-MM-DD.
Start with overview. Use query_transactions and spending_summary for questions, run_sql only when no other tool fits.
Every write tool returns a batch_id; tell the user what changed and that it can be undone. Dry-run a rule before making one that would change more than 20 transactions.
Categories set by hand (by the user or by you) are locked; rules, merchant memory and Plaid's category only fill in the rest.
These are estimates and records, not financial advice.`;

interface Prompt {
  name: string;
  description: string;
  arguments?: { name: string; description: string; required?: boolean }[];
  text(args: Record<string, string>): string;
}

const PROMPTS: Prompt[] = [
  {
    name: "clear-review-queue",
    description: "Work through everything waiting in Review, categorizing what is clear and asking about the rest.",
    text: () => `Clear my Finance Hub review queue.

1. Call review_queue. Work through it merchant group by merchant group.
2. For each group, decide from the merchant, Plaid's category and confidence, the past charges and suggested_category_id.
   - Unambiguous merchant (varies is false) and you're confident: categorize_transactions with create_rule true, so it never comes back.
   - Merchant that varies (Amazon, Costco, Venmo, PayPal, checks, ATM): categorize only what you can tell from the amount and description, with remember false and no rule.
   - Large, unfamiliar or unusual charges that already have a sensible category: review_transactions to mark them reviewed, with a short note if it helps.
   - Anything you can't tell: leave it, and list it for me with why.
   - Anything that looks wrong (a duplicate, a charge I wouldn't recognize): review_transactions with flag suspicious and a note.
3. Before any rule that would change more than 20 existing transactions, dry-run it and tell me the count.
4. When done, call review_queue again and record_review_run (trigger manual, started_at from before your first change, queue_before from step 1). Report: how many you categorized, rules created, what's left and why, and the batch_ids I can undo.`,
  },
  {
    name: "weekly-review",
    description: "A short review of the last seven days, then clear the queue.",
    text: () => `Give me my weekly Finance Hub review.

1. Call weekly_digest. It has the week's spending by group against the 8-week average, the largest charges, new merchants, open alerts, budget pace, the Review queue and charges due in the next two weeks. Narrate it; don't recompute it.
2. Call overview and mention any connection that needs me to sign in.
3. Go through the open alerts. Explain each in a line. Dismiss (dismiss_alert) only the ones the data explains, such as a price increase I'd expect; leave possible duplicates, large charges and missed charges for me, and say what to check.
4. Call review_queue and clear what you confidently can, as in the clear-review-queue prompt; ask me about the rest.
5. Report in a few short paragraphs: what stood out, how spending compares and how the budget is pacing, what's coming up, what you changed (with batch_ids), and what needs me.`,
  },
  {
    name: "month-close",
    description: "Close out a month: everything categorized, the totals checked, and a summary.",
    arguments: [{ name: "month", description: "The month to close, YYYY-MM. Defaults to last month." }],
    text: (args) => `Close out ${args.month ? `the month ${args.month}` : "last month"} in Finance Hub.

1. Call query_transactions for that month with needs_review true, and clear what you can (as in clear-review-queue). Ask me about the rest.
2. Call spending_summary for the month by group and by category, and cash_flow for the last 6 months.
3. Compare the month's spending and income with the previous three months, and name the biggest changes by category.
4. Check for anything odd: uncategorized transactions left, large one-off charges, transfers that didn't pair (query_transactions with kind transfer).
5. Report the month's income, spending, net and savings rate, the notable changes, and anything still open.`,
  },
];

type Id = string | number | null;
interface Request {
  jsonrpc?: string;
  id?: Id;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpServer {
  /** Handle one JSON-RPC message. Returns the response, or null for a notification. */
  handle(message: unknown): Promise<Record<string, unknown> | null>;
}

const ok = (id: Id, result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

export function createMcpServer(ctx: McpContext, options: { log?: (line: string) => void } = {}): McpServer {
  const byName = new Map(TOOLS.map((t) => [t.name, t]));

  async function call(name: string, args: Record<string, unknown>) {
    const tool = byName.get(name);
    if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    try {
      const result = await tool.run(ctx, args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 1) }],
        structuredContent: result && typeof result === "object" && !Array.isArray(result) ? result : { result },
      };
    } catch (err) {
      // Mistakes in the arguments go back to Claude to fix; anything else is logged too.
      if (!(err instanceof InvalidInput || err instanceof NotFound)) options.log?.(`${name} failed: ${err instanceof Error ? err.stack : String(err)}`);
      return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  }

  return {
    async handle(message) {
      if (!message || typeof message !== "object" || Array.isArray(message)) return fail(null, -32600, "Invalid request");
      const req = message as Request;
      const isNotification = req.id === undefined;
      const id = req.id ?? null;
      const params = req.params ?? {};
      switch (req.method) {
        case "initialize": {
          const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSIONS[0]!;
          return ok(id, {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, title: "Finance Hub", version: SERVER_VERSION },
            instructions: INSTRUCTIONS,
          });
        }
        case "ping":
          return isNotification ? null : ok(id, {});
        case "tools/list":
          return ok(id, {
            tools: TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              annotations: { readOnlyHint: t.readOnly, destructiveHint: false, idempotentHint: t.readOnly, openWorldHint: t.name === "sync_now" },
            })),
          });
        case "tools/call": {
          const name = typeof params.name === "string" ? params.name : "";
          const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
          return ok(id, await call(name, args));
        }
        case "prompts/list":
          return ok(id, { prompts: PROMPTS.map(({ name, description, arguments: a }) => ({ name, description, arguments: a ?? [] })) });
        case "prompts/get": {
          const prompt = PROMPTS.find((p) => p.name === params.name);
          if (!prompt) return fail(id, -32602, `Unknown prompt: ${String(params.name)}`);
          const args = (params.arguments ?? {}) as Record<string, string>;
          return ok(id, {
            description: prompt.description,
            messages: [{ role: "user", content: { type: "text", text: prompt.text(args) } }],
          });
        }
        default:
          if (isNotification) return null; // notifications/initialized, notifications/cancelled, ...
          return fail(id, -32601, `Method not found: ${String(req.method)}`);
      }
    },
  };
}
