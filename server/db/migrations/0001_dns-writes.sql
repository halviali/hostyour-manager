CREATE TABLE `dns_writes` (
	`name` text NOT NULL,
	`type` text NOT NULL,
	`content` text NOT NULL,
	`act` text NOT NULL,
	`owner_kind` text NOT NULL,
	`owner_name` text NOT NULL,
	`owner_stage` text,
	`run_id` text NOT NULL,
	`written_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`name`, `type`)
);
