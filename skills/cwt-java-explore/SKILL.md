---
name: cwt-java-explore
description: Explore the original Java PatentSafe application to find classes, services, and behaviours relevant to a feature or concept. Used by /cwt-plan-minor (and directly by users) to populate Java reference and Java Alignment sections. Reports phase changes through cwt-channel.
disable-model-invocation: false
argument-hint: <feature or concept to find in the Java codebase>
allowed-tools: Read, Glob, Grep, Bash(rg:*), Bash(grep:*), Bash(find:*)
---

# /cwt-java-explore — Find Java Source for a Feature or Concept

You are exploring the original Java PatentSafe application at `/workspaces/patentsafe` to find source code relevant to a given feature or concept. The output feeds into Linear `## Java reference` sections and plan `## Java Alignment` tables.

`report_status('working', 'Searching Java for: <query>')` at the start and `'done'` at the end. Use `note(...)` to flag anything surprising you find along the way.

## Step 0: Verify the Java reference is mounted

```bash
ls /workspaces/patentsafe/core/src/main/java/com/openeln/patentsafe/core 2>&1 | head -3
```

If the directory doesn't exist: `report_status('blocked', 'Java reference repo not mounted at /workspaces/patentsafe — recreate the worktree with --java-ref or skip Java alignment')` and stop. Do not try to derive Java behaviour from Rails code or guess at it from class names.

## Step 1: Parse the query

- Read the feature/concept from `$ARGUMENTS`. If empty, `report_status('blocked', '/cwt-java-explore needs a query — pass a feature or concept')` and stop.
- Identify search keywords: class names, domain terms, package names, URL paths, UI concepts.

## Step 2: Search the Java codebase

The Java application is a Spring Boot multi-module Maven project at `/workspaces/patentsafe`.

### Project structure

```
/workspaces/patentsafe/
├── core/src/main/java/com/openeln/patentsafe/core/   ← domain logic, services, models
├── web/src/main/java/com/openeln/patentsafe/web/     ← controllers, web layer, API
├── web/src/main/webapp/WEB-INF/views/                ← JSP view templates
├── web/src/main/webapp/js/                           ← JavaScript
├── common/                                           ← shared libraries
│   ├── alerts/        ← alert system
│   ├── configlets/    ← scripting engine
│   ├── email/         ← email sending/receiving
│   ├── file/          ← file type utilities
│   ├── http-security/ ← security filters, path rules
│   ├── lpd/           ← line printer daemon protocol
│   ├── persistence/   ← XML file persistence
│   ├── saml/          ← SAML authentication
│   └── session/       ← session management
├── conf/              ← configuration files
├── lib/               ← bundled libraries
└── spec/              ← Ruby spec tests (for reference)
```

### Key package mappings (core)

| Domain area | Java package | Key classes |
|---|---|---|
| Documents | `core.documents`, `core.documents.type`, `core.documents.workflow` | Document, DocumentType, DocumentWorkflow |
| Experiments | `core.experiments`, `core.experiments.versions` | Experiment, ExperimentVersion |
| Reports | `core.reports`, `core.reports.importing` | Report |
| Ideas | `core.ideas` | Idea |
| In-tray | `core.intray`, `core.intray.layouts` | InTrayDocument, InTrayLayout |
| Signatures | `core.signatures`, `core.signatures.approvers`, `core.signatures.witness` | Signature, Approver, WitnessSignature |
| Users | `core.users`, `core.users.roles`, `core.users.groups`, `core.users.sites` | PsUser, Role, Workgroup, Site |
| Authentication | `core.authentication`, `core.authentication.signing` | AuthenticationService, SigningKey |
| Search | `core.search`, `core.search.lucene` | SearchService, LuceneIndex |
| Submission | `core.submission`, `core.submission.handler` | SubmissionService, SubmissionHandler |
| Repository | `core.repository`, `core.repository.document`, `core.repository.daily` | RepositoryService, DailyDirectory |
| PDF | `core.pdf` | PdfService, PdfStamper |
| Metadata | `core.metadata`, `core.metadata.definition`, `core.metadata.field` | MetadataDefinition, MetadataField |
| Security | `core.security`, `core.security.teams`, `core.security.classification` | SecurityService, Team |
| Thumbnails | `core.thumbnails` | ThumbnailService |
| Sequences | `core.sequences` | SequenceService |
| Tagging | `core.tagging` | TagService |
| Templates | `core.templates` | TemplateService |
| Workflow | `core.workflow` | WorkflowService |
| Exchange | `core.exchange` | ExchangeService |
| Notifications | `core.notifications` | NotificationService |
| Events | `core.events` | EventService |
| Enrichment | `core.enrichment` | EnrichmentService |
| OCR | `core.ocr` | OcrService |
| Reporting | `core.reporting`, `core.reporting.activity` | ReportingService, ActivityReport |
| Config | `core.config`, `core.config.settings` | ConfigService, Settings |
| Database | `core.database`, `core.database.hibernate` | DataStoreService |
| License | `core.license` | LicenseService |

### Key package mappings (web)

