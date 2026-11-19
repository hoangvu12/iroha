package testchat

import (
	"encoding/json"
	"fmt"
	"hash/fnv"
	"math"
	"net/url"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata" // get_time answers for any IANA zone, whatever the host has installed
	"unicode"
)

// How Iroha answers each test tool. Every answer is a JSON object (Gemini's
// functionResponse needs one); a call it cannot answer gets {"error": ...},
// as a real tool would say so.

// toolAnswer is the result of one call, made up (or computed) by Iroha.
func toolAnswer(c ToolCall, now time.Time) obj {
	t := toolNamed(c.Name)
	if t == nil {
		return obj{{"error", "No tool named " + c.Name + " is offered."}}
	}
	var a map[string]any
	_ = json.Unmarshal(args(c), &a)
	if a == nil {
		a = map[string]any{}
	}
	return t.answer(a, now)
}

func argString(a map[string]any, k string) string {
	s, _ := a[k].(string)
	return strings.TrimSpace(s)
}

func weather(a map[string]any, _ time.Time) obj {
	city := argString(a, "city")
	if city == "" {
		city = "Hanoi"
	}
	return obj{{"city", city}, {"temperature_c", 24}, {"conditions", "partly cloudy"}, {"wind", "light east wind"}}
}

func clockTime(a map[string]any, now time.Time) obj {
	tz := argString(a, "timezone")
	if tz == "" {
		tz = "UTC"
	}
	loc, err := time.LoadLocation(tz)
	if err != nil || tz == "Local" {
		return obj{{"timezone", tz}, {"error", "Unknown time zone; use an IANA name such as Europe/Paris or UTC."}}
	}
	t := now.In(loc)
	return obj{{"timezone", tz}, {"datetime", t.Format(time.RFC3339)}, {"date", t.Format("2006-01-02")}, {"time", t.Format("15:04:05")},
		{"weekday", t.Weekday().String()}, {"utc_offset", t.Format("-07:00")}}
}

func calculation(a map[string]any, _ time.Time) obj {
	expr := argString(a, "expression")
	v, err := evaluate(expr)
	if err != nil {
		return obj{{"expression", expr}, {"error", err.Error()}}
	}
	return obj{{"expression", expr}, {"result", number(v)}}
}

// number writes whole results without a fraction.
func number(v float64) any {
	if v == math.Trunc(v) && math.Abs(v) < 1e15 {
		return int64(v)
	}
	return v
}

// hashOf is a stable number for made-up but repeatable answers.
func hashOf(s string) uint32 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(strings.ToLower(s)))
	return h.Sum32()
}

func slug(s string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			dash = false
		} else if !dash && b.Len() > 0 {
			b.WriteByte('-')
			dash = true
		}
	}
	return strings.TrimSuffix(b.String(), "-")
}

func webSearch(a map[string]any, now time.Time) obj {
	q := argString(a, "query")
	if q == "" {
		return obj{{"query", q}, {"error", "Give a query."}}
	}
	n := 3
	if f, ok := a["max_results"].(float64); ok && f >= 1 {
		n = min(int(f), 5)
	}
	s := slug(q)
	all := []any{
		obj{{"title", q + " - Encyclopedia"}, {"url", "https://encyclopedia.example.org/wiki/" + s}, {"snippet", "An overview of " + q + ": background, key facts and further reading."}},
		obj{{"title", "A practical guide to " + q}, {"url", "https://guides.example.com/" + s}, {"snippet", "Step by step: what " + q + " is, how it works, and common mistakes to avoid."}},
		obj{{"title", fmt.Sprintf("What's new with %s in %d", q, now.Year())}, {"url", fmt.Sprintf("https://news.example.net/%d/%s", now.Year(), s)}, {"snippet", "The latest developments around " + q + ", updated " + now.Format("January 2, 2006") + "."}},
		obj{{"title", q + " explained in five minutes"}, {"url", "https://blog.example.dev/" + s + "-explained"}, {"snippet", "A short, plain-language explanation of " + q + " with examples."}},
		obj{{"title", "Questions about " + q}, {"url", "https://forum.example.org/t/" + s}, {"snippet", "Answers from people who use " + q + " every day."}},
	}
	return obj{{"query", q}, {"results", all[:n]}}
}

func page(a map[string]any, now time.Time) obj {
	raw := argString(a, "url")
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return obj{{"url", raw}, {"error", "Not an http or https URL."}}
	}
	topic := strings.Trim(u.Path, "/")
	if i := strings.LastIndex(topic, "/"); i >= 0 {
		topic = topic[i+1:]
	}
	topic = strings.TrimSuffix(strings.TrimSuffix(topic, ".html"), ".htm")
	topic = strings.Join(strings.FieldsFunc(topic, func(r rune) bool { return r == '-' || r == '_' || r == '+' }), " ")
	if topic == "" {
		topic = u.Hostname()
	}
	title := strings.ToUpper(topic[:1]) + topic[1:]
	text := title + "\n\n" +
		"This page covers " + topic + ": what it is, why it matters and how to get started. " +
		"The first section gives a short history, the second walks through a worked example, and the last lists answers to common questions.\n\n" +
		"Last updated " + now.AddDate(0, 0, -int(hashOf(raw)%30)-1).Format("January 2, 2006") + "."
	return obj{{"url", u.String()}, {"status", 200}, {"content_type", "text/html; charset=utf-8"}, {"title", title}, {"text", text}}
}

