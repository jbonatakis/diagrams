package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"diagrams/internal/server"
)

func main() {
	addr := env("DIAGRAMS_ADDR", "127.0.0.1:8787")
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
	go func() {
		<-ctx.Done()
		app.Close()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
	}()
	log.Printf("Diagrams listening at http://%s; MCP endpoint /mcp", addr)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
