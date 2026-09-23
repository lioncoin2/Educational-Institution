# Storage

> Do NOT store large binary files directly in PostgreSQL.

**State: implemented (V1).** File metadata in Postgres (`file_assets`), bytes
behind a `StorageProvider`, a verified upload flow, and short-lived signed
links. The first user is messaging; homework submissions and certificate
scans will use the same path.

---

## 1. The split

| | Postgres | Storage provider |
| --- | --- | --- |
| Holds | `file_assets`: id, owner, kind, content type, size, generated storage key, display name, status, duration/dimensions, timestamps | the bytes |
| Queried by | the files module only | nothing — accessed by key |
| Backed up as | part of the database | separately, and far more cheaply |

Binaries in Postgres inflate every dump, restore, replica and vacuum; an
object store's lifecycle rules (tiering, expiry) apply to the split without
any application change.

---

## 2. Who owns what

```
messaging (or any module)          files                              storage
──────────────────────────         ─────────────────────────────      ─────────
holds a fileAssetId        ──▶     FILE_ASSETS contract:              StorageProvider
decides who may read it            describe · verifyAttachable ·      (internal port)
                                   createDownloadLink
```

- **Files decides what may be stored**, verifies it, and mints links.
- **The owning module decides who may read a file.** Files cannot know
  whether a PDF is a homework submission or a certificate scan, so it cannot
  authorize a reader. Messaging authorizes (member, message visible, file
  really attached), then asks files for a link.
- **The storage port is private to files.** The Foundation exported
  `STORAGE_PROVIDER` publicly; a module holding it could mint a link to *any*
  key in the store, whoever uploaded it. It now lives in
  `files/domain/storage-provider.ts`, and an architecture test fails if any
  other module imports it — or files' tables.

---

## 3. The upload flow

```
client                         API                                   storage
  │ POST /files/uploads  ─────▶ authorize files.upload, rate limit,
  │   {kind, contentType,       validate against the allow-list,
  │    byteSize, fileName,      create FileAsset PENDING,
  │    duration/dimensions}     sign a PUT URL (key, type, max size, 15 min)
  │ ◀──── {asset, upload: {url, method: PUT, headers}}
  │ PUT <url>  (bytes, exact Content-Type) ─────────────────────────▶ stored
  │ POST /files/uploads/:id/complete ─▶ owner only; object exists;
  │                             size == declared; magic bytes match
  │ ◀──── AVAILABLE summary     (or REJECTED — and the bytes are deleted)
```

