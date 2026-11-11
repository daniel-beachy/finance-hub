export type CategoryKind = "income" | "expense" | "transfer" | "investment";

export interface SeedGroup {
  id: string;
  name: string;
  kind: CategoryKind;
  /** [slug suffix, display name] */
  categories: [string, string][];
}

/** Category IDs are `<group>.<suffix>` and are stable; names can be edited. */
export const SEED_GROUPS: SeedGroup[] = [
  {
    id: "income",
    name: "Income",
    kind: "income",
    categories: [
      ["paycheck", "Paycheck"],
      ["bonus", "Bonus"],
      ["equity", "Equity compensation"],
      ["interest", "Interest"],
      ["dividends", "Dividends"],
      ["refunds", "Refunds and reimbursements"],
      ["other", "Other income"],
    ],
  },
  {
    id: "housing",
    name: "Housing",
    kind: "expense",
    categories: [
      ["rent", "Rent"],
      ["mortgage", "Mortgage"],
      ["property-tax", "Property tax"],
      ["insurance", "Home insurance"],
      ["hoa", "HOA"],
      ["maintenance", "Maintenance and repairs"],
      ["furnishings", "Furnishings"],
    ],
  },
  {
    id: "utilities",
    name: "Utilities",
    kind: "expense",
    categories: [
      ["energy", "Electric and gas"],
      ["water", "Water and trash"],
      ["internet", "Internet"],
      ["mobile", "Mobile phone"],
    ],
  },
  {
    id: "food",
    name: "Food",
    kind: "expense",
    categories: [
      ["groceries", "Groceries"],
      ["restaurants", "Restaurants"],
      ["coffee", "Coffee"],
      ["delivery", "Delivery"],
      ["alcohol", "Alcohol and bars"],
    ],
  },
  {
    id: "transport",
    name: "Transport",
    kind: "expense",
    categories: [
      ["fuel", "Fuel"],
      ["car-payment", "Car payment"],
      ["car-insurance", "Car insurance"],
      ["maintenance", "Maintenance"],
      ["parking", "Parking and tolls"],
      ["transit", "Rideshare and transit"],
    ],
  },
  {
    id: "shopping",
    name: "Shopping",
    kind: "expense",
    categories: [
      ["general", "General merchandise"],
      ["clothing", "Clothing"],
      ["electronics", "Electronics"],
      ["home", "Home goods"],
      ["gifts", "Gifts"],
    ],
  },
  {
    id: "health",
    name: "Health",
    kind: "expense",
    categories: [
      ["medical", "Medical"],
      ["dental-vision", "Dental and vision"],
      ["pharmacy", "Pharmacy"],
      ["fitness", "Fitness"],
      ["insurance", "Health insurance"],
    ],
  },
  {
    id: "entertainment",
    name: "Entertainment",
    kind: "expense",
    categories: [
      ["streaming", "Streaming"],
      ["games", "Games"],
      ["events", "Events"],
      ["hobbies", "Hobbies"],
      ["media", "Books and media"],
    ],
  },
  {
    id: "travel",
    name: "Travel",
    kind: "expense",
    categories: [
      ["flights", "Flights"],
      ["lodging", "Lodging"],
      ["rental-cars", "Rental cars"],
      ["activities", "Travel activities"],
    ],
  },
  {
    id: "personal",
    name: "Personal",
    kind: "expense",
    categories: [
      ["care", "Personal care"],
      ["education", "Education"],
      ["pets", "Pets"],
      ["childcare", "Childcare"],
      ["charity", "Charity"],
    ],
  },
  {
    id: "financial",
    name: "Financial",
    kind: "expense",
    categories: [
      ["fees", "Fees"],
      ["interest", "Interest paid"],
      ["taxes", "Taxes paid"],
      ["services", "Financial services"],
    ],
  },
  {
    id: "software",
    name: "Software",
    kind: "expense",
    categories: [
      ["subscriptions", "Subscriptions and apps"],
      ["cloud-ai", "Cloud and AI services"],
    ],
  },
  {
    id: "transfers",
    name: "Transfers",
    kind: "transfer",
    categories: [
      ["internal", "Internal transfer"],
      ["card-payment", "Credit card payment"],
      ["investment", "Investment contribution"],
      ["loan-principal", "Loan principal"],
    ],
  },
  {
    id: "uncategorized",
    name: "Uncategorized",
    kind: "expense",
    categories: [["uncategorized", "Uncategorized"]],
  },
];

export const UNCATEGORIZED = "uncategorized.uncategorized";

export const ALL_CATEGORY_IDS: string[] = SEED_GROUPS.flatMap((g) =>
  g.categories.map(([suffix]) => `${g.id}.${suffix}`),
);
