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

// Phases of a splitter.
const (
	beforeText = iota // nothing but whitespace yet: a reasoning block may open
	inReasoning
	afterReasoning // the answer text: passed on unchanged
)

// splitter moves a reasoning block that opens one choice's text out of it,
// fed the text piece by piece as a stream delivers it (a whole answer is one
// piece). Only a block at the very start is lifted: a tag later in the text
// is the answer's own (a model explaining the tag, say).
type splitter struct {
	phase int
	// held is text kept back because it may be the start of a tag ("<thi").
	held string
	// trim: the block just closed; whitespace before the answer text is dropped.
	trim bool
}

// feed takes the next piece of text and returns the reasoning and answer
// text it holds; acted is false when the piece passes on unchanged as text.
func (s *splitter) feed(text string) (reasoning, content string, acted bool) {
	switch s.phase {
	case afterReasoning:
		if !s.trim {
			return "", text, false
		}
		t := strings.TrimLeft(text, " \t\r\n")
		if t != "" {
			s.trim = false
		}
		return "", t, t != text
	case inReasoning:
		return s.inside(text)
	}
	buf := s.held + text
	held := s.held != ""
	s.held = ""
	rest := strings.TrimLeft(buf, " \t\r\n")
	if rest == "" {
		return "", buf, held
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
			s.held = buf
			return "", "", true
		}
	}
	s.phase = afterReasoning
	return "", buf, held
}

// inside handles text within the reasoning block.
func (s *splitter) inside(text string) (reasoning, content string, acted bool) {
	buf := s.held + text
	s.held = ""
	at, tagLen := -1, 0
	for _, tag := range closeTags {
		if i := strings.Index(buf, tag); i >= 0 && (at < 0 || i < at) {
			at, tagLen = i, len(tag)
		}
	}
	if at >= 0 {
		s.phase, s.trim = afterReasoning, true
		_, content, _ = s.feed(buf[at+tagLen:])
		return buf[:at], content, true
	}
	if k := partialSuffix(buf, closeTags); k > 0 {
		s.held = buf[len(buf)-k:]
		buf = buf[:len(buf)-k]
	}
	return buf, "", true
}

// flush returns the text held back at the end of the answer: reasoning
// inside an unclosed block, answer text otherwise.
func (s *splitter) flush() (reasoning, content string) {
	h := s.held
	s.held = ""
	if s.phase == inReasoning {
		return h, ""
	}
	return "", h
}

// pending reports whether text is held back.
func (s *splitter) pending() bool { return s.held != "" }

// partialSuffix is the length of the longest end of text that begins one of
// tags without completing it.
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
