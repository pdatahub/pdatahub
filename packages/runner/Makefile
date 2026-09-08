# pdatahub-runner Makefile
# Phase 1A skeleton — see README.md for scope.

GO        := go
PKG       := ./...
COVERFILE := coverage.out
COVERHTML := coverage.html
BIN       := bin/runner

.PHONY: help build test test-race cover lint vet tidy clean run run-dry

help: ## Print available targets
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-15s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

build: ## Build the runner binary into ./bin/runner
	mkdir -p bin
	$(GO) build -o $(BIN) ./cmd/runner

test: ## Run all tests
	$(GO) test $(PKG)

test-race: ## Run all tests with -race
	$(GO) test $(PKG) -race

cover: ## Run tests with coverage report (HTML)
	$(GO) test $(PKG) -race -coverprofile=$(COVERFILE)
	$(GO) tool cover -html=$(COVERFILE) -o $(COVERHTML)
	@echo "Coverage report: $(COVERHTML)"

lint: vet ## Alias for vet (Go's built-in static analyzer)

vet: ## Run go vet
	$(GO) vet $(PKG)

tidy: ## Run go mod tidy
	$(GO) mod tidy

clean: ## Remove build artifacts
	rm -rf bin coverage $(COVERFILE) $(COVERHTML)

run-dry: build ## Run runner in dry-run mode (skeleton default)
	$(BIN) --dry-run

run: build ## Run runner (Phase 1B; panics in skeleton)
	$(BIN)