-- The stop vote that took over a send waiting for consent (set with cancel_reason 'stop'). A
-- reconnecting peer is told about a dropped send only when the stop vote it is shown is the one that
-- dropped it, matched by this id instead of inferred from timestamps.
ALTER TABLE `doc_submit` ADD `cancelled_by_submit` text;
