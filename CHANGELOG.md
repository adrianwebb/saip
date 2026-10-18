# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]
### Fixed
- XML context pack now strict well-formed (parsableStyle) — raw doc content no longer breaks XML parsers (#16)
- Download for AI button contrast: accent-colored bold text on subtle surface replaces white-on-light-blue fill (#16)
- Download for AI header menu no longer renders permanently open; panel closes correctly (#13)

### Added
- training: `learning-api` Cordis plugin — Learning API honors adapter registry linkage (inherit strategy + data_scopes, override per-job) and rejects composites/unknown adapters with documented status codes (#24)
- inference: `adapter-compiler` Cordis plugin — composite compile planning, version resolution (pins + @latest), staleness detection, and provenance records; Python/PEFT merge execution behind a swappable backend (#23)
- shared: Cordis `AdapterRegistryService` + registry validator (`validateRegistry`) — single source of truth for adapter registry rules, consumed by CLI/inference/training (#22)
- Adapter registry architecture: first-class `adapters:` definitions with scopes, composite user adapters (weighted components + gain), and formal adapter→strategy→data-scope linkage (#19)
- All four Node packages (`cli`, `shared`, `inference`, `training`) documented as Cordis-based — everything is a plugin or injectable shared service (#19)
- Download for AI: Repomix context packs (XML/Markdown/JSON) at stable URLs with header selector (#10)
- Project architecture documentation and README (#1)
- Shared configuration schema (saip.yaml, saip.schema.yaml) (#1)
- CLI skeleton with awake/sleep/down/status commands (#1)
- Docker Compose scaffolds for inference and training services (#1)
- Issue templates and GitHub labels (#1)
- Agent loop guard and HTTPS remote protocol in workflow (#1)
- Changelog convention and monorepo guidance (#1)
