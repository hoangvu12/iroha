-- Captures: the full prompt and response of one Request, kept only for
-- Gateway Keys with capture on and only for the captures retention period.
-- response_body is what the Caller received; for streams it is reassembled
-- into one answer and the events as sent are in response_stream.
CREATE TABLE captures (
    request_id            TEXT PRIMARY KEY REFERENCES requests (id) ON DELETE CASCADE,
    created_at            INTEGER NOT NULL,
    request_content_type  TEXT NOT NULL DEFAULT '',
    request_body          BLOB,
    request_truncated     INTEGER NOT NULL DEFAULT 0,
    response_status       INTEGER NOT NULL DEFAULT 0,
    response_content_type TEXT NOT NULL DEFAULT '',
    response_body         BLOB,
    response_stream       BLOB,               -- the server-sent events as sent; NULL when not a stream
    response_truncated    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX captures_created ON captures (created_at);

-- Crash recovery finds Requests a stopped process left in progress.
CREATE INDEX requests_in_progress ON requests (state) WHERE state = 'in_progress';
