package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
	"github.com/google/uuid"
)

// Opt in explicitly with environment-specific credentials. Production requires
// a second explicit opt-in. This uploads a tiny
// generated fixture, never user content. It is not a substitute for browser CORS
// and application smoke tests; it proves the provider's wire-level restrictions.
func TestR2LiveEnforcement(t *testing.T) {
	if os.Getenv("DIAGRAMS_R2_LIVE_TEST") != "true" {
		t.Skip("live R2 credentials and explicit opt-in required")
	}
	bucket := os.Getenv("DIAGRAMS_R2_BUCKET")
	production := bucket == "diagrams-exports-prod" && os.Getenv("DIAGRAMS_R2_PRODUCTION_TEST") == "true"
	if bucket != "diagrams-exports-dev" && !production {
		t.Fatal("live proof requires the development bucket or explicit production opt-in")
	}
	secret, err := os.ReadFile(os.Getenv("DIAGRAMS_R2_SECRET_ACCESS_KEY_FILE"))
	if err != nil {
		t.Fatal("could not read the R2 secret file")
	}
	storage, err := newR2Storage(os.Getenv("DIAGRAMS_R2_ENDPOINT"), os.Getenv("DIAGRAMS_R2_BUCKET"), os.Getenv("DIAGRAMS_R2_ACCESS_KEY_ID"), strings.TrimSpace(string(secret)))
	if err != nil {
		t.Fatal("R2 configuration incomplete")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	// Authenticate before testing rejected requests, otherwise invalid credentials
	// could make a length/checksum test appear to pass for the wrong reason.
	if _, err := storage.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(bucket)}); err != nil {
		var apiErr smithy.APIError
		if errors.As(err, &apiErr) {
			t.Fatalf("bucket access failed (provider code %s); credential details suppressed", apiErr.ErrorCode())
		}
		t.Fatal("bucket access failed; credential details suppressed")
	}
	key := "proof_" + uuid.NewString()
	defer func() {
		cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_, err := storage.client.DeleteObject(cleanup, &s3.DeleteObjectInput{Bucket: aws.String(storage.bucket), Key: aws.String(key)})
		if err != nil {
			t.Log("fixture cleanup failed; the bucket lifecycle must remove it")
		}
	}()
	client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	do := func(method, address string, headers http.Header, body []byte) (int, http.Header, []byte) {
		t.Helper()
		req, err := http.NewRequestWithContext(ctx, method, address, bytes.NewReader(body))
		if err != nil {
			t.Fatal("could not construct fixture request")
		}
		for name, values := range headers {
			if !strings.EqualFold(name, "host") && !strings.EqualFold(name, "content-length") {
				req.Header[name] = values
			}
		}
		res, err := client.Do(req)
		if err != nil {
			// Do not print errors containing signed URLs or provider response bodies.
			t.Fatal("fixture request failed at the transport layer")
		}
		defer res.Body.Close()
		data, err := io.ReadAll(io.LimitReader(res.Body, 64<<10))
		if err != nil {
			t.Fatal("could not read fixture response")
		}
		return res.StatusCode, res.Header, data
	}
	fixture := []byte("<svg xmlns=\"http://www.w3.org/2000/svg\"><text>R2 proof</text></svg>")
	hash := sha256.Sum256(fixture)
	expected := exportObject{Size: int64(len(fixture)), ContentType: "image/svg+xml", SHA256: base64.StdEncoding.EncodeToString(hash[:])}
	put, headers, err := storage.PresignPut(ctx, key, expected, time.Minute)
	if err != nil {
		t.Fatal("could not sign fixture PUT")
	}
	// Both attacks use the original signed URL and a real Content-Length matching
	// the transmitted body, as browsers/curl do. Only the signed length differs.
	for _, item := range []struct {
		name string
		body []byte
	}{
		{"oversized body", append(append([]byte{}, fixture...), 'x')},
		{"wrong checksum", bytes.Repeat([]byte{'x'}, len(fixture))},
	} {
		status, _, _ := do("PUT", put, headers, item.body)
		if status != 400 && status != 403 {
			t.Fatalf("%s must be rejected with 400/403; got %d", item.name, status)
		}
	}
	status := 0
	if os.Getenv("DIAGRAMS_R2_BROWSER_TEST") == "true" {
		browserHeaders := make(map[string]string)
		for name := range headers {
			if !strings.EqualFold(name, "host") && !strings.EqualFold(name, "content-length") {
				browserHeaders[name] = headers.Get(name)
			}
		}
		origin := "http://localhost:5173"
		if production {
			origin = "https://diagrams.bonatak.is"
		}
		payload, _ := json.Marshal(map[string]any{"url": put, "headers": browserHeaders, "body": string(fixture), "contentType": expected.ContentType, "origin": origin})
		browser := exec.CommandContext(ctx, "node", "../../scripts/r2-browser-proof.mjs")
		browser.Stdin = bytes.NewReader(payload)
		output, err := browser.Output()
		var result struct {
			Status int `json:"status"`
		}
		if err != nil || json.Unmarshal(output, &result) != nil {
			t.Fatal("browser upload failed; signed URLs and browser error details are suppressed")
		}
		status = result.Status
		t.Logf("real browser PUT from %s completed", origin)
	} else {
		status, _, _ = do("PUT", put, headers, fixture)
	}
	if status != http.StatusOK {
		t.Fatalf("normal PUT failed: HTTP %d", status)
	}
	status, _, _ = do("PUT", put, headers, fixture)
	if status != http.StatusPreconditionFailed {
		t.Fatalf("conditional overwrite was not rejected: HTTP %d", status)
	}
	actual, err := storage.Head(ctx, key)
	if err != nil {
		t.Fatal("provider HEAD with checksum mode failed")
	}
	if actual != expected {
		t.Fatal("provider HEAD did not return the exact size, type and validated SHA-256")
	}
	get, err := storage.PresignGet(ctx, key, "R2 proof.svg", expected.ContentType, 5*time.Second)
	if err != nil {
		t.Fatal("could not sign fixture GET")
	}
	status, resultHeaders, downloaded := do("GET", get, nil, nil)
	if status != http.StatusOK || sha256.Sum256(downloaded) != hash || resultHeaders.Get("Content-Type") != expected.ContentType {
		t.Fatal("download status, bytes or type differ from the fixture")
	}
	disposition, parameters, err := mime.ParseMediaType(resultHeaders.Get("Content-Disposition"))
	if err != nil || disposition != "attachment" || parameters["filename"] != "R2 proof.svg" {
		t.Fatal("download attachment filename was not preserved")
	}
	private, _ := url.Parse(get)
	private.RawQuery = ""
	status, _, _ = do("GET", private.String(), nil, nil)
	if status != 400 && status != 403 && status != 404 {
		t.Fatalf("unsigned object access was not denied: HTTP %d", status)
	}
	time.Sleep(6 * time.Second)
	status, _, _ = do("GET", get, nil, nil)
	if status != 403 {
		t.Fatalf("expired signed download was not denied: HTTP %d", status)
	}
}
