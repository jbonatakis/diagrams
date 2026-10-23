package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"testing"
	"time"

	"github.com/coder/websocket/wsjson"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func previewFixture(t *testing.T) (map[string]any, []byte) {
	t.Helper()
	drawing := image.NewRGBA(image.Rect(0, 0, 32, 24))
	drawing.Set(12, 12, color.RGBA{R: 100, G: 180, B: 120, A: 255})
	var out bytes.Buffer
	if err := png.Encode(&out, drawing); err != nil {
		t.Fatal(err)
	}
	return map[string]any{"diagramId": "preview", "revision": 3, "width": 32, "height": 24, "mimeType": "image/png", "data": base64.StdEncoding.EncodeToString(out.Bytes())}, out.Bytes()
}

func TestMCPPreviewReturnsNativeImageContent(t *testing.T) {
	for _, tool := range []string{"preview_diagram", "preview_custom_shapes"} {
		t.Run(tool, func(t *testing.T) {
			app, server := testServer(t, time.Second)
			identity := newBrowser(t, server)
			credentials := pair(t, app, server, identity)
			client := mcpClient(t, server, credentials.Access)
			browser := dialBrowser(t, server, identity, "preview")
			readReady(t, browser)
			fixture, expected := previewFixture(t)
			args := map[string]any{"diagramId": "preview"}
			if tool == "preview_custom_shapes" {
				args = map[string]any{"shapeIds": []string{"shape-one"}}
				delete(fixture, "diagramId")
				delete(fixture, "revision")
				fixture["shapes"] = []map[string]any{{"number": 1, "id": "shape-one", "name": "Server"}}
			}
			raw, _ := json.Marshal(fixture)
			go func() {
				var message bridgeMessage
				if wsjson.Read(context.Background(), browser, &message) != nil {
					return
				}
				_ = wsjson.Write(context.Background(), browser, bridgeMessage{Type: "result", ID: message.ID, Result: raw})
			}()
			result, err := client.CallTool(context.Background(), &mcp.CallToolParams{Name: tool, Arguments: args})
			if err != nil || result.IsError {
				t.Fatalf("preview: %+v, %v", result, err)
			}
			if len(result.Content) != 2 {
				t.Fatalf("expected metadata and image, got %d content blocks", len(result.Content))
			}
			content, ok := result.Content[1].(*mcp.ImageContent)
			if !ok || content.MIMEType != "image/png" || !bytes.Equal(content.Data, expected) {
				t.Fatal("MCP did not preserve image bytes")
			}
			metadata, _ := json.Marshal(result.StructuredContent)
			if bytes.Contains(metadata, []byte(`"data"`)) || bytes.Contains([]byte(result.Content[0].(*mcp.TextContent).Text), []byte(fixture["data"].(string))) {
				t.Fatal("image data was duplicated into text/metadata")
			}
		})
	}
}

func TestInvalidBrowserPreviewsAreNotForwarded(t *testing.T) {
	for _, field := range []string{"data", "mimeType", "width", "height"} {
		t.Run(field, func(t *testing.T) {
			fixture, _ := previewFixture(t)
			fixture[field] = "invalid"
			raw, _ := json.Marshal(fixture)
			for _, tool := range []string{"preview_diagram", "preview_custom_shapes"} {
				if !browserToolResult(tool, raw).IsError {
					t.Fatalf("accepted invalid preview for %s", tool)
				}
			}
		})
	}
}
