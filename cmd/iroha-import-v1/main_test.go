package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestRefusesToStartWithoutWhatItNeeds(t *testing.T) {
	for _, c := range []struct {
		args []string
		env  map[string]string
		want string
	}{
		{nil, nil, "--v1-db is required"},
		{[]string{"--v1-db", "x.db"}, nil, "IROHA_ADMIN_TOKEN"},
		{[]string{"--v1-db", "x.db", "--url", "ftp://host"}, map[string]string{"IROHA_ADMIN_TOKEN": "t"}, "--url must be"},
		{[]string{"--v1-db", "x.db"}, map[string]string{"IROHA_ADMIN_TOKEN": "t"}, "master key"},
	} {
		var out, errOut bytes.Buffer
		code := run(c.args, func(k string) string { return c.env[k] }, &out, &errOut)
		if code != 2 || !strings.Contains(errOut.String(), c.want) {
			t.Errorf("%v: exit %d, stderr %q; want 2 and %q", c.args, code, errOut.String(), c.want)
		}
	}
}