var (
	orderStatuses = []string{"processing", "shipped", "out_for_delivery", "delivered"}
	orderItems    = []struct {
		sku, name string
		cents     int
	}{
		{"KB-201", "Mechanical keyboard", 8900},
		{"MS-114", "Wireless mouse", 2950},
		{"HD-330", "Noise-cancelling headphones", 15900},
		{"CB-007", "USB-C cable, 2 m", 1290},
		{"MN-270", "27-inch monitor", 24900},
		{"ST-052", "Laptop stand", 3490},
	}
	orderPeople = []struct{ name, email, city, country string }{
		{"Linh Nguyen", "linh.nguyen@example.com", "Hanoi", "VN"},
		{"Sam Carter", "sam.carter@example.com", "Austin", "US"},
		{"Aiko Tanaka", "aiko.tanaka@example.com", "Osaka", "JP"},
		{"Lena Fischer", "lena.fischer@example.com", "Hamburg", "DE"},
	}
)

func order(a map[string]any, now time.Time) obj {
	id := argString(a, "order_id")
	if id == "" {
		return obj{{"error", "Give an order_id."}}
	}
	h := hashOf(id)
	who := orderPeople[h%uint32(len(orderPeople))]
	status := orderStatuses[(h>>3)%uint32(len(orderStatuses))]
	placed := now.Add(-time.Duration(1+(h>>5)%9) * 24 * time.Hour).Truncate(time.Minute)
	var items []any
	total := 0
	for i := range 1 + int((h>>9)%3) {
		it := orderItems[(int(h>>12)+i*2)%len(orderItems)]
		qty := 1 + int((h>>(15+uint(i)))%2)
		total += qty * it.cents
		items = append(items, obj{{"sku", it.sku}, {"name", it.name}, {"quantity", qty}, {"unit_price", cents(it.cents)}})
	}
	shipping := obj{{"carrier", "Example Express"}, {"tracking_number", fmt.Sprintf("EX%010d", uint64(h)*7919%10_000_000_000)}, {"status", status},
		{"address", obj{{"name", who.name}, {"city", who.city}, {"country", who.country}}}}
	if status != "processing" {
		shipping = append(shipping, kv{"shipped_at", placed.Add(26 * time.Hour).UTC().Format(time.RFC3339)})
	}
	return obj{{"order_id", id}, {"status", status}, {"placed_at", placed.UTC().Format(time.RFC3339)},
		{"customer", obj{{"name", who.name}, {"email", who.email}}}, {"items", items}, {"shipping", shipping},
		{"total", obj{{"amount", cents(total)}, {"currency", "USD"}}}}
}

// cents writes an amount of cents as a decimal number of dollars.
func cents(c int) any { return number(float64(c) / 100) }

// ---- calculate ----------------------------------------------------------------

// evaluate computes an arithmetic expression: numbers, + - * / % ^ (or **),
// parentheses, unary signs, the constants pi and e, and sqrt, abs, round,
// floor, ceil, min, max.
func evaluate(s string) (float64, error) {
	if strings.TrimSpace(s) == "" {
		return 0, fmt.Errorf("Give an expression.")
	}
	p := &parser{s: strings.NewReplacer("×", "*", "÷", "/", "**", "^").Replace(s)}
	v, err := p.expr()
	if err != nil {
		return 0, err
	}
	p.space()
	if p.i < len(p.s) {
		return 0, fmt.Errorf("Unexpected %q at position %d.", p.s[p.i:p.i+1], p.i+1)
	}
	if math.IsInf(v, 0) || math.IsNaN(v) {
		return 0, fmt.Errorf("The result is not a finite number.")
	}
	return v, nil
}

type parser struct {
	s string
	i int
}

func (p *parser) space() {
	for p.i < len(p.s) && (p.s[p.i] == ' ' || p.s[p.i] == '\t' || p.s[p.i] == '\n') {
		p.i++
	}
}

func (p *parser) peek() byte {
	p.space()
	if p.i < len(p.s) {
		return p.s[p.i]
	}
	return 0
}

func (p *parser) expr() (float64, error) {
	v, err := p.term()
	for err == nil {
		switch p.peek() {
		case '+', '-':
			op := p.s[p.i]
			p.i++
			var r float64
			if r, err = p.term(); op == '+' {
				v += r
			} else {
				v -= r
			}
		default:
			return v, nil
		}
	}
	return 0, err
}

