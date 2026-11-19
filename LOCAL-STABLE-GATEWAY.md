# Local stable gateway trial (not upstream)

Adds an optional in-process OpenAI-compatible listener next to the existing
ephemeral loopback shims so LiteLLM (in Docker) can call:

`user → LiteLLM (:4000) → stable gateway (:4010) → region shim → WorkBuddy`

## Behaviour

- Ephemeral shim is unchanged: `127.0.0.1`, random port, in-memory secret.
- Stable gateway listens on `0.0.0.0:4010` (so `host.docker.internal:4010` works)
  and requires its own Bearer token from `$DSH_HOME/.workbuddy-stable-gateway.key`.
- Paths: `/cn/healthz`, `/cn/v1/models`, `/cn/v1/chat/completions`, and the same
  under `/global/...`. Each request re-reads `shim.baseUrl()` and `shim.token()`.
- Off unless `$DSH_HOME/.workbuddy-stable-gateway.json` has `"enabled": true`,
  or the key file already exists. Set `"enabled": false` to disable.

## Rollback

1. Fully quit DeepSeek Harness, then re-add the npm package:
   `dsh plugin --profile desktop add dsh-connect-workbuddy`
   (or restore the previous `dsh-connect-workbuddy` version in the desktop profile).
2. Remove WorkBuddy lines from `Ficus/litellm/.env` (`WORKBUDDY_*`) and
   revert `host.docker.internal` on `NO_PROXY`/`no_proxy` if you do not need it.
   Revert `litellm/launch.mjs`, `compose.workbuddy.yml`, and
   `generate-workbuddy-config.mjs` if those files were added or edited.
3. From the Ficus repo root:
   `node litellm/launch.mjs up --no-deps --force-recreate litellm`
4. Optionally delete `$DSH_HOME/.workbuddy-stable-gateway.key` and
   `.workbuddy-stable-gateway.json`.
