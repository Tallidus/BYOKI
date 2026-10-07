# Verification

| Area | How it is checked |
| --- | --- |
| Policy | Core router tests reject a disallowed provider and an incompatible model. Changing the catalog invalidates a saved selection on the next call. |
| Isolation | Server tests save a key as Alice and show that Bob cannot see or delete it. |
| Secrets | The encrypted file and HTTP responses are asserted to omit the plaintext key. Provider test failures return a fixed message and are asserted to omit upstream text and key fragments. The logger drops any line that contains a key-shaped string, including a masked echo. |
| Providers | Adapter tests mock HTTP for OpenAI, Anthropic, and Gemini request mapping, usage, timeout and rate-limit errors, and invalid keys. Live smoke tests are opt-in via `BYOKI_LIVE=1`. |
| Usage | Successful, failed, streamed, and unknown-price calls write ledger rows. Prompts are not stored. Unknown cost is not shown as zero. |
| Budgets | A concurrent pair of calls both pass a preflight, which is the documented best-effort behavior. |
| UI | React tests cover the password field, purpose text, and unknown cost. The example flow is also checked in a browser. |
| Packaging | `tests/packaging.test.ts` checks the browser entry and that `@byoki/react` does not depend on `@byoki/server`. |

Streaming for the paid adapters is not enabled. The mock path records `streamed: true` so the ledger shape is covered. Real provider streaming stays off until the non-streaming path is the one you operate.
