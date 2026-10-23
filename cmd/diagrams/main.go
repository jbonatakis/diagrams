package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"diagrams/internal/server"
)

func main() {
	addr := env("DIAGRAMS_ADDR", "127.0.0.1:8787")
	if len(os.Args) > 1 {
		if len(os.Args) != 2 || os.Args[1] != "healthcheck" {
			log.Fatal("usage: diagrams [healthcheck]")
		}
		if err := healthcheck(addr); err != nil {
			log.Fatal(err)
		}
		return
	}
	app, err := server.New(server.Config{
		PublicURL:    env("DIAGRAMS_PUBLIC_URL", "http://localhost:5173"),
		DatabasePath: env("DIAGRAMS_DB", "data/pairings.db"),
		StaticDir:    env("DIAGRAMS_STATIC_DIR", "dist"),
	})
	if err != nil {
		log.Fatal(err)
	}
	defer app.Close()
	httpServer := &http.Server{
		Addr: addr, Handler: app.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	serveErrors := make(chan error, 1)
	go func() { serveErrors <- httpServer.ListenAndServe() }()
	log.Printf("Diagrams listening at http://%s; MCP endpoint /mcp", addr)
	select {
	case err := <-serveErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	case <-ctx.Done():
		// Wait for HTTP requests before closing the pairing database. Shutdown
		// does not wait for WebSockets; app.Close closes those afterward.
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdown); err != nil {
			log.Printf("HTTP shutdown: %v", err)
			_ = httpServer.Close()
		}
	}
}

// The image needs no shell or curl to check its own health. Always probe the
// listener directly, without proxy environment variables or redirects.
func healthcheck(addr string) error {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return err
	}
	if host == "" || host == "0.0.0.0" {
		host = "127.0.0.1"
	} else if host == "::" {
		host = "::1"
	}
	client := &http.Client{
		Timeout:       3 * time.Second,
		Transport:     &http.Transport{Proxy: nil},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	defer client.CloseIdleConnections()
	response, err := client.Get("http://" + net.JoinHostPort(host, port) + "/healthz")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("healthcheck: HTTP %d", response.StatusCode)
	}
	return nil
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
