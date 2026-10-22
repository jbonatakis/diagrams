package server

import (
	"context"
	"net"
	"net/http"
	"sync"
)

// Exercise real HTTP, MCP and WebSocket transports over in-memory connections.
// Tests need neither free TCP ports nor network permissions.
type memoryListener struct {
	connections chan net.Conn
	done        chan struct{}
	once        sync.Once
}

func (l *memoryListener) Accept() (net.Conn, error) {
	select {
	case conn := <-l.connections:
		return conn, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}
func (l *memoryListener) Close() error   { l.once.Do(func() { close(l.done) }); return nil }
func (l *memoryListener) Addr() net.Addr { return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 80} }
func (l *memoryListener) dial(ctx context.Context, _, _ string) (net.Conn, error) {
	client, server := net.Pipe()
	select {
	case l.connections <- server:
		return client, nil
	case <-ctx.Done():
		_ = client.Close()
		_ = server.Close()
		return nil, ctx.Err()
	case <-l.done:
		_ = client.Close()
		_ = server.Close()
		return nil, net.ErrClosed
	}
}

type memoryHTTPServer struct {
	URL    string
	Client *http.Client
	server *http.Server
}

func newMemoryHTTPServer(handler http.Handler) *memoryHTTPServer {
	listener := &memoryListener{connections: make(chan net.Conn), done: make(chan struct{})}
	server := &http.Server{Handler: handler}
	go func() { _ = server.Serve(listener) }()
	return &memoryHTTPServer{
		URL:    testOrigin,
		Client: &http.Client{Transport: &http.Transport{DialContext: listener.dial}},
		server: server,
	}
}
func (s *memoryHTTPServer) Close() { s.Client.CloseIdleConnections(); _ = s.server.Close() }
