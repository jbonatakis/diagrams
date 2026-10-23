package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	exportUploadTTL  = 5 * time.Minute
	exportJobTTL     = 10 * time.Minute
	exportReceiptTTL = 48 * time.Hour
	exportLinkTTL    = 15 * time.Minute
	exportMaxBytes   = 64 << 20
)

type hostedExports struct {
	server           *Server
	storage          exportStorage
	key              []byte
	cancel           context.CancelFunc
	done             chan struct{}
	creationDisabled bool
}
type hostedJob struct {
	ID, BrowserID, GrantID, RequestID, Fingerprint, Kind, Status     string
	SourceID, Format, Filename, MIMEType, ObjectKey, SHA256, Failure string
	UploadURL, UploadHeaders                                         string
	Manifest                                                         string
	SourceRevision                                                   sql.NullInt64
	DiagramCount                                                     int
	SnapshotAt                                                       int64
	IncludeTrash                                                     bool
	Bytes                                                            int64
	Created, Deadline, ReceiptExpires, LinkExpires                   int64
	UploadExpires                                                    int64
}
type sourceRevision struct {
	DiagramID string `json:"diagramId"`
	Revision  int64  `json:"revision"`
}
type hostedSnapshot struct {
	Revision        *int64           `json:"revision,omitempty"`
	DiagramCount    int              `json:"diagramCount,omitempty"`
	SnapshotAt      string           `json:"snapshotAt,omitempty"`
	SourceRevisions []sourceRevision `json:"sourceRevisions,omitempty"`
}
type hostedMetadata struct {
	Filename     string `json:"filename"`
	MIMEType     string `json:"mimeType"`
	Size         int64  `json:"sizeBytes"`
	SHA256       string `json:"sha256"`
	SHA256Base64 string `json:"checksumSHA256"`
	hostedSnapshot
}

func (h *hostedExports) routes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/exports/{id}/captured", h.captured)
	mux.HandleFunc("POST /api/exports/{id}/upload", h.upload)
	mux.HandleFunc("POST /api/exports/{id}/complete", h.complete)
	mux.HandleFunc("POST /api/exports/{id}/failed", h.fail)
	mux.HandleFunc("GET /export/{id}", h.download)
}

