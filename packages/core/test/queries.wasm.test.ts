import initSqlJs from "sql.js";
import { createWasmDriver } from "../src/index.ts";
import { defineQuerySuite } from "./querySuite.ts";

defineQuerySuite("wasm", async () => {
  const SQL = await initSqlJs();
  return createWasmDriver(new SQL.Database());
});
