package server

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const testToken = "test-token-for-diagrams-not-a-real-secret"
const testOrigin = "http://diagrams.test"

func testServer(t *testing.T, timeout time.Duration) (*Server, *memoryHTTPServer) {
	t.Helper()
	staticDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(staticDir, "index.html"), []byte("<html>Diagrams</html>"), 0600); err != nil {
		t.Fatal(err)
	}
	app := New(Config{Token: testToken, Origins: []string{testOrigin}, StaticDir: staticDir, CommandTimeout: timeout})
	httpServer := newMemoryHTTPServer(app.Handler())
	t.Cleanup(func() { app.Close(); httpServer.Close() })
	return app, httpServer
}

func dialBrowser(t *testing.T, server *memoryHTTPServer, token, diagram string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/api/bridge", &websocket.DialOptions{HTTPClient: server.Client, HTTPHeader: http.Header{"Origin": {testOrigin}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	if err := wsjson.Write(ctx, conn, bridgeMessage{Type: "hello", Token: token, DiagramID: diagram}); err != nil {
		t.Fatal(err)
	}
	return conn
}

func readReady(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var message bridgeMessage
	if err := wsjson.Read(ctx, conn, &message); err != nil {
		t.Fatal(err)
	}
	if message.Type != "ready" {
		t.Fatalf("got %q, want ready", message.Type)
	}
}

type authenticatedTransport struct{ base http.RoundTripper }

func (transport authenticatedTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	request := r.Clone(r.Context())
	request.Header.Set("Authorization", "Bearer "+testToken)
	return transport.base.RoundTrip(request)
}

func mcpClient(t *testing.T, server *memoryHTTPServer) *mcp.ClientSession {
	t.Helper()
	client := mcp.NewClient(&mcp.Implementation{Name: "phase-one-test", Version: "1"}, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: server.URL + "/mcp", HTTPClient: &http.Client{Transport: authenticatedTransport{server.Client.Transport}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

func TestAuthenticationAndOrigins(t *testing.T) {
	_, server := testServer(t, time.Second)
	for _, test := range []struct {
		name, path, token, origin string
		want                      int
	}{
		{"health", "/healthz", "", "", 200},
		{"static frontend", "/", "", "", 200},
		{"unknown API", "/api/missing", "", "", 404},
		{"missing token", "/mcp", "", "", 401},
		{"invalid token", "/mcp", "incorrect", "", 401},
		{"foreign origin", "/mcp", testToken, "https://untrusted.example", 403},
		{"websocket foreign origin", "/api/bridge", "", "https://untrusted.example", 403},
		{"websocket missing origin", "/api/bridge", "", "", 403},
	} {
		t.Run(test.name, func(t *testing.T) {
			request, _ := http.NewRequest(http.MethodGet, server.URL+test.path, nil)
			if test.token != "" {
				request.Header.Set("Authorization", "Bearer "+test.token)
			}
			if test.origin != "" {
				request.Header.Set("Origin", test.origin)
			}
			response, err := server.Client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != test.want {
				t.Fatalf("got %d, want %d", response.StatusCode, test.want)
			}
		})
	}
}

func TestMCPDiscoveryAndBrowserRoundTrip(t *testing.T) {
	_, server := testServer(t, time.Second)
	client := mcpClient(t, server)
	ctx := context.Background()
	tools, err := client.ListTools(ctx, nil)
	if err != nil || len(tools.Tools) != 2 {
		t.Fatalf("tools: %v, %v", tools, err)
	}
	result, err := client.CallTool(ctx, &mcp.CallToolParams{Name: "get_diagram", Arguments: map[string]any{}})
	if err != nil || !result.IsError || !strings.Contains(result.Content[0].(*mcp.TextContent).Text, "browser_unavailable") {
		t.Fatalf("offline result: %+v, %v", result, err)
	}
	browser := dialBrowser(t, server, testToken, "diagram-one")
	readReady(t, browser)
	seen := make(chan bridgeMessage, 1)
	go func() {
		var message bridgeMessage
		if err := wsjson.Read(ctx, browser, &message); err != nil {
			return
		}
		seen <- message
		_ = wsjson.Write(ctx, browser, bridgeMessage{Type: "result", ID: message.ID, Result: json.RawMessage(`{"diagramId":"diagram-one","revision":3,"elements":[]}`)})
	}()
	result, err = client.CallTool(ctx, &mcp.CallToolParams{Name: "get_diagram", Arguments: map[string]any{}})
	if err != nil || result.IsError {
		t.Fatalf("round trip: %+v, %v", result, err)
	}
	select {
	case message := <-seen:
		if message.Tool != "get_diagram" || message.Type != "command" || message.Deadline <= time.Now().UnixMilli() {
			t.Fatalf("unexpected command: %+v", message)
		}
	case <-time.After(time.Second):
		t.Fatal("browser never received command")
	}
	if !strings.Contains(result.Content[0].(*mcp.TextContent).Text, `"revision":3`) {
		t.Fatalf("missing live response: %+v", result)
	}
}

func TestBrowserAuthenticationAndExclusiveConnection(t *testing.T) {
	_, server := testServer(t, time.Second)
	bad := dialBrowser(t, server, "wrong-token", "bad")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var message bridgeMessage
	if err := wsjson.Read(ctx, bad, &message); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("bad token close: %v", err)
	}
	first := dialBrowser(t, server, testToken, "first")
	readReady(t, first)
	second := dialBrowser(t, server, testToken, "second")
	if err := wsjson.Read(ctx, second, &message); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("second browser close: %v", err)
	}
}

func TestDisconnectAndTimeoutReleaseRequests(t *testing.T) {
	for _, disconnect := range []bool{false, true} {
		t.Run(map[bool]string{false: "timeout", true: "disconnect"}[disconnect], func(t *testing.T) {
			app, server := testServer(t, 100*time.Millisecond)
			browser := dialBrowser(t, server, testToken, "first")
			readReady(t, browser)
			go func() {
				var command bridgeMessage
				if wsjson.Read(context.Background(), browser, &command) == nil && disconnect {
					_ = browser.CloseNow()
				}
			}()
			_, err := app.bridge.call(context.Background(), "get_diagram", json.RawMessage(`{}`), 100*time.Millisecond)
			if err == nil {
				t.Fatal("expected a connection error")
			}
			app.bridge.mu.Lock()
			defer app.bridge.mu.Unlock()
			if app.bridge.active != nil && len(app.bridge.active.pending) != 0 {
				t.Fatal("pending request leaked")
			}
		})
	}
}
