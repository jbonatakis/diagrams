package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket/wsjson"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type fakeExportStorage struct {
	mu                sync.Mutex
	puts, heads, gets int
	actual            exportObject
	headErr           error
	entered, release  chan struct{}
}

func (f *fakeExportStorage) ObjectKey(id string) string { return id }
func (f *fakeExportStorage) PresignPut(_ context.Context, key string, obj exportObject, _ time.Duration) (string, http.Header, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.puts++
	f.actual = obj
	return "https://storage.example/" + key + "?signed-put=secret", http.Header{"Host": {"storage.example"}, "Content-Length": {"20"}, "Content-Type": {obj.ContentType}, "If-None-Match": {"*"}}, nil
}
func (f *fakeExportStorage) PresignGet(_ context.Context, key, _, _ string, _ time.Duration) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.gets++
	return "https://storage.example/" + key + "?signed-get=secret", nil
}
func (f *fakeExportStorage) Head(ctx context.Context, _ string) (exportObject, error) {
	f.mu.Lock()
	f.heads++
	obj, err, entered, release := f.actual, f.headErr, f.entered, f.release
	f.mu.Unlock()
	if entered != nil {
		entered <- struct{}{}
	}
	if release != nil {
		select {
		case <-release:
		case <-ctx.Done():
			return exportObject{}, ctx.Err()
		}
	}
	return obj, err
}
func (f *fakeExportStorage) counts() (int, int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.puts, f.heads, f.gets
}

type exportFixture struct {
	app     *Server
	h       *hostedExports
	store   *fakeExportStorage
	mux     *http.ServeMux
	http    *memoryHTTPServer
	browser *testBrowser
	owner   string
	pair    testPair
}

