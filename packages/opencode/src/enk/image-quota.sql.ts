import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"

export const ImageQuotaTable = sqliteTable("image_quota", {
  id: text().primaryKey(),
  limit: integer().notNull(),
  used: integer().notNull(),
  time_updated: integer().notNull(),
})
