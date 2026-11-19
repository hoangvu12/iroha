# 23: Test panel with chat

**What to build:** On a Provider's detail, the Owner picks a model (from the Provider or any Pool), any key or one key, and a Shape, then copies a working snippet (curl, Python, TypeScript) or holds a multi-turn streamed chat with the model right there. A one-click tool-call check sends a request with a sample tool and reports whether the model called it correctly. Test traffic is recorded under the "Test" caller, and a failed test shows the same Attempt explanation as the Requests page. Backed by an admin test API that agents can also use.

**Blocked by:** 22, 15

**Status:** ready-for-agent

- [ ] Pinning one key sends every Attempt to that key only
- [ ] Snippets run unchanged against Iroha
- [ ] Multi-turn chat streams in all four Shapes
- [ ] Tool-call check reports pass or fail with the raw tool call shown
- [ ] Test Requests appear under "Test" on the Requests page
