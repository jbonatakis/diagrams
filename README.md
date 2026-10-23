# Diagrams

A browser-based diagram editor that people and AI agents can use together. Built with React, Excalidraw, and Go, with an MCP interface for agent tools.

![High-level architecture: AI agents call the Go service through MCP; the service connects to the browser editor over WebSocket. The browser stores diagrams in IndexedDB, while the service stores pairings and export metadata in SQLite. Exports transfer directly between the browser and Cloudflare R2.](docs/architecture.svg)

Diagrams, images, and custom shapes stay in the browser's local library. The Go service handles agent pairing, authorization, and tool routing. It signs temporary export links and redirects downloads to a private R2 bucket; file bytes travel directly to and from R2.

[Editable Excalidraw source](docs/architecture.excalidraw)
