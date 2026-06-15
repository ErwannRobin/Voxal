# Release Workflow

## Local release command

```sh
make release
```

Or force a version:

```sh
make release VERSION=1.2.0
```

`make release` syncs the version across:

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- `src/version.js` (with build date update)

## CI release builds

Publishing a GitHub release triggers platform workflows:

- Windows artifacts (`.github/workflows/release-windows.yml`)
- Linux artifacts (`.github/workflows/release-linux.yml`)

These upload platform assets to the same release tag.

## Signing notes

- Desktop updater artifacts require valid Tauri signing secrets.
- On macOS, ad-hoc signed apps are often blocked by Gatekeeper for end users.
- `make release` protects against publishing ad-hoc DMGs by default; override explicitly if needed.

## Useful commands

```sh
make build          # Full Tauri release build
make build-signed   # Release build with updater signing key
make check          # Fast Rust type-check
npm test            # Rust + e2e tests
```
