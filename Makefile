.PHONY: help run run-web dev debug build build-debug build-signed build-web install clean lint check \
        cap-sync cap-ios cap-android docs release

# Default target
help:
	@echo "voxel — available targets:"
	@echo ""
	@echo "  run          Start the Tauri desktop app (release)"
	@echo "  run-web      Serve the web version locally on http://localhost:8080"
	@echo "  dev          Start Tauri in dev mode (hot reload, no URL scheme)"
	@echo "  debug        Build debug bundle if needed, then launch it"
	@echo "  build        Build the Tauri desktop app (release binary)"
	@echo "  build-signed Build release with updater signing (requires key)"
	@echo "  build-debug  Build the Tauri desktop app (debug bundle — registers voxel:// scheme)"
	@echo "  build-web    Bundle the web version into dist/"
	@echo "  cap-sync     Sync web assets to iOS & Android"
	@echo "  cap-ios      Open Xcode (iOS)"
	@echo "  cap-android  Open Android Studio"
	@echo "  install      Install npm + Rust dependencies"
	@echo "  release      Build signed release and publish to GitHub (requires gh CLI)"
	@echo "  docs         Serve architecture flow docs on http://localhost:8090"
	@echo "  check        Run Rust type-check (no binary)"
	@echo "  clean        Remove build artifacts"
	@echo ""

# ── Desktop (Tauri) ───────────────────────────────────────────────────────────

run:
	npm run tauri build -- --no-bundle
	./src-tauri/target/release/voxel

dev:
	npm run tauri dev

# Build and run the debug .app bundle (registers voxel:// URL scheme).
# Rebuilds only when Rust sources or config have changed.
debug:
	@APP="src-tauri/target/debug/bundle/macos/Voxel.app"; \
	NEEDS_BUILD=0; \
	if [ ! -d "$$APP" ]; then \
		NEEDS_BUILD=1; \
	elif [ "src-tauri/src/lib.rs"         -nt "$$APP" ] || \
	     [ "src-tauri/src/main.rs"        -nt "$$APP" ] || \
	     [ "src-tauri/Cargo.toml"         -nt "$$APP" ] || \
	     [ "src-tauri/tauri.conf.json"    -nt "$$APP" ] || \
	     [ "src-tauri/entitlements.plist" -nt "$$APP" ] || \
	     [ "src-tauri/Info.plist"         -nt "$$APP" ] || \
	     find src/ -newer "$$APP" | grep -q .; then \
		NEEDS_BUILD=1; \
	fi; \
	if [ "$$NEEDS_BUILD" = "1" ]; then \
		echo "→ Building debug bundle..."; \
		npm run tauri build -- --debug || exit 1; \
	else \
		echo "→ Bundle up to date, skipping build."; \
	fi; \
	echo "→ Launching Voxel (debug)..."; \
	open "$$APP"

build:
	npm run tauri build

build-signed:
	@export TAURI_SIGNING_PRIVATE_KEY="$${TAURI_SIGNING_PRIVATE_KEY:-$$(cat ~/.tauri/voxal.key 2>/dev/null)}"; \
	if [ -z "$$TAURI_SIGNING_PRIVATE_KEY" ]; then \
		echo "Error: No signing key found."; exit 1; \
	fi; \
	if [ -z "$$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" ]; then \
		printf "Signing key password: "; \
		read -s TAURI_SIGNING_PRIVATE_KEY_PASSWORD; echo; \
		export TAURI_SIGNING_PRIVATE_KEY_PASSWORD; \
	fi; \
	npm run tauri build

build-debug:
	npm run tauri build -- --debug
	@echo ""
	@echo "Debug bundle: src-tauri/target/debug/bundle/macos/Voxel.app"
	@echo "Open it once to register the voxel:// URL scheme with macOS."

# ── Web ───────────────────────────────────────────────────────────────────────

run-web:
	@command -v npx >/dev/null 2>&1 || { echo "npx not found — install Node.js"; exit 1; }
	@echo "Serving web app on http://localhost:8080"
	npx --yes serve src -l 8080