func (p *parser) term() (float64, error) {
	v, err := p.unary()
	for err == nil {
		op := p.peek()
		if op != '*' && op != '/' && op != '%' {
			return v, nil
		}
		p.i++
		var r float64
		if r, err = p.unary(); err != nil {
			break
		}
		if op != '*' && r == 0 {
			return 0, fmt.Errorf("Division by zero.")
		}
		switch op {
		case '*':
			v *= r
		case '/':
			v /= r
		default:
			v = math.Mod(v, r)
		}
	}
	return 0, err
}

func (p *parser) unary() (float64, error) {
	switch p.peek() {
	case '-':
		p.i++
		v, err := p.unary()
		return -v, err
	case '+':
		p.i++
		return p.unary()
	}
	return p.power()
}

func (p *parser) power() (float64, error) {
	base, err := p.primary()
	if err != nil || p.peek() != '^' {
		return base, err
	}
	p.i++
	exp, err := p.unary() // right-associative: 2^3^2 = 2^9
	return math.Pow(base, exp), err
}

var functions = map[string]func(...float64) (float64, error){
	"sqrt": one(func(x float64) (float64, error) {
		if x < 0 {
			return 0, fmt.Errorf("sqrt of a negative number.")
		}
		return math.Sqrt(x), nil
	}),
	"abs":   one(func(x float64) (float64, error) { return math.Abs(x), nil }),
	"round": one(func(x float64) (float64, error) { return math.Round(x), nil }),
	"floor": one(func(x float64) (float64, error) { return math.Floor(x), nil }),
	"ceil":  one(func(x float64) (float64, error) { return math.Ceil(x), nil }),
	"min":   fold(math.Min),
	"max":   fold(math.Max),
}

func one(f func(float64) (float64, error)) func(...float64) (float64, error) {
	return func(xs ...float64) (float64, error) {
		if len(xs) != 1 {
			return 0, fmt.Errorf("Takes one argument.")
		}
		return f(xs[0])
	}
}

func fold(f func(a, b float64) float64) func(...float64) (float64, error) {
	return func(xs ...float64) (float64, error) {
		if len(xs) == 0 {
			return 0, fmt.Errorf("Takes at least one argument.")
		}
		v := xs[0]
		for _, x := range xs[1:] {
			v = f(v, x)
		}
		return v, nil
	}
}

func (p *parser) primary() (float64, error) {
	c := p.peek()
	switch {
	case c == '(':
		p.i++
		v, err := p.expr()
		if err != nil {
			return 0, err
		}
		if p.peek() != ')' {
			return 0, fmt.Errorf("Missing ).")
		}
		p.i++
		return v, nil
	case c >= '0' && c <= '9' || c == '.':
		start := p.i
		for p.i < len(p.s) && (p.s[p.i] >= '0' && p.s[p.i] <= '9' || p.s[p.i] == '.' || p.s[p.i] == '_') {
			p.i++
		}
		if p.i < len(p.s) && (p.s[p.i] == 'e' || p.s[p.i] == 'E') && p.i+1 < len(p.s) && (p.s[p.i+1] >= '0' && p.s[p.i+1] <= '9' || p.s[p.i+1] == '-' || p.s[p.i+1] == '+') {
			p.i += 2
			for p.i < len(p.s) && p.s[p.i] >= '0' && p.s[p.i] <= '9' {
				p.i++
			}
		}
		v, err := strconv.ParseFloat(strings.ReplaceAll(p.s[start:p.i], "_", ""), 64)
		if err != nil {
			return 0, fmt.Errorf("%q is not a number.", p.s[start:p.i])
		}
		return v, nil
	case c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z':
		start := p.i
		for p.i < len(p.s) && (p.s[p.i] >= 'a' && p.s[p.i] <= 'z' || p.s[p.i] >= 'A' && p.s[p.i] <= 'Z') {
			p.i++
		}
		name := strings.ToLower(p.s[start:p.i])
		switch name {
		case "pi":
			return math.Pi, nil
		case "e":
			return math.E, nil
		}
		f, ok := functions[name]
		if !ok {
			return 0, fmt.Errorf("Unknown name %q.", name)
		}
		if p.peek() != '(' {
			return 0, fmt.Errorf("%s needs parentheses.", name)
		}
		p.i++
		var xs []float64
		for {
			v, err := p.expr()
			if err != nil {
				return 0, err
			}
			xs = append(xs, v)
			if p.peek() == ',' {
				p.i++
				continue
			}
			if p.peek() != ')' {
				return 0, fmt.Errorf("Missing ) after %s(.", name)
			}
			p.i++
			return f(xs...)
		}
	case c == 0:
		return 0, fmt.Errorf("The expression ends too early.")
	}
	return 0, fmt.Errorf("Unexpected %q at position %d.", string(c), p.i+1)
}