func newExportFixture(t *testing.T) *exportFixture {
	t.Helper()
	app, httpServer := testServer(t, time.Second)
	b := newBrowser(t, httpServer)
	p := pair(t, app, httpServer, b)
	var owner string
	if err := app.db.QueryRow(`SELECT browser_id FROM grants WHERE id=?`, p.Grant).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	store := &fakeExportStorage{}
	h := &hostedExports{server: app, storage: store, key: []byte(strings.Repeat("k", 32))}
	app.exports = h
	mux := http.NewServeMux()
	h.routes(mux)
	return &exportFixture{app, h, store, mux, httpServer, b, owner, p}
}
func (f *exportFixture) job(t *testing.T, kind string) (string, hostedMetadata) {
	t.Helper()
	id := "exp_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	now := time.Now().Unix()
	format := "svg"
	if kind == "library" {
		format = "json"
	}
	_, err := f.app.db.Exec(`INSERT INTO export_jobs(id,browser_id,grant_id,request_id,fingerprint,kind,status,source_id,format,object_key,created,deadline,receipt_expires) VALUES(?,?,?,?,?,?,'queued',?,?,?,?,?,?)`, id, f.owner, f.pair.Grant, uuid.NewString(), "fingerprint", kind, uuid.NewString(), format, strings.TrimPrefix(id, "exp_"), now, now+600, now+172800)
	if err != nil {
		t.Fatal(err)
	}
	revision := int64(7)
	sum := sha256.Sum256([]byte("<svg>fixture</svg>"))
	meta := hostedMetadata{Filename: "Diagram.svg", MIMEType: "image/svg+xml", Size: 18, SHA256: hex.EncodeToString(sum[:]), SHA256Base64: base64.StdEncoding.EncodeToString(sum[:]), hostedSnapshot: hostedSnapshot{Revision: &revision}}
	return id, meta
}
func (f *exportFixture) post(t *testing.T, id, action string, data any) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", "/api/exports/"+id+"/"+action, strings.NewReader(string(body)))
	req.Header.Set("Origin", testOrigin)
	req.AddCookie(f.browser.Cookie)
	w := httptest.NewRecorder()
	f.mux.ServeHTTP(w, req)
	return w
}
func mustStatus(t *testing.T, w *httptest.ResponseRecorder, status int) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status %d want %d: %s", w.Code, status, w.Body.String())
	}
}
func (f *exportFixture) authorize(t *testing.T, id string, meta hostedMetadata) *httptest.ResponseRecorder {
	t.Helper()
	mustStatus(t, f.post(t, id, "captured", meta.hostedSnapshot), 204)
	w := f.post(t, id, "upload", meta)
	mustStatus(t, w, 200)
	return w
}
func TestHostedRoundTripRetriesAndRedirect(t *testing.T) {
	f := newExportFixture(t)
	id, meta := f.job(t, "diagram")
	first := f.authorize(t, id, meta)
	retry := f.post(t, id, "upload", meta)
	mustStatus(t, retry, 200)
	if first.Body.String() != retry.Body.String() {
		t.Fatal("upload retry changed authorization")
	}
	if strings.Contains(first.Body.String(), "Content-Length") || strings.Contains(first.Body.String(), `"Host"`) {
		t.Fatal("returned browser-forbidden headers")
	}
	puts, _, _ := f.store.counts()
	if puts != 1 {
		t.Fatal("retry signed a new PUT")
	}
	meta.Revision = new(int64)
	*meta.Revision = 8
	mustStatus(t, f.post(t, id, "upload", meta), 409)
	*meta.Revision = 7
	ready := f.post(t, id, "complete", nil)
	mustStatus(t, ready, 200)
	repeat := f.post(t, id, "complete", nil)
	mustStatus(t, repeat, 200)
	if ready.Body.String() != repeat.Body.String() {
		t.Fatal("completion retry changed link or metadata")
	}
	_, heads, _ := f.store.counts()
	if heads != 1 {
		t.Fatalf("got %d HEADs", heads)
	}
	result := jsonMap(t, ready.Body.Bytes())
	if result["sha256"] != meta.SHA256 {
		t.Fatal("public checksum is not hexadecimal SHA256")
	}
	j, err := f.h.load(id)
	if err != nil {
		t.Fatal(err)
	}
	if j.UploadURL != "" || j.UploadHeaders != "" {
		t.Fatal("retained upload bearer capability after completion")
	}
	for _, method := range []string{"HEAD", "GET"} {
		w := httptest.NewRecorder()
		f.mux.ServeHTTP(w, httptest.NewRequest(method, result["downloadUrl"].(string), nil))
		if method == "HEAD" {
			mustStatus(t, w, 200)
			if w.Header().Get("Content-Length") != "18" {
				t.Fatal("HEAD lost file size")
			}
		} else {
			mustStatus(t, w, 302)
			if w.Header().Get("Content-Length") != "" {
				t.Fatal("redirect advertises an absent file body")
			}
		}
		if w.Header().Get("Cache-Control") != "private, no-store, no-transform" {
			t.Fatal("download response is cacheable")
		}
	}
	_, _, gets := f.store.counts()
	if gets != 1 {
		t.Fatal("HEAD unnecessarily signs a download")
	}
	var bytes int64
	if err := f.app.db.QueryRow(`SELECT bytes FROM export_usage WHERE scope='browser' AND scope_id=?`, f.owner).Scan(&bytes); err != nil {
		t.Fatal(err)
	}
	if bytes != meta.Size {
		t.Fatal("upload retry consumed quota twice")
	}
}

