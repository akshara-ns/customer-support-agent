-- 0008: bind each session to the browser that created it (review finding S1: anyone who knew a session
-- UUID could read its transcript/traces, write to it, mint a voice key for it, or act as its verified
-- customer). Stores only a SHA-256 hash of an HttpOnly cookie token.
ALTER TABLE sessions ADD COLUMN owner_hash text;
