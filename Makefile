.PHONY: help run run-web dev debug build build-debug build-signed build-web install clean lint check test \
        test-rust test-e2e \
        cap-sync cap-ios cap-android build-android docs release

# Default target
help:
	@echo "voxal — available targets:"
	@echo ""
	@echo "  run          Start the Tauri desktop app (release)"
	@echo "  run-web      Serve the web version locally on http://localhost:8080"
	@echo "  dev          Start Tauri in dev mode (hot reload, no URL scheme)"
	@echo "  debug        Build debug bundle if needed, then launch it"
	@echo "  build        Build the Tauri desktop app (release binary)"
	@echo "  build-signed Build release with updater signing (requires key)"
	@echo "  build-debug  Build the Tauri desktop app (debug bundle — registers voxal:// scheme)"
	@echo "  build-web    Bundle the web version into dist/"
	@echo "  cap-sync     Sync web assets to iOS & Android"
	@echo "  cap-ios      Open Xcode (iOS)"
	@echo "  cap-android  Open Android Studio"
	@echo "  build-android Build signed release AAB for Google Play"
	@echo "  install      Check prereqs, then install npm + Rust dependencies"
	@echo "  release      Build signed release and publish to GitHub (requires gh CLI)"
	@echo "  docs         Serve architecture flow docs on http://localhost:8090"
	@echo "  check        Run Rust type-check (no binary)"
	@echo "  test         Run all test suites (check + Rust tests + Playwright)"
	@echo "  test-rust    Run Rust unit tests"
	@echo "  test-e2e     Run Playwright E2E tests"
	@echo "  clean        Remove build artifacts"
	@echo ""

# ── Desktop (Tauri) ───────────────────────────────────────────────────────────

run:
	npm run tauri build -- --no-bundle
	./src-tauri/target/release/voxal

dev:
	npm run tauri dev

# Build and run the debug .app bundle (registers voxal:// URL scheme).
# Rebuilds only when Rust sources or config have changed.
debug:
	@APP="src-tauri/target/debug/bundle/macos/Voxal.app"; \
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
	echo "→ Launching Voxal (debug)..."; \
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
	@echo "Debug bundle: src-tauri/target/debug/bundle/macos/Voxal.app"
	@echo "Open it once to register the voxal:// URL scheme with macOS."

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

build-android: cap-sync
	@JAVA_HOME="$$( /usr/libexec/java_home 2>/dev/null || echo /opt/homebrew/Cellar/openjdk/26.0.1/libexec/openjdk.jdk/Contents/Home )"; \
	export JAVA_HOME; \
	cd android && ./gradlew bundleRelease
	@echo ""
	@echo "Signed AAB: android/app/build/outputs/bundle/release/app-release.aab"
	@echo "Upload this file to Google Play Console."

# ── Misc ──────────────────────────────────────────────────────────────────────

install:
	@missing=0; \
	if ! command -v npm >/dev/null 2>&1; then \
		echo "Error: npm not found."; \
		echo "Install Node.js 18+ first: https://nodejs.org/"; \
		echo "Or, if you have Homebrew: brew install node"; \
		missing=1; \
	fi; \
	if ! command -v cargo >/dev/null 2>&1; then \
		echo "Error: cargo not found."; \
		echo "Install Rust with rustup: curl https://sh.rustup.rs -sSf | sh"; \
		missing=1; \
	fi; \
	if ! xcode-select -p >/dev/null 2>&1; then \
		echo "Error: Xcode Command Line Tools are missing."; \
		echo "Install them with: xcode-select --install"; \
		missing=1; \
	fi; \
	if [ "$$missing" -ne 0 ]; then \
		echo ""; \
		echo "After installing the missing tools, rerun: make install"; \
		exit 1; \
	fi
	@echo "→ Installing npm dependencies..."
	npm install
	@echo "→ Fetching Rust crates..."
	cd src-tauri && cargo fetch

