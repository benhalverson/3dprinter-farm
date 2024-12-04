import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "sqlite", // "mysql" | "sqlite" | "postgresql"
  schema: "./src/db/schema.ts",
  out: "./drizzle/migrations",
	dbCredentials: {
		url: "./.wrangler/state/v3/d1/miniflare-D1DatabaseObject/d35103565605bbf34650d892dc0fd8c2d60033a082705f64d098d6dc8b9a5fb5.sqlite"
	}
});
