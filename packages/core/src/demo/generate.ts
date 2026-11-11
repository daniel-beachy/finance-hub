import type { SqlDriver } from "../db/driver.ts";
import { DEFAULT_OWNER_ID } from "../db/seed.ts";
import { UNCATEGORIZED } from "../seed/categories.ts";
import { createIdFactory } from "../util/ids.ts";
import { addDays } from "../util/money.ts";
import { createRng, type Rng } from "../util/rng.ts";

/**
 * Builds a complete synthetic household. Everything here is invented: the
 * institutions, merchants and amounts. It feeds the public demo, the tests
 * and every screenshot, so each milestone extends it to exercise its
 * features. The same seed and `asOf` always produce the same database.
 */

export interface DemoOptions {
  seed?: number;
  /** Last day of data, YYYY-MM-DD. */
  asOf?: string;
  months?: number;
}

export interface DemoSummary {
  accounts: number;
  transactions: number;
  from: string;
  to: string;
}

export const DEMO_DEFAULTS = { seed: 42, asOf: "2026-11-01", months: 26 } as const;

type AccountKey =
  | "checking"
  | "savings"
  | "harborCard"
  | "summitCard"
  | "meridianCard"
  | "brokerage"
  | "ira"
  | "roth"
  | "k401"
  | "hsa";

interface DemoAccount {
  key: AccountKey;
  connection: "harbor" | "summit" | "meridian" | "northstar";
  name: string;
  mask: string;
  type: "depository" | "credit" | "investment";
  subtype: string;
  tax: string;
  /** Starting balance in cents, signed by worth to the owner. */
  start: number;
}

const ACCOUNTS: DemoAccount[] = [
  { key: "checking", connection: "harbor", name: "Everyday Checking", mask: "4410", type: "depository", subtype: "checking", tax: "none", start: 620_000 },
  { key: "savings", connection: "harbor", name: "High-Yield Savings", mask: "7702", type: "depository", subtype: "savings", tax: "none", start: 1_850_000 },
  { key: "harborCard", connection: "harbor", name: "Harbor Rewards Card", mask: "3391", type: "credit", subtype: "credit card", tax: "none", start: 0 },
  { key: "summitCard", connection: "summit", name: "Summit Travel Card", mask: "9025", type: "credit", subtype: "credit card", tax: "none", start: 0 },
  { key: "meridianCard", connection: "meridian", name: "Meridian Cash Card", mask: "1187", type: "credit", subtype: "credit card", tax: "none", start: 0 },
  { key: "brokerage", connection: "northstar", name: "Individual Brokerage", mask: "5521", type: "investment", subtype: "brokerage", tax: "taxable", start: 4_200_000 },
  { key: "ira", connection: "northstar", name: "Rollover IRA", mask: "5522", type: "investment", subtype: "ira", tax: "traditional", start: 3_100_000 },
  { key: "roth", connection: "northstar", name: "Roth IRA", mask: "5523", type: "investment", subtype: "roth", tax: "roth", start: 2_400_000 },
  { key: "k401", connection: "northstar", name: "Nimbus Labs 401(k)", mask: "8840", type: "investment", subtype: "401k", tax: "traditional", start: 9_600_000 },
  { key: "hsa", connection: "northstar", name: "Health Savings Account", mask: "6603", type: "investment", subtype: "hsa", tax: "hsa", start: 780_000 },
];

const CONNECTIONS: Record<DemoAccount["connection"], string> = {
  harbor: "Harbor Bank",
  summit: "Summit Card Services",
  meridian: "Meridian Financial",
  northstar: "Northstar Investments",
};

interface Tx {
  account: AccountKey;
  date: string;
  cents: number;
  description: string;
  merchant: string | null;
  category: string;
  pending?: boolean;
  needsReview?: boolean;
}

/** A merchant that shows up at random: [description, merchant, category, min, max, account]. */
type Variable = readonly [string, string, string, number, number, AccountKey];

