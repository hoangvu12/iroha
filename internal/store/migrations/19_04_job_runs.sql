-- Job runs: one row per finished run of a background job (dry runs are not
-- stored). The runner keeps the latest 100 per job.
CREATE TABLE job_runs (
    id          INTEGER PRIMARY KEY,
    job         TEXT NOT NULL,
    trigger     TEXT NOT NULL,              -- schedule, manual
    started_at  INTEGER NOT NULL,
    finished_at INTEGER NOT NULL,
    outcome     TEXT NOT NULL,              -- ok, failed
    summary     TEXT NOT NULL DEFAULT '',
    details     TEXT NOT NULL DEFAULT '{}', -- the job's own figures, JSON
    error       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX job_runs_job ON job_runs (job, id);
