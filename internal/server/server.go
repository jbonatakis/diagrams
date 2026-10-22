package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"time"

	"diagrams/shared"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type Config struct {
	Token          string
	Origins        []string
	StaticDir      string
	CommandTimeout time.Duration
}

type Server struct {
	config    Config
	tokenHash [32]byte
	bridge    bridge
	mux       *http.ServeMux
}

func New(config Config) *Server {
	if config.CommandTimeout == 0 {
		config.CommandTimeout = 10 * time.Second
	}
	s := &Server{config: config, tokenHash: sha256.Sum256([]byte(config.Token)), mux: http.NewServeMux()}
	mcpServer := mcp.NewServer(&mcp.Implementation{Name: "diagrams", Version: "0.1.0"}, &mcp.ServerOptions{
		Instructions: "Edit the one connected browser diagram. Call get_diagram before apply_operations; use the returned diagramId and revision. Use stable element IDs. A batch is one undo step. Never blindly retry a timed-out write: read the diagram first. Phase 1 stores diagrams only in browser memory; reload clears them. The browser must remain connected.",
	})
	var definitions map[string]struct {
		Description string          `json:"description"`
		InputSchema json.RawMessage `json:"inputSchema"`
	}
	if err := json.Unmarshal(shared.ToolsJSON, &definitions); err != nil {
		panic(err)
	}
	closedWorld := false
	for name, definition := range definitions {
		mcpServer.AddTool(&mcp.Tool{
			Name: name, Description: definition.Description, InputSchema: definition.InputSchema,
			Annotations: &mcp.ToolAnnotations{ReadOnlyHint: name == "get_diagram", OpenWorldHint: &closedWorld},
		}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			args := req.Params.Arguments
			if len(args) == 0 {
				args = json.RawMessage(`{}`)
			}
			result, err := s.bridge.call(ctx, name, args, s.config.CommandTimeout)
			if err != nil {
				data, _ := json.Marshal(publicError(err))
				return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: string(data)}}}, nil
			}
			var structured any
			if err := json.Unmarshal(result, &structured); err != nil {
				return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: "Invalid browser response"}}}, nil
			}
			return &mcp.CallToolResult{StructuredContent: structured, Content: []mcp.Content{&mcp.TextContent{Text: string(result)}}}, nil
		})
	}
	mcpHandler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return mcpServer }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true})
	s.mux.Handle("/mcp", s.authenticate(mcpHandler))
	s.mux.HandleFunc("GET /api/bridge", s.serveBridge)
	s.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	s.mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	if config.StaticDir != "" {
		files := http.FileServer(http.Dir(config.StaticDir))
		s.mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				w.Header().Set("Allow", "GET, HEAD")
				http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
				return
			}
			if _, err := os.Stat(config.StaticDir + "/index.html"); err != nil {
				http.Error(w, "Frontend not built. Run npm run dev, or npm run build before starting this service.", http.StatusServiceUnavailable)
				return
			}
			w.Header().Set("Cache-Control", "no-cache")
			files.ServeHTTP(w, r)
		})
	}
	return s
}

func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		s.mux.ServeHTTP(w, r)
	})
}

func (s *Server) Close() { s.bridge.close() }

func (s *Server) validToken(token string) bool {
	actual := sha256.Sum256([]byte(token))
	return token != "" && subtle.ConstantTimeCompare(actual[:], s.tokenHash[:]) == 1
}

func (s *Server) originAllowed(origin string) bool {
	for _, allowed := range s.config.Origins {
		if origin == strings.TrimSpace(allowed) {
			return true
		}
	}
	return false
}

func (s *Server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" && !s.originAllowed(origin) {
			http.Error(w, "origin not allowed", http.StatusForbidden)
			return
		}
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") || !s.validToken(strings.TrimPrefix(auth, "Bearer ")) {
			w.Header().Set("WWW-Authenticate", `Bearer realm="diagrams"`)
			http.Error(w, "a valid bearer token is required", http.StatusUnauthorized)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 256<<10)
		next.ServeHTTP(w, r)
	})
}
