# migr_ts

A CLI tool for migrating Salesforce records between orgs (or to/from files). It automatically discovers and migrates related records, resolves circular dependencies, matches existing records to avoid duplicates, and applies configurable "solvers" to fix errors during migration.

## Features

- **Relationship discovery** — starting from a set of record IDs, recursively fetches referenced records (lookups, master-detail, even IDs embedded in text/formula fields) up to a configurable depth
- **Circular dependency resolution** — detects dependency cycles, temporarily clears required lookups, and restores them after all records are created
- **Matchers** — identify records that already exist in the target org (by name, developer name, or any field mapping) so they are reused instead of duplicated
- **Solvers** — pattern-based error handlers that automatically fix field values, skip records, retry with backoff, extract IDs from error messages, and more
- **Resumable migrations** — a per-target history file maps source IDs to target IDs, so re-runs skip already-migrated records
- **File mode** — serialize records to JSON or a SQLite database instead of inserting, or load from either instead of a source org
- **Anonymization** — obfuscate or sanitize email fields during migration
- **Interactive terminal UI** — full-screen TUI with progress, error resolution prompts, and the ability to add solvers on the fly (or run fully automated with `fullAuto`)

## Requirements

- Node.js 22+
- [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) with authenticated orgs (the tool connects via org aliases using `@salesforce/core`), or direct instance URL + access token auth

## Usage

```bash
npm install
npm run build
node bundle.js -c config.json [-o output.log] [-d] [-p]
```

| Flag | Description |
|------|-------------|
| `-c, --config-json <path>` | Path to the config file (required) |
| `-o, --output-file <path>` | Save output logs to a file |
| `-d, --debug` | Enable debug mode |
| `-p, --plain` | Use the plain streaming UI instead of the full-screen TUI |

## Configuration

See [config.json](config.json) for a full example. The most important fields:

| Field | Description |
|-------|-------------|
| `sourceOrg` / `targetOrg` | Org aliases (as known to the Salesforce CLI) |
| `recordIds` | Record IDs to start the migration from |
| `matchers` | How to identify records that already exist in the target org. `whenMissing` controls whether missing records are created or skipped |
| `solvers` | Automatic error handlers (`fix`, `skip`, `match`, `extract_column`, `append_random`, `retry`, `backoff`, `fallback`) |
| `relationships` | Child relationships to fetch explicitly (e.g. `Account` → `Contacts`) |
| `relatedRecordDepthLimit` | How many levels of related records to fetch |
| `maxConcurrentRequests` | API request parallelism (default: 10) |
| `fullAuto.enabled` | Run without interactive prompts |
| `anonymization.emailFields` | Obfuscate or sanitize email addresses |
| `sourceFile` / `targetFile` | Migrate from/to a JSON file instead of an org |
| `sourceSqlite` / `targetSqlite` | Migrate from/to a SQLite database instead of an org |

### SQLite export format

`targetSqlite` writes the fetched records to a SQLite database instead of inserting them, and `sourceSqlite` reads that database back as the source of a later migration. The database is a plain SQLite file with no extensions, so it can be opened with any SQLite client:

```bash
sqlite3 export.db "SELECT Id, Name FROM Account"
```

Each SObject type gets its own table, named after the type (`Account`, `Custom_Object_A__c`), with the record id as the primary key and one column per field. Two bookkeeping tables sit alongside them:

| Table | Contents |
|-------|----------|
| `_migr_meta` | Export format version and timestamp |
| `_migr_fields` | The JS type of every field, so booleans (stored as `0`/`1`) and numbers are restored on import rather than coming back as text |

An export merges into a database already at that path: records only the database holds are left alone, and records the new run exports again replace their stored version, so several migrations can accumulate in one file. Delete the file to start a fresh export. A file that is not a migr_ts export is never overwritten - the run fails instead.

Records edited in place with SQL are picked up on the next `sourceSqlite` run, which makes the database a convenient place to tweak data between orgs.

### Example

```json
{
  "sourceOrg": "myDevOrg",
  "targetOrg": "myScratchOrg",
  "recordIds": ["001XXXXXXXXXXXXXXX"],
  "matchers": [
    {
      "sObjectType": "User",
      "fieldMappings": [{ "sourceField": "Name", "targetField": "Name" }]
    }
  ],
  "solvers": [
    {
      "errorPattern": "FIELD_CUSTOM_VALIDATION_EXCEPTION",
      "action": "skip"
    }
  ]
}
```

## Development

```bash
npm run build        # bundle main.ts to bundle.js
npm run release      # minified build in build/v{version}/
npm run lint         # eslint
npm test             # run all tests
```

Unit tests run standalone. The main e2e suite (`tests/e2e.test.ts`) requires a build (`npm run build`) and two authenticated Salesforce orgs aliased `testMigrationOrgA` and `testMigrationOrgB` with the [TestProject](tests/TestProject) metadata deployed — see [tests/create_scratch.sh](tests/create_scratch.sh). CI provisions scratch orgs automatically.

## License

[ISC](LICENSE)
