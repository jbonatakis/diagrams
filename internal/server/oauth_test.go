package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"
)

type testBrowser struct {
	Cookie *http.Cookie
	CSRF   string
}
type testPair struct{ Client, Access, Refresh, Code, Verifier, Grant string }

func httpCall(t *testing.T, h *memoryHTTPServer, method, path, body string, headers http.Header, b *testBrowser) (*http.Response, []byte) {
	t.Helper()
	r, err := http.NewRequest(method, h.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	r.Header = headers.Clone()
	if r.Header == nil {
		r.Header = make(http.Header)
	}
	if b != nil {
		r.AddCookie(b.Cookie)
	}
	res, err := h.Client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	return res, data
}
func jsonMap(t *testing.T, data []byte) map[string]any {
	t.Helper()
	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("invalid JSON %q: %v", data, err)
	}
	return result
}
func newBrowser(t *testing.T, h *memoryHTTPServer) *testBrowser {
	t.Helper()
	res, data := httpCall(t, h, "POST", "/api/session", "", http.Header{"Origin": {testOrigin}, "X-Diagrams-Request": {"1"}}, nil)
	if res.StatusCode != 200 {
		t.Fatalf("session %d: %s", res.StatusCode, data)
	}
	cookies := res.Cookies()
	if len(cookies) != 1 {
		t.Fatal("missing cookie")
	}
	if !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteLaxMode {
		t.Fatal("insecure cookie")
	}
	return &testBrowser{Cookie: cookies[0], CSRF: jsonMap(t, data)["csrf"].(string)}
}
func register(t *testing.T, h *memoryHTTPServer) string {
	t.Helper()
	res, data := httpCall(t, h, "POST", "/oauth/register", `{"client_name":"Test agent","redirect_uris":["http://127.0.0.1/callback"],"token_endpoint_auth_method":"none"}`, http.Header{"Content-Type": {"application/json"}}, nil)
	if res.StatusCode != 201 {
		t.Fatalf("register %d: %s", res.StatusCode, data)
	}
	return jsonMap(t, data)["client_id"].(string)
}
func authPath(client, verifier string) string {
	q := url.Values{"response_type": {"code"}, "client_id": {client}, "redirect_uri": {"http://127.0.0.1:32123/callback"}, "resource": {testOrigin + "/mcp"}, "scope": {agentScope}, "code_challenge_method": {"S256"}, "code_challenge": {digest(verifier)}, "state": {"test-state"}}
	return "/oauth/authorize?" + q.Encode()
}

var requestPattern = regexp.MustCompile(`name="request" value="([^"]+)"`)

