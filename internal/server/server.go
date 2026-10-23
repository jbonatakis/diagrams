package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"diagrams/shared"
	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type Config struct {
	PublicURL      string
	DatabasePath   string
	StaticDir      string
	CommandTimeout time.Duration
	R2Endpoint     string
	R2Bucket       string
	R2AccessKey    string
	R2SecretKey    string
	DownloadKey    []byte
	R2Enabled      bool
	R2Verified     bool
}

type Server struct {
	config    Config
	db        *sql.DB
	limits    windowLimiter
	stop      chan struct{}
	done      chan struct{}
	closeOnce sync.Once
	bridge    bridge
	mux       *http.ServeMux
	exports   *hostedExports
}

func New(config Config) (*Server, error) {
	config.PublicURL = strings.TrimSuffix(config.PublicURL, "/")
	u, err := url.Parse(config.PublicURL)
	if err != nil || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && !(u.Scheme == "http" && loopback(u.Hostname()))) {
		return nil, fmt.Errorf("DIAGRAMS_PUBLIC_URL must be an HTTPS origin, or HTTP on loopback for local development")
	}
	db, err := openIdentityStore(config.DatabasePath, config.PublicURL)
	if err != nil {
		return nil, fmt.Errorf("open pairing database: %w", err)
	}
	if config.CommandTimeout == 0 {
		config.CommandTimeout = 10 * time.Second
	}
	s := &Server{config: config, db: db, mux: http.NewServeMux(), stop: make(chan struct{}), done: make(chan struct{})}
	if config.R2Enabled || config.R2Verified {
		if !config.R2Verified || len(config.DownloadKey) < 32 {
			log.Print("hosted exports remain disabled until R2 enforcement is verified and a download signing key is configured")
		} else {
			storage, storageErr := newR2Storage(config.R2Endpoint, config.R2Bucket, config.R2AccessKey, config.R2SecretKey)
			if storageErr != nil {
				log.Print("hosted exports remain disabled because the R2 configuration is incomplete")
			} else {
				s.exports = &hostedExports{server: s, storage: storage, key: append([]byte(nil), config.DownloadKey...), creationDisabled: !config.R2Enabled}
			}
		}
	}
	mcpServer := mcp.NewServer(&mcp.Implementation{Name: "diagrams", Version: "0.1.0"}, &mcp.ServerOptions{
		Instructions: "Manage the connected browser's local diagram library. Discover imported templates with list_custom_shapes (includes names when available). Use preview_custom_shapes to inspect icons before inserting with insert_custom_shape. create_shape only makes rectangles, ellipses and diamonds. Call get_diagram before edits; pass its diagramId and revision. List before opening or managing diagrams. Edits autosave to browser IndexedDB, never the server. Use a fresh requestId for each edit batch; retry only with identical arguments and ID. Preview diagrams to inspect layout. fit_canvas changes the browser viewport. A batch is one undo step; switching diagrams clears undo. Import/export tools support chunked files in browser memory; hosted exports upload directly to temporary Cloudflare R2 storage when enabled. Never blindly retry a timed-out write: inspect the diagram/library first. The browser must stay connected.",
	})
	var definitions map[string]struct {
		Description string          `json:"description"`
		InputSchema json.RawMessage `json:"inputSchema"`
	}
	if err := json.Unmarshal(shared.ToolsJSON, &definitions); err != nil {
		panic(err)
	}
	for name, definition := range definitions {
		openWorld := name == "export_diagram" || name == "export_library"
		mcpServer.AddTool(&mcp.Tool{
			Name: name, Description: definition.Description, InputSchema: definition.InputSchema,
			Annotations: &mcp.ToolAnnotations{ReadOnlyHint: name == "get_diagram" || name == "list_diagrams" || name == "list_custom_shapes" || name == "preview_custom_shapes" || name == "get_export" || name == "read_export" || name == "preview_diagram", OpenWorldHint: &openWorld},
		}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			args := req.Params.Arguments
			if len(args) == 0 {
				args = json.RawMessage(`{}`)
			}
			if req.Extra == nil || req.Extra.TokenInfo == nil {
				return nil, fmt.Errorf("missing authorization context")
			}
			var input map[string]any
			if name == "export_diagram" || name == "export_library" || name == "get_export" || name == "cancel_export" {
				if err := json.Unmarshal(args, &input); err != nil {
					return nil, err
				}
				if input["delivery"] == "download" || name == "get_export" || name == "cancel_export" {
					if s.exports == nil {
						return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: `{"code":"hosted_exports_unavailable","message":"Hosted exports are not configured; use the local chunked export instead."}`}}}, nil
					}
					grant, _ := req.Extra.TokenInfo.Extra["grant"].(string)
					var result *mcp.CallToolResult
					var err error
					if name == "get_export" || name == "cancel_export" {
						result, err = s.exports.agentTool(ctx, req.Extra.TokenInfo.UserID, grant, name, input)
					} else {
						result, err = s.exports.start(ctx, req.Extra.TokenInfo.UserID, grant, name, input)
					}
					if err != nil {
						data, _ := json.Marshal(publicError(err))
						return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: string(data)}}}, nil
					}
					return result, nil
				}
				// Legacy browsers do not know the hosted-only arguments.
				delete(input, "delivery")
				delete(input, "requestId")
				var err error
				args, err = json.Marshal(input)
				if err != nil {
					return nil, err
				}
			}
			result, err := s.bridge.call(ctx, req.Extra.TokenInfo.UserID, name, args, s.config.CommandTimeout)
			if err != nil {
				data, _ := json.Marshal(publicError(err))
				return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: string(data)}}}, nil
			}
			return browserToolResult(name, result), nil
		})
	}
	mcpHandler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return mcpServer }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true})
	s.mux.Handle("/mcp", s.authenticate(mcpHandler))
	s.mux.HandleFunc("GET /.well-known/oauth-protected-resource", s.resourceMetadata)
	s.mux.HandleFunc("GET /.well-known/oauth-protected-resource/mcp", s.resourceMetadata)
	s.mux.HandleFunc("GET /.well-known/oauth-authorization-server", s.oauthMetadata)
	s.mux.HandleFunc("POST /oauth/register", s.registerClient)
	s.mux.HandleFunc("GET /oauth/authorize", s.authorize)
	s.mux.HandleFunc("POST /oauth/approve", s.approve)
	s.mux.HandleFunc("POST /oauth/token", s.token)
	s.mux.HandleFunc("POST /oauth/revoke", s.revokeToken)
	s.mux.HandleFunc("POST /api/session", s.serveSession)
	s.mux.HandleFunc("GET /api/session", s.restoreSession)
	s.mux.HandleFunc("GET /api/agents", s.serveAgents)
	s.mux.HandleFunc("POST /api/agents/{id}/revoke", s.revokeAgent)
	s.mux.HandleFunc("POST /api/forget", s.forgetBrowser)
	s.mux.HandleFunc("GET /api/bridge", s.serveBridge)
	s.mux.HandleFunc("GET /healthz", s.health)
	if s.exports != nil {
		s.exports.routes(s.mux)
	} else {
		notFound := func(w http.ResponseWriter, _ *http.Request) { http.Error(w, "Not found", http.StatusNotFound) }
		s.mux.HandleFunc("GET /export/{id}", notFound)
		s.mux.HandleFunc("POST /api/exports/{id}/captured", notFound)
		s.mux.HandleFunc("POST /api/exports/{id}/upload", notFound)
		s.mux.HandleFunc("POST /api/exports/{id}/complete", notFound)
		s.mux.HandleFunc("POST /api/exports/{id}/failed", notFound)
	}
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
			// Vite puts content hashes in these filenames. Cache only files that
			// exist, so a missing asset from a previous deploy is never cached.
			asset := path.Clean(r.URL.Path)
			if strings.HasPrefix(asset, "/assets/") {
				if info, err := os.Stat(filepath.Join(config.StaticDir, asset)); err != nil || !info.Mode().IsRegular() {
					http.NotFound(w, r)
					return
				}
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			files.ServeHTTP(w, r)
		})
	}
	s.pruneIdentities()
	if s.exports != nil {
		if err := s.exports.startWorker(); err != nil {
			db.Close()
			return nil, err
		}
	}
	go func() {
		defer close(s.done)
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-s.stop:
				return
			case <-ticker.C:
				s.pruneIdentities()
			}
		}
	}()
	return s, nil
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.db.PingContext(ctx); err != nil {
		http.Error(w, "Pairing database unavailable", http.StatusServiceUnavailable)
		return
	}
	if s.config.StaticDir != "" {
		if info, err := os.Stat(filepath.Join(s.config.StaticDir, "index.html")); err != nil || !info.Mode().IsRegular() {
			http.Error(w, "Frontend unavailable", http.StatusServiceUnavailable)
			return
		}
	}
	jsonReply(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		public, _ := url.Parse(s.config.PublicURL)
		if r.URL.Path != "/healthz" && r.Host != public.Host {
			http.Error(w, "Use the configured public address.", http.StatusMisdirectedRequest)
			return
		}
		if len(r.RequestURI) > 8192 {
			http.Error(w, "Request URL too long.", http.StatusRequestURITooLong)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/oauth/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		s.mux.ServeHTTP(w, r)
	})
}

func (s *Server) Close() {
	s.closeOnce.Do(func() {
		close(s.stop)
		<-s.done
		s.bridge.close()
		if s.exports != nil {
			s.exports.close()
		}
		_ = s.db.Close()
	})
}

func (s *Server) authenticate(next http.Handler) http.Handler {
	protected := auth.RequireBearerToken(s.verifyAccess, &auth.RequireBearerTokenOptions{
		ResourceMetadataURL: s.config.PublicURL + "/.well-known/oauth-protected-resource", Scopes: []string{agentScope},
	})(next)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" && origin != s.config.PublicURL {
			http.Error(w, "origin not allowed", http.StatusForbidden)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
		protected.ServeHTTP(w, r)
	})
}
