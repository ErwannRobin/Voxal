.PHONY: help run run-web dev debug build build-debug build-web install clean lint check \
        cap-sync cap-ios cap-android

# Default target
help:
	@echo "voxel — available targets:"
	@echo ""
	@echo "  run          Start the Tauri desktop app (release)"
	@echo "  run-web      Serve the web version locally on http://localhost:8080"
	@echo "  dev          Start Tauri in dev mode (hot reload, no URL scheme)"
	@echo "  debug        Build debug bundle if needed, then launch it"
	@echo "  build        Build the Tauri desktop app (release binary)"
	@echo "  build-debug  Build the Tauri desktop app (debug bundle — registers voxel:// scheme)"
	@echo "  build-web    Bundle the web version into dist/"
	@echo "  cap-sync     Sync web assets to iOS & Android"
	@echo "  cap-ios      Open Xcode (iOS)"
	@echo "  cap-android  Open Android Studio"
	@echo "  install      Install npm + Rust dependencies"
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

check:
	cd src-tauri && cargo check

clean:
	cd src-tauri && cargo clean
	rm -rf dist node_modules/.cache