func consentRequest(t *testing.T, h *memoryHTTPServer, b *testBrowser, client, verifier string) string {
	t.Helper()
	res, data := httpCall(t, h, "GET", authPath(client, verifier), "", nil, b)
	if res.StatusCode != 200 {
		t.Fatalf("authorize %d: %s", res.StatusCode, data)
	}
	if res.Header.Get("Referrer-Policy") != "same-origin" {
		t.Fatal("consent must preserve Origin for the same-origin form submission")
	}
	if !strings.Contains(res.Header.Get("Content-Security-Policy"), "form-action 'self' http://127.0.0.1:32123;") {
		t.Fatal("consent must allow its registered callback after the form redirect")
	}
	match := requestPattern.FindSubmatch(data)
	if len(match) != 2 {
		t.Fatalf("missing consent form: %s", data)
	}
	return string(match[1])
}
func consent(t *testing.T, h *memoryHTTPServer, b *testBrowser, id, decision string) (*http.Response, []byte) {
	return httpCall(t, h, "POST", "/oauth/approve", url.Values{"request": {id}, "csrf": {b.CSRF}, "decision": {decision}}.Encode(), http.Header{"Origin": {testOrigin}, "Content-Type": {"application/x-www-form-urlencoded"}}, b)
}
func tokenCall(t *testing.T, h *memoryHTTPServer, values url.Values) (*http.Response, []byte) {
	t.Helper()
	return httpCall(t, h, "POST", "/oauth/token", values.Encode(), http.Header{"Content-Type": {"application/x-www-form-urlencoded"}}, nil)
}
func exchangeValues(p testPair) url.Values {
	return url.Values{"grant_type": {"authorization_code"}, "client_id": {p.Client}, "code": {p.Code}, "code_verifier": {p.Verifier}, "redirect_uri": {"http://127.0.0.1:32123/callback"}, "resource": {testOrigin + "/mcp"}}
}
func pair(t *testing.T, app *Server, h *memoryHTTPServer, b *testBrowser) testPair {
	t.Helper()
	p := testPair{Client: register(t, h), Verifier: secret()}
	id := consentRequest(t, h, b, p.Client, p.Verifier)
	res, data := consent(t, h, b, id, "approve")
	if res.StatusCode != 303 {
		t.Fatalf("consent %d: %s", res.StatusCode, data)
	}
	redirect, err := url.Parse(res.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if redirect.Query().Get("state") != "test-state" || redirect.Query().Get("iss") != testOrigin {
		t.Fatal("missing state/issuer")
	}
	p.Code = redirect.Query().Get("code")
	res, data = tokenCall(t, h, exchangeValues(p))
	if res.StatusCode != 200 {
		t.Fatalf("exchange %d: %s", res.StatusCode, data)
	}
	tokens := jsonMap(t, data)
	p.Access = tokens["access_token"].(string)
	p.Refresh = tokens["refresh_token"].(string)
	if err = app.db.QueryRow("SELECT grant_id FROM tokens WHERE hash=?", digest(p.Access)).Scan(&p.Grant); err != nil {
		t.Fatal(err)
	}
	return p
}
func checkToken(t *testing.T, app *Server, token string, want bool) {
	t.Helper()
	_, err := app.verifyAccess(context.Background(), token, nil)
	if (err == nil) != want {
		t.Fatalf("token validity=%v want=%v", err == nil, want)
	}
}

func TestOAuthBindingDenialAndReplay(t *testing.T) {
	app, h := testServer(t, time.Second)
	b, other := newBrowser(t, h), newBrowser(t, h)
	client, verifier := register(t, h), secret()
	id := consentRequest(t, h, b, client, verifier)
	for _, origin := range []string{"", "null", "https://other.example"} {
		res, _ := httpCall(t, h, "POST", "/oauth/approve", url.Values{"request": {id}, "csrf": {b.CSRF}, "decision": {"approve"}}.Encode(), http.Header{"Origin": {origin}, "Content-Type": {"application/x-www-form-urlencoded"}}, b)
		if res.StatusCode != 403 {
			t.Fatalf("consent accepted untrusted Origin %q", origin)
		}
	}
	res, _ := consent(t, h, other, id, "approve")
	if res.StatusCode != 400 {
		t.Fatal("cross-browser consent accepted")
	}
	res, _ = consent(t, h, b, id, "deny")
	location, _ := url.Parse(res.Header.Get("Location"))
	if res.StatusCode != 303 || location.Query().Get("error") != "access_denied" {
		t.Fatal("denial failed")
	}
	res, _ = consent(t, h, b, id, "approve")
	if res.StatusCode != 400 {
		t.Fatal("consent replay")
	}
	p := testPair{Client: client, Verifier: verifier}
	id = consentRequest(t, h, b, client, verifier)
	res, _ = consent(t, h, b, id, "approve")
	location, _ = url.Parse(res.Header.Get("Location"))
	p.Code = location.Query().Get("code")
	for _, field := range []string{"code_verifier", "client_id", "redirect_uri", "resource"} {
		values := exchangeValues(p)
		values.Set(field, "incorrect")
		res, _ = tokenCall(t, h, values)
		if res.StatusCode != 400 {
			t.Fatalf("accepted wrong %s", field)
		}
	}
	res, data := tokenCall(t, h, exchangeValues(p))
	if res.StatusCode != 200 {
		t.Fatalf("exchange: %s", data)
	}
	access := jsonMap(t, data)["access_token"].(string)
	checkToken(t, app, access, true)
	res, _ = tokenCall(t, h, exchangeValues(p))
	if res.StatusCode != 400 {
		t.Fatal("code replay accepted")
	}
	checkToken(t, app, access, false)
	q, _ := url.Parse(authPath(client, verifier))
	v := q.Query()
	v.Set("redirect_uri", "https://evil.example/callback")
	q.RawQuery = v.Encode()
	res, _ = httpCall(t, h, "GET", q.String(), "", nil, b)
	if res.StatusCode != 400 || res.Header.Get("Location") != "" {
		t.Fatal("unregistered redirect")
	}
	v.Set("redirect_uri", "http://127.0.0.1:32123/callback")
	v.Set("code_challenge_method", "plain")
	q.RawQuery = v.Encode()
	res, _ = httpCall(t, h, "GET", q.String(), "", nil, b)
	if res.StatusCode != 400 {
		t.Fatal("plain PKCE accepted")
	}
}

func TestRedirectOriginsCannotInjectConsentPolicy(t *testing.T) {
	for _, raw := range []string{"https://*.example/callback", "https://agent.example;script-src/callback", "https://agent.example,other.example/callback"} {
		if validRedirect(raw) {
			t.Errorf("accepted unsafe callback origin %q", raw)
		}
	}
	for _, raw := range []string{"https://agent.example/callback", "http://localhost:32123/callback", "http://127.0.0.1:32123/callback", "http://[::1]:32123/callback"} {
		if !validRedirect(raw) {
			t.Errorf("rejected callback %q", raw)
		}
	}
}

func TestRefreshRevocationAndForget(t *testing.T) {
	app, h := testServer(t, time.Second)
	a, b := newBrowser(t, h), newBrowser(t, h)
	p, other := pair(t, app, h, a), pair(t, app, h, b)
	values := url.Values{"grant_type": {"refresh_token"}, "client_id": {p.Client}, "refresh_token": {p.Refresh}}
	res, data := tokenCall(t, h, values)
	if res.StatusCode != 200 {
		t.Fatalf("refresh: %s", data)
	}
	rotated := jsonMap(t, data)
	checkToken(t, app, rotated["access_token"].(string), true)
	res, _ = tokenCall(t, h, values)
	if res.StatusCode != 400 {
		t.Fatal("refresh replay accepted")
	}
	checkToken(t, app, p.Access, false)
	checkToken(t, app, rotated["access_token"].(string), false)
	checkToken(t, app, other.Access, true)
	p = pair(t, app, h, a)
	headers := http.Header{"Origin": {testOrigin}, "X-Diagrams-Csrf": {b.CSRF}}
	res, _ = httpCall(t, h, "POST", "/api/agents/"+p.Grant+"/revoke", "", headers, b)
	if res.StatusCode != 200 {
		t.Fatal("idempotent revoke failed")
	}
	checkToken(t, app, p.Access, true)
	headers.Set("X-Diagrams-CSRF", a.CSRF)
	res, _ = httpCall(t, h, "POST", "/api/agents/"+p.Grant+"/revoke", "", headers, a)
	if res.StatusCode != 200 {
		t.Fatal("revoke failed")
	}
	checkToken(t, app, p.Access, false)
	checkToken(t, app, other.Access, true)
	p = pair(t, app, h, a)
	res, _ = httpCall(t, h, "POST", "/api/forget", "", headers, a)
	if res.StatusCode != 200 {
		t.Fatal("forget failed")
	}
	checkToken(t, app, p.Access, false)
	checkToken(t, app, other.Access, true)
	var count int
	_ = app.db.QueryRow("SELECT count(*) FROM browsers WHERE cookie_hash=?", digest(a.Cookie.Value)).Scan(&count)
	if count != 0 {
		t.Fatal("identity retained")
	}
}

func TestPairingsSurviveRestartAndStoreNoRawCredentials(t *testing.T) {
	app, h := testServer(t, time.Second)
	b := newBrowser(t, h)
	p := pair(t, app, h, b)
	config := app.config
	app.Close()
	reopened, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	checkToken(t, reopened, p.Access, true)
	req, _ := http.NewRequest("GET", testOrigin+"/api/agents", nil)
	req.AddCookie(b.Cookie)
	if _, err := reopened.session(req); err != nil {
		t.Fatal("browser session did not survive restart")
	}
	for _, path := range []string{config.DatabasePath, config.DatabasePath + "-wal"} {
		data, err := os.ReadFile(path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		for _, value := range []string{b.Cookie.Value, p.Access, p.Refresh, p.Code} {
			if bytes.Contains(data, []byte(value)) {
				t.Fatal("raw credential persisted")
			}
		}
	}
}

func TestBrowserMutationCSRFAndHostValidation(t *testing.T) {
	app, h := testServer(t, time.Second)
	b := newBrowser(t, h)
	p := pair(t, app, h, b)
	for _, path := range []string{"/api/forget", "/api/agents/" + p.Grant + "/revoke"} {
		for _, headers := range []http.Header{
			{"Origin": {testOrigin}},
			{"Origin": {"https://other.example"}, "X-Diagrams-Csrf": {b.CSRF}},
			{"Origin": {testOrigin}, "X-Diagrams-Csrf": {"incorrect"}},
		} {
			res, _ := httpCall(t, h, "POST", path, "", headers, b)
			if res.StatusCode != 403 {
				t.Fatalf("CSRF accepted for %s", path)
			}
		}
	}
	checkToken(t, app, p.Access, true)
	req, _ := http.NewRequest("GET", h.URL+"/", nil)
	req.Host = "untrusted.example"
	res, err := h.Client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 421 {
		t.Fatal("untrusted Host was accepted")
	}
	res, _ = httpCall(t, h, "POST", "/api/session", "", http.Header{"Origin": {testOrigin}}, nil)
	if res.StatusCode != 403 {
		t.Fatal("session creation accepted a simple cross-site form")
	}
}

func TestSecureCookieAndOriginBoundDatabase(t *testing.T) {
	config := Config{PublicURL: "https://diagrams.example", DatabasePath: t.TempDir() + "/pairings.db"}
	app, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", config.PublicURL+"/api/session", nil)
	r.Header.Set("Origin", config.PublicURL)
	r.Header.Set("X-Diagrams-Request", "1")
	w := httptest.NewRecorder()
	app.Handler().ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != "__Host-diagrams-session" || !cookies[0].Secure || !cookies[0].HttpOnly || cookies[0].Domain != "" || cookies[0].Path != "/" {
		t.Fatal("production cookie protections missing")
	}
	app.Close()
	config.PublicURL = "https://different.example"
	if other, err := New(config); err == nil {
		other.Close()
		t.Fatal("pairings reused under a different issuer")
	}
	config.PublicURL = "http://public.example"
	if other, err := New(config); err == nil {
		other.Close()
		t.Fatal("public HTTP allowed")
	}
}

func TestExpiredSessionsAndGrants(t *testing.T) {
	app, h := testServer(t, time.Second)
	b := newBrowser(t, h)
	p := pair(t, app, h, b)
	if _, err := app.db.Exec("UPDATE tokens SET expires=0 WHERE hash=?", digest(p.Access)); err != nil {
		t.Fatal(err)
	}
	checkToken(t, app, p.Access, false)
	if _, err := app.db.Exec("UPDATE browsers SET expires=0 WHERE cookie_hash=?", digest(b.Cookie.Value)); err != nil {
		t.Fatal(err)
	}
	res, _ := tokenCall(t, h, url.Values{"grant_type": {"refresh_token"}, "client_id": {p.Client}, "refresh_token": {p.Refresh}})
	if res.StatusCode != 400 {
		t.Fatal("expired browser refreshed")
	}
	app.pruneIdentities()
	var count int
	_ = app.db.QueryRow("SELECT count(*) FROM grants").Scan(&count)
	if count != 0 {
		t.Fatal("expired grants not pruned")
	}
}
