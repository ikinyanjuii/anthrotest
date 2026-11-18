# AnthroTest — Feature Intelligence System

This repository contains the Feature Intelligence assessment project in [feature-intel/](feature-intel/).

The TypeScript/Express application source, scripts, static web UI, evaluation dataset, configuration and setup guide are available directly in that folder. Start with [feature-intel/README.md](feature-intel/README.md).

The project uses Anthropic Claude for feature-request triage, optional Voyage embeddings for semantic retrieval, and SQLite for local persistence. It also includes offline smoke tests and a labelled evaluation harness.

**Security:** The assessment MVP does not implement authentication or authorization. Do not expose it publicly or use real customer data without adding access controls, rate limiting, managed secrets and production hardening. The real `.env` file and API credentials are intentionally not included.
