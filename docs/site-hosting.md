# Site hosting — modoki-engine.com

How the public site (VitePress landing + `/docs` guide/reference + every game/demo web build)
gets from the `modoki-www-site` GCS bucket to `https://modoki-engine.com` over HTTPS.

## What it is

`modoki-engine.com` and `www.modoki-engine.com` are served by a **Cloudflare Worker** named
`modoki-site`, routed on both hosts, which proxies every request to the public bucket
`gs://modoki-www-site`. Source of truth is `site/cloudflare-worker.js` in this repo, but
**nothing deploys it automatically** — there is no `wrangler` config and no CI step. It was
uploaded straight to the Workers API, and a change means editing the file **and re-uploading**,
not just committing:

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/<account-id>/workers/scripts/modoki-site" \
  -H "Authorization: Bearer $CF_TOKEN" \
  -F 'metadata={"main_module":"worker.js","compatibility_date":"2026-08-01"};type=application/json' \
  -F "worker.js=@site/cloudflare-worker.js;filename=worker.js;type=application/javascript+module"
```

The `filename=worker.js` is load-bearing: Cloudflare resolves `main_module` against the uploaded
part's FILENAME, not the form field name, so uploading the repo file under its own name fails with
`No such module: worker.js`. The token needs Workers Scripts: Edit.

The bucket itself, and the two pipelines that write to it, are unchanged by any of this:
- `site/deploy-site.sh` — builds VitePress and rsyncs it to the bucket root (`/docs`, `/ja`, …).
- The editor's **Build → Web** — writes each game/demo into its own sub-folder via that
  project's `webBucket` in `project.config.json` (`/forest-camp`, `/particle-demo`, …).

## Why a Worker exists at all

GCS can serve a bucket over plain HTTP via CNAME, but **HTTPS on a custom domain requires
something in front of it to terminate TLS** — GCS won't do it for you. Until 2026-08-03 that
something was a GCP external HTTPS load balancer (forwarding rules + URL map + backend
bucket + managed cert + static IP), whose entire job was TLS termination in front of a bucket
that itself costs about 2 cents a month to store. GCP bills forwarding rules at ~$0.025/hr
covering the first five, so that stack alone ran **~$18.25/mo** — for a job a single Worker
does for free. It was deleted 2026-08-03; GCP's recurring bill for this domain dropped from
~$19/mo to ~$0.02/mo (bucket storage only). The separate **Cloud Domains** registration
(~$12–15/yr, auto-renew 2027-05-26) is unrelated billing and untouched.

## Why a Worker, not Cloudflare's built-in rules

The original plan (see the deleted `docs/plans/gcp-lb-retirement-plan.md`) was to do this with
zero code: a free-tier **Transform Rule** to rewrite the path (prefix `/modoki-www-site`) plus
a free-tier **Origin Rule** to point the request at `storage.googleapis.com` with a matching
Host header. That plan turned out to be wrong: **Origin Rules are a paid Cloudflare
entitlement.** On the Free plan, both the origin-host override and the Host-header override
are rejected outright with "not entitled" — this was only discovered after the migration was
already planned around them. Transform Rules alone are free but useless without also being
able to change the origin — rewriting the path is pointless if the request still goes to
`modoki-engine.com`'s own (nonexistent) origin. So the rewrite-and-redirect logic moved into a
Worker, which is unrestricted on the Free plan.

## Why not Cloudflare Pages / R2 / a renamed bucket

Anything that moves the site's *content* off GCS breaks one or both of the two writers above
and forces rewiring every demo's `webBucket`. That was rejected on the pipeline coupling, not
on capacity — Cloudflare Pages was in fact measured viable on its own limits (5,531 objects vs
a 20,000 cap, largest file 13.6 MB vs a 25 MB cap). The Worker was chosen specifically because
it changes nothing about how content gets INTO the bucket — it only changes what answers HTTPS
requests for the domain.

## Legacy redirects the Worker replicates

The load balancer wasn't *only* terminating TLS — its URL map (`gcloud compute url-maps
describe static-lb`, pathMatcher `main`) carried routing that would otherwise have vanished
silently when it was deleted. **This was the load-bearing risk of the whole migration**: had
the LB been deleted without first extracting these, every one of the URLs below would have
started 404ing with no error anywhere to notice it. They are reproduced verbatim in the
`REDIRECTS` map in `site/cloudflare-worker.js`, all served as 301 with the query string
preserved (`stripQuery: false` in the original). Each was registered both with and without a
trailing slash in the original url-map; the Worker normalizes the trailing slash away before
the lookup instead of duplicating keys.

| From | To |
|---|---|
| `/docs` | `/docs/guide/getting-started.html` |
| `/docs/animation-editor` | `/docs/guide/animation-editor.html` |
| `/docs/assets-import` | `/docs/guide/assets-import.html` |
| `/docs/build-deploy` | `/docs/guide/build-deploy.html` |
| `/docs/hierarchy-inspector` | `/docs/guide/hierarchy-inspector.html` |
| `/docs/particle-editor` | `/docs/guide/particle-editor.html` |
| `/docs/scene-view` | `/docs/guide/scene-view.html` |

Adding a new one means editing the `REDIRECTS` map in `site/cloudflare-worker.js` and
redeploying the Worker — there is no other place this routing lives.

The load balancer's `www-redirect` host matcher (a `defaultUrlRedirect` sending the whole
`www.` host to the apex, 301) is likewise reproduced as the first check in the Worker's
`fetch` handler, ahead of everything else.

## Directory indexes

The load balancer's backend-bucket auto-served `index.html` for a directory URL (`/docs/guide/`
→ `/docs/guide/index.html`); raw GCS has no directory concept and does not do this. The Worker
reimplements it in `candidates()`:
- a path ending in `/` tries `path + 'index.html'`.
- an extensionless path (no `.` in the last segment) is assumed to be a directory in disguise
  (`/docs/guide` → `/docs/guide/index.html`) but is tried **verbatim first**, so a genuine
  extensionless file still wins.
- anything else is tried as-is.

Without this, every directory-style URL on the site 404s.

## Caching / deploys

There is no CDN invalidation step anymore — the old deploy ran
`gcloud compute url-maps invalidate-cdn-cache static-lb`; that url-map no longer exists, and
nothing purges Cloudflare on deploy. Staleness is bounded by the Worker's own edge TTLs
(`ttlFor()`) instead:
- `.html` → 60s, so a publish becomes visible in about a minute.
- everything else → 86400s (1 day). Vite/VitePress build assets are content-hashed in their
  filename so a changed file is a changed URL and can be cached hard regardless; the day-long
  TTL exists for **unhashed** media (models, textures, audio) sharing the bucket — long enough
  to protect the request budget, short enough that a re-uploaded asset shows up without anyone
  hunting for a purge button.

Manual purge, if ever needed: Cloudflare dashboard → Caching → Purge Everything.

404s are returned with `cache-control: no-store` **deliberately** — an earlier version cached
them, and during a deploy race (a file requested moments before it lands) the 404 stuck at the
edge and URLs visibly flapped between 301 and 404 depending on which PoP answered a given
request. `no-store` on 404 specifically avoids re-triggering that.

## Free-tier ceiling

Cloudflare Workers' free plan allows 100,000 requests/day. `cf: { cacheEverything: true }` on
every origin fetch means the edge absorbs repeat traffic for a given `cacheTtl` window, so real
Worker invocations should sit well under the cap — but exceeding it **errors rather than
degrades**, so it's worth an occasional glance at Cloudflare analytics if traffic grows.

## What is NOT affected

**OTA.** `games/ota-test/project.config.json` pins
`https://storage.googleapis.com/modoki-www-site/ota-test-releases` directly at the GCS URL,
bypassing the domain (and therefore the Worker) entirely. Nothing about this migration touches
that feed.

