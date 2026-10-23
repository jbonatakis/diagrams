package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

type toolError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *toolError) Error() string { return e.Message }

type bridgeMessage struct {
	Capabilities []string        `json:"capabilities,omitempty"`
	Type         string          `json:"type"`
	ID           string          `json:"id,omitempty"`
	DiagramID    string          `json:"diagramId,omitempty"`
	Tool         string          `json:"tool,omitempty"`
	Arguments    json.RawMessage `json:"arguments,omitempty"`
	Deadline     int64           `json:"deadline,omitempty"`
	Result       json.RawMessage `json:"result,omitempty"`
	Error        *toolError      `json:"error,omitempty"`
}

type peer struct {
	hostedExports bool
	conn          *websocket.Conn
	diagramID     string
	browserID     string
	done          chan struct{}
	pending       map[string]chan bridgeMessage
}

// bridge retains connection metadata and in-flight requests, never diagram state.
type bridge struct {
	mu     sync.Mutex
	active map[string]*peer
}

func (b *bridge) attach(p *peer) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.active == nil {
		b.active = make(map[string]*peer)
	}
	if b.active[p.browserID] != nil || len(b.active) >= 256 {
		return false
	}
	b.active[p.browserID] = p
	return true
}

func (b *bridge) detach(p *peer) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.active[p.browserID] == p {
		delete(b.active, p.browserID)
		close(p.done)
	}
}

func (b *bridge) disconnect(browserID string) {
	b.mu.Lock()
	p := b.active[browserID]
	b.mu.Unlock()
	if p != nil {
		b.detach(p)
		_ = p.conn.CloseNow()
	}
}
func (b *bridge) close() {
	b.mu.Lock()
	peers := make([]*peer, 0, len(b.active))
	for _, p := range b.active {
		peers = append(peers, p)
	}
	b.mu.Unlock()
	for _, p := range peers {
		b.detach(p)
		_ = p.conn.CloseNow()
	}
}

func (b *bridge) call(ctx context.Context, browserID, tool string, args json.RawMessage, timeout time.Duration) (json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		return nil, err
	}
	id := hex.EncodeToString(idBytes)
	response := make(chan bridgeMessage, 1)
	b.mu.Lock()
	p := b.active[browserID]
	if p == nil {
		b.mu.Unlock()
		return nil, &toolError{"browser_unavailable", "Open the paired browser’s diagram app before using this tool."}
	}
	if len(p.pending) >= 8 {
		b.mu.Unlock()
		return nil, &toolError{"busy", "Too many pending requests. Wait for existing calls to finish."}
	}
	p.pending[id] = response
	b.mu.Unlock()
	defer func() { b.mu.Lock(); delete(p.pending, id); b.mu.Unlock() }()
	deadline, _ := ctx.Deadline()
	if err := wsjson.Write(ctx, p.conn, bridgeMessage{
		Type: "command", ID: id, Tool: tool, Arguments: args, Deadline: deadline.UnixMilli(),
	}); err != nil {
		return nil, &toolError{"browser_unavailable", "The browser disconnected. Reconnect and inspect the diagram before retrying an edit."}
	}
	select {
	case message := <-response:
		if message.Error != nil {
			return nil, message.Error
		}
		if len(message.Result) == 0 {
			return nil, &toolError{"invalid_response", "The browser returned an empty response."}
		}
		return message.Result, nil
	case <-p.done:
		return nil, &toolError{"browser_unavailable", "The browser disconnected. An edit may have completed; inspect the diagram before retrying."}
	case <-ctx.Done():
		return nil, &toolError{"browser_timeout", "The browser did not respond in time. It may be suspended. Inspect the diagram before retrying an edit."}
	}
}

func (b *bridge) supportsHosted(browserID string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	p := b.active[browserID]
	if p == nil {
		return &toolError{"browser_unavailable", "Open the paired browser before starting a hosted export."}
	}
	if !p.hostedExports {
		return &toolError{"unsupported_capability", "Refresh the paired browser to enable hosted exports."}
	}
	return nil
}

func (b *bridge) send(browserID, tool string, args json.RawMessage, deadline time.Time) error {
	b.mu.Lock()
	p := b.active[browserID]
	b.mu.Unlock()
	if p == nil {
		return &toolError{"browser_unavailable", "Open the paired browser’s diagram app before using this tool."}
	}
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return wsjson.Write(ctx, p.conn, bridgeMessage{Type: "command", ID: hex.EncodeToString(idBytes), Tool: tool, Arguments: args, Deadline: deadline.UnixMilli()})
}

func (s *Server) serveBridge(w http.ResponseWriter, r *http.Request) {
	// Browser WebSockets must originate at an explicitly configured app origin.
	if r.Header.Get("Origin") != s.config.PublicURL {
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	browser, err := s.session(r)
	if err != nil {
		http.Error(w, "Browser session required", http.StatusUnauthorized)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(4 << 20)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	authCtx, authCancel := context.WithTimeout(ctx, 5*time.Second)
	var hello bridgeMessage
	err = wsjson.Read(authCtx, conn, &hello)
	authCancel()
	if err != nil || hello.Type != "hello" || len(hello.DiagramID) == 0 || len(hello.DiagramID) > 100 {
		_ = conn.Close(websocket.StatusPolicyViolation, "Invalid browser handshake")
		return
	}
	p := &peer{conn: conn, browserID: browser.ID, diagramID: hello.DiagramID, done: make(chan struct{}), pending: make(map[string]chan bridgeMessage)}
	for _, capability := range hello.Capabilities {
		if capability == "hosted_exports_v1" {
			p.hostedExports = true
		}
	}
	if !s.bridge.attach(p) {
		_ = conn.Close(websocket.StatusTryAgainLater, "Waiting for the previous tab to disconnect.")
		return
	}
	defer s.bridge.detach(p)
	if err := wsjson.Write(ctx, conn, bridgeMessage{Type: "ready", DiagramID: p.diagramID}); err != nil {
		return
	}
	go func() {
		ticker := time.NewTicker(20 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if _, err := s.session(r); err != nil {
					_ = conn.Close(websocket.StatusPolicyViolation, "Browser session expired")
					cancel()
					return
				}
				pingCtx, pingCancel := context.WithTimeout(ctx, 10*time.Second)
				err := conn.Ping(pingCtx)
				pingCancel()
				if err != nil {
					cancel()
					_ = conn.CloseNow()
					return
				}
			}
		}
	}()
	for {
		var message bridgeMessage
		if err := wsjson.Read(ctx, conn, &message); err != nil {
			return
		}
		if message.Type != "result" || message.ID == "" {
			continue
		}
		s.bridge.mu.Lock()
		waiter := p.pending[message.ID]
		s.bridge.mu.Unlock()
		if waiter != nil {
			select {
			case waiter <- message:
			default:
			}
		}
	}
}

func publicError(err error) *toolError {
	var result *toolError
	if errors.As(err, &result) {
		return result
	}
	return &toolError{"internal_error", "The command could not be completed."}
}
