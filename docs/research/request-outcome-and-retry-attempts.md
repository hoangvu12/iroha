# Request outcome and retry attempts

## Question

When one logical Gateway Request has failed upstream Attempts followed by a successful Attempt, what should the Request show, and what should remain visible for debugging?

## Primary-source findings

### Envoy: the client-visible response is the request result; retry responses are separate evidence

Envoy's retry statistics make the distinction explicit. Its ordinary `upstream_rq_<*>` counters count only final responses actually sent to the downstream client. Responses that triggered a retry and were not forwarded downstream are counted in a separate `cluster.<name>.retry.upstream_rq_<*>` family. Envoy also exposes `upstream_rq_retry_success` independently. This means a `503` followed by a successful `200` contributes a successful final request plus retry evidence, rather than a failed request merely because one upstream attempt failed. [Envoy cluster retry statistics](https://www.envoyproxy.io/docs/envoy/latest/configuration/upstream/cluster_manager/cluster_stats.html#retry-statistics)

Envoy's access-log model follows the same boundary: an access-log entry describes the downstream request/response exchange, `response_code` is the HTTP response code returned by Envoy, and `upstream_request_attempt_count` records how many upstream attempts occurred. Envoy can additionally emit an upstream access-log entry for each retry attempt. [Envoy access-log protobuf](https://www.envoyproxy.io/docs/envoy/latest/api-v3/data/accesslog/v3/accesslog.proto), [Envoy access logging](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/observability/access_logging)

### AWS SDK: overall API-call success is separate from attempt errors

AWS SDK for Java metrics distinguish request-level and attempt-level observations. Request-level metrics include `ApiCallSuccessful`, `ApiCallDuration` (including all attempts), and `RetryCount`. A separate attempt section records metrics such as `ErrorType` for each call attempt. AWS states that one API call may require multiple attempts before a response is received. [AWS SDK for Java 2.x metrics reference](https://docs.aws.amazon.com/sdk-for-java/latest/developer-guide/metrics-list.html)

AWS's retry flow further states that the SDK repeats attempts until the request succeeds or a terminal condition occurs, and that the application sees either the successful response or the final error. Therefore, a failed attempt recovered by a later success is not the overall API-call failure. [AWS SDK retry behavior](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html#how-retries-work)

### OpenTelemetry: physical HTTP attempts should remain individually observable

OpenTelemetry's HTTP semantic conventions recommend one client span for each physical attempt to send an HTTP request. Repeated spans carry `http.request.resend_count`; the normative examples show `500`, `500`, then `200` as three distinct client spans under one inbound server request. This preserves the failed attempts rather than flattening them into the final result. [OpenTelemetry HTTP span conventions](https://opentelemetry.io/docs/specs/semconv/http/http-spans/#http-client-span), [OpenTelemetry retry examples](https://opentelemetry.io/docs/specs/semconv/http/http-spans/#http-client-request-retries-and-redirects)

OpenTelemetry also defines status from the result of the operation represented by a span: successful HTTP responses normally do not receive error status, while failed client responses do. That reinforces the need to be explicit about whether a record represents the downstream logical Request or one upstream Attempt. [OpenTelemetry HTTP span status](https://opentelemetry.io/docs/specs/semconv/http/http-spans/#status)

## Recommendation for Iroha

Treat the two layers as separate observability facts:

- A **Request** represents the complete downstream Gateway exchange. Its status, outcome, latency, streaming flag, and token totals should describe what the caller ultimately received across the whole operation.
- An **Attempt** represents one upstream transmission. Its status, outcome, latency, Upstream Key, failure classification, and diagnostics should describe that attempt only.

For attempts `#1 401 failure` followed by `#2 200 success`, show the Request as `success / HTTP 200`. Preserve both Attempts in order in the detail view. Add a visible `2 attempts` or `recovered after 1 failed attempt` indicator so the successful Request does not hide routing or credential trouble.

Do not define Request status as "the latest Attempt" in the data model. The latest completed Attempt often supplies the downstream response, but hedging, cancellation, response transformation, streaming failures after headers, and locally generated Gateway responses can break that equivalence. Finalize the Request explicitly from the actual downstream result; link the winning Attempt when one exists.

For analytics, count completed Request outcomes for caller-facing success rate and latency. Report Attempt failures, retries, and recovery rate as separate operational metrics. This matches Envoy's final-response versus retry-response counters and AWS's API-call versus call-attempt metrics, while keeping the full trail useful for debugging.

## Suggested fields and UI semantics

- Request: terminal `outcome`, downstream `httpStatus` when available, end-to-end `latencyMs`, aggregate usage, `attemptCount`, and optional `winningAttemptId`.
- Attempt: ordinal, per-attempt outcome/status/latency, Upstream Key, failure classification, and bounded Provider Diagnostics.
- History row: emphasize final Request outcome; show an attempt-count/recovered-retry badge.
- Detail view: show final Request summary first, then the complete ordered Attempt trail.
- Overview: compute success/failure and latency from completed Requests; compute retry and upstream-health charts from Attempts.
