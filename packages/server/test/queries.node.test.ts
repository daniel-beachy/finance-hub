import { defineQuerySuite } from "../../core/test/querySuite.ts";
import { openNodeDatabase } from "../src/nodeDriver.ts";

defineQuerySuite("node", async () => openNodeDatabase(":memory:").driver);
