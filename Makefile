.PHONY: start stop status review config-init test test-watch install help

BUN := bun
CLI := $(BUN) run src/index.ts

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	$(BUN) install

start: ## Start the review daemon
	$(CLI) start

stop: ## Stop the review daemon
	$(CLI) stop

status: ## Show active PR reviews
	$(CLI) status

review: ## Manually review a PR (usage: make review PR=https://github.com/org/repo/pull/42)
	@test -n "$(PR)" || (echo "Usage: make review PR=<pr-url>" && exit 1)
	@echo "Triggering manual review for $(PR)..."
	$(CLI) review $(PR)

config-init: ## Initialize default config files
	$(CLI) config init

test: ## Run all tests
	$(BUN) test

test-watch: ## Run tests in watch mode
	$(BUN) test --watch

logs: ## Tail daemon logs
	$(CLI) logs
