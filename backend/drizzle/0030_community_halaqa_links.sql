CREATE TABLE "community_halaqa_links" (
	"id" text PRIMARY KEY NOT NULL,
	"community_id" text NOT NULL,
	"halaqa_id" text NOT NULL,
	"linked_by" text,
	"linked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "community_halaqa_links" ADD CONSTRAINT "community_halaqa_links_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "community_halaqa_links_unique" ON "community_halaqa_links" USING btree ("community_id","halaqa_id");--> statement-breakpoint
CREATE INDEX "community_halaqa_links_by_halaqa" ON "community_halaqa_links" USING btree ("halaqa_id");--> statement-breakpoint
-- Data backfill (hand-added; drizzle-kit does not generate data moves): preserve
-- every existing single-halaqa association into the new join table BEFORE the
-- legacy scalar column is retired. One link per linked community; `linked_by` is
-- null (migrated, no acting overseer); `linked_at` is the migration instant.
INSERT INTO "community_halaqa_links" ("id", "community_id", "halaqa_id", "linked_by", "linked_at")
SELECT gen_random_uuid()::text, "id", "halaqa_id", NULL, now()
FROM "communities"
WHERE "halaqa_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "communities" DROP COLUMN "halaqa_id";