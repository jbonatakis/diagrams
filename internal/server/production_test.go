package server

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProductionAssetCaching(t *testing.T) {
	app, server := testServer(t, time.Second)
	assets := filepath.Join(app.config.StaticDir, "assets")
	if err := os.Mkdir(assets, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(assets, "index-abc123.js"), []byte("console.log('diagrams')"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		path, cache string
		status      int
	}{
		{"/", "no-cache", 200},
		{"/assets/index-abc123.js", "public, max-age=31536000, immutable", 200},
		{"/assets/missing.js", "no-cache", 404},
		{"/api/session", "no-store", 401},
		{"/healthz", "no-store", 200},
	} {
		t.Run(test.path, func(t *testing.T) {
			for _, method := range []string{http.MethodGet, http.MethodHead} {
				res, _ := httpCall(t, server, method, test.path, "", nil, nil)
				if res.StatusCode != test.status || res.Header.Get("Cache-Control") != test.cache {
					t.Fatalf("%s %s: status %d, cache %q", method, test.path, res.StatusCode, res.Header.Get("Cache-Control"))
				}
			}
		})
	}
}

func TestHealthReportsUnavailableDeployment(t *testing.T) {
	for _, unavailable := range []string{"frontend", "database"} {
		t.Run(unavailable, func(t *testing.T) {
			app, server := testServer(t, time.Second)
			// Docker probes the loopback listener; the site still enforces its Host.
			req, _ := http.NewRequest(http.MethodGet, server.URL+"/healthz", nil)
			req.Host = "127.0.0.1:8080"
			res, err := server.Client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			res.Body.Close()
			if res.StatusCode != 200 {
				t.Fatalf("container health probe: %d", res.StatusCode)
			}
			if unavailable == "frontend" {
				if err := os.Remove(filepath.Join(app.config.StaticDir, "index.html")); err != nil {
					t.Fatal(err)
				}
			} else {
				app.Close()
			}
			res, data := httpCall(t, server, "GET", "/healthz", "", nil, nil)
			if res.StatusCode != 503 || !strings.Contains(strings.ToLower(string(data)), unavailable) {
				t.Fatalf("unhealthy deployment reported success: %d %s", res.StatusCode, data)
			}
		})
	}
}
