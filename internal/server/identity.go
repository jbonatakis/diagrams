package server

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

const browserLifetime = 180 * 24 * time.Hour
const accessLifetime = 15 * time.Minute
const refreshLifetime = 90 * 24 * time.Hour
const agentScope = "diagrams"

func secret() string {
	return base64.RawURLEncoding.EncodeToString(randBytes())
}

func randBytes() []byte {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

func digest(value string) string {
	h := sha256.Sum256([]byte(value))
	return base64.RawURLEncoding.EncodeToString(h[:])
}

func openIdentityStore(path, issuer string) (*sql.DB, error) {
	if path == "" {
		return nil, errors.New("a pairing database path is required")
	}
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return nil, err
		}
		f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
		if err != nil {
			return nil, err
		}
		if err = f.Chmod(0600); err != nil {
			f.Close()
			return nil, err
		}
		if err = f.Close(); err != nil {
			return nil, err
		}
		abs, err := filepath.Abs(path)
		if err != nil {
			return nil, err
		}
		path = (&url.URL{Scheme: "file", Path: abs}).String()
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	// One connection keeps transactions ordered, bounds memory, and applies
	// foreign_keys to every query. No diagram content enters this database.
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA secure_delete = ON;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS browsers (
 id TEXT PRIMARY KEY, cookie_hash TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS clients (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, redirects TEXT NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS grants (
 id TEXT PRIMARY KEY, browser_id TEXT NOT NULL REFERENCES browsers(id) ON DELETE CASCADE,
 client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
 created INTEGER NOT NULL, expires INTEGER NOT NULL, UNIQUE(browser_id, client_id)
);
CREATE TABLE IF NOT EXISTS authorizations (
 id TEXT PRIMARY KEY, browser_id TEXT NOT NULL REFERENCES browsers(id) ON DELETE CASCADE,
 client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
 redirect TEXT NOT NULL, challenge TEXT NOT NULL, state TEXT NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS codes (
 hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
 redirect TEXT NOT NULL, challenge TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tokens (
 hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
 kind TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS grants_browser ON grants(browser_id);
CREATE INDEX IF NOT EXISTS tokens_grant ON tokens(grant_id);
CREATE INDEX IF NOT EXISTS codes_grant ON codes(grant_id);
CREATE INDEX IF NOT EXISTS authorizations_browser ON authorizations(browser_id);
`)
	if err != nil {
		db.Close()
		return nil, err
	}
	var version int
	if err = db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		db.Close()
		return nil, err
	}
	if version > 3 {
		db.Close()
		return nil, errors.New("pairing database schema is newer than this server")
	}
	if version < 1 {
		if _, err = db.Exec("PRAGMA user_version = 1"); err != nil {
			db.Close()
			return nil, err
		}
		version = 1
	}
	if version < 2 {
		tx, txErr := db.Begin()
		if txErr != nil {
			db.Close()
			return nil, txErr
		}
		_, err = tx.Exec(`
CREATE TABLE IF NOT EXISTS export_jobs (
 id TEXT PRIMARY KEY, browser_id TEXT NOT NULL, grant_id TEXT NOT NULL,
 request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, kind TEXT NOT NULL,
 status TEXT NOT NULL, source_id TEXT NOT NULL DEFAULT '', source_revision INTEGER, format TEXT NOT NULL DEFAULT 'svg',
 include_trash INTEGER NOT NULL DEFAULT 1, object_key TEXT NOT NULL UNIQUE,
 filename TEXT NOT NULL DEFAULT '', mime_type TEXT NOT NULL DEFAULT '',
 byte_length INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL DEFAULT '', diagram_count INTEGER NOT NULL DEFAULT 0, snapshot_at INTEGER NOT NULL DEFAULT 0,
 upload_url TEXT NOT NULL DEFAULT '', upload_headers TEXT NOT NULL DEFAULT '', upload_expires INTEGER NOT NULL DEFAULT 0,
 manifest TEXT NOT NULL DEFAULT '',
 created INTEGER NOT NULL, deadline INTEGER NOT NULL, receipt_expires INTEGER NOT NULL,
 link_expires INTEGER NOT NULL DEFAULT 0, failure TEXT NOT NULL DEFAULT '',
 UNIQUE(browser_id, grant_id, request_id)
);
CREATE INDEX IF NOT EXISTS export_jobs_expiry ON export_jobs(receipt_expires);
CREATE INDEX IF NOT EXISTS export_jobs_owner ON export_jobs(browser_id, grant_id, created);
CREATE TABLE IF NOT EXISTS export_usage (
 day TEXT NOT NULL, scope TEXT NOT NULL, scope_id TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(day, scope, scope_id)
);
`)
		if err == nil {
			_, err = tx.Exec("PRAGMA user_version = 2")
		}
		if err == nil {
			err = tx.Commit()
		} else {
			_ = tx.Rollback()
		}
		if err != nil {
			db.Close()
			return nil, err
		}
	}
	if version < 3 {
		tx, txErr := db.Begin()
		if txErr != nil {
			db.Close()
			return nil, txErr
		}
		_, err = tx.Exec(`
ALTER TABLE export_jobs ADD COLUMN verification_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE export_jobs ADD COLUMN verify_after INTEGER NOT NULL DEFAULT 0;
PRAGMA user_version = 3;
`)
		if err == nil {
			err = tx.Commit()
		} else {
			_ = tx.Rollback()
		}
		if err != nil {
			db.Close()
			return nil, err
		}
	}
	if _, err = db.Exec("INSERT OR IGNORE INTO settings VALUES ('issuer', ?)", issuer); err != nil {
		db.Close()
		return nil, err
	}
	var storedIssuer string
	if err = db.QueryRow("SELECT value FROM settings WHERE key='issuer'").Scan(&storedIssuer); err != nil {
		db.Close()
		return nil, err
	}
	if storedIssuer != issuer {
		db.Close()
		return nil, errors.New("this pairing database belongs to a different public URL; use a separate database for each origin")
	}
	return db, nil
}

func (s *Server) pruneIdentities() {
	now := time.Now().Unix()
	_, _ = s.db.Exec(`UPDATE export_jobs SET status='expired',failure='expired',upload_url='',upload_headers='' WHERE status IN ('queued','preparing','uploading','verifying','ready') AND (CASE WHEN status='ready' THEN link_expires ELSE deadline END) <= ?`, now)
	_, _ = s.db.Exec(`DELETE FROM export_jobs WHERE receipt_expires <= ?`, now)
	day := time.Now().UTC().Add(-7 * 24 * time.Hour).Format("2006-01-02")
	_, _ = s.db.Exec(`DELETE FROM export_usage WHERE day < ?`, day)
	// Expired records are removed on startup and hourly, without tracking IPs.
	for _, q := range []string{
		"DELETE FROM browsers WHERE expires <= ?",
		"DELETE FROM grants WHERE expires <= ?",
		"DELETE FROM authorizations WHERE expires <= ?",
		"DELETE FROM codes WHERE expires <= ?",
		"DELETE FROM tokens WHERE expires <= ?",
		"DELETE FROM clients WHERE expires <= ? AND id NOT IN (SELECT client_id FROM grants)",
	} {
		_, _ = s.db.Exec(q, now)
	}
}
