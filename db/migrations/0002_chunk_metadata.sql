-- 0002_chunk_metadata: stable chunk keys for citations, section/doc metadata, injection quarantine.

ALTER TABLE chunks
  ADD COLUMN chunk_key   text NOT NULL,
  ADD COLUMN title       text NOT NULL,
  ADD COLUMN doc_type    text NOT NULL,
  ADD COLUMN quarantined boolean NOT NULL DEFAULT false,
  ADD COLUMN flags       text[] NOT NULL DEFAULT '{}';

ALTER TABLE chunks ADD CONSTRAINT chunks_chunk_key_key UNIQUE (chunk_key);

ALTER TABLE documents RENAME COLUMN category TO doc_type;
