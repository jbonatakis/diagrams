package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"diagrams/internal/server"
)

func main() {
	token := os.Getenv("DIAGRAMS_TOKEN")
	if len(token) < 32 || strings.HasPrefix(token, "replace-with") {
		log.Fatal("DIAGRAMS_TOKEN must be a private token of at least 32 characters; npm run dev creates one in .env")
	}
	addr := env("DIAGRAMS_ADDR", "127.0.0.1:8787")
	app := server.New(server.Config{
		Token:     token,
		Origins:   strings.Split(env("DIAGRAMS_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:8787,http://localhost:8787"), ","),
		StaticDir: env("DIAGRAMS_STATIC_DIR", "dist"),
	})
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
