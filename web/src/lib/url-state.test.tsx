import { act, render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { expect, test } from "vitest";
import { patchParams, useUrlParams } from "./url-state";

test("a patch sets values, removes empty ones and keeps every other param", () => {
  const next = patchParams(new URLSearchParams("q=old&state=cooling&sheet=key:a/b&sheet=provider:a"), { q: "team", state: undefined, sort: "" });
  expect(next.toString()).toBe("q=team&sheet=key%3Aa%2Fb&sheet=provider%3Aa");
});

test("setParam, setSort and setParams change the URL in place (no history entry); the default sort leaves no param", () => {
  let url!: ReturnType<typeof useUrlParams>;
  function Page() {
    url = useUrlParams();
    return null;
  }
  const router = createMemoryRouter([{ path: "*", element: <Page /> }], { initialEntries: ["/providers/acme/keys?key=team-5"] });
  let pushes = 0;
  router.subscribe((s) => void (s.historyAction === "PUSH" && pushes++));
  render(<RouterProvider router={router} />);
  const where = () => router.state.location.pathname + router.state.location.search;

  act(() => url.setParam("q", "team"));
  expect(where()).toBe("/providers/acme/keys?key=team-5&q=team");
  act(() => url.setSort("state", true, "name"));
  expect(where()).toBe("/providers/acme/keys?key=team-5&q=team&sort=state&dir=desc");
  act(() => url.setSort("name", false, "name"));
  expect(where()).toBe("/providers/acme/keys?key=team-5&q=team");
  act(() => url.setParams({ q: undefined, key: undefined }));
  expect(where()).toBe("/providers/acme/keys");
  expect(pushes).toBe(0);
  expect(url.params.toString()).toBe("");
});
