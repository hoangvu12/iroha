## Logos and the overview

**Logos.** Every Provider and Model Pool has a logo the UI draws, fetched and cached by Iroha and served from its own URLs (the browser never loads a third-party image):

```
GET   /api/providers/acme/logo                               the Provider's logo, from its logo_domain
PATCH /api/providers/acme  {"logo_domain": "alibabacloud.com"}   "" guesses it from the first Endpoint's host; "none": no logo
GET   /api/pools/glm-4.6/logo                                the Pool's logo, from its model's maker
PATCH /api/pools/glm-4.6   {"maker": "zhipuai"}                  "" guesses it from the Pool name and members' models
GET   /api/logos?domain=alibabacloud.com   GET /api/logos?maker=zhipuai    try one before setting it
```

A Provider shows `logo_domain` (and `logo_domain_guessed`); a Pool shows `maker` (and `maker_guessed`). A logo route answers the image, or `404 logo_unavailable` when none was found; clients then draw the name's first letter (round for Providers, rounded square for Pools). Logos are cached for a day (a failed lookup for a minute) and kept across restarts; changing the domain or maker takes effect at once. Logo domains are stored as plain hostnames: a URL is read for its host, and IP addresses, ports and single-label names are refused.

**Overview.** `GET /api/overview?since=24h` lists every Provider (keys by Key State, models listed to Callers, Requests, succeeded, failed, last Request) and every Pool (the same traffic, plus `served_by`: Requests per serving Provider) in one call.
