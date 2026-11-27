-- Why the server itself cancelled a consent vote ('stop': a stop vote took over a send waiting for
-- consent). Stored so every later read of the vote — a reconnecting client's replay included — says the
-- same thing the live cancellation said.
ALTER TABLE `doc_submit` ADD `cancel_reason` text;
