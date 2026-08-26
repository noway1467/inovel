CREATE TABLE `login_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`blocked_until` integer,
	`last_failed_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `login_attempts_identifier_unique` ON `login_attempts` (`identifier`);