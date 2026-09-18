.PHONY: help run run-web gen-build-info dev debug build build-debug build-signed build-web install clean lint check test \
        test-rust test-api test-e2e test-mesh coverage coverage-rust coverage-e2e \
        coverage-api coverage-summary coverage-badge bench bench-audio bench-report \
        cap-sync cap-ios cap-android build-android docs release release-official release-core sync-version \
        seg-assets emoji-data

# Default target
help:
	@echo "voxal — available targets:"
	@echo ""
	@echo "  run          Start the Tauri desktop app (release)"
	@echo "  run-web      Serve the web version locally on http://localhost:8080"
	@echo "  dev          Start Tauri in dev mode (hot reload, no URL scheme)"
	@echo "  debug        Build debug bundle if needed, then launch it"
	@echo "  build        Build the Tauri desktop app (release binary, unsigned — no key needed)"
	@echo "  build-signed Build release with updater signing (requires key)"
	@echo "  build-debug  Build the Tauri desktop app (debug bundle — registers voxal:// scheme)"
	@echo "  build-web    Bundle the web version into dist/"
	@echo "  seg-assets   Stage the background-effects runtime into src/assets/seg"
	@echo "  cap-sync     Sync web assets to iOS & Android"
	@echo "  cap-ios      Open Xcode (iOS)"
	@echo "  cap-android  Open Android Studio"
	@echo "  build-android Build signed release AAB for Google Play"
	@echo "  install      Check prereqs, then install npm + Rust dependencies"
	@echo "  release      Build signed release and publish to GitHub (ad-hoc DMG signature allowed)"
	@echo "  release-official Same as release, but refuses an ad-hoc-signed DMG (requires Developer ID)"
	@echo "  sync-version Sync package.json/Cargo.toml/version.js/Android/iOS to tauri.conf.json's version (no bump, no commit)"
	@echo "  docs         Serve architecture flow docs on http://localhost:8090"
	@echo "  check        Run Rust type-check (no binary)"
	@echo "  test         Run all test suites (check + Rust tests + Playwright)"
	@echo "  test-rust    Run Rust unit tests"
	@echo "  test-e2e     Run fast Playwright E2E tests (unit project)"
	@echo "  test-mesh    Run multi-peer WebRTC E2E tests (mesh project)"
	@echo "  coverage     Generate Rust + E2E + API coverage reports"
	@echo "  coverage-rust Generate Rust coverage report (cargo-llvm-cov)"
	@echo "  coverage-e2e Generate E2E JS coverage report (Playwright + monocart)"
	@echo "  coverage-api Generate API handler coverage (node --test)"
	@echo "  coverage-summary Print one markdown summary of whatever has been measured"
	@echo "  coverage-badge Re-measure main.js and rewrite the README coverage badge"
	@echo "  bench        Run the performance benchmark, then write an HTML dashboard + CSV"
	@echo "  bench-report Re-render the newest run (HTML + CSV + markdown), without re-measuring"
	@echo "  clean        Remove build artifacts"
	@echo ""

# ── Desktop (Tauri) ───────────────────────────────────────────────────────────

run: seg-assets
	npm run tauri build -- --no-bundle
	./src-tauri/target/release/voxal

dev: seg-assets
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
		$(MAKE) gen-build-info; \
		npm run tauri build -- --debug || exit 1; \
	else \
		echo "→ Bundle up to date, skipping build."; \
	fi; \
	echo "→ Launching Voxal (debug)..."; \
	open "$$APP"

build: gen-build-info seg-assets
	@echo "→ Building release (unsigned, no updater artifacts). Use 'make build-signed' to sign."
	npm run tauri build -- --config '{"bundle":{"createUpdaterArtifacts":false}}'

build-signed: gen-build-info seg-assets
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

build-debug: gen-build-info seg-assets
	npm run tauri build -- --debug
	@echo ""
	@echo "Debug bundle: src-tauri/target/debug/bundle/macos/Voxal.app"
	@echo "Open it once to register the voxal:// URL scheme with macOS."

