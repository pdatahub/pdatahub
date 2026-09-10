# pdatahub — convenience targets for self-hosted deployment.
# Wraps docker compose so you don't need to remember exact CLI flags.
#
# Usage: make <target>
# Run `make` (or `make help`) to see all targets with descriptions.

ifneq (,$(wildcard .env))
include .env
export
endif

.DEFAULT_GOAL := help

.PHONY: help up down logs restart status backup reset shell open plugin-install plugin-list

help: ## Show this help
	@echo "pdatahub make targets:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""

up: ## Start hub in background (docker compose up -d)
	docker compose up -d
	@echo ""
	@echo "Hub starting on http://localhost:8080"
	@echo "Tail logs with: make logs"

down: ## Stop hub (docker compose down)
	docker compose down

logs: ## Tail hub logs (Ctrl+C to exit)
	docker compose logs -f hub

restart: ## Restart hub (picks up newly-mounted plugins)
	docker compose restart hub

status: ## Show container status
	@docker compose ps
	@echo ""
	@echo "Image:        $$(docker inspect --format '{{.Config.Image}}' pdatahub-hub 2>/dev/null || echo 'not running')"
	@echo "Plugins dir:  $$(ls -1 ./plugins 2>/dev/null | grep -v '^\.' | tr '\n' ' ' || echo 'empty')"

backup: ## Snapshot encrypted vault to ./backups/
	@mkdir -p backups
	docker compose exec -T hub pdatahub-hub backup /data/pdatahub-hub.db /tmp/snapshot.db
	docker compose cp hub:/tmp/snapshot.db ./backups/hub-$(shell date +%Y%m%d-%H%M%S).db
	@echo ""
	@echo "Backup saved to ./backups/"
	@echo "Remember: the master_key (printed on first run) is needed to restore."

reset: ## DESTRUCTIVE: delete all OAuth tokens + audit log
	@echo "This DELETES all OAuth tokens, installed plugins, and audit log."
	@echo "There is no undo."
	@read -p "Type 'delete-everything' to continue: " c && [ "$$c" = "delete-everything" ] || exit 1
	docker compose down -v
	rm -rf ./plugins
	@echo ""
	@echo "Reset complete. Run 'make up' to start fresh."

shell: ## Open shell inside hub container
	docker compose exec hub sh

open: ## Open web UI in browser
	@xdg-open http://localhost:8080 2>/dev/null || \
	  open http://localhost:8080 2>/dev/null || \
	  echo "Open http://localhost:8080 in your browser"

# ─── Plugin management (uses hub-core CLI) ──────────────────────────────────

plugin-install: ## Install plugin from GitHub Releases URL
	@if [ -z "$(URL)" ]; then \
	  echo "Usage: make plugin-install URL=https://github.com/.../releases/download/v0.1.0/plugin.tgz"; \
	  exit 1; \
	fi
	docker compose exec hub pdatahub-hub plugin install "$(URL)"
	docker compose restart hub

plugin-list: ## List installed plugins
	docker compose exec hub pdatahub-hub plugin list
