# migr_ts

A CLI tool for migrating Salesforce records between orgs (or to/from files). It automatically discovers and migrates related records, resolves circular dependencies, matches existing records to avoid duplicates, and applies configurable "solvers" to fix errors during migration.

## Features

- **Relationship discovery** — starting from a set of record IDs, recursively fetches referenced records (lookups, master-detail, even IDs embedded in text/formula fields) up to a configurable depth
- **Circular dependency resolution** — detects dependency cycles, temporarily clears required lookups, and restores them after all records are created
- **Matchers** — identify records that already exist in the target org (by name, developer name, or any field mapping) so they are reused instead of duplicated
- **Solvers** — pattern-based error handlers that automatically fix field values, skip records, retry with backoff, extract IDs from error messages, and more
- **Files** — moves the contents behind ContentVersion/ContentDocument, and reattaches them to the records they were on
- **Resumable migrations** — a per-target history file maps source IDs to target IDs, so re-runs skip already-migrated records
- **File mode** — serialize records to JSON or a SQLite database instead of inserting, or load from either instead of a source org
- **Anonymization** — obfuscate or sanitize email fields during migration
- **Anonymous Apex hooks** — run scripts in the target org before and after a confirmed migration, to disable automation and put it back
- **Interactive terminal UI** — full-screen TUI with progress, error resolution prompts, and the ability to add solvers on the fly (or run fully automated with `fullAuto`)

## Requirements

- Node.js 22.5+ (the SQLite export uses the built-in `node:sqlite` module, added in 22.5)
- [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) with authenticated orgs — the tool connects via org aliases using `@salesforce/core` — or direct instance URL + access token auth (`sourceOrgUrl` / `sourceOrgToken` and `targetOrgUrl` / `targetOrgToken`)

## Usage

