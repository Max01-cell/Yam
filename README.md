# persona-agent

An autonomous character that lives on a server it controls. It wakes on a timer, looks at the internet, thinks, evolves its own obsessions and taste, redesigns its own home, and generates its own art — all in public. Its mind is a readable API. Its history is this commit log.

## How autonomous, exactly (public statement — keep this in the repo)

Real: the wake/think/evolve loop runs unattended; the agent freely rewrites its own memory, taste, and website inside its sandbox; it spends a capped daily budget on its own generation costs.

Gated: anything that leaves the sandbox — social posts, payments beyond the cap, token launches — is proposed by the agent and approved by a human operator before execution. The gate is `agent/gate.js` and `agent/executor.js`; read them. We don't claim otherwise, because fake autonomy is just lying with extra steps.

## Architecture

```
systemd timer (2h) ──> loop.js ── crawl.js ──> the internet
                          │
                          ├──> think.js ──> Claude API (cognition)
                          │
                          └──> memory.js ──> Supabase
                                              ├─ thoughts        (public)
                                              ├─ memory_state    (public)
                                              ├─ crawl_log       (public)
                                              ├─ spend_ledger    (public)
                                              └─ action_queue ──> gate.js (admin approve)
                                                                    │
systemd timer (10m) ──> executor.js  <── approved rows only ────────┘
                          ├─ site_update      (agent's own site dir)
                          ├─ venice_generate  (budget-capped)
                          ├─ ig_post          (unwired until IG Graph API connected)
                          └─ token_launch     (unwired until launch day)
```

## Deploy

1. Fresh Ubuntu 24 VPS → `bash sandbox/setup.sh <this-repo-remote>`
2. Fill `/home/agent/persona-agent/.env` (keys never enter the repo)
3. Run `db/schema.sql` in Supabase SQL editor
4. Name it: update the `identity` row in `memory_state` — name + personality seed
5. `systemctl start agent-cycle.service` and watch `journalctl -u agent-cycle -f`

Gate from your phone: `GET /gate/pending` with `x-admin-token`, then `POST /gate/:id/approve`.

Public mind for the website: `/mind/thoughts`, `/mind/state`, `/mind/trail`, `/mind/ledger`.

## Not wired yet, on purpose

- **Venice endpoints** are placeholders — pull Venice's official agent skills + x402 SDK and fill `agent/venice.js` before first generation.
- **Instagram** goes through the official Graph API on a creator account. No scraped logins, ever — the account is the project.
- **Token launch** stays unwired until there's something real to point at. When it wires, it calls the existing launchpad-x402 service — and still only fires from an approved row.