func TestHostedCreationDisabledPreservesDownloads(t *testing.T) {
	f := newExportFixture(t)
	id, meta := f.job(t, "diagram")
	f.authorize(t, id, meta)
	mustStatus(t, f.post(t, id, "complete", nil), http.StatusOK)
	f.h.creationDisabled = true
	_, err := f.h.start(context.Background(), f.owner, f.pair.Grant, "export_diagram", map[string]any{"diagramId": uuid.NewString(), "requestId": uuid.NewString()})
	var denied *toolError
	if !errors.As(err, &denied) || denied.Code != "hosted_exports_unavailable" {
		t.Fatalf("new exports were not disabled: %v", err)
	}
	result, err := f.h.agentTool(context.Background(), f.owner, f.pair.Grant, "get_export", map[string]any{"exportId": id})
	if err != nil {
		t.Fatal(err)
	}
	link := result.StructuredContent.(map[string]any)["downloadUrl"].(string)
	w := httptest.NewRecorder()
	f.mux.ServeHTTP(w, httptest.NewRequest("GET", link, nil))
	mustStatus(t, w, http.StatusFound)

	app, err := New(Config{PublicURL: testOrigin, DatabasePath: ":memory:", R2Verified: true, R2Endpoint: "https://storage.example", R2Bucket: "exports", R2AccessKey: "fixture", R2SecretKey: "fixture", DownloadKey: []byte(strings.Repeat("k", 32))})
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	if app.exports == nil || !app.exports.creationDisabled {
		t.Fatal("disabled creation removed the configured export service")
	}
}
func TestHostedVerificationBoundedAndFailedCallbacksCannotRevive(t *testing.T) {
	f := newExportFixture(t)
	id, meta := f.job(t, "diagram")
	f.authorize(t, id, meta)
	f.store.headErr = errors.New("temporary storage outage")
	for attempt := 1; attempt <= 3; attempt++ {
		status := 202
		if attempt == 3 {
			status = 409
		}
		mustStatus(t, f.post(t, id, "complete", nil), status)
		mustStatus(t, f.post(t, id, "complete", nil), status)
		_, heads, _ := f.store.counts()
		if heads != attempt {
			t.Fatalf("retry made %d HEADs, expected %d", heads, attempt)
		}
		if _, err := f.app.db.Exec(`UPDATE export_jobs SET verify_after=0 WHERE id=?`, id); err != nil {
			t.Fatal(err)
		}
	}
	j, _ := f.h.load(id)
	if j.Status != "failed" {
		t.Fatal(j.Status)
	}
	mustStatus(t, f.post(t, id, "failed", map[string]string{"code": "unsanitized provider details"}), 204)
	j, _ = f.h.load(id)
	if j.Failure != "export_verification_failed" {
		t.Fatal("browser overwrote terminal failure")
	}
}
func TestHostedCancellationRacesVerification(t *testing.T) {
	f := newExportFixture(t)
	id, meta := f.job(t, "diagram")
	f.authorize(t, id, meta)
	f.store.entered = make(chan struct{}, 1)
	f.store.release = make(chan struct{})
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- f.post(t, id, "complete", nil) }()
	<-f.store.entered
	_, err := f.h.agentTool(context.Background(), f.owner, f.pair.Grant, "cancel_export", map[string]any{"exportId": id})
	if err != nil {
		t.Fatal(err)
	}
	close(f.store.release)
	mustStatus(t, <-done, 409)
	j, _ := f.h.load(id)
	if j.Status != "cancelled" || j.LinkExpires != 0 {
		t.Fatal("completion revived cancellation")
	}
	mustStatus(t, f.post(t, id, "complete", nil), 404)
}
func TestHostedAuthorizationExpiryAndMetadataFailures(t *testing.T) {
	for _, scenario := range []string{"other-browser", "foreign-origin", "revoked", "expired", "wrong-checksum", "wrong-size", "missing-checksum"} {
		t.Run(scenario, func(t *testing.T) {
			f := newExportFixture(t)
			id, meta := f.job(t, "diagram")
			f.authorize(t, id, meta)
			switch scenario {
			case "other-browser":
				f.browser = newBrowser(t, f.http)
			case "foreign-origin":
				req := httptest.NewRequest("POST", "/api/exports/"+id+"/complete", nil)
				req.AddCookie(f.browser.Cookie)
				req.Header.Set("Origin", "https://evil.example")
				w := httptest.NewRecorder()
				f.mux.ServeHTTP(w, req)
				mustStatus(t, w, 403)
				return
			case "revoked":
				if _, err := f.app.db.Exec(`DELETE FROM grants WHERE id=?`, f.pair.Grant); err != nil {
					t.Fatal(err)
				}
			case "expired":
				if _, err := f.app.db.Exec(`UPDATE export_jobs SET deadline=0 WHERE id=?`, id); err != nil {
					t.Fatal(err)
				}
			case "wrong-checksum":
				f.store.actual.SHA256 = base64.StdEncoding.EncodeToString(make([]byte, 32))
			case "wrong-size":
				f.store.actual.Size++
			case "missing-checksum":
				f.store.actual.SHA256 = ""
			}
			status := 404
			if strings.Contains(scenario, "checksum") || scenario == "wrong-size" {
				status = 409
			}
			mustStatus(t, f.post(t, id, "complete", nil), status)
			j, _ := f.h.load(id)
			if j.Status == "ready" {
				t.Fatal("unauthorized or unverified export became ready")
			}
		})
	}
}
func TestHostedLibraryManifestLimit(t *testing.T) {
	f := newExportFixture(t)
	id, meta := f.job(t, "library")
	meta.Filename = "library.json"
	meta.MIMEType = "application/json"
	meta.Revision = nil
	meta.DiagramCount = 100
	meta.SnapshotAt = time.Now().UTC().Format(time.RFC3339Nano)
	for i := 0; i < 100; i++ {
		meta.SourceRevisions = append(meta.SourceRevisions, sourceRevision{DiagramID: uuid.NewString() + strings.Repeat("a", 64), Revision: int64(i)})
	}
	raw, _ := json.Marshal(meta)
	if len(raw) < 8192 {
		t.Fatal("test must cover manifests over the old 8KiB body limit")
	}
	f.authorize(t, id, meta)
	j, _ := f.h.load(id)
	if j.SourceRevision.Valid || j.DiagramCount != 100 || j.Manifest == "" {
		t.Fatal("lost source manifest")
	}
}
func TestChunkedExportsWorkWhenHostedDisabled(t *testing.T) {
	app, httpServer := testServer(t, time.Second)
	b := newBrowser(t, httpServer)
	p := pair(t, app, httpServer, b)
	client := mcpClient(t, httpServer, p.Access)
	browser := dialBrowser(t, httpServer, b, "diagram")
	readReady(t, browser)
	go func() {
		for {
			var message bridgeMessage
			if wsjson.Read(context.Background(), browser, &message) != nil {
				return
			}
			_ = wsjson.Write(context.Background(), browser, bridgeMessage{Type: "result", ID: message.ID, Result: json.RawMessage(`{"artifactId":"fixture","encoding":"utf8","data":"{}"}`)})
		}
	}()
	for _, tool := range []string{"export_diagram", "export_library"} {
		for _, delivery := range []string{"", "chunks"} {
			args := map[string]any{}
			if tool == "export_diagram" {
				args["diagramId"] = uuid.NewString()
			}
			if delivery != "" {
				args["delivery"] = delivery
			}
			result, err := client.CallTool(context.Background(), &mcp.CallToolParams{Name: tool, Arguments: args})
			if err != nil || result.IsError {
				t.Fatalf("legacy export unavailable: %+v %v", result, err)
			}
		}
	}
	result, err := client.CallTool(context.Background(), &mcp.CallToolParams{Name: "export_library", Arguments: map[string]any{"delivery": "download", "requestId": uuid.NewString()}})
	if err != nil || !result.IsError {
		t.Fatal("disabled hosted export was accepted")
	}
}
func TestR2PresignConstrainsLengthAndConditionalWrite(t *testing.T) {
	storage, err := newR2Storage("https://account.r2.cloudflarestorage.com", "diagrams-exports-dev", "fixture-key", strings.Repeat("s", 64))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte("fixture"))
	checksum := base64.StdEncoding.EncodeToString(sum[:])
	signed, headers, err := storage.PresignPut(context.Background(), "top-level", exportObject{Size: 7, ContentType: "image/svg+xml", SHA256: checksum}, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(signed)
	signedHeaders := u.Query().Get("X-Amz-SignedHeaders")
	for _, name := range []string{"content-length", "content-type", "if-none-match"} {
		if !strings.Contains(signedHeaders, name) {
			t.Errorf("%s is not signed: %s", name, signedHeaders)
		}
	}
	if headers.Get("If-None-Match") != "*" {
		t.Fatal("PUT can overwrite")
	}
	if u.Query().Get("X-Amz-Checksum-Sha256") != checksum && headers.Get("X-Amz-Checksum-Sha256") != checksum {
		t.Fatal("checksum is absent from signed request")
	}
	if storage.ObjectKey("id") != "id" {
		t.Fatal("keys must stay at bucket root")
	}
}