The bytes **never pass through API memory**: they go to storage directly (an
object store's presigned URL), or, with the local adapter, stream to disk
through a byte ceiling. Only an AVAILABLE asset can be attached, and only by
its uploader.

`FileAsset` states: `PENDING` → `AVAILABLE` | `REJECTED`. Completion is a
compare-and-set from PENDING, so eight simultaneous "complete" calls complete
once (tested on Postgres); a completed upload is idempotent to re-complete.

---

## 4. Upload policy — every upload is untrusted

The policy is an **allow-list per kind** in `files/domain/file-policy.ts`.
Anything not listed is refused. There is no "other" type and no executable.

**V1 allowed types — the sizes and durations are PROVISIONAL (Q19):**

| Kind | Content types (extensions) | Max size | Metadata |
| --- | --- | --- | --- |
| `IMAGE` | `image/jpeg` (jpg, jpeg) · `image/png` (png) · `image/webp` (webp) | 10 MB | width/height ≤ 20,000, both or neither |
| `VOICE` | `audio/mp4` (m4a, mp4) · `audio/aac` (aac) · `audio/ogg` (ogg, oga, opus) · `audio/webm` (webm) | 5 MB | duration ≤ 10 min |
| `AUDIO` | `audio/mpeg` (mp3) · `audio/mp4` · `audio/aac` · `audio/ogg` | 50 MB | duration ≤ 24 h |
| `DOCUMENT` | `application/pdf` (pdf) | 25 MB | — |

Not accepted, deliberately: SVG (it can carry script), HTML, Office formats
(ZIP containers that can carry macros — whether to accept them is Q19), and
anything executable.

What is validated, and where:

| Check | When | Refusal |
| --- | --- | --- |
| content type in the kind's allow-list (normalized: case, parameters) | declaring | `files.content_type_not_allowed` |
| size is a positive integer, at most the kind's cap | declaring | `files.empty`, `files.too_large` |
| declared extension belongs to the declared type — `photo.html` as `image/png` is refused | declaring | `files.extension_mismatch` |
| duration / dimensions plausible and only on kinds that have them | declaring | `files.metadata_invalid` |
| request `Content-Type` equals the signed type | the PUT | `files.content_type_mismatch` |
| `Content-Length` present and within the signed ceiling; streamed bytes cut off past it | the PUT | `files.length_required`, `files.too_large` |
| stored size equals the declared size | completing | `files.content_mismatch` |
| **leading bytes carry the declared type's signature** (PNG, JPEG, WebP, PDF, MP4 `ftyp`, ADTS, Ogg, EBML, MP3/ID3) | completing | `files.content_mismatch` |

The magic-byte check is what stops an HTML page uploaded as "image/png" from
ever being served back; a test asserts every accepted type has a signature.
It proves the container, not harmlessness — a valid PDF can still be hostile,
which is why documents are always served as downloads (§6).

### Names and keys

- **Storage keys are generated from ids only**: `<kind>/<yyyy>/<mm>/<assetId>`
  — no extension, nothing the client sent. Path traversal and key collisions
  are impossible by construction; the local adapter additionally refuses any
  key that does not match that exact shape, or that would resolve outside its
  root.
- **The client's file name is display metadata only.** Sanitized: control
  characters removed; **Unicode direction controls removed** (`invoice<RLO>fdp.exe`
  renders as `invoiceexe.pdf` in an RTL-aware UI — which this app is); path
  separators and reserved characters replaced; leading dots removed; bounded
  at 200 characters; the canonical extension appended when missing.

---

## 5. Signed URLs

A signed URL is a capability: possession grants the transfer it names, until
it expires.

| | Upload | Download |
| --- | --- | --- |
| Lifetime | 15 minutes | 5 minutes |
| Bound into the signature | `PUT`, key, expiry, content type, max bytes | `GET`, key, expiry, content type, disposition, file name |

Signatures are **purpose-bound**: the signed string names the method and every
parameter that shapes the transfer, JSON-encoded so no value can smuggle a
separator. A download link cannot be replayed as an upload — the Foundation's
signature covered only key and expiry, so anyone holding a download link could
have overwritten the file — and no signed parameter can be edited in the URL.
HMAC-SHA256, compared in constant time.

The key is its own secret, **`STORAGE_SIGNING_SECRET`**: production refuses to
start if it is missing, shorter than 32 bytes, a placeholder, or equal to
`JWT_SECRET` — one leaked key must not forge both sessions and file links.
The `sig` parameter is redacted from access logs (a signed URL is a bearer
credential until it expires), and the secret is on the log redaction list.

Links are not bound to a principal: the authorization happens before the link
is minted, and the short lifetime bounds a leaked one. Binding the user id
into the signature is a small change if a file class ever warrants it.

---

## 6. Adapters

**`LocalStorageProvider`** — implemented, tested. Filesystem-backed, for
development and single-node deployment. It emulates an object store's
signed-URL contract **including its HTTP face**, `LocalTransferController`
(in `files/infrastructure/`, because it *is* the adapter — an S3 deployment
has no such routes):

- `PUT /files/local/:token` — verifies the signature before reading a byte,
  then **write-once**: bytes stream to a temporary file (`O_EXCL`, mode 0600)
  through a byte ceiling and are hard-linked into place only if nothing is
  there. A leaked upload URL cannot replace a file after the fact (409).
- `GET /files/local/:token` — streams from one open file handle (so a delete
  between "how big" and "send" cannot split the two), with:
  `Content-Type` as verified; `X-Content-Type-Options: nosniff`;
  `Content-Security-Policy: default-src 'none'; sandbox`;
  `Content-Disposition` per RFC 6266 (ASCII fallback plus the exact UTF-8
  name — names here are often Arabic); `inline` for images and audio,
  **`attachment` always for documents**; `Cache-Control: private, max-age`
  = the link's remaining life; and single byte ranges (206/416), because
  AVPlayer and Safari will not play audio without them.
- Both routes are public in the access guard's sense — the signature is the
  authorization, exactly as for a presigned object-store URL — and listed as
  such in the architecture test. No per-IP limit: upload URLs come only from
  the authenticated, per-user-limited request; downloads are what a classroom
  behind one school NAT does all day.

**`S3CompatibleStorageProvider`** — not written. The port is presigned-URL
first (`createUploadTarget`, `createDownloadUrl`, `stat`, `readHead`,
`delete`), so the adapter is a drop-in: S3 presigned PUT with the content type
and length bound, presigned GET with `response-content-disposition`, `HEAD`
and a ranged `GET` for verification. Only `files.module.ts` changes.

---

## 7. Deliberately deferred

- **Sweeping abandoned uploads.** PENDING assets that never complete, and
  objects left by a rejected re-upload, accumulate. A partial index
  (`file_assets_pending_idx`) is in place for the job that will sweep them.
- **Virus scanning** — an event-driven step before AVAILABLE.
- **Image thumbnails and audio transcoding** — derived assets from a job.
- **Retention and deletion** — institutional, not technical (Q3, Q23).
- **A CDN** in front of downloads.
- **Per-user storage quotas** (Q19).
