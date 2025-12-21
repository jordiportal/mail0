CREATE TABLE "mail0_label" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "label_connection_name_unique" UNIQUE("connection_id","name")
);
--> statement-breakpoint
CREATE TABLE "mail0_sync_state" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"last_sync_at" timestamp,
	"last_history_id" text,
	"sync_in_progress" boolean DEFAULT false NOT NULL,
	"total_threads_synced" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mail0_sync_state_connection_id_unique" UNIQUE("connection_id")
);
--> statement-breakpoint
CREATE TABLE "mail0_thread" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"latest_sender" jsonb,
	"latest_received_on" timestamp,
	"latest_subject" text,
	"summary" text,
	"ai_processed_at" timestamp,
	"synced_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "thread_connection_thread_unique" UNIQUE("connection_id","thread_id")
);
--> statement-breakpoint
CREATE TABLE "mail0_thread_label" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"label_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "thread_label_thread_label_unique" UNIQUE("thread_id","label_id")
);
--> statement-breakpoint
ALTER TABLE "mail0_label" ADD CONSTRAINT "mail0_label_connection_id_mail0_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mail0_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail0_sync_state" ADD CONSTRAINT "mail0_sync_state_connection_id_mail0_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mail0_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail0_thread" ADD CONSTRAINT "mail0_thread_connection_id_mail0_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mail0_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail0_thread_label" ADD CONSTRAINT "mail0_thread_label_thread_id_mail0_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."mail0_thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail0_thread_label" ADD CONSTRAINT "mail0_thread_label_label_id_mail0_label_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."mail0_label"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "label_connection_id_idx" ON "mail0_label" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "label_name_idx" ON "mail0_label" USING btree ("name");--> statement-breakpoint
CREATE INDEX "sync_state_connection_id_idx" ON "mail0_sync_state" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "sync_state_last_sync_at_idx" ON "mail0_sync_state" USING btree ("last_sync_at");--> statement-breakpoint
CREATE INDEX "thread_connection_id_idx" ON "mail0_thread" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "thread_thread_id_idx" ON "mail0_thread" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "thread_latest_received_on_idx" ON "mail0_thread" USING btree ("latest_received_on");--> statement-breakpoint
CREATE INDEX "thread_ai_processed_at_idx" ON "mail0_thread" USING btree ("ai_processed_at");--> statement-breakpoint
CREATE INDEX "thread_synced_at_idx" ON "mail0_thread" USING btree ("synced_at");--> statement-breakpoint
CREATE INDEX "thread_label_thread_id_idx" ON "mail0_thread_label" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "thread_label_label_id_idx" ON "mail0_thread_label" USING btree ("label_id");