func TestHostedStartDeduplicationCapabilitiesAndLimits(t *testing.T) {
	f := newExportFixture(t)
	args := map[string]any{"diagramId": uuid.NewString(), "requestId": uuid.NewString()}
	if _, err := f.h.start(context.Background(), f.owner, f.pair.Grant, "export_diagram", args); err == nil {
		t.Fatal("accepted disconnected browser")
	}
	browser := dialBrowser(t, f.http, f.browser, "diagram")
	readReady(t, browser)
	if _, err := f.h.start(context.Background(), f.owner, f.pair.Grant, "export_diagram", args); err == nil {
		t.Fatal("accepted browser without hosted capability")
	}
	f.app.bridge.disconnect(f.owner)
	browser = dialBrowser(t, f.http, f.browser, "diagram", "hosted_exports_v1")
	readReady(t, browser)
	go func() {
		for {
			var message bridgeMessage
			if wsjson.Read(context.Background(), browser, &message) != nil {
				return
			}
			_ = wsjson.Write(context.Background(), browser, bridgeMessage{Type: "result", ID: message.ID, Result: json.RawMessage(`{"accepted":true,"version":1}`)})
		}
	}()
	first, err := f.h.start(context.Background(), f.owner, f.pair.Grant, "export_diagram", args)
	if err != nil {
		t.Fatal(err)
	}
	initial := first.StructuredContent.(map[string]any)
	id := initial["exportId"].(string)
	if initial["status"] != "queued" {
		t.Fatal("reported captured before capture acknowledgement")
	}
	args["format"] = "svg"
	again, err := f.h.start(context.Background(), f.owner, f.pair.Grant, "export_diagram", args)
	if err != nil || again.StructuredContent.(map[string]any)["exportId"] != id {
		t.Fatal("default SVG didn't deduplicate")
	}
	args["format"] = "png"
	if _, err = f.h.start(context.Background(), f.owner, f.pair.Grant, "export_diagram", args); err == nil {
		t.Fatal("reused requestId with changed format")
	}
	args["requestId"] = uuid.NewString()
	second, err := f.h.start(context.Background(), f.owner, f.pair.Grant, "export_diagram", args)
	if err != nil {
		t.Fatal(err)
	}
	args["requestId"] = uuid.NewString()
	if _, err = f.h.start(context.Background(), f.owner, f.pair.Grant, "export_diagram", args); err == nil {
		t.Fatal("accepted third active export")
	}
	if _, err = f.h.agentTool(context.Background(), f.owner, "other-grant", "get_export", map[string]any{"exportId": id}); err == nil {
		t.Fatal("cross-grant job access")
	}
	for _, jobID := range []string{id, second.StructuredContent.(map[string]any)["exportId"].(string)} {
		if _, err = f.h.agentTool(context.Background(), f.owner, f.pair.Grant, "cancel_export", map[string]any{"exportId": jobID}); err != nil {
			t.Fatal(err)
		}
	}
	// A new limiter instance must not reset the persistent accepted-attempt cap.
	for i := 2; i < 10; i++ {
		args["requestId"] = uuid.NewString()
		result, err := f.h.start(context.Background(), f.owner, f.pair.Grant, "export_diagram", args)
		if err != nil {
			t.Fatal(err)
		}
		_, err = f.h.agentTool(context.Background(), f.owner, f.pair.Grant, "cancel_export", map[string]any{"exportId": result.StructuredContent.(map[string]any)["exportId"]})
		if err != nil {
			t.Fatal(err)
		}
	}
	f.app.limits = windowLimiter{}
	args["requestId"] = uuid.NewString()
	if _, err = f.h.start(context.Background(), f.owner, f.pair.Grant, "export_diagram", args); err == nil {
		t.Fatal("minute quota reset with memory limiter")
	}
}

