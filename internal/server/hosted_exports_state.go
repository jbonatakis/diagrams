package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

const exportGrantActive = `EXISTS (SELECT 1 FROM grants g JOIN browsers b ON b.id=g.browser_id WHERE g.id=export_jobs.grant_id AND g.browser_id=export_jobs.browser_id AND g.expires>? AND b.expires>?)`

func (h *hostedExports) grantActive(ctx context.Context, j hostedJob) bool {
	var active int
	now := time.Now().Unix()
	return h.server.db.QueryRowContext(ctx, `SELECT 1 FROM grants g JOIN browsers b ON b.id=g.browser_id WHERE g.id=? AND g.browser_id=? AND g.expires>? AND b.expires>?`, j.GrantID, j.BrowserID, now, now).Scan(&active) == nil
}

func decodeHosted(w http.ResponseWriter, r *http.Request, data any, limit int64) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(data); err != nil {
		http.Error(w, "invalid export metadata", http.StatusBadRequest)
		return false
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		http.Error(w, "invalid export metadata", http.StatusBadRequest)
		return false
	}
	return true
}

func normalizeSnapshot(j hostedJob, data hostedSnapshot) (revision sql.NullInt64, count int, at int64, manifest string, err error) {
	invalid := func() (sql.NullInt64, int, int64, string, error) {
		return sql.NullInt64{}, 0, 0, "", fmt.Errorf("invalid export snapshot")
	}
	if j.Kind == "diagram" {
		if data.Revision == nil || *data.Revision < 0 || *data.Revision > 1<<53-1 || data.DiagramCount != 0 || len(data.SourceRevisions) != 0 || data.SnapshotAt != "" {
			return invalid()
		}
		return sql.NullInt64{Int64: *data.Revision, Valid: true}, 0, 0, "", nil
	}
	if data.Revision != nil || data.DiagramCount < 1 || data.DiagramCount > 100 || len(data.SourceRevisions) != data.DiagramCount {
		return invalid()
	}
	captured, err := time.Parse(time.RFC3339Nano, data.SnapshotAt)
	if err != nil {
		return invalid()
	}
	seen := make(map[string]bool, len(data.SourceRevisions))
	for _, item := range data.SourceRevisions {
		if item.DiagramID == "" || len(item.DiagramID) > 128 || seen[item.DiagramID] || item.Revision < 0 || item.Revision > 1<<53-1 {
			return invalid()
		}
		seen[item.DiagramID] = true
	}
	encoded, err := json.Marshal(data.SourceRevisions)
	if err != nil || len(encoded) > 16<<10 {
		return invalid()
	}
	return sql.NullInt64{}, data.DiagramCount, captured.Unix(), string(encoded), nil
}

