# 22: Providers page and Upstream Keys table

**What to build:** The Providers page is a searchable list of Provider names (Model Pools reachable here as the design places them). A Provider's detail centres on the Upstream Keys data table: sort, filter and search on every column (name, Key State and reason, Endpoints, last used, recent Requests and failures, Model Gaps), multi-select, paste many keys one per line, and bulk test, enable, disable, delete, restrict to Endpoints, clear Model Gaps and copy. Endpoints, Models and Rules are present but plain.

**Blocked by:** 21, 10, 18

**Status:** ready-for-agent

- [ ] Every bulk action uses the bulk admin API and shows per-item results
- [ ] Key secrets readable and copyable
- [ ] Key State reason visible per row
- [ ] Pools listed and editable (members, order)
- [ ] Endpoints, Models (add, hide, overrides, refresh, reset) and Rules editable
