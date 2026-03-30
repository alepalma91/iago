.PHONY: start stop status review dashboard mcp dev config-init config-validate config-show test test-watch install help swiftbar-install menubar-build menubar-install menubar-run build install-all launchctl-load launchctl-unload uninstall logs logs-rotate

BUN := bun
CLI := $(BUN) run src/index.ts

# LaunchAgent config
DAEMON_LABEL := com.iago.daemon
MENUBAR_LABEL := com.iago.menubar
LAUNCH_DIR := $(HOME)/Library/LaunchAgents
DAEMON_PLIST := $(LAUNCH_DIR)/$(DAEMON_LABEL).plist
MENUBAR_PLIST := $(LAUNCH_DIR)/$(MENUBAR_LABEL).plist
PROJECT_DIR := $(shell pwd)
LOG_FILE := $(HOME)/.local/share/iago/daemon.log

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	$(BUN) install

start: ## Start the review daemon
	@if launchctl list 2>/dev/null | grep -q $(DAEMON_LABEL); then \
		echo "Starting via launchctl..."; \
		launchctl start $(DAEMON_LABEL); \
	else \
		$(CLI) start; \
	fi

stop: ## Stop the review daemon
	@if launchctl list 2>/dev/null | grep -q $(DAEMON_LABEL); then \
		echo "Stopping via launchctl..."; \
		launchctl stop $(DAEMON_LABEL); \
	else \
		$(CLI) stop; \
	fi

status: ## Show active PR reviews
	$(CLI) status

review: ## Manually review a PR (usage: make review PR=https://github.com/org/repo/pull/42)
	@test -n "$(PR)" || (echo "Usage: make review PR=<pr-url>" && exit 1)
	@echo "Triggering manual review for $(PR)..."
	$(CLI) review $(PR)

dashboard: ## Start the dashboard server (standalone)
	$(CLI) dashboard

mcp: ## Start the MCP server (stdio transport)
	$(CLI) mcp

dev: ## Start daemon + dashboard together
	$(CLI) start

config-init: ## Initialize default config files
	$(CLI) config init

config-validate: ## Check config for errors
	$(CLI) config validate

config-show: ## Print resolved config
	$(CLI) config show

test: ## Run all tests
	$(BUN) test

test-watch: ## Run tests in watch mode
	$(BUN) test --watch

logs: ## Tail daemon logs
	@if [ -f "$(LOG_FILE)" ]; then \
		tail -f "$(LOG_FILE)"; \
	else \
		$(CLI) logs; \
	fi

logs-rotate: ## Rotate log file and restart daemon
	@if [ -f "$(LOG_FILE)" ]; then \
		mv "$(LOG_FILE)" "$(LOG_FILE).$(shell date +%Y%m%d%H%M%S)"; \
		touch "$(LOG_FILE)"; \
		if launchctl list 2>/dev/null | grep -q $(DAEMON_LABEL); then \
			launchctl stop $(DAEMON_LABEL); \
			sleep 1; \
			launchctl start $(DAEMON_LABEL); \
			echo "Log rotated and daemon restarted."; \
		else \
			echo "Log rotated. Daemon not running via launchctl."; \
		fi \
	else \
		echo "No log file found at $(LOG_FILE)"; \
	fi

swiftbar-install: ## Install SwiftBar menu bar plugin
	@if [ -z "$(SWIFTBAR_DIR)" ]; then \
		echo "Usage: make swiftbar-install SWIFTBAR_DIR=~/swiftbar"; \
		echo "Set SWIFTBAR_DIR to your SwiftBar plugin directory."; \
		exit 1; \
	fi
	@mkdir -p "$(SWIFTBAR_DIR)"
	cp extras/swiftbar/iago.30s.sh "$(SWIFTBAR_DIR)/iago.30s.sh"
	chmod +x "$(SWIFTBAR_DIR)/iago.30s.sh"
	@echo "Installed to $(SWIFTBAR_DIR)/iago.30s.sh"

# ── Menu Bar App ────────────────────────────────────────────

MENUBAR_SRC := extras/menubar/Sources/TheReviewerBar
MENUBAR_BIN := extras/menubar/.build/IagoBar
MENUBAR_SRCS := $(MENUBAR_SRC)/main.swift $(MENUBAR_SRC)/Models.swift $(MENUBAR_SRC)/DatabaseManager.swift $(MENUBAR_SRC)/StatusBarController.swift

menubar-build: ## Build the menu bar app
	@mkdir -p extras/menubar/.build
	swiftc -O -o $(MENUBAR_BIN) \
		-sdk $$(xcrun --show-sdk-path) \
		-target arm64-apple-macosx13.0 \
		-framework AppKit \
		-lsqlite3 \
		$(MENUBAR_SRCS)

menubar-install: menubar-build ## Install menu bar binary
	@mkdir -p $(HOME)/bin
	cp $(MENUBAR_BIN) $(HOME)/bin/iago-bar
	codesign -s - -f $(HOME)/bin/iago-bar
	@echo "Installed to $(HOME)/bin/iago-bar (ad-hoc signed)"

menubar-run: menubar-build ## Run the menu bar app
	$(MENUBAR_BIN)

# ── Compile (standalone binary) ────────────────────────────