const GROCERIES: Variable[] = [
  ["FRESH BASKET MARKET #214", "Fresh Basket Market", "food.groceries", 2200, 9800, "meridianCard"],
  ["GREENWAY FOODS 0087", "Greenway Foods", "food.groceries", 1800, 7400, "meridianCard"],
  ["CORNER CO-OP", "Corner Co-op", "food.groceries", 900, 5200, "harborCard"],
];
const RESTAURANTS: Variable[] = [
  ["TST* LANTERN NOODLE HOUSE", "Lantern Noodle House", "food.restaurants", 1600, 5200, "harborCard"],
  ["SQ *TWO RIVERS TAQUERIA", "Two Rivers Taqueria", "food.restaurants", 1100, 3900, "harborCard"],
  ["OAK & EMBER GRILL", "Oak & Ember Grill", "food.restaurants", 3400, 11800, "summitCard"],
  ["BLUE DOOR PIZZA", "Blue Door Pizza", "food.restaurants", 1800, 4600, "harborCard"],
  ["SALAD THEORY", "Salad Theory", "food.restaurants", 1200, 2100, "harborCard"],
  ["DASHPLATE*ORDER", "Dashplate", "food.delivery", 1900, 5800, "harborCard"],
];
const COFFEE: Variable[] = [
  ["SQ *KETTLE & CROW COFFEE", "Kettle & Crow Coffee", "food.coffee", 425, 890, "harborCard"],
  ["NORTHWIND ROASTERS", "Northwind Roasters", "food.coffee", 375, 1250, "harborCard"],
];
const SHOPPING: Variable[] = [
  ["RIVERMART.COM*ORDER", "Rivermart", "shopping.general", 700, 5800, "meridianCard"],
  ["RIVERMART.COM*ORDER", "Rivermart", "shopping.home", 900, 4900, "meridianCard"],
  ["THREADLINE APPAREL", "Threadline Apparel", "shopping.clothing", 1800, 8800, "summitCard"],
  ["HOLLOWAY HARDWARE", "Holloway Hardware", "housing.maintenance", 800, 9600, "harborCard"],
  ["PAPER LANTERN BOOKS", "Paper Lantern Books", "entertainment.media", 1100, 4800, "harborCard"],
  ["VOLT ELECTRONICS", "Volt Electronics", "shopping.electronics", 1200, 7900, "summitCard"],
];
const TRANSPORT: Variable[] = [
  ["CEDAR FUEL 4471", "Cedar Fuel", "transport.fuel", 3400, 6200, "meridianCard"],
  ["HOPLINK RIDE", "Hoplink", "transport.transit", 900, 3400, "harborCard"],
  ["CITY PARKING METER", "City Parking", "transport.parking", 200, 1800, "harborCard"],
];
const SMALL: Variable[] = [
  ["QUICKSTOP CONVENIENCE 22", "Quickstop", "shopping.general", 250, 1400, "harborCard"],
  ["SQ *SUNRISE BAGELS", "Sunrise Bagels", "food.restaurants", 450, 1300, "harborCard"],
  ["VENDWELL SNACKS", "Vendwell", "food.restaurants", 150, 400, "harborCard"],
];
const OCCASIONAL: Variable[] = [
  ["WELLSPRING PHARMACY", "Wellspring Pharmacy", "health.pharmacy", 600, 4800, "harborCard"],
  ["BRIGHT SMILE DENTAL", "Bright Smile Dental", "health.dental-vision", 4000, 22000, "harborCard"],
  ["STARLIGHT CINEMAS", "Starlight Cinemas", "entertainment.events", 1400, 4200, "harborCard"],
  ["PAWS & CLAWS SUPPLY", "Paws & Claws Supply", "personal.pets", 1800, 7400, "meridianCard"],
  ["SHEAR STUDIO", "Shear Studio", "personal.care", 3000, 6500, "harborCard"],
  ["THE TAPROOM", "The Taproom", "food.alcohol", 1400, 5200, "harborCard"],
  ["OPEN HANDS FOOD BANK", "Open Hands Food Bank", "personal.charity", 2500, 10000, "summitCard"],
];

/** Fixed monthly charges: [day, description, merchant, category, cents, account]. */
type Monthly = readonly [number, string, string, string, number, AccountKey];
const SUBSCRIPTIONS: Monthly[] = [
  [3, "TUNEBOX PREMIUM", "Tunebox", "entertainment.streaming", 1099, "harborCard"],
  [7, "CLOUDNEST STORAGE", "CloudNest", "software.subscriptions", 299, "harborCard"],
  [11, "PIXEL ARCADE PASS", "Pixel Arcade", "entertainment.games", 1499, "harborCard"],
  [12, "FITLOOP GYM MEMBERSHIP", "FitLoop", "health.fitness", 3900, "meridianCard"],
  [15, "THE DAILY LEDGER", "The Daily Ledger", "entertainment.media", 1200, "harborCard"],
  [19, "LUMEN AI PRO", "Lumen AI", "software.cloud-ai", 2000, "summitCard"],
  [21, "FIBERLINE INTERNET", "Fiberline", "utilities.internet", 7000, "harborCard"],
  [24, "CLEARWAVE MOBILE", "Clearwave Mobile", "utilities.mobile", 4500, "harborCard"],
];

