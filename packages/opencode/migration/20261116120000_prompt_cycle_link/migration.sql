-- Which run a user message joined (steer, a consented send landing mid-run, auto-compaction or a
-- subtask summary created by the run). The cycle recorder folds those answers into the run's
-- anchor cycle instead of splitting one AI run into several cycles. Existing cycles stay as they
-- were recorded; only runs from now on are merged.
CREATE TABLE `prompt_cycle_link` (
	`user_message_id` text PRIMARY KEY NOT NULL,
	`anchor_user_message_id` text NOT NULL,
	`session_id` text NOT NULL,
	`time_created` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `prompt_cycle_link_anchor_idx` ON `prompt_cycle_link` (`anchor_user_message_id`);