func (h *hostedExports) captured(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	j, ok := h.callbackJob(w, r)
	if !ok {
		return
	}
	var data hostedSnapshot
	if !decodeHosted(w, r, &data, 32<<10) {
		return
	}
	rev, count, at, manifest, err := normalizeSnapshot(j, data)
	if err != nil {
		http.Error(w, "invalid export snapshot", http.StatusBadRequest)
		return
	}
	now := time.Now().Unix()
	result, err := h.server.db.ExecContext(r.Context(), `UPDATE export_jobs SET status='preparing',source_revision=?,diagram_count=?,snapshot_at=?,manifest=? WHERE id=? AND status='queued' AND deadline>? AND `+exportGrantActive, rev, count, at, manifest, j.ID, now, now, now)
	if err != nil {
		http.Error(w, "export unavailable", http.StatusServiceUnavailable)
		return
	}
	changed, _ := result.RowsAffected()
	if changed == 0 {
		j, err = h.load(j.ID)
		if err != nil || (j.Status != "preparing" && j.Status != "uploading") || j.SourceRevision != rev || j.DiagramCount != count || j.SnapshotAt != at || j.Manifest != manifest || !h.grantActive(r.Context(), j) {
			http.Error(w, "snapshot already fixed or unavailable", http.StatusConflict)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// Claim a verification in SQLite before making one bounded R2 HEAD. The claim
// survives disconnects/restarts and spaces the maximum three attempts by 10s.
func (h *hostedExports) verify(ctx context.Context, id string, completed bool) error {
	j, err := h.load(id)
	if err != nil {
		return err
	}
	now := time.Now().Unix()
	var attempt int
	err = h.server.db.QueryRowContext(ctx, `UPDATE export_jobs SET status='verifying',verification_attempts=verification_attempts+1,verify_after=? WHERE id=? AND status IN ('uploading','verifying') AND deadline>? AND verification_attempts<3 AND ((verification_attempts=0 AND ?=1) OR verify_after<=?) AND `+exportGrantActive+` RETURNING verification_attempts`, now+10, id, now, completed, now, now, now).Scan(&attempt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	headCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	actual, headErr := h.storage.Head(headCtx, j.ObjectKey)
	cancel()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	failure := ""
	if headErr != nil {
		if attempt < 3 {
			return nil
		}
		failure = "export_verification_failed"
	} else if actual.Size != j.Bytes || actual.ContentType != j.MIMEType {
		failure = "export_verification_failed"
	} else if actual.SHA256 == "" {
		failure = "checksum_unavailable"
	} else {
		checksum, err := base64.StdEncoding.DecodeString(actual.SHA256)
		if err != nil || len(checksum) != sha256.Size || hex.EncodeToString(checksum) != j.SHA256 {
			failure = "export_verification_failed"
		}
	}
	if failure != "" {
		_, err = h.server.db.ExecContext(ctx, `UPDATE export_jobs SET status='failed',failure=?,upload_url='',upload_headers='' WHERE id=? AND status='verifying' AND verification_attempts=?`, failure, id, attempt)
		return err
	}
	now = time.Now().Unix()
	_, err = h.server.db.ExecContext(ctx, `UPDATE export_jobs SET status='ready',link_expires=?,upload_url='',upload_headers='' WHERE id=? AND status='verifying' AND verification_attempts=? AND deadline>? AND `+exportGrantActive, now+int64(exportLinkTTL.Seconds()), id, attempt, now, now, now)
	return err
}

func (h *hostedExports) startWorker() error {
	// Snapshots lived only in the interrupted browser command. Never recapture a
	// newer revision under the same requestId after a server restart.
	if _, err := h.server.db.Exec(`UPDATE export_jobs SET status='failed',failure='export_interrupted',upload_url='',upload_headers='' WHERE status IN ('queued','preparing')`); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	h.cancel = cancel
	h.done = make(chan struct{})
	go func() {
		defer close(h.done)
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			// No provider errors or signed URLs are logged. Polling remains a DB read;
			// uncertain uploads are reconciled here even if the browser has closed.
			_ = h.reconcile(ctx)
		}
	}()
	return nil
}

func (h *hostedExports) reconcile(ctx context.Context) error {
	now := time.Now().Unix()
	if _, err := h.server.db.ExecContext(ctx, `UPDATE export_jobs SET status='expired',failure='expired',upload_url='',upload_headers='' WHERE status IN ('queued','preparing','uploading','verifying','ready') AND (CASE WHEN status='ready' THEN link_expires ELSE deadline END)<=?`, now); err != nil {
		return err
	}
	if _, err := h.server.db.ExecContext(ctx, `UPDATE export_jobs SET status='failed',failure='authorization_revoked',upload_url='',upload_headers='' WHERE status IN ('queued','preparing','uploading','verifying','ready') AND NOT `+exportGrantActive, now, now); err != nil {
		return err
	}
	// A process could have died during its last HEAD; do not strand that claim.
	if _, err := h.server.db.ExecContext(ctx, `UPDATE export_jobs SET status='failed',failure='export_verification_failed',upload_url='',upload_headers='' WHERE status='verifying' AND verification_attempts>=3 AND verify_after<=?`, now); err != nil {
		return err
	}
	rows, err := h.server.db.QueryContext(ctx, `SELECT id FROM export_jobs WHERE status IN ('uploading','verifying') AND verify_after<=? AND deadline>? AND verification_attempts<3 ORDER BY verify_after LIMIT 16`, now, now)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err = h.verify(ctx, id, false); err != nil {
			return err
		}
	}
	return nil
}

func (h *hostedExports) close() {
	if h.cancel != nil {
		h.cancel()
		<-h.done
	}
}
