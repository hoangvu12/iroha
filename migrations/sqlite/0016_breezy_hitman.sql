ALTER TABLE `request_events` ADD `gateway_key_name` text;--> statement-breakpoint
UPDATE `request_events`
SET `gateway_key_name` = (
	SELECT `gateway_keys`.`name`
	FROM `gateway_keys`
	WHERE `gateway_keys`.`id` = `request_events`.`gateway_key_id`
)
WHERE `gateway_key_id` IS NOT NULL;