Download `bundle.js` from the [latest release](https://github.com/mpekacki/migr_ts/releases/latest) and run it with Node — the bundle is self-contained, so no `npm install` is needed next to it:

```bash
node bundle.js -c config.json [-o output.log] [-d] [-p]
```

Or build it from source:

```bash
npm install
npm run build
node bundle.js -c config.json
```

| Flag | Description |
|------|-------------|
| `-c, --config-json <path>` | Path to the config file (required) |
| `-o, --output-file <path>` | Save output logs to a file |
| `-d, --debug` | Enable debug mode |
| `-p, --plain` | Use the plain streaming UI instead of the full-screen TUI |

### Before you point it at something you care about

The tool **inserts records into the target org**. It asks for confirmation first, showing what it is about to migrate and why each record was pulled in — but `fullAuto.enabled` skips that prompt, so read a run's plan at least once before automating it.

It also **writes a history file** — `{targetOrg}__history.json` in the working directory, unless `historyFilePath` says otherwise. That file is what makes a run resumable: a re-run skips records already mapped in it. Delete it to force a fresh migration, and keep in mind it holds source-to-target ID pairs for the org you migrated into.

Two cheap ways to rehearse: set `targetSqlite` (or `targetFile`) to export the record graph without touching an org, or set `files.enabled: false` to leave file contents behind while you check the shape of what gets pulled in.

## Configuration

[config.json](config.json) is a starting point rather than an exhaustive one: it carries a curated set of matchers for the standard and setup objects a migration usually drags in, plus a couple of solvers. The full field list is below.

| Field | Description |
|-------|-------------|
| `sourceOrg` / `targetOrg` | Org aliases (as known to the Salesforce CLI) |
| `sourceOrgUrl` / `sourceOrgToken`<br>`targetOrgUrl` / `targetOrgToken` | Connect by instance URL and access token instead of an alias |
| `recordIds` | Record IDs to start the migration from |
| `relatedRecordDepthLimit` | How many levels of related records to fetch. **There is no default — omit it and the fetch is not depth-limited**, which from a well-connected record can pull in a large part of the org |
| `matchers` | How to identify records that already exist in the target org. `whenMissing` (`create` or `skip`) controls what happens when no match is found; omitting it behaves like `create` |
| `solvers` | Automatic error handlers — see [Solvers](#solvers) |
| `relationships` | Child relationships to fetch explicitly (e.g. `Account` → `Contacts`) |
| `maxConcurrentRequests` | API request parallelism (default: 10) |
| `historyFilePath` | Where to keep the resume history. Names either the file itself or a directory to put it in (end it with a separator to mean a directory). Defaults to `{targetOrg}__history.json` in the working directory |
| `fullAuto.enabled` | Run without interactive prompts |
| `fullAuto.unhandledErrorBehavior` | What `fullAuto` does with an error no solver handles: `skip` the record and carry on, or `saveAndExit` |
| `anonymization.emailFields` | Obfuscate or sanitize email addresses. `mode` is `obfuscate` (replaces the address with a hash) or `sanitize` (rewrites `a@b.com` to `a.at.b.com`); `template` sets the resulting address, either a bare domain or a pattern containing `{0}` (default `{0}@example.com`) |
| `files.enabled` | Migrate file contents (default: `true`) |
| `files.maxFileSizeMb` | Files larger than this are migrated without their contents (default: 25) |
| `apex.beforeMigration` / `apex.afterMigration` | Anonymous Apex scripts to run in the target org around the migration |
| `sourceFile` / `targetFile` | Migrate from/to a JSON file instead of an org |
| `sourceSqlite` / `targetSqlite` | Migrate from/to a SQLite database instead of an org |

### Solvers

A solver is an error handler: a pattern, and what to do when an error matches it. Every solver has a `message` and an `action`.

**`message` is a regular expression**, not a literal — it is compiled with `new RegExp(...)` and tested against the error text Salesforce returned. That means `.`, `(`, `[` and friends carry their regex meaning and need escaping if you want them literally. Solvers are tried in the order they are listed and the first match wins, so put the specific ones first.

```json
{
  "solvers": [
    {
      "message": "FIELD_CUSTOM_VALIDATION_EXCEPTION",
      "action": "skip"
    },
    {
      "message": "duplicate value found: .* duplicates value on record with id: (\\w+)",
      "action": "match"
    }
  ]
}
```

Solvers come in two families, and which one an action belongs to decides what it can react to.

**Per-record errors** — a record the API rejected while the rest of the batch succeeded:

| Action | Extra fields | What it does |
|--------|--------------|--------------|
| `fix` | `changeFields: [{ field, value }]` | Sets each field to `value` and retries the record. The **original value is written back in the update pass** after the insert, so this is for getting a record past a check that only bites on the way in |
| `skip` | — | Gives up on the record and moves on |
| `match` | — | Reads an existing target record ID out of the error and treats the record as already migrated. The ID is taken from **capture group 1** of `message`, so the pattern must contain a group |
| `extract_column` | `replaceWith`, `fromFields` | Clears the offending field and retries. The field name comes from capture group 1 of `message`, or from the error's own `fields` list when `fromFields` is true. `replaceWith: null` drops the field outright — unlike `fix`, a dropped field is *not* restored later |
| `append_random` | `changeFields: [{ field, length }]` | Appends `.` and `length` random characters to each field and retries. For uniqueness constraints on names and external IDs |

**Whole-operation errors** — the API call itself failed, so there is no single record to blame:

| Action | Extra fields | What it does |
|--------|--------------|--------------|
| `retry` | `maxAttempts` (3), `delay` (1000 ms) | Re-runs the operation on a fixed delay |
| `backoff` | `maxAttempts` (3), `initialDelay` (1000 ms), `backoffMultiplier` (2) | Re-runs it on an exponential delay. For `REQUEST_LIMIT_EXCEEDED` and friends |
| `fallback` | `fallbackAction` | `skip` abandons the operation, `log_and_continue` reports it and carries on |

Worth knowing:

- Any solver may set `hideError: true`, which keeps the matched error out of the output and out of the error count entirely. Useful for the expected, uninteresting failures — see the `DUPLICATE_VALUE` note under [Files](#files).
- Each solver is used **once per record per message**, so a solver that does not actually resolve an error cannot spin on it. If a record produces the same error again, the next matching solver is tried instead.
- A `match` or `extract_column` whose pattern captures nothing leaves the error unresolved rather than silently succeeding.
- An error no solver matches goes to the user, who can write a solver on the spot (`addSolver`) and have it applied to every later error in the run. Under `fullAuto` it falls to `unhandledErrorBehavior` instead.

### Files

Files are fetched and inserted differently from ordinary records, and the tool handles both sides of that automatically — no configuration is needed to migrate a `ContentVersion`.

Retrieving a record does not bring its file along: a blob field such as `ContentVersion.VersionData` comes back holding the *path* of the endpoint that serves it, so the contents are downloaded per record and put back into the field base64 encoded. From there the record travels the ordinary path, which means exports carry file contents too and a `sourceFile` / `sourceSqlite` run restores them.

A `ContentDocument` has no createable field, so it can never be inserted. The target creates one of its own the moment the `ContentVersion` carrying the file lands, and the tool maps the source document ID onto that new one. That mapping is what makes attachments work: point `relationships` at `ContentDocumentLinks` and the files on a record follow it into the target org.

```json
{
  "recordIds": ["001XXXXXXXXXXXXXXX"],
  "relationships": {
    "Account": [{ "name": "ContentDocumentLinks" }]
  }
}
```

Worth knowing:

- Only the **latest version** of each file is migrated. A file with a version history arrives in the target as a single version holding the current contents.
- `maxFileSizeMb` defaults to 25 because a non-multipart request body may carry at most 37.5 MB of base64, and a 25 MB file encodes to roughly 33 MB. A file over the limit is reported and its record is migrated without contents — which for a `ContentVersion` means the insert then fails, since the field is required.
- Salesforce shares every new file with its owner by itself. Migrating the source's owner `ContentDocumentLink` therefore runs into `DUPLICATE_VALUE`; a `skip` solver on `is already linked with the entity` disposes of it.
- `files.enabled: false` migrates file records without their contents, which is useful for rehearsing a large migration.

### Anonymous Apex around the migration

`apex.beforeMigration` and `apex.afterMigration` are lists of files holding Anonymous Apex, executed in the target org in the order they are listed — one script per file, the way `sf apex run -f` takes them. This is where the "switch the triggers off, put the rollups back afterwards" work goes.

```json
{
  "apex": {
    "beforeMigration": ["scripts/disable-automation.apex"],
    "afterMigration": ["scripts/enable-automation.apex", "scripts/recalculate-rollups.apex"]
  }
}
```

- The scripts bracket what the run **writes** to the target org, so they only run when it writes something. Answering `n` at the confirmation prompt leaves the target org untouched and runs neither phase, and so does a re-run that finds every record in its history already (`nothing to migrate`). `fullAuto` runs them without asking.
- `beforeMigration` runs before the first record is inserted; `afterMigration` runs after the last one has landed and the deferred lookup updates are done.
- They run as a **pair**: once `beforeMigration` has run, `afterMigration` runs on every way out of the migration — including a run abandoned part way with `h` (save and exit), so automation a `beforeMigration` script switched off is never left off.
- A script that fails — one that does not compile, or one that throws — stops the run with a non-zero exit code. A `beforeMigration` failure stops it before anything is inserted; an `afterMigration` failure is reported only after the migration summary has been written, so a broken cleanup script never costs you the record of what was migrated.
- Missing script files and combining `apex` with `targetFile` / `targetSqlite` (an export has no target org to run them in) are rejected before the run starts fetching.

### SQLite export format

`targetSqlite` writes the fetched records to a SQLite database instead of inserting them, and `sourceSqlite` reads that database back as the source of a later migration. The database is a plain SQLite file with no extensions, so it can be opened with any SQLite client:

```bash
sqlite3 export.db "SELECT Id, Name FROM Account"
```

Each SObject type gets its own table, named after the type (`Account`, `Custom_Object_A__c`), with the record id as the primary key and one column per field. Every field fetched from the source is exported, read-only ones included — formula fields, `Name` on `User`, `DeveloperName` on `RecordType` — so the export can be queried on them and matchers can match on them. Which fields can actually be inserted is decided on import, not on export. Two bookkeeping tables sit alongside them:

| Table | Contents |
|-------|----------|
| `_migr_meta` | Export format version and timestamp |
| `_migr_fields` | The JS type of every field, so booleans (stored as `0`/`1`) and numbers are restored on import rather than coming back as text |

An export merges into a database already at that path: records only the database holds are left alone, and records the new run exports again replace their stored version, so several migrations can accumulate in one file. Delete the file to start a fresh export. A file that is not a migr_ts export is never overwritten — the run fails instead.

Records edited in place with SQL are picked up on the next `sourceSqlite` run, which makes the database a convenient place to tweak data between orgs.

### Example

```json
{
  "sourceOrg": "myDevOrg",
  "targetOrg": "myScratchOrg",
  "recordIds": ["001XXXXXXXXXXXXXXX"],
  "relatedRecordDepthLimit": 5,
  "matchers": [
    {
      "sObjectType": "User",
      "fieldMappings": [{ "sourceField": "Name", "targetField": "Name" }],
      "whenMissing": "skip"
    }
  ],
  "solvers": [
    {
      "message": "FIELD_CUSTOM_VALIDATION_EXCEPTION",
      "action": "skip"
    }
  ]
}
```

## Development

```bash
npm run build        # bundle main.ts to bundle.js
npm run release      # build in build/v{version}/
npm run lint         # eslint
npm test             # run all tests
```

Unit tests run standalone. The main e2e suite (`tests/e2e.test.ts`) requires a build (`npm run build`) and two authenticated Salesforce orgs aliased `testMigrationOrgA` and `testMigrationOrgB` with the [TestProject](tests/TestProject) metadata deployed — see [tests/create_scratch.sh](tests/create_scratch.sh). CI provisions scratch orgs automatically.

## License

[ISC](LICENSE)