func exportFingerprint(kind, source string, format string, includeTrash bool) string {
	b, _ := json.Marshal(struct {
		Kind, Source, Format string
		IncludeTrash         bool
	}{kind, source, format, includeTrash})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func (h *hostedExports) start(ctx context.Context, browserID, grantID, tool string, args map[string]any) (*mcp.CallToolResult, error) {
	if grantID == "" {
		return nil, &toolError{"unauthorized", "The initiating agent grant is unavailable."}
	}
	kind, source, format, includeTrash := "diagram", "", "svg", true
	if tool == "export_diagram" {
		source, _ = args["diagramId"].(string)
		if _, err := uuid.Parse(source); err != nil {
			return nil, &toolError{"invalid_arguments", "A diagram UUID is required."}
		}
		if f, ok := args["format"].(string); ok && f != "" {
			format = f
		}
		if format != "svg" && format != "png" && format != "excalidraw" {
			return nil, &toolError{"invalid_arguments", "Unsupported hosted export format."}
		}
	} else {
		kind, format = "library", "json"
		includeTrash = args["includeTrash"] != false
	}
	requestID, _ := args["requestId"].(string)
	if parsed, err := uuid.Parse(requestID); err != nil {
		return nil, &toolError{"invalid_arguments", "Hosted exports require a UUID requestId."}
	} else {
		requestID = parsed.String()
	}
	fingerprint := exportFingerprint(kind, source, format, includeTrash)
	now := time.Now().Unix()
	id := "exp_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	key := h.storage.ObjectKey(strings.TrimPrefix(id, "exp_"))
	tx, err := h.server.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var valid int
	if err = tx.QueryRowContext(ctx, `SELECT 1 FROM grants g JOIN browsers b ON b.id=g.browser_id WHERE g.id=? AND g.browser_id=? AND g.expires>? AND b.expires>?`, grantID, browserID, now, now).Scan(&valid); err != nil {
		return nil, &toolError{"unauthorized", "The initiating agent grant is no longer active."}
	}
	var existing hostedJob
	err = scanHosted(tx.QueryRowContext(ctx, hostedSelect+` WHERE browser_id=? AND grant_id=? AND request_id=? AND receipt_expires>?`, browserID, grantID, requestID, now), &existing)
	if err == nil {
		if existing.Fingerprint != fingerprint {
			return nil, &toolError{"request_id_conflict", "This requestId was used with different arguments. Use a new UUID."}
		}
		if err = tx.Commit(); err != nil {
			return nil, err
		}
		existing, err = h.load(existing.ID)
		if err != nil {
			return nil, err
		}
		return h.result(existing), nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if h.creationDisabled {
		return nil, &toolError{"hosted_exports_unavailable", "New hosted exports are disabled; existing downloads remain available until expiry. Use a local chunked export."}
	}
	if err = h.server.bridge.supportsHosted(browserID); err != nil {
		return nil, err
	}
	var recent int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM export_jobs WHERE browser_id=? AND created>?`, browserID, now-60).Scan(&recent); err != nil {
		return nil, err
	}
	if recent >= 10 {
		return nil, &toolError{"export_limit", "Hosted export request rate limit reached. Retry in one minute."}
	}
	// The unique retry receipt can be replaced only after its fixed retention window.
	if _, err = tx.ExecContext(ctx, `DELETE FROM export_jobs WHERE browser_id=? AND grant_id=? AND request_id=? AND receipt_expires<=?`, browserID, grantID, requestID, now); err != nil {
		return nil, err
	}
	if err = reserveAttempt(ctx, tx, now, browserID); err != nil {
		return nil, err
	}
	var active int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM export_jobs WHERE browser_id=? AND status IN ('queued','preparing','uploading','verifying') AND deadline>?`, browserID, now).Scan(&active); err != nil {
		return nil, err
	}
	if active >= 2 {
		return nil, &toolError{"export_limit", "This browser already has two active hosted exports."}
	}
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM export_jobs WHERE status IN ('queued','preparing','uploading','verifying') AND deadline>?`, now).Scan(&active); err != nil {
		return nil, err
	}
	if active >= 16 {
		return nil, &toolError{"export_limit", "The deployment already has sixteen active hosted exports."}
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO export_jobs(id,browser_id,grant_id,request_id,fingerprint,kind,status,source_id,format,include_trash,object_key,created,deadline,receipt_expires) VALUES(?,?,?,?,?,?, 'queued',?,?,?,?,?,?,?)`, id, browserID, grantID, requestID, fingerprint, kind, source, format, includeTrash, key, now, now+int64(exportJobTTL.Seconds()), now+int64(exportReceiptTTL.Seconds()))
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	command, _ := json.Marshal(map[string]any{"version": 1, "deadline": (now + int64(exportJobTTL.Seconds())) * 1000, "exportId": id, "kind": kind, "diagramId": source, "format": format, "includeTrash": includeTrash})
	_, err = h.server.bridge.call(ctx, browserID, "__hosted_export_job", command, time.Second)
	if err != nil {
		var bridgeErr *toolError
		if errors.As(err, &bridgeErr) && bridgeErr.Code != "browser_timeout" {
			failure := bridgeErr.Code
			if failure == "unknown_tool" {
				failure = "unsupported_capability"
			}
			_, _ = h.server.db.ExecContext(ctx, `UPDATE export_jobs SET status='failed',failure=? WHERE id=? AND status IN ('queued','preparing')`, failure, id)
			if failure == "unsupported_capability" {
				return nil, &toolError{failure, "Refresh the paired browser to enable hosted exports."}
			}
			if failure == "browser_unavailable" {
				return nil, &toolError{failure, "Open the paired browser before starting a hosted export."}
			}
			return nil, bridgeErr
		}
	}
	job, err := h.load(id)
	if err != nil {
		return nil, err
	}
	return h.result(job), nil
}