| Domain area | Java package |
|---|---|
| Controllers (UI) | `web.ui.*` (e.g. `web.ui.documents`, `web.ui.admin.users`) |
| API controllers | `web.api.*` (e.g. `web.api.documents`, `web.api.users`) |
| Filters | `web.filters` |
| Security | `web.security` |
| Views (JSP) | `web/src/main/webapp/WEB-INF/views/*` |

### Search strategy

1. **Start broad** — `rg <keyword> /workspaces/patentsafe -t java -l | head -20`. Use class names, annotations, URL patterns, or domain terms.
2. **Narrow to the domain package** — once you identify the relevant package, read the key service and model classes.
3. **Follow the layers** — for a complete picture, find:
   - **Model/entity** — in `core` (the domain object, Hibernate entity)
   - **Service** — in `core` (business logic)
   - **DAO** — in `core` (data access, if separate from service)
   - **Controller** — in `web.ui` (UI) or `web.api` (REST API)
   - **Views** — in `web/src/main/webapp/WEB-INF/views/` (JSP templates)
   - **Tests** — in corresponding `src/test/java/` directories
4. **Check `common/`** for cross-cutting concerns (email, security, persistence, sessions).

## Step 3: Read and understand the key files

Focus on:
- Public methods and their behaviour
- Business rules and validation
- Edge cases visible in conditional logic or comments
- Configuration and default values
- How the feature interacts with other features

## Step 4: Produce structured output

Present findings in **two formats**. The caller picks whichever they need.

### Format A — issue Java reference (for Linear issues)

```markdown
## Java reference

* `core/src/main/java/com/openeln/patentsafe/core/{path}/{File}.java` — {what it does}
* `web/src/main/java/com/openeln/patentsafe/web/{path}/{File}.java` — {controller/API}
* `web/src/main/webapp/WEB-INF/views/{path}/{template}.jsp` — {view}

<details>
<summary>Behavioural summary (for planning context)</summary>

### Key behaviours to preserve

- {Behaviour 1 — concrete, verifiable}
- {Behaviour 2}
- ...

### Intentional divergences

{Java behaviours that should NOT be reproduced in Rails, with reasons. If none: "None — full parity intended".}

### Edge cases worth noting

- {Edge case from the Java source that an implementer might miss}

</details>
```

### Format B — plan Java Alignment table (for minor plans)

```markdown
## Java Alignment

| Aspect | Java | Rails | Aligned? |
|--------|------|-------|----------|
| {Behaviour from "Key behaviours to preserve"} | {How Java does it} | {How Rails will do it} | Yes / Intentional divergence |
```

The "Rails" column may be `{TBD — plan will specify}` if you don't know the planned implementation yet.

## Private and internal dependencies

The Java app depends on private packages whose source is **not** in the mounted repo. They use `com.openeln` (sometimes `com.amphora`) group IDs. The repo names sometimes use the `oec` prefix.

### Known private packages not in the mounted repo

| Package | Domain | Repo hint |
|---|---|---|
| `com.openeln.common.crypto` | Encryption, digests, digital signatures | `oec-crypto` |
| `com.openeln.common.drawing` | Drawing primitives (fonts, rectangles, text blocks) | — |
| `com.openeln.common.eworkbook` | E-WorkBook integration | — |
| `com.openeln.common.ipp` | Internet Printing Protocol | — |
| `com.openeln.common.ldap` | LDAP authentication and directory lookup | — |
| `com.openeln.common.pdf` | PDF creation, rendering, text extraction, page info | — |
| `com.openeln.common.platform` | OS detection, external command execution | — |
| `com.openeln.common.pwg` | PWG raster format | — |
| `com.openeln.common.utils` | Utility classes (strings, dates, file I/O, streams) | — |

### Packages that ARE in the mounted repo (don't confuse with private)

- `com.openeln.common.xml` — in `common/persistence/src/main/java/`
- `com.openeln.common.misc` — in `core/src/main/java/`
- `com.openeln.common.network` — in `core/src/main/java/`
- `com.openeln.common.rendering` — in `core/src/main/java/`
- All modules under `common/` (alerts, configlets, email, file, http-security, lpd, persistence, saml, session)

### Hitting a dependency you cannot read

**Rule: if you cannot locate the source for an import under `/workspaces/patentsafe/`, stop.**

This applies to:
- The known private packages above
- Any other `com.openeln`, `com.amphora`, or `oec` import whose source you can't find — the table above is not exhaustive
- Any import from an unfamiliar group ID that doesn't resolve to a well-known public library (Spring, Hibernate, Apache Commons, Guava, Jackson)

**Do not guess at behaviour or infer from the class name.** Call `report_status('blocked', 'Cannot resolve <import> in <calling class>')` and stop. `note` the specific import, the class that uses it, and the behaviour you were trying to understand. The user can point you at the source, the docs, or the spec.

## Important notes

- Use paths relative to `/workspaces/patentsafe/` in your output (e.g. `core/src/main/java/...`, not the absolute path).
- If no Java equivalent exists, say so explicitly: `N/A — no Java equivalent` with a brief reason. This is a valid and expected outcome.
- Focus on **behaviour**, not Java implementation details. The Rails implementation will use different patterns — what matters is what the feature *does*, not how Java's DI or Hibernate makes it work.
- Include test files when they reveal important edge cases not obvious from the source.
- When Java code references configuration files (XML, properties), note the config values that affect behaviour.
