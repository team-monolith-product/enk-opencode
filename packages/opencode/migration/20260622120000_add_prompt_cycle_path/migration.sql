-- Record the session working directory each prompt cycle ran in. The same value is reported
-- to enk-hackathon-rails as the ai_usages `mount_path`. Nullable; existing rows stay null.
ALTER TABLE `prompt_cycle` ADD `path` text;