## Email

MX records point at `mx1.improvmx.com` / `mx2.improvmx.com` with a matching SPF TXT record,
hosted on Cloudflare DNS as **DNS-only** (grey-clouded) — MX records cannot be proxied through
Cloudflare's edge at all. **Do not enable Cloudflare Email Routing** — it writes its own MX
records on the zone and would silently clobber ImprovMX's, breaking mail forwarding with no
obvious error at either end.

## DNS / registrar

Nameservers are `kia.ns.cloudflare.com` / `paul.ns.cloudflare.com`. The domain is registered
via **Cloud Domains** in the GCP project `modoki-www` — Squarespace appears in `whois` only as
registrar of record (a Cloud Domains implementation detail), and the domain was never added to
a Squarespace customer account, so it does not appear there and nameserver changes are **not**
made through Squarespace. They're made with:

```bash
gcloud domains registrations configure dns modoki-engine.com \
  --project=modoki-www \
  --name-servers=kia.ns.cloudflare.com,paul.ns.cloudflare.com
```

## Rollback

No longer a cheap operation. While the load balancer still existed, rollback was "point DNS
back at it" — free and instant. Now that it's deleted, rolling back means **rebuilding the LB
stack from scratch** (forwarding rules, URL map, backend bucket, managed cert, static IP) before
DNS could point at it again. Deleting the Worker's routes today just breaks the site outright —
the origin it used to be able to fall back to no longer exists.

## Related

- `site/cloudflare-worker.js` — the Worker source, the actual implementation of everything above.
- [doc-conventions.md](./doc-conventions.md) — publishing rules; this doc is filed under Native &
  Build below.
