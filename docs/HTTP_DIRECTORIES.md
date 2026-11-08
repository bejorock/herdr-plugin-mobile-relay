# Superseded: HTTP host directory operations

**Removed by the SSH/SFTP migration.** Use host SFTP for folder/file operations. The following is historical 2.0.4 implementation evidence, not an available API or current root policy. See [SSH transport](SSH_TRANSPORT.md).

# HTTP host directory operations

Implemented on `lean-relay` (2.0.4); Linux-only in this first safe-filesystem increment. No ACP. Folder operations never create Herdr workspaces, start agents, run a shell or invoke models.

## Owner policy

`HERDR_RELAY_BROWSE_ROOTS` is JSON: `[{"name":"Workspaces","path":"/home/owner/workspaces"}]`. Default `[]` exposes no directories. Maximum 16 unique absolute roots, named 1–128 characters. Invalid config fails closed. Roots must exist. Explicit roots attest these paths are in the same local filesystem/user context as the selected Herdr runtime; remote SSH/container/different-user filesystem translation is not supported. Runtime registry selects local sockets only. No client can add roots.

Conservative symlink policy: reject every symlink component, even an in-root link. Reject relative paths, NUL/control characters and explicit `.`/`..` components; normalize trailing/repeated separators consistently. Overlapping roots choose the longest matching root. Root aliases are configuration, not a means to escape parent navigation.

For race-safe operations, Linux uses descriptor-relative directory traversal with O_DIRECTORY/O_NOFOLLOW and `/proc/self/fd` anchors. Each path component is opened under the previously held descriptor. Creation uses the held parent descriptor, not a checked-then-reopened absolute parent. If these guarantees are unavailable (including macOS in this first directory increment), fail 503 `filesystem_unsupported`; never silently use unsafe mkdir-after-realpath. Descriptor traversal does not make an owner-approved root a sandbox against a privileged local actor moving directories; assume trusted local owner/admin. Symlink replacement attacks must not redirect operations to unrelated directories.

## Endpoints

All honor `?session=<discovered runtime>`. Unknown runtime 404; disconnected 503. Read access for GET; write authorization/audit for POST. Lifecycle-style JSON errors `{error:{code,message}}`; existing authorization gate may return plain text 403.

- `GET /api/directories`: `{roots:[{name,path}]}`. No directory creation or recursive listing.
- `GET /api/directories?path=<absolute>&limit=100&cursor=<opaque>`: `{path,parentPath,directories:[{name,path}],nextCursor}`. Immediate actual directories only; symlink entries omitted. Default 100, maximum 200. Stable lexicographic order. Parent null at selected root. Bounded enumeration (10,000 entries); entry payloads also bounded to 8 MiB; larger listings fail 413 `directory_too_large` rather than unbounded scan. Cursor binds runtime/canonical path/selected root/listing fingerprint; mutation returns 409 `directory_changed`, restart at first page.
- `GET /api/directories/validate?path=<absolute>`: `{path,valid,reason}`. Existing allowed searchable directory returns normalized path/true/null. Normal invalid outcomes: 200 false with `not_found`, `not_directory`, `not_accessible`, `outside_allowed_roots`; conservative symlink rejection is `not_accessible`. Relative/malformed paths are 400. No success claim for a different launch identity.
- `POST /api/directories`: `{parentPath,name,requestId}`; create one nonrecursive child under an existing allowed parent. name is one component, not `.`/`..`, no separators/control characters, maximum 255 UTF-8 bytes. Return 200 `{ok:true,path,created:true|false}`; existing actual directory yields false, existing file/symlink 409 `existing_non_directory`. New mode 0700 (subject to stricter umask).

Create dedupe: mandatory requestId (1–128 alphanumeric/`.`/`_`/`:`/`-`), keyed to operation/runtime, ten-minute in-memory bounded cache (512). Same signature shares original response; mismatched ID reuse 409 `request_id_conflict`; saturation with all operations in flight 429 `request_capacity`. After expiry/restart/eviction, filesystem existence prevents duplicate directory creation, but historical mismatched-ID detection is not retained. No deletion endpoint.

Errors include 400 `invalid_request`/`invalid_path`/`invalid_cursor`, 403 `outside_allowed_roots`/`not_accessible`, 404 `not_found`/`runtime_unknown`, 409 `not_directory`/`existing_non_directory`/`directory_changed`, 413 `directory_too_large`, 503 `filesystem_unsupported`/`runtime_unavailable`/`root_unavailable`. Paths are expected public output for owner-authorized folder selection; no environment/credentials/file contents are returned. Recheck cwd at actual agent launch.

## Validation evidence (2026-11-07)

Automated real-filesystem tests cover roots, sorted pagination, changed-cursor rejection, validation, private single-child creation, concurrent/idempotent retries, post-restart existence behavior, conflicting request IDs, file/symlink conflicts, bad names/traversal, overlapping roots, unknown/unavailable runtime, unreadable parents and root replacement by symlink. HTTP tests exercise runtime routing and reject read-only-device creation. Invalid owner root configuration fails closed.

A separate loopback relay with a disposable configured root was tested against real Herdr 0.9.5. HTTP root browse, two-page listing, three concurrent same-ID creates, validation, existing-directory false, conflicting request ID, existing-file conflict, symlink-parent rejection and out-of-root validation all behaved as specified. Herdr workspace inventory remained unchanged and a pre-existing file retained its contents. Test relay and disposable directories were removed. Production was not restarted or reconfigured.

macOS directory operations and different-user/container/SSH runtime filesystem contexts are not supported or claimed. This does not change the existing cross-platform terminal/management support. Discovery executable verification and public attach-existing are separate pending requirements.