func reserveAttempt(ctx context.Context, tx *sql.Tx, now int64, browser string) error {
	day := time.Unix(now, 0).UTC().Format("2006-01-02")
	for _, row := range []struct {
		scope, id string
		max       int64
	}{{"browser", browser, 50}, {"deployment", "all", 1000}} {
		_, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO export_usage(day,scope,scope_id,attempts,bytes) VALUES(?,?,?,0,0)`, day, row.scope, row.id)
		if err != nil {
			return err
		}
		var attempts int64
		err = tx.QueryRowContext(ctx, `SELECT attempts FROM export_usage WHERE day=? AND scope=? AND scope_id=?`, day, row.scope, row.id).Scan(&attempts)
		if err != nil {
			return err
		}
		if attempts >= row.max {
			return &toolError{"export_limit", "The hosted export daily attempt limit has been reached."}
		}
		if _, err = tx.ExecContext(ctx, `UPDATE export_usage SET attempts=attempts+1 WHERE day=? AND scope=? AND scope_id=?`, day, row.scope, row.id); err != nil {
			return err
		}
	}
	return nil
}

func scanHosted(row interface{ Scan(...any) error }, j *hostedJob) error {
	return row.Scan(&j.ID, &j.BrowserID, &j.GrantID, &j.RequestID, &j.Fingerprint, &j.Kind, &j.Status, &j.SourceID, &j.SourceRevision, &j.Format, &j.IncludeTrash, &j.ObjectKey, &j.Filename, &j.MIMEType, &j.Bytes, &j.SHA256, &j.DiagramCount, &j.SnapshotAt, &j.Manifest, &j.UploadURL, &j.UploadHeaders, &j.UploadExpires, &j.Created, &j.Deadline, &j.ReceiptExpires, &j.LinkExpires, &j.Failure)
}

const hostedSelect = `SELECT id,browser_id,grant_id,request_id,fingerprint,kind,status,source_id,source_revision,format,include_trash,object_key,filename,mime_type,byte_length,sha256,diagram_count,snapshot_at,manifest,upload_url,upload_headers,upload_expires,created,deadline,receipt_expires,link_expires,failure FROM export_jobs`

func (h *hostedExports) load(id string) (hostedJob, error) {
	if _, err := h.server.db.Exec(`UPDATE export_jobs SET status='expired',failure='expired',upload_url='',upload_headers='' WHERE id=? AND status IN ('queued','preparing','uploading','verifying','ready') AND (CASE WHEN status='ready' THEN link_expires ELSE deadline END)<=?`, id, time.Now().Unix()); err != nil {
		return hostedJob{}, err
	}
	var j hostedJob
	err := scanHosted(h.server.db.QueryRow(hostedSelect+` WHERE id=?`, id), &j)
	return j, err
}

func (h *hostedExports) result(j hostedJob) *mcp.CallToolResult {
	status := j.Status
	out := map[string]any{"exportId": j.ID, "status": status}
	if j.Kind == "diagram" {
		out["diagramId"] = j.SourceID
		if j.SourceRevision.Valid {
			out["revision"] = j.SourceRevision.Int64
		}
	} else {
		out["includeTrash"], out["diagramCount"] = j.IncludeTrash, j.DiagramCount
		if j.SnapshotAt > 0 {
			out["snapshotAt"] = time.Unix(j.SnapshotAt, 0).UTC().Format(time.RFC3339)
		}
	}
	if status == "ready" {
		out["filename"], out["mimeType"], out["sizeBytes"], out["sha256"] = j.Filename, j.MIMEType, j.Bytes, j.SHA256
		out["downloadUrl"], out["expiresAt"] = h.downloadURL(j), time.Unix(j.LinkExpires, 0).UTC().Format(time.RFC3339)
		size := j.Bytes
		return &mcp.CallToolResult{StructuredContent: out, Content: []mcp.Content{&mcp.TextContent{Text: mustJSON(out)}, &mcp.ResourceLink{URI: out["downloadUrl"].(string), Name: j.Filename, Title: j.Filename, MIMEType: j.MIMEType, Size: &size}}}
	}
	if status == "failed" {
		out["error"] = j.Failure
	}
	if status == "queued" || status == "preparing" || status == "uploading" || status == "verifying" {
		out["jobExpiresAt"] = time.Unix(j.Deadline, 0).UTC().Format(time.RFC3339)
		out["pollAfterMs"] = 2000
	}
	return &mcp.CallToolResult{StructuredContent: out, Content: []mcp.Content{&mcp.TextContent{Text: mustJSON(out)}}}
}
func mustJSON(value any) string { b, _ := json.Marshal(value); return string(b) }
func (h *hostedExports) downloadURL(j hostedJob) string {
	mac := hmac.New(sha256.New, h.key)
	fmt.Fprintf(mac, "v1\n%s\n%d", j.ID, j.LinkExpires)
	token := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return h.server.config.PublicURL + "/export/" + url.PathEscape(j.ID) + "?token=" + token
}

func (h *hostedExports) agentTool(ctx context.Context, browser, grant, tool string, args map[string]any) (*mcp.CallToolResult, error) {
	id, _ := args["exportId"].(string)
	j, err := h.load(id)
	if err != nil {
		return nil, &toolError{"export_not_found", "Export not found."}
	}
	if j.BrowserID != browser || j.GrantID != grant || !h.grantActive(ctx, j) {
		return nil, &toolError{"export_not_found", "Export not found."}
	}
	if tool == "cancel_export" {
		_, err = h.server.db.ExecContext(ctx, `UPDATE export_jobs SET status='cancelled',failure='cancelled',upload_url='',upload_headers='' WHERE id=? AND browser_id=? AND grant_id=? AND status IN ('queued','preparing','uploading','verifying','ready')`, id, browser, grant)
		if err != nil {
			return nil, err
		}
		cancelArgs, _ := json.Marshal(map[string]string{"exportId": id})
		_ = h.server.bridge.send(browser, "__cancel_hosted_export", cancelArgs, time.Now().Add(5*time.Second))
		j, err = h.load(id)
		if err != nil {
			return nil, err
		}
		out := map[string]any{"exportId": id, "status": j.Status}
		return &mcp.CallToolResult{StructuredContent: out, Content: []mcp.Content{&mcp.TextContent{Text: mustJSON(out)}}}, nil
	}
	return h.result(j), nil
}

func (h *hostedExports) callbackJob(w http.ResponseWriter, r *http.Request) (hostedJob, bool) {
	if r.Header.Get("Origin") != h.server.config.PublicURL {
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return hostedJob{}, false
	}
	b, err := h.server.session(r)
	if err != nil {
		http.Error(w, "Browser session required", http.StatusUnauthorized)
		return hostedJob{}, false
	}
	j, err := h.load(r.PathValue("id"))
	if err != nil || j.BrowserID != b.ID || j.Status == "cancelled" || j.Status == "expired" {
		http.NotFound(w, r)
		return hostedJob{}, false
	}
	var active int
	now := time.Now().Unix()
	err = h.server.db.QueryRowContext(r.Context(), `SELECT 1 FROM grants g JOIN browsers b ON b.id=g.browser_id WHERE g.id=? AND g.browser_id=? AND g.expires>? AND b.expires>?`, j.GrantID, b.ID, now, now).Scan(&active)
	if err != nil {
		http.NotFound(w, r)
		return hostedJob{}, false
	}
	return j, true
}
func (h *hostedExports) upload(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	j, ok := h.callbackJob(w, r)
	if !ok {
		return
	}
	var data hostedMetadata
	if !decodeHosted(w, r, &data, 32<<10) {
		return
	}
	sum, hashErr := hex.DecodeString(data.SHA256)
	if data.Size < 1 || data.Size > exportMaxBytes || data.Filename == "" || len(data.Filename) > 512 || len(sum) != sha256.Size || hashErr != nil || strings.ContainsAny(data.Filename, "/\\") || strings.ContainsFunc(data.Filename, unicode.IsControl) {
		http.Error(w, "invalid upload metadata", http.StatusBadRequest)
		return
	}
	data.SHA256 = hex.EncodeToString(sum)
	checksum := base64.StdEncoding.EncodeToString(sum)
	if data.SHA256Base64 != "" && data.SHA256Base64 != checksum {
		http.Error(w, "checksum metadata mismatch", http.StatusBadRequest)
		return
	}
	revision, count, snapshotAt, manifest, err := normalizeSnapshot(j, data.hostedSnapshot)
	if err != nil || revision != j.SourceRevision || count != j.DiagramCount || snapshotAt != j.SnapshotAt || manifest != j.Manifest {
		http.Error(w, "snapshot metadata cannot change", http.StatusConflict)
		return
	}
	expectedType := map[string]string{"svg": "image/svg+xml", "png": "image/png", "excalidraw": "application/json", "json": "application/json"}[j.Format]
	expectedExt := map[string]string{"svg": ".svg", "png": ".png", "excalidraw": ".excalidraw", "json": ".json"}[j.Format]
	if expectedType == "" || data.MIMEType != expectedType || !strings.HasSuffix(data.Filename, expectedExt) {
		http.Error(w, "invalid upload metadata", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	tx, err := h.server.db.BeginTx(ctx, nil)
	if err != nil {
		http.Error(w, "export unavailable", 503)
		return
	}
	defer tx.Rollback()
	var oldSize int64
	var oldHash, oldType, oldName, oldURL, oldHeaders string
	var oldUploadExpires int64
	var status string
	err = tx.QueryRowContext(ctx, `SELECT byte_length,sha256,mime_type,filename,status,upload_url,upload_headers,upload_expires FROM export_jobs WHERE id=? AND deadline>? AND EXISTS (SELECT 1 FROM grants g JOIN browsers b ON b.id=g.browser_id WHERE g.id=? AND g.browser_id=? AND g.expires>? AND b.expires>?)`, j.ID, time.Now().Unix(), j.GrantID, j.BrowserID, time.Now().Unix(), time.Now().Unix()).Scan(&oldSize, &oldHash, &oldType, &oldName, &status, &oldURL, &oldHeaders, &oldUploadExpires)
	if err != nil || !(status == "preparing" || status == "uploading") {
		http.Error(w, "export unavailable", http.StatusConflict)
		return
	}
	if oldSize > 0 && (oldSize != data.Size || oldHash != data.SHA256 || oldType != data.MIMEType || oldName != data.Filename) {
		http.Error(w, "upload metadata cannot change", http.StatusConflict)
		return
	}
	if oldSize > 0 {
		if oldURL == "" || oldHeaders == "" || oldUploadExpires <= time.Now().Unix() {
			http.Error(w, "upload authorization expired", http.StatusGone)
			return
		}
		var headers map[string]string
		if json.Unmarshal([]byte(oldHeaders), &headers) != nil {
			http.Error(w, "upload authorization unavailable", http.StatusServiceUnavailable)
			return
		}
		if err = tx.Commit(); err != nil {
			http.Error(w, "export unavailable", http.StatusServiceUnavailable)
			return
		}
		jsonReply(w, http.StatusOK, map[string]any{"url": oldURL, "headers": headers, "expiresAt": time.Unix(oldUploadExpires, 0).UTC().Format(time.RFC3339)})
		return
	}
	if oldSize == 0 {
		if err = reserveBytes(ctx, tx, time.Now().Unix(), j.BrowserID, data.Size); err != nil {
			http.Error(w, "daily upload allowance exceeded", http.StatusTooManyRequests)
			return
		}
	}
	uploadExpires := min(time.Now().Unix()+int64(exportUploadTTL.Seconds()), j.Deadline)
	ttl := time.Duration(uploadExpires-time.Now().Unix()) * time.Second
	if ttl <= 0 {
		http.Error(w, "export expired", http.StatusGone)
		return
	}
	putURL, headers, err := h.storage.PresignPut(ctx, j.ObjectKey, exportObject{Size: data.Size, ContentType: data.MIMEType, SHA256: checksum}, ttl)
	if err != nil {
		http.Error(w, "storage unavailable", http.StatusServiceUnavailable)
		return
	}
	plainHeaders := map[string]string{}
	for key, values := range headers {
		if !strings.EqualFold(key, "host") && !strings.EqualFold(key, "content-length") && len(values) > 0 {
			plainHeaders[key] = values[0]
		}
	}
	headerJSON, _ := json.Marshal(plainHeaders)
	_, err = tx.ExecContext(ctx, `UPDATE export_jobs SET status='uploading',filename=?,mime_type=?,byte_length=?,sha256=?,upload_url=?,upload_headers=?,upload_expires=?,verify_after=? WHERE id=?`, data.Filename, data.MIMEType, data.Size, data.SHA256, putURL, string(headerJSON), uploadExpires, uploadExpires, j.ID)
	if err != nil {
		http.Error(w, "export unavailable", http.StatusServiceUnavailable)
		return
	}
	if err = tx.Commit(); err != nil {
		http.Error(w, "export unavailable", http.StatusServiceUnavailable)
		return
	}
	jsonReply(w, http.StatusOK, map[string]any{"url": putURL, "headers": plainHeaders, "expiresAt": time.Unix(uploadExpires, 0).UTC().Format(time.RFC3339)})
}

func reserveBytes(ctx context.Context, tx *sql.Tx, now int64, browser string, size int64) error {
	day := time.Unix(now, 0).UTC().Format("2006-01-02")
	for _, row := range []struct {
		scope, id string
		limit     int64
	}{{"browser", browser, 128 << 20}, {"deployment", "all", 1 << 30}} {
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO export_usage(day,scope,scope_id,attempts,bytes) VALUES(?,?,?,0,0)`, day, row.scope, row.id); err != nil {
			return err
		}
		var current int64
		if err := tx.QueryRowContext(ctx, `SELECT bytes FROM export_usage WHERE day=? AND scope=? AND scope_id=?`, day, row.scope, row.id).Scan(&current); err != nil {
			return err
		}
		if current+size > row.limit {
			return fmt.Errorf("byte quota exceeded")
		}
		if _, err := tx.ExecContext(ctx, `UPDATE export_usage SET bytes=bytes+? WHERE day=? AND scope=? AND scope_id=?`, size, day, row.scope, row.id); err != nil {
			return err
		}
	}
	return nil
}
func (h *hostedExports) complete(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	j, ok := h.callbackJob(w, r)
	if !ok {
		return
	}
	if j.Status == "uploading" || j.Status == "verifying" {
		if err := h.verify(r.Context(), j.ID, true); err != nil {
			http.Error(w, "export unavailable", http.StatusServiceUnavailable)
			return
		}
		var err error
		j, err = h.load(j.ID)
		if err != nil {
			http.Error(w, "export unavailable", http.StatusServiceUnavailable)
			return
		}
	}
	if !h.grantActive(r.Context(), j) {
		http.NotFound(w, r)
		return
	}
	if j.Status == "ready" {
		jsonReply(w, http.StatusOK, h.result(j).StructuredContent)
		return
	}
	if j.Status == "verifying" || j.Status == "uploading" {
		w.Header().Set("Retry-After", "10")
		jsonReply(w, http.StatusAccepted, map[string]any{"exportId": j.ID, "status": j.Status, "pollAfterMs": 10000})
		return
	}
	http.Error(w, "export unavailable", http.StatusConflict)
}
func (h *hostedExports) fail(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	j, ok := h.callbackJob(w, r)
	if !ok {
		return
	}
	var data struct {
		Code string `json:"code"`
	}
	if !decodeHosted(w, r, &data, 1024) {
		return
	}
	code := "export_failed"
	switch data.Code {
	case "empty_diagram", "diagram_not_found", "corrupt_diagram", "library_too_large", "export_too_large", "upload_failed", "export_timeout", "export_cancelled":
		code = data.Code
	}
	_, err := h.server.db.ExecContext(r.Context(), `UPDATE export_jobs SET status='failed',failure=?,upload_url='',upload_headers='' WHERE id=? AND status IN ('queued','preparing')`, code, j.ID)
	if err != nil {
		http.Error(w, "export unavailable", 503)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *hostedExports) download(w http.ResponseWriter, r *http.Request) {
	// HEAD describes the stored object even though this handler sends no body.
	// Prevent proxy compression from replacing its length with an empty stream's.
	w.Header().Set("Cache-Control", "private, no-store, no-transform")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if h.server.limited(w, "hosted-download-deployment", 300) {
		return
	}
	id := r.PathValue("id")
	token := r.URL.Query().Get("token")
	j, err := h.load(id)
	if err != nil || j.LinkExpires == 0 {
		http.NotFound(w, r)
		return
	}
	mac := hmac.New(sha256.New, h.key)
	fmt.Fprintf(mac, "v1\n%s\n%d", j.ID, j.LinkExpires)
	expected := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(token)) {
		http.NotFound(w, r)
		return
	}
	if j.Status == "cancelled" || j.Status == "failed" || j.Status == "preparing" || j.Status == "uploading" || j.Status == "verifying" || j.Status == "queued" {
		http.NotFound(w, r)
		return
	}
	var active int
	now := time.Now().Unix()
	if h.server.db.QueryRowContext(r.Context(), `SELECT 1 FROM grants g JOIN browsers b ON b.id=g.browser_id WHERE g.id=? AND g.browser_id=? AND g.expires>? AND b.expires>?`, j.GrantID, j.BrowserID, now, now).Scan(&active) != nil {
		http.NotFound(w, r)
		return
	}
	if j.Status == "expired" || time.Now().Unix() >= j.LinkExpires {
		http.Error(w, "This hosted export has expired. Request a new export from the diagram.", http.StatusGone)
		return
	}
	if h.server.limited(w, "hosted-download:"+j.ID, 10) {
		return
	}
	if r.Method == http.MethodHead {
		w.Header().Set("Content-Type", j.MIMEType)
		w.Header().Set("Content-Length", strconv.FormatInt(j.Bytes, 10))
		w.Header().Set("Content-Disposition", exportDisposition(j.Filename))
		w.WriteHeader(http.StatusOK)
		return
	}
	ttl := time.Duration(60) * time.Second
	if left := time.Until(time.Unix(j.LinkExpires, 0)); left < ttl {
		ttl = left
	}
	if ttl <= 0 {
		http.Error(w, "export expired", http.StatusGone)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	location, err := h.storage.PresignGet(ctx, j.ObjectKey, j.Filename, j.MIMEType, ttl)
	if err != nil {
		http.Error(w, "download temporarily unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Location", location)
	w.WriteHeader(http.StatusFound)
}