export async function generateDemoData(db: SqlDriver, options: DemoOptions = {}): Promise<DemoSummary> {
  const seed = options.seed ?? DEMO_DEFAULTS.seed;
  const asOf = options.asOf ?? DEMO_DEFAULTS.asOf;
  const months = options.months ?? DEMO_DEFAULTS.months;
  const rng = createRng(seed);
  const stamp = `${asOf}T12:00:00.000Z`;
  const newId = createIdFactory(() => Date.parse(stamp), rng.next);

  const start = `${shiftMonth(asOf.slice(0, 7), -months)}-01`;
  const txs = buildTransactions(rng, start, asOf);

  await db.transaction(async () => {
    const connectionIds = new Map<string, string>();
    for (const [key, name] of Object.entries(CONNECTIONS)) {
      const id = newId();
      connectionIds.set(key, id);
      await db.run(
        `INSERT INTO connections (id, source, institution_name, status, last_synced_at, created_at)
         VALUES (?, 'file', ?, 'ok', ?, ?)`,
        [id, name, stamp, stamp],
      );
    }
    const accountIds = new Map<AccountKey, string>();
    for (const a of ACCOUNTS) {
      const id = newId();
      accountIds.set(a.key, id);
      await db.run(
        `INSERT INTO accounts (id, connection_id, owner_id, name, mask, type, subtype, tax_treatment, feed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'file', ?)`,
        [id, connectionIds.get(a.connection)!, DEFAULT_OWNER_ID, a.name, a.mask, a.type, a.subtype, a.tax, stamp],
      );
    }

    let n = 0;
    for (const t of txs) {
      n++;
      const review = t.needsReview || t.category === UNCATEGORIZED;
      await db.run(
        `INSERT INTO transactions (id, account_id, source, external_id, pending, posted_date, amount_cents,
           description_raw, merchant_raw, category_id, category_source, needs_review, created_at, updated_at)
         VALUES (?, ?, 'file', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId(),
          accountIds.get(t.account)!,
          `demo-${String(n).padStart(6, "0")}`,
          t.pending ? 1 : 0,
          t.date,
          t.cents,
          t.description,
          t.merchant,
          t.category,
          review ? null : "memory",
          review ? 1 : 0,
          stamp,
          stamp,
        ],
      );
    }

    for (const [key, date, cents] of buildBalances(rng, txs, start, asOf)) {
      await db.run(
        "INSERT INTO balances (account_id, as_of, current_cents, source) VALUES (?, ?, ?, 'file')",
        [accountIds.get(key)!, date, cents],
      );
    }
  });

  return { accounts: ACCOUNTS.length, transactions: txs.length, from: start, to: asOf };
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

function lastDayOfMonth(month: string): string {
  return addDays(`${shiftMonth(month, 1)}-01`, -1);
}

function buildTransactions(rng: Rng, start: string, asOf: string): Tx[] {
  const txs: Tx[] = [];
  const add = (t: Tx) => {
    if (t.date >= start && t.date <= asOf) txs.push(t);
  };
  const spend = (v: Variable, date: string) =>
    add({ account: v[5], date, cents: -rng.int(v[3], v[4]), description: v[0], merchant: v[1], category: v[2] });

  // Day-by-day variable spending.
  let payday = addDays(start, 4);
  for (let date = start; date <= asOf; date = addDays(date, 1)) {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekend = dow === 0 || dow === 6;

    if (date === payday) {
      add({ account: "checking", date, cents: 448_000 + rng.int(-900, 900), description: "NIMBUS LABS PAYROLL DIRECT DEP", merchant: "Nimbus Labs", category: "income.paycheck" });
      payday = addDays(payday, 14);
    }
    if (rng.chance(weekend ? 0.7 : 0.45)) spend(rng.pick(GROCERIES), date);
    if (rng.chance(0.15)) spend(rng.pick(GROCERIES), date);
    const meals = rng.chance(weekend ? 0.85 : 0.6) ? 1 + (rng.chance(0.35) ? 1 : 0) : 0;
    for (let i = 0; i < meals; i++) spend(rng.pick(RESTAURANTS), date);
    if (rng.chance(weekend ? 0.5 : 0.85)) spend(rng.pick(COFFEE), date);
    if (rng.chance(0.55)) spend(rng.pick(SHOPPING), date);
    if (rng.chance(0.4)) spend(rng.pick(TRANSPORT), date);
    if (rng.chance(0.8)) spend(rng.pick(SMALL), date);
    if (rng.chance(0.2)) spend(rng.pick(COFFEE), date);
    if (rng.chance(0.25)) spend(rng.pick(OCCASIONAL), date);
    if (!weekend) {
      // The commute: a fare each way on most working days.
      const fares = rng.chance(0.85) ? 2 : 0;
      for (let i = 0; i < fares; i++) {
        add({ account: "harborCard", date, cents: -275, description: "METROLINE TRANSIT FARE", merchant: "Metroline Transit", category: "transport.transit" });
      }
    }
    if (rng.chance(0.012)) {
      add({ account: "harborCard", date, cents: -rng.int(900, 6400), description: `POS PURCHASE ${rng.int(100000, 999999)}`, merchant: null, category: UNCATEGORIZED });
    }
  }

  // Month-by-month fixed items.
  const firstMonth = start.slice(0, 7);
  const lastMonth = asOf.slice(0, 7);
  for (let month = firstMonth, index = 0; month <= lastMonth; month = shiftMonth(month, 1), index++) {
    const day = (d: number) => `${month}-${String(d).padStart(2, "0")}`;
    add({ account: "checking", date: day(1), cents: -215_000, description: "WILLOW CREEK APARTMENTS RENT", merchant: "Willow Creek Apartments", category: "housing.rent" });
    add({ account: "harborCard", date: day(18), cents: -rng.int(6100, 14200), description: "BRIGHTGRID ENERGY", merchant: "Brightgrid Energy", category: "utilities.energy" });
    add({ account: "checking", date: day(9), cents: -rng.int(3800, 5600), description: "CITY WATER & WASTE AUTOPAY", merchant: "City Water & Waste", category: "utilities.water" });
    for (const s of SUBSCRIPTIONS) {
      add({ account: s[5], date: day(s[0]), cents: -s[4], description: s[1], merchant: s[2], category: s[3] });
    }
    // A planted price increase: Streamly goes up five months before asOf.
    const streamly = shiftMonth(lastMonth, -5) <= month ? 1799 : 1599;
    add({ account: "harborCard", date: day(5), cents: -streamly, description: "STREAMLY.COM", merchant: "Streamly", category: "entertainment.streaming" });

    // Transfers: both sides are generated so the matcher has pairs to find.
    add({ account: "checking", date: day(2), cents: -60_000, description: "TRANSFER TO SAVINGS 7702", merchant: null, category: "transfers.internal" });
    add({ account: "savings", date: day(2), cents: 60_000, description: "TRANSFER FROM CHECKING 4410", merchant: null, category: "transfers.internal" });
    add({ account: "checking", date: day(6), cents: -50_000, description: "NORTHSTAR INVESTMENTS CONTRIB", merchant: "Northstar Investments", category: "transfers.investment" });
    add({ account: "savings", date: lastDayOfMonth(month), cents: rng.int(5800, 7400), description: "INTEREST PAYMENT", merchant: null, category: "income.interest" });

    if (index % 6 === 2) {
      add({ account: "checking", date: day(14), cents: -64_000, description: "IRONCLAD AUTO INSURANCE", merchant: "Ironclad Insurance", category: "transport.car-insurance" });
    }
    if (index % 12 === 4) {
      add({ account: "harborCard", date: day(22), cents: -1800, description: "DOMAINHOST ANNUAL RENEWAL", merchant: "DomainHost", category: "software.subscriptions" });
    }
    if (index % 7 === 3) {
      // A trip: flights booked mid-month, lodging and activities a week later.
      add({ account: "summitCard", date: day(10), cents: -rng.int(28_000, 64_000), description: "SKYLARK AIRLINES", merchant: "Skylark Airlines", category: "travel.flights" });
      add({ account: "summitCard", date: day(17), cents: -rng.int(42_000, 88_000), description: "HARBORVIEW HOTEL", merchant: "Harborview Hotel", category: "travel.lodging" });
      add({ account: "summitCard", date: day(18), cents: -rng.int(6000, 18_000), description: "COASTLINE KAYAK TOURS", merchant: "Coastline Kayak Tours", category: "travel.activities" });
      add({ account: "summitCard", date: day(18), cents: -312, description: "FOREIGN TRANSACTION FEE", merchant: null, category: "financial.fees" });
    }
    if (index % 12 === 2) {
      add({ account: "checking", date: day(15), cents: 620_000, description: "NIMBUS LABS BONUS", merchant: "Nimbus Labs", category: "income.bonus" });
    }
  }

  // Planted anomalies, placed relative to asOf so they are always recent.
  const recent = (daysAgo: number) => addDays(asOf, -daysAgo);
  add({ account: "summitCard", date: recent(23), cents: -189_900, description: "VOLT ELECTRONICS", merchant: "Volt Electronics", category: "shopping.electronics" });
  add({ account: "harborCard", date: recent(12), cents: -4250, description: "BLUE DOOR PIZZA", merchant: "Blue Door Pizza", category: "food.restaurants" });
  add({ account: "harborCard", date: recent(11), cents: -4250, description: "BLUE DOOR PIZZA", merchant: "Blue Door Pizza", category: "food.restaurants" });
  add({ account: "harborCard", date: recent(8), cents: -4999, description: "QK*ZRX HOLDINGS 8842", merchant: null, category: UNCATEGORIZED });
  // Look-alikes that are not duplicates: same merchant, same day, different amounts.
  add({ account: "harborCard", date: recent(6), cents: -475, description: "SQ *KETTLE & CROW COFFEE", merchant: "Kettle & Crow Coffee", category: "food.coffee" });
  add({ account: "harborCard", date: recent(6), cents: -1150, description: "SQ *KETTLE & CROW COFFEE", merchant: "Kettle & Crow Coffee", category: "food.coffee" });
  for (const [daysAgo, v] of [[1, RESTAURANTS[0]!], [0, COFFEE[0]!], [0, GROCERIES[0]!]] as const) {
    add({ account: v[5], date: recent(daysAgo), cents: -rng.int(v[3], v[4]), description: v[0], merchant: v[1], category: v[2], pending: true });
  }

  // Card payments: each month, pay last month's charges from checking.
  const cards: AccountKey[] = ["harborCard", "summitCard", "meridianCard"];
  const payee: Record<string, string> = { harborCard: "HARBOR CARD", summitCard: "SUMMIT CARD SVCS", meridianCard: "MERIDIAN FINANCIAL" };
  for (let month = shiftMonth(firstMonth, 1); month <= lastMonth; month = shiftMonth(month, 1)) {
    const previous = shiftMonth(month, -1);
    cards.forEach((card, i) => {
      const owed = -txs
        .filter((t) => t.account === card && t.date.startsWith(previous) && !t.pending && t.cents < 0)
        .reduce((sum, t) => sum + t.cents, 0);
      if (owed <= 0) return;
      const date = `${month}-${String(20 + i * 2).padStart(2, "0")}`;
      add({ account: "checking", date, cents: -owed, description: `${payee[card]} PAYMENT`, merchant: null, category: "transfers.card-payment" });
      add({ account: card, date, cents: owed, description: "PAYMENT THANK YOU", merchant: null, category: "transfers.card-payment" });
    });
  }

  txs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return txs;
}

/** Month-end balances for every account, plus one on the final day. */
function buildBalances(rng: Rng, txs: Tx[], start: string, asOf: string): [AccountKey, string, number][] {
  const out: [AccountKey, string, number][] = [];
  const dates: string[] = [];
  for (let month = start.slice(0, 7); month < asOf.slice(0, 7); month = shiftMonth(month, 1)) {
    dates.push(lastDayOfMonth(month));
  }
  if (dates[dates.length - 1] !== asOf) dates.push(asOf);

  for (const a of ACCOUNTS) {
    if (a.type === "investment") {
      // A random walk with drift, plus the monthly contribution for the
      // brokerage account and payroll deferrals for the 401(k).
      let value = a.start;
      const contribution = a.key === "brokerage" ? 50_000 : a.key === "k401" ? 190_000 : a.key === "hsa" ? 30_000 : 0;
      for (const date of dates) {
        value = Math.round(value * (1 + 0.006 + (rng.next() - 0.5) * 0.07)) + contribution;
        out.push([a.key, date, value]);
      }
      continue;
    }
    const mine = txs.filter((t) => t.account === a.key && !t.pending);
    let balance = a.start;
    let i = 0;
    for (const date of dates) {
      while (i < mine.length && mine[i]!.date <= date) balance += mine[i++]!.cents;
      out.push([a.key, date, balance]);
    }
  }
  return out;
}
