package main_test

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Builds the real binary and starts it with nothing but a data directory.
func TestBinaryStartsWithOnlyADataDir(t *testing.T) {
	if testing.Short() {
		t.Skip("builds the binary")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "iroha")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	build := exec.Command("go", "build", "-ldflags", "-X main.version=v-test", "-o", bin, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	data := filepath.Join(dir, "data")
	cmd := exec.Command(bin, "--data-dir", data, "--addr", "127.0.0.1:0")
	cmd.Env = append(os.Environ(), "IROHA_LOG_FORMAT=json")
	stdout, _ := cmd.StdoutPipe()
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })

	lines := make(chan string, 100)
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
	}()
	token := regexp.MustCompile(`iroha_admin_[a-z2-7]+`)
	var secret, addr string
	timeout := time.After(30 * time.Second)
	for secret == "" || addr == "" {
		select {
		case line, ok := <-lines:
			if !ok {
				t.Fatal("binary exited early")
			}
			if m := token.FindString(line); m != "" && !strings.HasPrefix(line, "{") {
				secret = m
			}
			var ev map[string]any
			if json.Unmarshal([]byte(line), &ev) == nil && ev["kind"] == "startup" {
				addr, _ = ev["addr"].(string)
				if ev["version"] != "v-test" {
					t.Fatalf("startup version %v", ev["version"])
				}
			}
		case <-timeout:
			t.Fatalf("no bootstrap token and startup event within 30s (token %q, addr %q)", secret, addr)
		}
	}
	if _, err := os.Stat(filepath.Join(data, "iroha.db")); err != nil {
		t.Fatalf("database not created beside the data dir: %v", err)
	}
	resp, err := http.Get("http://" + addr + "/readyz")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !strings.Contains(string(body), "v-test") {
		t.Fatalf("readyz %d %s", resp.StatusCode, body)
	}
	req, _ := http.NewRequest(http.MethodGet, "http://"+addr+"/api/logs?kind=startup", nil)
	req.Header.Set("Authorization", "Bearer "+secret)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("logs with bootstrap token: %d", resp.StatusCode)
	}
}
