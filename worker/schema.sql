-- Fair Dinkum online sign-ups. Kept in an EU-only Cloudflare D1 database.
CREATE TABLE IF NOT EXISTS orgs (id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, name TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT NOT NULL, org TEXT NOT NULL, token TEXT NOT NULL, name TEXT, starts INTEGER, when_text TEXT, place TEXT,
  remind_hours INTEGER DEFAULT 24, reminded INTEGER DEFAULT 0, invited_at INTEGER, created INTEGER, updated INTEGER,
  PRIMARY KEY (org, id));
CREATE TABLE IF NOT EXISTS invitees (org TEXT NOT NULL, session TEXT NOT NULL, pid TEXT NOT NULL, name TEXT, PRIMARY KEY (org, session, pid));
CREATE TABLE IF NOT EXISTS signups (org TEXT NOT NULL, session TEXT NOT NULL, pid TEXT NOT NULL, name TEXT, status TEXT, newcomer INTEGER DEFAULT 0, at INTEGER,
  PRIMARY KEY (org, session, pid));
CREATE TABLE IF NOT EXISTS people (org TEXT NOT NULL, pid TEXT NOT NULL, name TEXT, email TEXT, consent_at INTEGER, unsub INTEGER DEFAULT 0, token TEXT,
  PRIMARY KEY (org, pid));
CREATE TABLE IF NOT EXISTS emaillog (day TEXT PRIMARY KEY, n INTEGER);
