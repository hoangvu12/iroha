package normalise

import "strings"

// Inline reasoning. DeepSeek, Qwen and MiniMax models (and the servers that
// host them without a reasoning parser) write their reasoning into the
// answer text as a leading <think>…</think> block. The tag names are the
// three liteLLM recognises.
var (
	openTags  = []string{"<think>", "<thinking>", "<budget:thinking>"}
	closeTags = []string{"</think>", "</thinking>", "</budget:thinking>"}
)

type splitPhase int

const (
	beforeText splitPhase = iota
	inReasoning
	afterReasoning
)

type leadingReasoningSplitter struct {
	phase                splitPhase
	maybeTag             string
	trimSpaceAfterReason bool
}

func (s *leadingReasoningSplitter) feed(text string) (reasoning, content string, acted bool) {
	switch s.phase {
	case afterReasoning:
		if !s.trimSpaceAfterReason {
			return "", text, false
		}
		t := strings.TrimLeft(text, " \t\r\n")
		if t != "" {
			s.trimSpaceAfterReason = false
		}
		return "", t, t != text
	case inReasoning:
		return s.inside(text)
	}
	buf := s.maybeTag + text
	hadMaybeTag := s.maybeTag != ""
	s.maybeTag = ""
	rest := strings.TrimLeft(buf, " \t\r\n")
	if rest == "" {
		return "", buf, hadMaybeTag
	}
	for _, tag := range openTags {
		if strings.HasPrefix(rest, tag) {
			s.phase = inReasoning
			r, c, _ := s.inside(rest[len(tag):])
			return r, c, true
		}
	}
	for _, tag := range openTags {
		if len(rest) < len(tag) && strings.HasPrefix(tag, rest) {
			s.maybeTag = buf
			return "", "", true
		}
	}
	s.phase = afterReasoning
	return "", buf, hadMaybeTag
}

func (s *leadingReasoningSplitter) inside(text string) (reasoning, content string, acted bool) {
	buf := s.maybeTag + text
	s.maybeTag = ""
	at, tagLen := -1, 0
	for _, tag := range closeTags {
		if i := strings.Index(buf, tag); i >= 0 && (at < 0 || i < at) {
			at, tagLen = i, len(tag)
		}
	}
	if at >= 0 {
		s.phase, s.trimSpaceAfterReason = afterReasoning, true
		_, content, _ = s.feed(buf[at+tagLen:])
		return buf[:at], content, true
	}
	if k := partialSuffix(buf, closeTags); k > 0 {
		s.maybeTag = buf[len(buf)-k:]
		buf = buf[:len(buf)-k]
	}
	return buf, "", true
}

func (s *leadingReasoningSplitter) flush() (reasoning, content string) {
	h := s.maybeTag
	s.maybeTag = ""
	if s.phase == inReasoning {
		return h, ""
	}
	return "", h
}

func (s *leadingReasoningSplitter) pending() bool { return s.maybeTag != "" }

func partialSuffix(text string, tags []string) int {
	best := 0
	for _, tag := range tags {
		for n := len(tag) - 1; n > best; n-- {
			if strings.HasSuffix(text, tag[:n]) {
				best = n
				break
			}
		}
	}
	return best
}
