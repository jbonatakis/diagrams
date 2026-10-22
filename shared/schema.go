// Package shared contains the tool contract consumed by both Go and the browser.
package shared

import _ "embed"

//go:embed tools.json
var ToolsJSON []byte
