package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	_ "image/jpeg"
	_ "image/png"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Images are transient browser responses, just like diagram JSON. Send binary
// image content to the agent rather than duplicating base64 into text/metadata.
func browserToolResult(tool string, raw json.RawMessage) *mcp.CallToolResult {
	invalid := func() *mcp.CallToolResult {
		return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: "Invalid browser response"}}}
	}
	var structured map[string]any
	if json.Unmarshal(raw, &structured) != nil {
		return invalid()
	}
	if tool != "preview_diagram" && tool != "preview_custom_shapes" {
		return &mcp.CallToolResult{StructuredContent: structured, Content: []mcp.Content{&mcp.TextContent{Text: string(raw)}}}
	}
	encoded, ok := structured["data"].(string)
	if !ok || len(encoded) > 2_000_000 {
		return invalid()
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return invalid()
	}
	config, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width < 1 || config.Height < 1 || config.Width > 1600 || config.Height > 1600 || (format != "png" && format != "jpeg") {
		return invalid()
	}
	mime := "image/" + format
	if structured["mimeType"] != mime || structured["width"] != float64(config.Width) || structured["height"] != float64(config.Height) {
		return invalid()
	}
	delete(structured, "data")
	metadata, _ := json.Marshal(structured)
	return &mcp.CallToolResult{StructuredContent: structured, Content: []mcp.Content{
		&mcp.TextContent{Text: string(metadata)},
		&mcp.ImageContent{Data: data, MIMEType: mime},
	}}
}
