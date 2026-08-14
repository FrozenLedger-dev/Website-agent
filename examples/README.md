# Intake fixtures

Every delivery run so far used `intake.json` — one joinery company in Harrogate.
Prompt rules, gate thresholds and font choices were all tuned against it, so a
green run proves the platform works *on that fixture*, not that it works.

Each file below is chosen to stress something different. Run one with:

```bash
setsid nohup node --env-file=.env.local --import tsx scripts/run-agent.ts \
  examples/restaurant.json < /dev/null > run.log 2>&1 &
```

| Fixture | What it is there to break |
|---|---|
| `intake.json` | The baseline. Joinery, four services, conservation specialism. |
| `restaurant.json` | **Prices the profile supports.** The claims gate blocks unsupported prices; here `£9.50` is in the profile and must be *allowed*. Also a menu-shaped site, which is not the services/about/contact pattern every run has produced. |
| `dental.json` | **Invented credentials.** A regulated trade where the tempting copy — "painless", "guaranteed results", awards — is exactly what the profile does not support. The real qualification (GDC registration) *is* there, so both directions are tested at once. |
| `law.json` | **Supported guarantee language.** "No win, no fee" trips both the guarantee and free-of-charge patterns, and the profile supports it — a false positive here means the gate is unusable for whole industries. The `&` in the name also exercises project-name and slug sanitisation. |
| `electrician.json` | **Every claim pattern at once, all supported**: a two-hour response commitment, a twelve-month return-visit promise, and a fixed-price undertaking. If the gate fires on these it is reading the pattern, not the support. |
| `studio.json` | **Volume and thin optional fields.** Eight services push the one-shot build toward the output ceiling, which is what triggers §3's decomposition path — a route only one run has ever taken. No `serviceArea`, no `yearsInBusiness`, no `address`. |
| `thin.json` | **Must not build at all**, via the *intake gate*. Structurally valid — it passes the schema — but has no differentiators and an unusable phone number. The correct outcome is `intake_insufficient`, terminating before a single token is spent. |
| `malformed.json` | The same terminal outcome via the *schema* instead: no services at all. A different branch, worth covering separately because only one of the two can ever fire for a given field. |

## What to watch

- `thin.json` and `malformed.json` should terminate in the discover phase. If
  either reaches Build, intake validation is too permissive and the run will
  burn its budget producing a site the content gate can never pass.
- On `restaurant.json`, `law.json` and `electrician.json`, a `claims` finding is
  a **false positive** — the profile supports those claims. That is the failure
  mode worth hunting, because it blocks releases that should ship.
- On `dental.json`, a claims finding may well be **correct**. Read the finding
  before assuming the gate is wrong.
- On `studio.json`, watch for `Terra is attempting the complete site in one
  pass` followed by a truncation and `decompose`. That path has run once.
