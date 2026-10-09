-- Team image generation quota cache. enk-hackathon-rails stays authoritative (it reserves each
-- image); this row only lets the UI show limit/used without waiting on rails.
CREATE TABLE `image_quota` (
	`id` text PRIMARY KEY NOT NULL,
	`limit` integer NOT NULL,
	`used` integer NOT NULL,
	`time_updated` integer NOT NULL
);
