CREATE TABLE `background_jobs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`last_started_at` integer,
	`last_completed_at` integer,
	`status` text NOT NULL,
	`last_outcome` text,
	`last_error_code` text,
	`last_error_message` text,
	`last_duration_ms` integer,
	`last_affected_count` integer,
	`updated_at` integer NOT NULL
);
