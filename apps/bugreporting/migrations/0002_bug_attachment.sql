CREATE TABLE bug_attachment (
 id TEXT PRIMARY KEY,
 report_id INTEGER NOT NULL REFERENCES bug_report(id),
 filename TEXT NOT NULL,
 content_type TEXT NOT NULL,
 size INTEGER NOT NULL,
 object_key TEXT NOT NULL UNIQUE
);
CREATE INDEX bug_attachment_report ON bug_attachment(report_id);
