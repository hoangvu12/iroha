package gateway

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/shape"
)

// A Gemini request names its model and whether it streams in the URL, not
// the body:
//
//	POST .../v1beta/models/{model}:generateContent
//	POST .../v1beta/models/{model}:streamGenerateContent?alt=sse
//
// The Google SDKs stream with alt=sse.

const (
	geminiGenerate = "generateContent"
	geminiStream   = "streamGenerateContent"
)

type GenerateContentRequest struct {
	Contents          []map[string]any `json:"contents"`
	SystemInstruction map[string]any   `json:"systemInstruction,omitempty"`
	Tools             []map[string]any `json:"tools,omitempty"`
	GenerationConfig  map[string]any   `json:"generationConfig,omitempty"`
}

const geminiDescription = "Gemini generateContent: POST /providers/{handle}/v1beta/models/{model}:generateContent, or :streamGenerateContent for a stream " +
	"(always server-sent events, as with ?alt=sse). The model is the path segment(s) between models/ and the colon and may contain slashes. " +
	"Authenticate with \"x-goog-api-key: <Gateway Key>\" (the Google SDKs' header), the ?key=<Gateway Key> query parameter, or \"Authorization: Bearer <Gateway Key>\"; " +
	"Caller credentials (the key parameter included) are never forwarded. On an Endpoint speaking Gemini the body passes through unchanged and the model goes in the upstream URL; " +
	"answers pass through with modelVersion set to the model you asked for. " + translationNote +
	"Errors use Google's envelope {\"error\":{\"code\":<HTTP status>,\"message\",\"status\":\"INVALID_ARGUMENT\"...,\"reason\":<Iroha code>,\"hint\",\"request_id\"}}. " +
	"A stream with no upstream byte after 10 s is committed (200; an empty-text chunk every 15 s of silence keeps it open); failures after that arrive as a final data: {\"error\": ...} event."

func (g *Gateway) geminiRoute() api.Route {
	return api.Route{
		Method: http.MethodPost, Path: "/providers/{handle}/v1beta/models/{model...}", Tag: "Gateway", Auth: api.AuthCaller,
		Summary:     "Send a Gemini generateContent or streamGenerateContent request to one Provider",
		Description: geminiDescription,
		Request:     GenerateContentRequest{}, Response: map[string]any{},
		Raw: g.serveProvider(shape.Gemini),
	}
}

func readGeminiTarget(r *http.Request, cr *callerRequest) *api.Error {
	rest := r.PathValue("model")
	i := strings.LastIndex(rest, ":")
	method := ""
	if i >= 0 {
		method = rest[i+1:]
		rest = rest[:i]
	}
	switch method {
	case geminiGenerate:
	case geminiStream:
		cr.stream = true
	default:
		return api.Errorf(http.StatusNotFound, "operation_not_supported",
			"POST .../models/{model}:generateContent, or :streamGenerateContent for a stream.",
			"Iroha serves Gemini generateContent and streamGenerateContent, not %q.", method)
	}
	cr.modelAsWritten = rest
	cr.model = strings.TrimSpace(rest)
	if cr.model == "" {
		return api.Errorf(http.StatusBadRequest, "model_required", specOrChat(shape.Gemini).bodyHint, "The URL names no model.")
	}
	return nil
}

func geminiOp(model string, stream bool) string {
	segs := strings.Split(model, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	op := "/models/" + strings.Join(segs, "/") + ":"
	if stream {
		return op + geminiStream + "?alt=sse"
	}
	return op + geminiGenerate
}

func echoModelVersion(obj []byte, model string) []byte {
	raw, ok := field(obj, "modelVersion")
	if !ok || len(raw) == 0 || raw[0] != '"' {
		return obj
	}
	var cur string
	if json.Unmarshal(raw, &cur) != nil || cur == model {
		return obj
	}
	out, _ := setField(obj, "modelVersion", jsonString(model))
	return out
}

// The Google SDKs parse every non-empty line that is not data as JSON, so an
// SSE comment breaks them; a chunk with an empty text adds no text.
type geminiStreamShape struct{}

func (geminiStreamShape) keepAlive() []byte {
	return []byte(`data: {"candidates":[{"content":{"role":"model","parts":[{"text":""}]},"index":0}]}` + "\n\n")
}

func (geminiStreamShape) errorEvent(e *api.Error, requestID string) []byte {
	return append(append([]byte("data: "), compactJSON(geminiError(e, requestID))...), "\n\n"...)
}

// In Google's error envelope code is the HTTP status and status its gRPC
// name; the Google SDKs read both.
func geminiError(e *api.Error, requestID string) map[string]any {
	inner := map[string]any{
		"code":       e.Status,
		"message":    e.Message,
		"status":     geminiStatus(e.Status),
		"reason":     e.Code,
		"hint":       e.Hint,
		"request_id": requestID,
		"details": []any{map[string]any{
			"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": e.Code, "domain": "iroha",
			"metadata": map[string]string{"request_id": requestID},
		}},
	}
	if e.Details != nil {
		inner["iroha_details"] = e.Details
	}
	return map[string]any{"error": inner}
}

func geminiStatus(status int) string {
	switch {
	case status == http.StatusUnauthorized:
		return "UNAUTHENTICATED"
	case status == http.StatusForbidden:
		return "PERMISSION_DENIED"
	case status == http.StatusNotFound:
		return "NOT_FOUND"
	case status == http.StatusConflict:
		return "ABORTED"
	case status == http.StatusTooManyRequests:
		return "RESOURCE_EXHAUSTED"
	case status == 499:
		return "CANCELLED"
	case status == http.StatusNotImplemented:
		return "UNIMPLEMENTED"
	case status == http.StatusBadGateway || status == http.StatusServiceUnavailable:
		return "UNAVAILABLE"
	case status == http.StatusGatewayTimeout:
		return "DEADLINE_EXCEEDED"
	case status >= 500:
		return "INTERNAL"
	}
	return "INVALID_ARGUMENT"
}
