# Finalize request history after alternate success

Status: Complete
Blocked by: None

Fix parent request rows that remain placeholder status `0` failures after an attempt trail completes. A `402 -> 200` or `429 -> 200` request must be stored as successful while retaining both attempts and their diagnostics.

Cover non-streaming, streaming, cancellation, terminal failure, and alternate success at the assembled HTTP seam.

## Comments

Added module-interface and assembled HTTP regression coverage for 402/429 alternate recovery. Parent requests finalize successful while every attempt remains visible. Existing terminal and cancellation coverage remains in the HTTP suite; non-streaming abort placeholder cleanup is tracked as an integration audit item. Evidence: request-history suites passed within the 194-test Wave 1 gate.