build-web:
	mkdir -p dist
	cp -r src/* dist/
	@echo "Web app copied to dist/"

# ── Mobile (Capacitor) ────────────────────────────────────────────────────────

cap-sync:
	npx cap sync

cap-ios: cap-sync
	npx cap open ios

cap-android: cap-sync
	npx cap open android

# ── Misc ──────────────────────────────────────────────────────────────────────

install:
	npm install
	cd src-tauri && cargo fetch

# Build a signed release and publish it as a GitHub Release.
# Reads version from tauri.conf.json. Creates a latest.json manifest for the updater.
release:
	@command -v gh >/dev/null 2>&1 || { echo "Error: gh CLI not installed (https://cli.github.com)"; exit 1; }
	@if [ -z "$$TAURI_SIGNING_PRIVATE_KEY" ] && [ ! -f ~/.tauri/voxal.key ]; then \
		echo "Error: No signing key found."; \
		echo "Set TAURI_SIGNING_PRIVATE_KEY or place key at ~/.tauri/voxal.key"; \
		exit 1; \
	fi
	@VERSION=$$(grep '"version"' src-tauri/tauri.conf.json | head -1 | sed 's/.*: *"//;s/".*//'); \
	echo "→ Building Voxal v$$VERSION (signed release)…"; \
	export TAURI_SIGNING_PRIVATE_KEY="$${TAURI_SIGNING_PRIVATE_KEY:-$$(cat ~/.tauri/voxal.key)}"; \
	if [ -z "$$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" ]; then \
		printf "Signing key password: "; \
		read -s TAURI_SIGNING_PRIVATE_KEY_PASSWORD; echo; \
		export TAURI_SIGNING_PRIVATE_KEY_PASSWORD; \
	fi; \
	npm run tauri build || exit 1; \
	BUNDLE_DIR="src-tauri/target/release/bundle"; \
	DMG=$$(find $$BUNDLE_DIR/dmg -name '*.dmg' 2>/dev/null | head -1); \
	APP_TAR=$$(find $$BUNDLE_DIR/macos -name '*.app.tar.gz' 2>/dev/null | head -1); \
	SIG=$$(find $$BUNDLE_DIR/macos -name '*.app.tar.gz.sig' 2>/dev/null | head -1); \
	if [ -z "$$APP_TAR" ] || [ -z "$$SIG" ]; then \
		echo "Error: Signed bundle not found."; \
		exit 1; \
	fi; \
	SIG_CONTENT=$$(cat "$$SIG"); \
	APP_TAR_NAME=$$(basename "$$APP_TAR"); \
	echo '{ "version": "'$$VERSION'", "platforms": { "darwin-aarch64": { "url": "https://github.com/ErwannRobin/Voxel/releases/download/v'$$VERSION'/'$$APP_TAR_NAME'", "signature": "'$$SIG_CONTENT'" }, "darwin-x86_64": { "url": "https://github.com/ErwannRobin/Voxel/releases/download/v'$$VERSION'/'$$APP_TAR_NAME'", "signature": "'$$SIG_CONTENT'" } } }' > $$BUNDLE_DIR/latest.json; \
	echo "→ Creating GitHub release v$$VERSION…"; \
	ASSETS="$$APP_TAR $$SIG $$BUNDLE_DIR/latest.json"; \
	if [ -n "$$DMG" ]; then ASSETS="$$ASSETS $$DMG"; fi; \
	gh release create "v$$VERSION" $$ASSETS \
		--title "Voxal v$$VERSION" \
		--generate-notes; \
	echo "✓ Published v$$VERSION to GitHub Releases"

check:
	cd src-tauri && cargo check

clean:
	cd src-tauri && cargo clean
	rm -rf dist node_modules/.cache

# ── Documentation ─────────────────────────────────────────────────────────────

docs:
	@echo "Serving architecture docs on http://localhost:8090"
	@open http://localhost:8090/architecture.html 2>/dev/null || true
	python3 -m http.server 8090 -d docs
