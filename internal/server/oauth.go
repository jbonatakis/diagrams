package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"html/template"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
)

type browserSession struct {
	ID, Cookie string
	Expires    int64
}
type agentGrant struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Created int64  `json:"createdAt"`
	Expires int64  `json:"expiresAt"`
}
type windowLimiter struct {
	mu     sync.Mutex
	start  time.Time
	counts map[string]int
}

func (l *windowLimiter) allow(key string, limit int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if time.Since(l.start) >= time.Minute {
		l.start = time.Now()
		l.counts = make(map[string]int)
	}
	if l.counts[key] >= limit {
		return false
	}
	l.counts[key]++
	return true
}

func jsonReply(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func oauthError(w http.ResponseWriter, status int, code, message string) {
	jsonReply(w, status, map[string]string{"error": code, "error_description": message})
}
func (s *Server) limited(w http.ResponseWriter, key string, limit int) bool {
	if s.limits.allow(key, limit) {
		return false
	}
	w.Header().Set("Retry-After", "60")
	oauthError(w, 429, "temporarily_unavailable", "Please try again in a minute.")
	return true
}
func readJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	if strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/json" {
		oauthError(w, 415, "invalid_request", "Use application/json.")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(target); err != nil {
		oauthError(w, 400, "invalid_request", "Invalid JSON.")
		return false
	}
	if dec.Decode(new(any)) != io.EOF {
		oauthError(w, 400, "invalid_request", "Expected one JSON object.")
		return false
	}
	return true
}
func formValues(w http.ResponseWriter, r *http.Request) (url.Values, bool) {
	if strings.Split(r.Header.Get("Content-Type"), ";")[0] != "application/x-www-form-urlencoded" {
		oauthError(w, 415, "invalid_request", "Use application/x-www-form-urlencoded.")
		return nil, false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	if err := r.ParseForm(); err != nil {
		oauthError(w, 400, "invalid_request", "Invalid form.")
		return nil, false
	}
	for _, values := range r.PostForm {
		if len(values) != 1 {
			oauthError(w, 400, "invalid_request", "Duplicate parameters.")
			return nil, false
		}
	}
	return r.PostForm, true
}
func (s *Server) cookieName() string {
	if strings.HasPrefix(s.config.PublicURL, "https://") {
		return "__Host-diagrams-session"
	}
	return "diagrams-session"
}
func (s *Server) setCookie(w http.ResponseWriter, value string, expires int64) {
	maxAge := int(time.Until(time.Unix(expires, 0)).Seconds())
	if value == "" {
		maxAge = -1
	}
	http.SetCookie(w, &http.Cookie{Name: s.cookieName(), Value: value, Path: "/", HttpOnly: true,
		Secure: strings.HasPrefix(s.config.PublicURL, "https://"), SameSite: http.SameSiteLaxMode,
		MaxAge: maxAge, Expires: time.Unix(expires, 0)})
}
func (s *Server) session(r *http.Request) (browserSession, error) {
	c, err := r.Cookie(s.cookieName())
	if err != nil || len(c.Value) != 43 {
		return browserSession{}, sql.ErrNoRows
	}
	b := browserSession{Cookie: c.Value}
	err = s.db.QueryRowContext(r.Context(), "SELECT id, expires FROM browsers WHERE cookie_hash = ? AND expires > ?", digest(c.Value), time.Now().Unix()).Scan(&b.ID, &b.Expires)
	return b, err
}
func (s *Server) sameOrigin(w http.ResponseWriter, r *http.Request) bool {
	if r.Header.Get("Origin") != s.config.PublicURL {
		oauthError(w, 403, "forbidden", "This action must come from the diagram app.")
		return false
	}
	return true
}
func (s *Server) browserMutation(w http.ResponseWriter, r *http.Request) (browserSession, bool) {
	if !s.sameOrigin(w, r) {
		return browserSession{}, false
	}
	b, err := s.session(r)
	if err != nil {
		oauthError(w, 401, "session_expired", "Reconnect this browser.")
		return b, false
	}
	if r.Header.Get("X-Diagrams-CSRF") != digest("csrf:"+b.Cookie) {
		oauthError(w, 403, "forbidden", "Reload the app before trying again.")
		return b, false
	}
	return b, true
}
func (s *Server) serveSession(w http.ResponseWriter, r *http.Request) {
	if !s.sameOrigin(w, r) {
		return
	}
	if r.Header.Get("X-Diagrams-Request") != "1" {
		oauthError(w, 403, "forbidden", "Use the diagram app.")
		return
	}
	if s.limited(w, "sessions", 120) {
		return
	}
	b, err := s.session(r)
	if errors.Is(err, sql.ErrNoRows) {
		var count int
		if err = s.db.QueryRow("SELECT count(*) FROM browsers").Scan(&count); err != nil {
			oauthError(w, 503, "temporarily_unavailable", "Could not open a session.")
			return
		}
		if count >= 10000 {
			oauthError(w, 503, "temporarily_unavailable", "The server has reached its browser limit.")
			return
		}
		b = browserSession{ID: secret(), Cookie: secret(), Expires: time.Now().Add(browserLifetime).Unix()}
		_, err = s.db.ExecContext(r.Context(), "INSERT INTO browsers VALUES (?, ?, ?)", b.ID, digest(b.Cookie), b.Expires)
	}
	if err != nil {
		oauthError(w, 503, "temporarily_unavailable", "Could not open a session.")
		return
	}
	// Renew the browser session daily while in use, rather than writing for
	// every poll. Agent grants have their own absolute expiry.
	if b.Expires < time.Now().Add(browserLifetime-24*time.Hour).Unix() {
		b.Expires = time.Now().Add(browserLifetime).Unix()
		if _, err = s.db.ExecContext(r.Context(), "UPDATE browsers SET expires = ? WHERE id = ?", b.Expires, b.ID); err != nil {
			oauthError(w, 503, "temporarily_unavailable", "Could not renew the session.")
			return
		}
	}
	s.setCookie(w, b.Cookie, b.Expires)
	jsonReply(w, 200, map[string]any{"csrf": digest("csrf:" + b.Cookie), "endpoint": s.config.PublicURL + "/mcp"})
}

func (s *Server) restoreSession(w http.ResponseWriter, r *http.Request) {
	b, err := s.session(r)
	if err != nil {
		oauthError(w, 401, "session_expired", "Connect this browser first.")
		return
	}
	jsonReply(w, 200, map[string]any{"csrf": digest("csrf:" + b.Cookie), "endpoint": s.config.PublicURL + "/mcp"})
}
func (s *Server) serveAgents(w http.ResponseWriter, r *http.Request) {
	b, err := s.session(r)
	if err != nil {
		oauthError(w, 401, "session_expired", "Reconnect this browser.")
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `SELECT g.id, c.name, g.created, g.expires FROM grants g JOIN clients c ON c.id=g.client_id WHERE g.browser_id=? AND g.expires>? ORDER BY g.created DESC`, b.ID, time.Now().Unix())
	if err != nil {
		oauthError(w, 503, "temporarily_unavailable", "Could not list agents.")
		return
	}
	defer rows.Close()
	agents := []agentGrant{}
	for rows.Next() {
		var a agentGrant
		if err = rows.Scan(&a.ID, &a.Name, &a.Created, &a.Expires); err != nil {
			break
		}
		agents = append(agents, a)
	}
	if err != nil || rows.Err() != nil {
		oauthError(w, 503, "temporarily_unavailable", "Could not list agents.")
		return
	}
	jsonReply(w, 200, map[string]any{"agents": agents})
}
func (s *Server) revokeAgent(w http.ResponseWriter, r *http.Request) {
	b, ok := s.browserMutation(w, r)
	if !ok {
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "DELETE FROM grants WHERE id=? AND browser_id=?", r.PathValue("id"), b.ID); err != nil {
		oauthError(w, 503, "temporarily_unavailable", "Could not revoke the agent.")
		return
	}
	jsonReply(w, 200, map[string]bool{"revoked": true})
}
func (s *Server) forgetBrowser(w http.ResponseWriter, r *http.Request) {
	b, ok := s.browserMutation(w, r)
	if !ok {
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "DELETE FROM browsers WHERE id=?", b.ID); err != nil {
		oauthError(w, 503, "temporarily_unavailable", "Could not forget this browser.")
		return
	}
	s.bridge.disconnect(b.ID)
	s.setCookie(w, "", 1)
	jsonReply(w, 200, map[string]bool{"forgotten": true})
}

func (s *Server) oauthMetadata(w http.ResponseWriter, r *http.Request) {
	base := s.config.PublicURL
	jsonReply(w, 200, map[string]any{
		"issuer": base, "authorization_endpoint": base + "/oauth/authorize", "token_endpoint": base + "/oauth/token",
		"registration_endpoint": base + "/oauth/register", "revocation_endpoint": base + "/oauth/revoke",
		"response_types_supported": []string{"code"}, "grant_types_supported": []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported": []string{"S256"}, "token_endpoint_auth_methods_supported": []string{"none"},
		"revocation_endpoint_auth_methods_supported": []string{"none"}, "scopes_supported": []string{agentScope},
		"authorization_response_iss_parameter_supported": true,
	})
}
func (s *Server) resourceMetadata(w http.ResponseWriter, r *http.Request) {
	jsonReply(w, 200, map[string]any{"resource": s.config.PublicURL + "/mcp", "authorization_servers": []string{s.config.PublicURL},
		"scopes_supported": []string{agentScope}, "bearer_methods_supported": []string{"header"}})
}
func loopback(host string) bool { return host == "127.0.0.1" || host == "::1" || host == "localhost" }

// Callback origins also appear in CSP. Accept literal DNS/IP hosts, never
// wildcard sources or CSP punctuation. International domains can use punycode.
var redirectHostPattern = regexp.MustCompile(`^[A-Za-z0-9.\-:\[\]]+$`)

func validRedirect(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 2048 || !redirectHostPattern.MatchString(u.Host) || u.User != nil || u.Fragment != "" {
		return false
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && loopback(u.Hostname())) {
		return false
	}
	for _, key := range []string{"code", "state", "error", "iss"} {
		if u.Query().Has(key) {
			return false
		}
	}
	return true
}
func redirectMatches(registered, actual string) bool {
	if registered == actual {
		return true
	}
	a, err := url.Parse(registered)
	if err != nil {
		return false
	}
	b, err := url.Parse(actual)
	if err != nil {
		return false
	}
	if a.Scheme != "http" || !loopback(a.Hostname()) || a.Port() != "" || a.Hostname() != b.Hostname() {
		return false
	}
	// Native OAuth clients choose an ephemeral loopback port at login.
	b.Host = a.Host
	return a.String() == b.String()
}
func (s *Server) registerClient(w http.ResponseWriter, r *http.Request) {
	if s.limited(w, "register", 30) {
		return
	}
	var input struct {
		Name      string   `json:"client_name"`
		Redirects []string `json:"redirect_uris"`
		Method    string   `json:"token_endpoint_auth_method"`
		Grants    []string `json:"grant_types"`
		Responses []string `json:"response_types"`
	}
	if !readJSON(w, r, &input) {
		return
	}
	if input.Method != "" && input.Method != "none" {
		oauthError(w, 400, "invalid_client_metadata", "Only public clients are supported.")
		return
	}
	if len(input.Redirects) == 0 || len(input.Redirects) > 5 {
		oauthError(w, 400, "invalid_redirect_uri", "Provide one to five redirect URLs.")
		return
	}
	for _, redirect := range input.Redirects {
		if !validRedirect(redirect) {
			oauthError(w, 400, "invalid_redirect_uri", "Use HTTPS or a loopback callback.")
			return
		}
	}
	for _, grant := range input.Grants {
		if grant != "authorization_code" && grant != "refresh_token" {
			oauthError(w, 400, "invalid_client_metadata", "Unsupported grant type.")
			return
		}
	}
	if len(input.Responses) > 0 && (len(input.Responses) != 1 || input.Responses[0] != "code") {
		oauthError(w, 400, "invalid_client_metadata", "Only code responses are supported.")
		return
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = "Unnamed agent"
	}
	if len(name) > 120 || strings.ContainsAny(name, "\r\n\x00") {
		oauthError(w, 400, "invalid_client_metadata", "Invalid client name.")
		return
	}
	redirects, _ := json.Marshal(input.Redirects)
	var count int
	if err := s.db.QueryRow("SELECT count(*) FROM clients").Scan(&count); err != nil || count >= 10000 {
		oauthError(w, 503, "temporarily_unavailable", "Client registration is unavailable.")
		return
	}
	id := secret()
	if _, err := s.db.ExecContext(r.Context(), "INSERT INTO clients VALUES (?, ?, ?, ?)", id, name, string(redirects), time.Now().Add(7*24*time.Hour).Unix()); err != nil {
		oauthError(w, 503, "temporarily_unavailable", "Could not register client.")
		return
	}
	jsonReply(w, 201, map[string]any{"client_id": id, "client_name": name, "redirect_uris": input.Redirects, "token_endpoint_auth_method": "none",
		"grant_types": []string{"authorization_code", "refresh_token"}, "response_types": []string{"code"}})
}

var pkcePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
var verifierPattern = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)
var consentPage = template.Must(template.New("consent").Parse(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect an agent · Diagrams</title><style>
body{margin:0;background:#fcfcf9;color:#344b47;font:16px system-ui;display:grid;min-height:100vh;place-items:center}main{max-width:480px;padding:36px;background:white;border:1px solid #daddd1;border-radius:16px;margin:20px}h1{font-size:26px}p{line-height:1.6}button,a{font:inherit}button{padding:12px 18px;border:1px solid #344b47;border-radius:8px;cursor:pointer;background:#344b47;color:white;margin:8px 8px 0 0}button[value=deny]{background:white;color:#344b47}small{display:block;color:#61736b;line-height:1.6}code{overflow-wrap:anywhere}a{color:#344b47}.note{background:#f0f5f2;padding:12px;border-radius:8px}
</style></head><body><main>
{{if .Missing}}<h1>Open your diagram library first</h1><p>Open Diagrams in this browser, then return here and reload this page to approve the connection.</p><p><a href="/" target="_blank" rel="noopener noreferrer">Open Diagrams ↗</a></p><p>Your browser library stays separate from everyone else’s. No account is needed.</p>
{{else}}<h1>Connect this agent?</h1><p><strong>{{.Name}}</strong> is requesting permission to read, create, edit, import, export, and trash diagrams in <strong>this browser’s library</strong>.</p><p class="note">Only approve a connection you just started. The app must remain open for agent access.</p><small>The agent supplied this name. Authorization returns to <code>{{.Destination}}</code>.</small>
<form method="post" action="/oauth/approve"><input type="hidden" name="request" value="{{.Request}}"><input type="hidden" name="csrf" value="{{.CSRF}}"><button name="decision" value="approve">Allow access</button><button name="decision" value="deny">Cancel</button></form>
<p><small>You can revoke access from Connected agents at any time. No email address or account is required.</small></p>{{end}}
</main></body></html>`))

func (s *Server) authorize(w http.ResponseWriter, r *http.Request) {
	if s.limited(w, "authorize", 120) {
		return
	}
	q := r.URL.Query()
	for _, values := range q {
		if len(values) != 1 {
			oauthError(w, 400, "invalid_request", "Duplicate parameters.")
			return
		}
	}
	var name, rawRedirects string
	if err := s.db.QueryRowContext(r.Context(), "SELECT name, redirects FROM clients WHERE id=?", q.Get("client_id")).Scan(&name, &rawRedirects); err != nil {
		oauthError(w, 400, "invalid_client", "Unknown client.")
		return
	}
	var redirects []string
	_ = json.Unmarshal([]byte(rawRedirects), &redirects)
	redirect := q.Get("redirect_uri")
	if !validRedirect(redirect) || !slices.ContainsFunc(redirects, func(item string) bool { return redirectMatches(item, redirect) }) {
		oauthError(w, 400, "invalid_request", "Unregistered redirect URL.")
		return
	}
	if q.Get("response_type") != "code" || q.Get("code_challenge_method") != "S256" || !pkcePattern.MatchString(q.Get("code_challenge")) || len(q.Get("state")) > 1024 {
		oauthError(w, 400, "invalid_request", "An authorization code with S256 PKCE is required.")
		return
	}
	if q.Get("resource") != s.config.PublicURL+"/mcp" {
		oauthError(w, 400, "invalid_target", "Select this diagram server as the resource.")
		return
	}
	if q.Get("scope") != "" && q.Get("scope") != agentScope {
		oauthError(w, 400, "invalid_scope", "Unsupported scope.")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// no-referrer makes browser form submissions send Origin: null. Preserve
	// the same-origin approval check without sending a referrer to the agent.
	w.Header().Set("Referrer-Policy", "same-origin")
	destination, _ := url.Parse(redirect)
	// Browsers also check form-action after the approval's 303 redirect.
	callbackOrigin := destination.Scheme + "://" + destination.Host
	w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' "+callbackOrigin+"; frame-ancestors 'none'; base-uri 'none'")
	b, err := s.session(r)
	if errors.Is(err, sql.ErrNoRows) {
		_ = consentPage.Execute(w, map[string]any{"Missing": true})
		return
	}
	if err != nil {
		http.Error(w, "Could not load browser session.", 503)
		return
	}
	var count int
	if err = s.db.QueryRow("SELECT count(*) FROM authorizations WHERE browser_id=? AND expires>?", b.ID, time.Now().Unix()).Scan(&count); err != nil || count >= 20 {
		http.Error(w, "Too many pending approvals. Try again in five minutes.", 429)
		return
	}
	id := secret()
	if _, err = s.db.ExecContext(r.Context(), "INSERT INTO authorizations VALUES (?, ?, ?, ?, ?, ?, ?)", id, b.ID, q.Get("client_id"), redirect, q.Get("code_challenge"), q.Get("state"), time.Now().Add(5*time.Minute).Unix()); err != nil {
		http.Error(w, "Could not start authorization.", 503)
		return
	}
	_ = consentPage.Execute(w, map[string]any{"Name": name, "Destination": destination.Host, "Request": id, "CSRF": digest("csrf:" + b.Cookie)})
}
func (s *Server) approve(w http.ResponseWriter, r *http.Request) {
	if !s.sameOrigin(w, r) {
		return
	}
	b, err := s.session(r)
	if err != nil {
		oauthError(w, 401, "session_expired", "Open the diagram app again.")
		return
	}
	form, ok := formValues(w, r)
	if !ok {
		return
	}
	if form.Get("csrf") != digest("csrf:"+b.Cookie) {
		oauthError(w, 403, "forbidden", "Invalid approval.")
		return
	}
	if form.Get("decision") != "approve" && form.Get("decision") != "deny" {
		oauthError(w, 400, "invalid_request", "Choose allow or cancel.")
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		oauthError(w, 503, "temporarily_unavailable", "Please retry.")
		return
	}
	defer tx.Rollback()
	var clientID, redirect, challenge, state string
	err = tx.QueryRowContext(r.Context(), `DELETE FROM authorizations WHERE id=? AND browser_id=? AND expires>? RETURNING client_id,redirect,challenge,state`, form.Get("request"), b.ID, time.Now().Unix()).Scan(&clientID, &redirect, &challenge, &state)
	if err != nil {
		oauthError(w, 400, "invalid_request", "This approval expired or was already used.")
		return
	}
	target, _ := url.Parse(redirect)
	query := target.Query()
	query.Set("state", state)
	query.Set("iss", s.config.PublicURL)
	if form.Get("decision") == "deny" {
		query.Set("error", "access_denied")
	} else {
		var count int
		if err = tx.QueryRow("SELECT count(*) FROM grants WHERE browser_id=? AND expires>?", b.ID, time.Now().Unix()).Scan(&count); err != nil || count >= 20 {
			oauthError(w, 400, "invalid_request", "Revoke an existing agent before pairing another.")
			return
		}
		grant, code := secret(), secret()
		if _, err = tx.Exec("DELETE FROM grants WHERE browser_id=? AND client_id=?", b.ID, clientID); err == nil {
			_, err = tx.Exec("INSERT INTO grants VALUES (?, ?, ?, ?, ?)", grant, b.ID, clientID, time.Now().Unix(), time.Now().Add(browserLifetime).Unix())
		}
		if err == nil {
			_, err = tx.Exec("INSERT INTO codes(hash,grant_id,redirect,challenge,expires) VALUES (?, ?, ?, ?, ?)", digest(code), grant, redirect, challenge, time.Now().Add(time.Minute).Unix())
		}
		if err != nil {
			oauthError(w, 503, "temporarily_unavailable", "Could not save the pairing.")
			return
		}
		query.Set("code", code)
	}
	if err = tx.Commit(); err != nil {
		oauthError(w, 503, "temporarily_unavailable", "Could not save the approval.")
		return
	}
	target.RawQuery = query.Encode()
	http.Redirect(w, r, target.String(), http.StatusSeeOther)
}

func (s *Server) token(w http.ResponseWriter, r *http.Request) {
	if s.limited(w, "token", 300) {
		return
	}
	form, ok := formValues(w, r)
	if !ok {
		return
	}
	if form.Get("resource") != "" && form.Get("resource") != s.config.PublicURL+"/mcp" {
		oauthError(w, 400, "invalid_target", "Wrong resource.")
		return
	}
	if form.Get("scope") != "" && form.Get("scope") != agentScope {
		oauthError(w, 400, "invalid_scope", "Unsupported scope.")
		return
	}
	if form.Get("client_secret") != "" || r.Header.Get("Authorization") != "" {
		oauthError(w, 400, "invalid_client", "This server uses public clients with PKCE.")
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		oauthError(w, 503, "temporarily_unavailable", "Please retry.")
		return
	}
	defer tx.Rollback()
	var grant, clientID, redirect, challenge string
	var expires int64
	var used int
	now := time.Now().Unix()
	switch form.Get("grant_type") {
	case "authorization_code":
		err = tx.QueryRow(`SELECT c.grant_id,g.client_id,c.redirect,c.challenge,g.expires,c.used FROM codes c JOIN grants g ON g.id=c.grant_id JOIN browsers b ON b.id=g.browser_id WHERE c.hash=? AND c.expires>? AND g.expires>? AND b.expires>?`, digest(form.Get("code")), now, now, now).Scan(&grant, &clientID, &redirect, &challenge, &expires, &used)
		if err == nil && (clientID != form.Get("client_id") || redirect != form.Get("redirect_uri") || !verifierPattern.MatchString(form.Get("code_verifier")) || challenge != digest(form.Get("code_verifier"))) {
			err = sql.ErrNoRows
		}
		if err == nil && used == 0 {
			_, err = tx.Exec("UPDATE codes SET used=1 WHERE hash=?", digest(form.Get("code")))
		}
	case "refresh_token":
		err = tx.QueryRow(`SELECT t.grant_id,g.client_id,g.expires,t.used FROM tokens t JOIN grants g ON g.id=t.grant_id JOIN browsers b ON b.id=g.browser_id WHERE t.hash=? AND t.kind='refresh' AND t.expires>? AND g.expires>? AND b.expires>?`, digest(form.Get("refresh_token")), now, now, now).Scan(&grant, &clientID, &expires, &used)
		if err == nil && clientID != form.Get("client_id") {
			err = sql.ErrNoRows
		}
		if err == nil && used == 0 {
			_, err = tx.Exec("UPDATE tokens SET used=1 WHERE hash=?", digest(form.Get("refresh_token")))
		}
	default:
		oauthError(w, 400, "unsupported_grant_type", "Use authorization_code or refresh_token.")
		return
	}
	if err != nil {
		oauthError(w, 400, "invalid_grant", "The authorization expired or is invalid. Reconnect the agent.")
		return
	}
	if used != 0 {
		// A replayed code/refresh credential invalidates its entire grant.
		_, err = tx.Exec("DELETE FROM grants WHERE id=?", grant)
		if err == nil {
			err = tx.Commit()
		}
		if err != nil {
			oauthError(w, 503, "temporarily_unavailable", "Please retry.")
			return
		}
		oauthError(w, 400, "invalid_grant", "This credential was already used. Reconnect the agent.")
		return
	}
	access, refresh := secret(), secret()
	accessExpiry := min(time.Now().Add(accessLifetime).Unix(), expires)
	refreshExpiry := min(time.Now().Add(refreshLifetime).Unix(), expires)
	_, err = tx.Exec("INSERT INTO tokens(hash,grant_id,kind,expires) VALUES (?,?,'access',?),(?,?,'refresh',?)", digest(access), grant, accessExpiry, digest(refresh), grant, refreshExpiry)
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		oauthError(w, 503, "temporarily_unavailable", "Could not complete authorization.")
		return
	}
	jsonReply(w, 200, map[string]any{"access_token": access, "token_type": "Bearer", "expires_in": accessExpiry - now, "refresh_token": refresh, "scope": agentScope})
}
func (s *Server) revokeToken(w http.ResponseWriter, r *http.Request) {
	if s.limited(w, "revoke", 120) {
		return
	}
	form, ok := formValues(w, r)
	if !ok {
		return
	}
	_, err := s.db.ExecContext(r.Context(), `DELETE FROM grants WHERE client_id=? AND id IN (SELECT grant_id FROM tokens WHERE hash=?)`, form.Get("client_id"), digest(form.Get("token")))
	if err != nil {
		oauthError(w, 503, "temporarily_unavailable", "Could not revoke access.")
		return
	}
	jsonReply(w, 200, map[string]bool{"revoked": true})
}
func (s *Server) verifyAccess(ctx context.Context, token string, r *http.Request) (*auth.TokenInfo, error) {
	if len(token) != 43 {
		return nil, auth.ErrInvalidToken
	}
	var browser, grant string
	var expires int64
	now := time.Now().Unix()
	err := s.db.QueryRowContext(ctx, `SELECT g.browser_id,g.id,t.expires FROM tokens t JOIN grants g ON g.id=t.grant_id JOIN browsers b ON b.id=g.browser_id WHERE t.hash=? AND t.kind='access' AND t.used=0 AND t.expires>? AND g.expires>? AND b.expires>?`, digest(token), now, now, now).Scan(&browser, &grant, &expires)
	if err != nil {
		return nil, auth.ErrInvalidToken
	}
	return &auth.TokenInfo{UserID: browser, Scopes: []string{agentScope}, Expiration: time.Unix(expires, 0), Extra: map[string]any{"grant": grant}}, nil
}
