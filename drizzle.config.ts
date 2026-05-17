import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "src/monitor/data/schema.ts",
  out: "drizzle/migrations",
});