# ── Web ───────────────────────────────────────────────────────────────────────

# Stamps src/build-info.js with the real commit + build timestamp, consumed
# by about.html / settings.html / the in-page about modal. Used by the web
# build (mirroring what Vercel generates via vercel.json's buildCommand, since
# deployed src/ is served as-is with no `make` step) and by every native
# build (Tauri via build/build-debug/build-signed, Capacitor via cap-sync).
gen-build-info:
	@COMMIT=$$(git rev-parse --short HEAD); \
	BUILD_DATE=$$(date -u +%FT%TZ); \
	echo "window.VOXAL_COMMIT='$$COMMIT';window.VOXAL_WEB_BUILD_DATE='$$BUILD_DATE';" > src/build-info.js

# Regenerates src/emoji-data.js (the chat picker's catalog) from Unicode's own
# emoji-test.txt. Committed output — this is not part of any build; run it when
# a new Unicode emoji release is worth picking up.
emoji-data:
	@node scripts/gen-emoji-data.mjs

# Stages the ~12 MB MediaPipe vision runtime into src/assets/seg/. The copy
# itself lives in seg-assets.sh so this target and the Vercel deploy
# (vercel-build.sh) share one definition of it — see docs/video-effects.md.
seg-assets:
	@sh seg-assets.sh

run-web: gen-build-info seg-assets
	@command -v npx >/dev/null 2>&1 || { echo "npx not found — install Node.js"; exit 1; }
	@mkdir -p src/.well-known/appspecific
	@[ -f .devtools-workspace-uuid ] || uuidgen > .devtools-workspace-uuid
	@printf '{"workspace":{"root":"%s","uuid":"%s"}}\n' "$$(pwd)" "$$(cat .devtools-workspace-uuid)" \
		> src/.well-known/appspecific/com.chrome.devtools.json
	@echo "Serving web app on http://localhost:8080"
	npx --yes serve src -l 8080