# Build a signed release and publish it as a GitHub Release.
# If VERSION is set (for example: make release VERSION=1.2.3), it syncs:
# - package.json version
# - src-tauri/tauri.conf.json version
# - src-tauri/Cargo.toml version
# - android/app/build.gradle versionName
# and increments android/app/build.gradle versionCode by 1.
# Without VERSION, it auto-bumps patch version from tauri.conf.json.
release:
	@command -v gh >/dev/null 2>&1 || { echo "Error: gh CLI not installed (https://cli.github.com)"; exit 1; }
	@if [ -z "$$TAURI_SIGNING_PRIVATE_KEY" ] && [ ! -f ~/.tauri/voxal.key ]; then \
		echo "Error: No signing key found."; \
		echo "Set TAURI_SIGNING_PRIVATE_KEY or place key at ~/.tauri/voxal.key"; \
		exit 1; \
	fi
	@CURRENT_VERSION=$$(grep '"version"' src-tauri/tauri.conf.json | head -1 | sed 's/.*: *"//;s/".*//'); \
	NEW_VERSION="$(VERSION)"; \
	if [ -z "$$NEW_VERSION" ]; then \
		NEW_VERSION=$$(node --input-type=module -e "const v='$$CURRENT_VERSION'; const m=v.match(/^([0-9]+)\.([0-9]+)\.([0-9]+)$$/); if (!m) { process.exit(1); } console.log(m[1] + '.' + m[2] + '.' + (Number(m[3]) + 1));") || { \
			echo "Error: could not auto-bump version from '$$CURRENT_VERSION'. Use make release VERSION=x.y.z"; \
			exit 1; \
		}; \
	fi; \
	echo "$$NEW_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$$' || { \
		echo "Error: VERSION must be semver x.y.z (got '$$NEW_VERSION')"; \
		exit 1; \
	}; \
	if [ "$$NEW_VERSION" != "$$CURRENT_VERSION" ]; then \
		echo "→ Syncing release version $$CURRENT_VERSION → $$NEW_VERSION"; \
	else \
		echo "→ Using existing version $$NEW_VERSION"; \
	fi; \
	NEW_VERSION="$$NEW_VERSION" perl -i -pe 's/("version"\s*:\s*")[^"]+(")/$$1.$$ENV{NEW_VERSION}.$$2/e if !$$done++' package.json; \
	NEW_VERSION="$$NEW_VERSION" perl -i -pe 's/("version"\s*:\s*")[^"]+(")/$$1.$$ENV{NEW_VERSION}.$$2/e if !$$done++' src-tauri/tauri.conf.json; \
	NEW_VERSION="$$NEW_VERSION" perl -i -pe 's/^(version\s*=\s*")[^"]+(")/$$1.$$ENV{NEW_VERSION}.$$2/e if !$$done++' src-tauri/Cargo.toml; \
	NEW_VERSION="$$NEW_VERSION" perl -i -pe 's/^(\s*versionName\s+)"[^"]+"/$$1 . "\"" . $$ENV{NEW_VERSION} . "\""/e' android/app/build.gradle; \
	if [ "$$NEW_VERSION" != "$$CURRENT_VERSION" ]; then \
		perl -i -pe 's/^(\s*versionCode\s+)(\d+)/$$1.($$2+1)/e' android/app/build.gradle; \
	fi; \
	echo "→ Updated package.json, tauri.conf.json, Cargo.toml, and Android version fields"; \
	VERSION="$$NEW_VERSION"; \
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
	echo '{ "version": "'$$VERSION'", "platforms": { "darwin-aarch64": { "url": "https://github.com/ErwannRobin/Voxal/releases/download/v'$$VERSION'/'$$APP_TAR_NAME'", "signature": "'$$SIG_CONTENT'" }, "darwin-x86_64": { "url": "https://github.com/ErwannRobin/Voxal/releases/download/v'$$VERSION'/'$$APP_TAR_NAME'", "signature": "'$$SIG_CONTENT'" } } }' > $$BUNDLE_DIR/latest.json; \
	echo "→ Creating signed git tag v$$VERSION…"; \
	git tag -s "v$$VERSION" -m "Voxal v$$VERSION" 2>/dev/null || git tag -f -s "v$$VERSION" -m "Voxal v$$VERSION"; \
	git push origin "v$$VERSION" --force; \
	echo "→ Creating GitHub release v$$VERSION…"; \
	MOBILE_ZIP="src-tauri/target/release/bundle/voxal-mobile-$$VERSION.zip"; \
	(cd src && zip -qr "../$$MOBILE_ZIP" .); \
	MOBILE_CHECKSUM=$$(shasum -a 256 "$$MOBILE_ZIP" | cut -d' ' -f1); \
	echo '{"version":"'$$VERSION'","url":"https://github.com/ErwannRobin/Voxal/releases/download/v'$$VERSION'/voxal-mobile-'$$VERSION'.zip","checksum":"'$$MOBILE_CHECKSUM'"}' > src-tauri/target/release/bundle/mobile-update.json; \
	ASSETS="$$APP_TAR $$SIG $$BUNDLE_DIR/latest.json $$MOBILE_ZIP src-tauri/target/release/bundle/mobile-update.json"; \
	if [ -n "$$DMG" ]; then ASSETS="$$ASSETS $$DMG"; fi; \
	gh release create "v$$VERSION" $$ASSETS \
		--title "Voxal v$$VERSION" \
		--generate-notes; \
	echo "✓ Published v$$VERSION to GitHub Releases (desktop + mobile OTA)"

check:
	cd src-tauri && cargo check

test: check test-rust test-e2e

test-rust:
	npm run test:rust

test-e2e:
	npm run test:e2e

clean:
	cd src-tauri && cargo clean
	rm -rf dist node_modules/.cache

# ── Documentation ─────────────────────────────────────────────────────────────

docs:
	@echo "Serving architecture docs on http://localhost:8090"
	@open http://localhost:8090/architecture.html 2>/dev/null || true
	python3 -m http.server 8090 -d docs