DIST_DIR := dist
VERSION := $(shell node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")

compile: ## Compile standalone binary (native arch)
	@mkdir -p $(DIST_DIR)
	bun build --compile --minify src/index.ts --outfile $(DIST_DIR)/iago
	@echo "Built $(DIST_DIR)/iago ($(shell uname -m))"

compile-arm64: ## Compile standalone binary (arm64)
	@mkdir -p $(DIST_DIR)
	bun build --compile --minify --target=bun-darwin-arm64 src/index.ts --outfile $(DIST_DIR)/iago-arm64
	@echo "Built $(DIST_DIR)/iago-arm64"

compile-x64: ## Compile standalone binary (x86_64)
	@mkdir -p $(DIST_DIR)
	bun build --compile --minify --target=bun-darwin-x64 src/index.ts --outfile $(DIST_DIR)/iago-x64
	@echo "Built $(DIST_DIR)/iago-x64"

compile-universal: compile-arm64 compile-x64 ## Compile universal binary (arm64 + x86_64)
	@lipo -create -output $(DIST_DIR)/iago $(DIST_DIR)/iago-arm64 $(DIST_DIR)/iago-x64
	@rm -f $(DIST_DIR)/iago-arm64 $(DIST_DIR)/iago-x64
	@echo "Built $(DIST_DIR)/iago (universal)"

dist: compile menubar-build ## Build distributable tarball (native arch)
	@mkdir -p $(DIST_DIR)
	@cp $(MENUBAR_BIN) $(DIST_DIR)/iago-bar 2>/dev/null || true
	@tar -czf $(DIST_DIR)/iago-$(VERSION)-darwin-$(shell uname -m).tar.gz -C $(DIST_DIR) iago $(shell test -f $(DIST_DIR)/iago-bar && echo iago-bar)
	@echo "Tarball: $(DIST_DIR)/iago-$(VERSION)-darwin-$(shell uname -m).tar.gz"

clean-dist: ## Remove dist directory
	rm -rf $(DIST_DIR)

# ── Unified Build & Install ─────────────────────────────────

build: install menubar-build ## Build everything (bun deps + menu bar binary)
	@echo "Build complete."

install-all: build menubar-install ## Build + install binary + install LaunchAgent plists
	@mkdir -p "$(LAUNCH_DIR)"
	@mkdir -p "$(HOME)/.local/share/iago"
	@# Resolve tool paths for daemon PATH
	@BUN_PATH=$$(which bun) && \
	GH_DIR=$$(dirname $$(which gh 2>/dev/null) 2>/dev/null || echo "") && \
	CLAUDE_DIR=$$(dirname $$(which claude 2>/dev/null) 2>/dev/null || echo "") && \
	AGENT_PATH="$$(dirname $$BUN_PATH)" && \
	if [ -n "$$GH_DIR" ]; then AGENT_PATH="$$AGENT_PATH:$$GH_DIR"; fi && \
	if [ -n "$$CLAUDE_DIR" ]; then AGENT_PATH="$$AGENT_PATH:$$CLAUDE_DIR"; fi && \
	AGENT_PATH="$$AGENT_PATH:/usr/local/bin:/usr/bin:/bin" && \
	sed -e "s|__BUN_PATH__|$$BUN_PATH|g" \
	    -e "s|__PROJECT_DIR__|$(PROJECT_DIR)|g" \
	    -e "s|__AGENT_PATH__|$$AGENT_PATH|g" \
	    -e "s|__HOME__|$(HOME)|g" \
	    extras/launchd/com.iago.daemon.plist > "$(DAEMON_PLIST)" && \
	sed -e "s|__HOME__|$(HOME)|g" \
	    extras/launchd/com.iago.menubar.plist > "$(MENUBAR_PLIST)" && \
	echo "LaunchAgent plists installed to $(LAUNCH_DIR)" && \
	echo "Run 'make launchctl-load' to start auto-launch."

launchctl-load: ## Load LaunchAgents (start auto-launch)
	@if [ -f "$(DAEMON_PLIST)" ]; then \
		launchctl load "$(DAEMON_PLIST)" 2>/dev/null || true; \
		echo "Loaded $(DAEMON_LABEL)"; \
	else \
		echo "Daemon plist not found. Run 'make install-all' first."; \
	fi
	@if [ -f "$(MENUBAR_PLIST)" ]; then \
		launchctl load "$(MENUBAR_PLIST)" 2>/dev/null || true; \
		echo "Loaded $(MENUBAR_LABEL)"; \
	else \
		echo "Menu bar plist not found. Run 'make install-all' first."; \
	fi

launchctl-unload: ## Unload LaunchAgents (stop auto-launch)
	@launchctl unload "$(DAEMON_PLIST)" 2>/dev/null || true
	@launchctl unload "$(MENUBAR_PLIST)" 2>/dev/null || true
	@echo "LaunchAgents unloaded."

uninstall: ## Stop + unload + remove plists + remove binary (preserves data)
	@echo "Stopping services..."
	-@launchctl stop $(DAEMON_LABEL) 2>/dev/null || true
	-@launchctl stop $(MENUBAR_LABEL) 2>/dev/null || true
	@sleep 1
	-@launchctl unload "$(DAEMON_PLIST)" 2>/dev/null || true
	-@launchctl unload "$(MENUBAR_PLIST)" 2>/dev/null || true
	-@rm -f "$(DAEMON_PLIST)" "$(MENUBAR_PLIST)"
	-@rm -f "$(HOME)/bin/iago-bar"
	@echo "Uninstalled. Data in ~/.local/share/iago/ preserved."