build-web: gen-build-info seg-assets
	mkdir -p dist
	cp -r src/* dist/
	@echo "Web app copied to dist/"

# ── Mobile (Capacitor) ────────────────────────────────────────────────────────

cap-sync: gen-build-info
	npx cap sync
	@# The vision runtime is fetched from the service at runtime, not shipped:
	@# 12 MB of WASM in every App Store / Play download, for a feature most
	@# users never turn on, is not a trade worth making. The 250 KB model and
	@# the preset artwork stay bundled — those are small and save a round-trip.
	@rm -f ios/App/App/public/assets/seg/vision_* \
	      android/app/src/main/assets/public/assets/seg/vision_*

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
	@$(MAKE) --no-print-directory seg-assets

# Build a signed release and publish it as a GitHub Release.
# If VERSION is set (for example: make release VERSION=1.2.3), it syncs:
# - package.json version
# - src-tauri/tauri.conf.json version
# - src-tauri/Cargo.toml version
# - src/version.js VOXAL_VERSION + VOXAL_BUILD_DATE
# - android/app/build.gradle versionName
# and increments android/app/build.gradle versionCode by 1.
# Without VERSION, it auto-bumps patch version from tauri.conf.json.
#
# "release" allows an ad-hoc-signed DMG (ALLOW_ADHOC_DMG=1 by default).
# "release-official" refuses ad-hoc signing — use it once Developer ID
# signing/notarization is configured.
release:
	@$(MAKE) release-core ALLOW_ADHOC_DMG=1

release-official:
	@$(MAKE) release-core ALLOW_ADHOC_DMG=

release-core:
	@command -v gh >/dev/null 2>&1 || { echo "Error: gh CLI not installed (https://cli.github.com)"; exit 1; }
	@git diff --quiet && git diff --cached --quiet || { \
		echo "Error: working tree has uncommitted changes. Commit or stash before releasing."; \
		exit 1; \
	}
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
	BUILD_DATE=$$(date +%F); \
	NEW_VERSION="$$NEW_VERSION" perl -i -pe 's/("version"\s*:\s*")[^"]+(")/$$1.$$ENV{NEW_VERSION}.$$2/e' package.json; \
	NEW_VERSION="$$NEW_VERSION" perl -i -pe 's/("version"\s*:\s*")[^"]+(")/$$1.$$ENV{NEW_VERSION}.$$2/e' src-tauri/tauri.conf.json; \
	NEW_VERSION="$$NEW_VERSION" perl -i -pe 's/^(version\s*=\s*")[^"]+(")/$$1.$$ENV{NEW_VERSION}.$$2/e' src-tauri/Cargo.toml; \
	NEW_VERSION="$$NEW_VERSION" perl -i -pe "s/^(const VOXAL_VERSION\\s*=\\s*')[^']+(';)/\$$1.\$$ENV{NEW_VERSION}.\$$2/e" src/version.js; \
	BUILD_DATE="$$BUILD_DATE" perl -i -pe "s/^(const VOXAL_BUILD_DATE\\s*=\\s*')[^']+(';)/\$$1.\$$ENV{BUILD_DATE}.\$$2/e" src/version.js; \
	NEW_VERSION="$$NEW_VERSION" perl -i -pe 's/^(\s*versionName\s+)"[^"]+"/$$1 . "\"" . $$ENV{NEW_VERSION} . "\""/e' android/app/build.gradle; \
	if [ "$$NEW_VERSION" != "$$CURRENT_VERSION" ]; then \
		perl -i -pe 's/^(\s*versionCode\s+)(\d+)/$$1.($$2+1)/e' android/app/build.gradle; \
	fi; \
	NEW_VERSION="$$NEW_VERSION" perl -i -pe 's/(MARKETING_VERSION = )[^;]+;/$$1.$$ENV{NEW_VERSION}.";"/e' ios/App/App.xcodeproj/project.pbxproj; \
	if [ "$$NEW_VERSION" != "$$CURRENT_VERSION" ]; then \
		perl -i -pe 's/(CURRENT_PROJECT_VERSION = )(\d+);/$$1.($$2+1).";"/e' ios/App/App.xcodeproj/project.pbxproj; \
	fi; \
	echo "→ Updated package.json, tauri.conf.json, Cargo.toml, version.js, Android, and iOS version fields"; \
	VERSION="$$NEW_VERSION"; \
	if ! git diff --quiet -- package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src/version.js android/app/build.gradle ios/App/App.xcodeproj/project.pbxproj; then \
		echo "→ Committing and pushing version bump…"; \
		git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src/version.js android/app/build.gradle ios/App/App.xcodeproj/project.pbxproj; \
		git commit -m "publish new release $$VERSION"; \
		git push; \
	fi; \
	echo "→ Building Voxal v$$VERSION (signed release)…"; \
	export TAURI_SIGNING_PRIVATE_KEY="$${TAURI_SIGNING_PRIVATE_KEY:-$$(cat ~/.tauri/voxal.key)}"; \
	if [ -z "$$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" ]; then \
		printf "Signing key password: "; \
		read -s TAURI_SIGNING_PRIVATE_KEY_PASSWORD; echo; \
		export TAURI_SIGNING_PRIVATE_KEY_PASSWORD; \
	fi; \
	npm run tauri build || exit 1; \
	BUNDLE_DIR="src-tauri/target/release/bundle"; \
	APP_DIR=$$(find $$BUNDLE_DIR/macos -maxdepth 1 -name '*.app' -type d 2>/dev/null | head -1); \
	if [ -n "$$APP_DIR" ]; then \
		if codesign -dv --verbose=2 "$$APP_DIR" 2>&1 | grep -q 'Signature=adhoc'; then \
			if [ "$(ALLOW_ADHOC_DMG)" = "1" ]; then \
				echo "Warning: $$APP_DIR is ad-hoc signed; continuing because ALLOW_ADHOC_DMG=1."; \
			else \
				echo "Error: $$APP_DIR is ad-hoc signed."; \
				echo "Configure Developer ID signing/notarization before publishing a DMG,"; \
				echo "or run: make release ALLOW_ADHOC_DMG=1"; \
				exit 1; \
			fi; \
		fi; \
	fi; \
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

sync-version:
	@CURRENT_VERSION=$$(grep '"version"' src-tauri/tauri.conf.json | head -1 | sed 's/.*: *"//;s/".*//'); \
	echo "→ Syncing all platforms to version $$CURRENT_VERSION"; \
	NEW_VERSION="$$CURRENT_VERSION" perl -i -pe 's/("version"\s*:\s*")[^"]+(")/$$1.$$ENV{NEW_VERSION}.$$2/e' package.json; \
	NEW_VERSION="$$CURRENT_VERSION" perl -i -pe 's/^(version\s*=\s*")[^"]+(")/$$1.$$ENV{NEW_VERSION}.$$2/e' src-tauri/Cargo.toml; \
	NEW_VERSION="$$CURRENT_VERSION" perl -i -pe "s/^(const VOXAL_VERSION\\s*=\\s*')[^']+(';)/\$$1.\$$ENV{NEW_VERSION}.\$$2/e" src/version.js; \
	NEW_VERSION="$$CURRENT_VERSION" perl -i -pe 's/^(\s*versionName\s+)"[^"]+"/$$1 . "\"" . $$ENV{NEW_VERSION} . "\""/e' android/app/build.gradle; \
	NEW_VERSION="$$CURRENT_VERSION" perl -i -pe 's/(MARKETING_VERSION = )[^;]+;/$$1.$$ENV{NEW_VERSION}.";"/e' ios/App/App.xcodeproj/project.pbxproj; \
	echo "✓ Synced package.json, Cargo.toml, version.js, Android, and iOS to $$CURRENT_VERSION"

check:
	cd src-tauri && cargo check

test: check test-rust test-api test-e2e

test-rust:
	npm run test:rust

test-api:
	npm run test:api

test-e2e:
	npm run test:e2e

test-mesh:
	npm run test:mesh

# ── Coverage ──────────────────────────────────────────────────────────────────

coverage: coverage-rust coverage-e2e coverage-api
	@echo ""
	@echo "→ Coverage reports generated:"
	@echo "    Rust : src-tauri/target/llvm-cov/html/index.html"
	@echo "    E2E  : coverage/index.html"
	@echo "    API  : coverage-api/lcov.info"
	@$(MAKE) --no-print-directory coverage-summary

# Rust line/region coverage via cargo-llvm-cov.
coverage-rust:
	@if ! cargo llvm-cov --version >/dev/null 2>&1; then \
		echo "✗ cargo-llvm-cov is not installed. Install it once with:"; \
		echo ""; \
		echo "    rustup component add llvm-tools-preview"; \
		echo "    cargo install cargo-llvm-cov"; \
		echo ""; \
		exit 1; \
	fi
	cd src-tauri && cargo llvm-cov --no-report && \
		cargo llvm-cov report --html && \
		cargo llvm-cov report --lcov --output-path target/llvm-cov/lcov.info
	@echo "→ Rust coverage: src-tauri/target/llvm-cov/html/index.html (lcov: src-tauri/target/llvm-cov/lcov.info)"

# Frontend (main.js) V8 coverage collected through Playwright (COVERAGE=1 turns
# on the monocart collector wired into the fixtures). Runs both the unit and
# mesh projects so the multi-peer/migration glue is included in the report.
# The projects are named explicitly: `npx playwright test` with no --project
# would also collect the `bench` project, turning a 3-minute coverage run into a
# 20-minute one and writing benchmark results nobody asked for.
coverage-e2e:
	COVERAGE=1 NODE_OPTIONS=--disable-warning=DEP0205 npx playwright test --project=unit --project=mesh
	@echo "→ E2E coverage: coverage/index.html (lcov: coverage/lcov.info)"

# API handler coverage, straight out of node:test. Its own directory because
# monocart CLEARS coverage/ on every E2E report.
coverage-api:
	npm run test:api:coverage
	@echo "→ API coverage: coverage-api/lcov.info"

# One markdown table over whatever reports exist on disk — the same text the CI
# job puts in its run summary. Safe to run with only some of them present.
coverage-summary:
	@node scripts/coverage-report.mjs

# Refresh the README coverage badge. Deliberately manual, and deliberately
# re-measures first: CI cannot do this (`main` takes no direct push, and a
# workflow's own GITHUB_TOKEN can neither open the pull request nor produce one
# that is mergeable — see KNOWLEDGE/learning.md), so the badge is only ever as
# honest as the last person to run this. Depending on coverage-e2e is what stops
# it publishing a number off a stale report; run the script directly if you know
# the report on disk is current and want to skip the ~3 minutes.
coverage-badge: coverage-e2e
	@node scripts/coverage-report.mjs --write-badge
	@echo "→ README badge updated. Commit README.md to publish it."

# ── Benchmark ─────────────────────────────────────────────────────────────────
#
# Deliberately NOT part of `make test`: it takes minutes, it measures the
# machine as much as the code, and it asserts no thresholds — a number that
# fails a build on a shared CI runner teaches nobody anything. Read
# docs/benchmarking.md before drawing a conclusion from the output.
#
# Tunable without editing anything:
#   BENCH_SIZES=2,4,8   room sizes to sweep          (default 2,3,4,6)
#   BENCH_HOLD_MS=60000 steady-state window per run  (default 30000)
#   BENCH_REPS=5        repeats for join latency     (default 3)
#   BENCH_LABEL=...     records the network conditions of this run
#
# One worker, always: two scenarios measured side by side would be competing
# for the same cores and both numbers would be wrong.
bench: bench-audio
	@BENCH_RUN_ID=$${BENCH_RUN_ID:-$$(date +%Y%m%d-%H%M%S)}; \
	export BENCH_RUN_ID; \
	NODE_OPTIONS=--disable-warning=DEP0205 npx playwright test --project=bench --workers=1; \
	echo ""; \
	node scripts/bench-report.mjs "bench-results/$$BENCH_RUN_ID.ndjson" \
		--html "bench-results/$$BENCH_RUN_ID.html" \
		--csv  "bench-results/$$BENCH_RUN_ID.csv"; \
	echo ""; \
	echo "→ open bench-results/$$BENCH_RUN_ID.html to read it as charts"

# The speech-shaped WAV Chromium's fake microphone reads. Seeded, so it is
# byte-identical everywhere and two runs stay comparable; regenerated only when
# it is missing, so a run never silently changes its own input.
bench-audio: tests/bench/assets/bench-speech.wav

tests/bench/assets/bench-speech.wav: scripts/gen-bench-audio.mjs
	@node scripts/gen-bench-audio.mjs $@

# Re-render the newest run. Writes the dashboard beside its NDJSON so the two
# never drift apart, and prints the markdown for pasting into a pull request.
bench-report:
	@set -e; \
	LATEST=$$(ls -1 bench-results/*.ndjson 2>/dev/null | tail -1); \
	if [ -z "$$LATEST" ]; then node scripts/bench-report.mjs; exit 0; fi; \
	node scripts/bench-report.mjs "$$LATEST" \
		--html "$${LATEST%.ndjson}.html" --csv "$${LATEST%.ndjson}.csv"

clean:
	cd src-tauri && cargo clean
	rm -rf dist node_modules/.cache

# ── Documentation ─────────────────────────────────────────────────────────────

docs:
	@echo "Serving architecture docs on http://localhost:8090"
	@echo "  flows: /architecture.html   topology diagrams: /topology.html"
	@open http://localhost:8090/architecture.html 2>/dev/null || true
	python3 -m http.server 8090 -d docs
