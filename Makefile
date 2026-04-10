.PHONY: help run run-web dev build build-web install clean lint check \
        cap-sync cap-ios cap-android

# Default target
help:
	@echo "push2talk — available targets:"
	@echo ""
	@echo "  run          Start the Tauri desktop app (release)"
	@echo "  run-web      Serve the web version locally on http://localhost:8080"
	@echo "  dev          Start Tauri in dev mode (hot reload)"
	@echo "  build        Build the Tauri desktop app (release binary)"
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
	./src-tauri/target/release/push2talk

dev:
	npm run tauri dev

build:
	npm run tauri build

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
