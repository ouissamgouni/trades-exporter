# Contributing to TradeTrail

Thanks for your interest in improving TradeTrail (repository `trades-exporter`).
This document explains how to contribute and the legal terms that apply to
contributions.

## License and contribution terms

- The project is licensed under the **GNU Affero General Public License v3.0**
  (AGPL-3.0). See [LICENSE](LICENSE).
- Every commit must be signed off under the
  **[Developer Certificate of Origin](DCO)** (DCO 1.1).
- By contributing you also agree to the
  **[Contributor License Agreement](CLA.md)**, which lets the maintainer offer
  a dual-licensed (hosted / commercial) edition while the public source stays
  AGPL-3.0.

### Signing off your commits (DCO)

Add a `Signed-off-by` line to every commit using your real name and email:

```bash
git commit -s -m "Short, descriptive message"
```

This appends a trailer like:

```
Signed-off-by: Jane Doe <jane@example.com>
```

To sign off a range of existing commits before opening a pull request:

```bash
git rebase --signoff main
```

Pull requests with unsigned commits cannot be merged.

## Development workflow

See [docs/DEVELOPMENT_WORKFLOW.md](docs/DEVELOPMENT_WORKFLOW.md) for the full
local setup. In short:

```bash
task install     # install backend and frontend dependencies
task start:dev   # run the development stack
```

Before opening a pull request, run the relevant checks:

```bash
task test               # full test suite
task test:unit:backend  # backend unit tests
task test:unit:frontend # frontend unit tests
```

## Pull request guidelines

- Keep changes focused; one logical change per pull request.
- Include tests for new behavior and bug fixes where practical.
- Update documentation in [docs/](docs) when behavior or workflows change.
- Ensure the test suite passes and all commits are signed off.

## Reporting issues

Open a GitHub issue with clear reproduction steps, expected vs. actual
behavior, and environment details. Please do not include real credentials,
API keys, or personal financial data in issues or pull requests.