func TestHostedRestartPreservesReadyAndReconcilesUncertain(t *testing.T) {
	f := newExportFixture(t)
	readyID, meta := f.job(t, "diagram")
	f.authorize(t, readyID, meta)
	mustStatus(t, f.post(t, readyID, "complete", nil), 200)
	ready, _ := f.h.load(readyID)
	link := f.h.downloadURL(ready)
	uncertainID, meta := f.job(t, "diagram")
	f.authorize(t, uncertainID, meta)
	queuedID, _ := f.job(t, "diagram")
	database := f.app.config.DatabasePath
	key := f.h.key
	f.app.Close()
	app, err := New(Config{PublicURL: testOrigin, DatabasePath: database})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	h := &hostedExports{server: app, storage: f.store, key: key}
	app.exports = h
	if err = h.startWorker(); err != nil {
		t.Fatal(err)
	}
	if _, err = app.db.Exec(`UPDATE export_jobs SET verify_after=0 WHERE id=?`, uncertainID); err != nil {
		t.Fatal(err)
	}
	if err = h.reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	restored, err := h.load(readyID)
	if err != nil || h.downloadURL(restored) != link || restored.Status != "ready" {
		t.Fatal("ready download lost across restart")
	}
	restored, err = h.load(uncertainID)
	if err != nil || restored.Status != "ready" {
		t.Fatal("uncertain upload was not recovered")
	}
	restored, err = h.load(queuedID)
	if err != nil || restored.Failure != "export_interrupted" {
		t.Fatal("uncaptured snapshot was left pending or recaptured")
	}
	var used int64
	if err = app.db.QueryRow(`SELECT bytes FROM export_usage WHERE scope='deployment'`).Scan(&used); err != nil || used != meta.Size*2 {
		t.Fatal("byte quota lost across restart")
	}
}

func TestHostedDownloadExpiryRevocationAndUploadPermissionExpiry(t *testing.T) {
	f := newExportFixture(t)
	id, meta := f.job(t, "diagram")
	f.authorize(t, id, meta)
	if _, err := f.app.db.Exec(`UPDATE export_jobs SET upload_expires=0 WHERE id=?`, id); err != nil {
		t.Fatal(err)
	}
	mustStatus(t, f.post(t, id, "upload", meta), 410)
	puts, _, _ := f.store.counts()
	if puts != 1 {
		t.Fatal("renewed upload capability")
	}
	mustStatus(t, f.post(t, id, "complete", nil), 200)
	if _, err := f.app.db.Exec(`UPDATE export_jobs SET link_expires=? WHERE id=?`, time.Now().Unix()-1, id); err != nil {
		t.Fatal(err)
	}
	j, _ := f.h.load(id)
	w := httptest.NewRecorder()
	f.mux.ServeHTTP(w, httptest.NewRequest("GET", f.h.downloadURL(j), nil))
	mustStatus(t, w, 410)
	if _, err := f.app.db.Exec(`DELETE FROM grants WHERE id=?`, f.pair.Grant); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	f.mux.ServeHTTP(w, httptest.NewRequest("GET", f.h.downloadURL(j), nil))
	mustStatus(t, w, 404)
}

func TestHostedConcurrentByteReservations(t *testing.T) {
	f := newExportFixture(t)
	type item struct {
		id   string
		meta hostedMetadata
	}
	var jobs []item
	for i := 0; i < 3; i++ {
		id, meta := f.job(t, "diagram")
		meta.Size = exportMaxBytes
		mustStatus(t, f.post(t, id, "captured", meta.hostedSnapshot), 204)
		jobs = append(jobs, item{id, meta})
	}
	codes := make(chan int, 3)
	for _, job := range jobs {
		go func() { codes <- f.post(t, job.id, "upload", job.meta).Code }()
	}
	counts := map[int]int{}
	for range jobs {
		counts[<-codes]++
	}
	if counts[200] != 2 || counts[429] != 1 {
		t.Fatalf("quota race: %v", counts)
	}
	var used int64
	if err := f.app.db.QueryRow(`SELECT bytes FROM export_usage WHERE scope='deployment'`).Scan(&used); err != nil || used != 2*exportMaxBytes {
		t.Fatal("quota reservation was lost or overspent")
	}
}
