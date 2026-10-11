# MT Link — common operations.
# Everything here assumes `cp .env.example .env` has been done once.

SHELL := /bin/bash
COMPOSE := docker compose
COMPOSE_PROD := docker compose -f docker-compose.yml -f docker-compose.prod.yml

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

.PHONY: dev
dev: ## Start the full dev stack (hot reload)
	$(COMPOSE) up --build

.PHONY: up
up: ## Start the dev stack detached
	$(COMPOSE) up -d --build

.PHONY: down
down: ## Stop the stack (keeps volumes)
	$(COMPOSE) down

.PHONY: nuke
nuke: ## Stop the stack and DELETE all data volumes
	$(COMPOSE) down -v

.PHONY: build
build: ## Build all workspace packages
	npm run build

.PHONY: install
install: ## Install dependencies
	npm install

.PHONY: migrate
migrate: ## Apply database migrations
	$(COMPOSE) run --rm api npm run migrate

.PHONY: migrate-local
migrate-local: ## Apply migrations against DATABASE_URL on the host
	npm -w @mtlink/api run migrate

.PHONY: seed
seed: ## Seed a tenant, user, domain and 25 sample links
	$(COMPOSE) run --rm api npm run seed

.PHONY: test
test: ## Run all unit and integration tests
	npm run test

.PHONY: test-e2e
test-e2e: ## Run the Playwright dashboard smoke test
	npm -w @mtlink/dashboard run test:e2e

.PHONY: bench
bench: ## Benchmark the redirect hot path with autocannon
	bash scripts/bench.sh

.PHONY: lint
lint: ## Lint the whole repo
	npm run lint

.PHONY: typecheck
typecheck: ## Typecheck every workspace
	npm run typecheck

.PHONY: logs
logs: ## Tail logs for all services
	$(COMPOSE) logs -f --tail=100

.PHONY: logs-redirect
logs-redirect: ## Tail the redirect service only
	$(COMPOSE) logs -f --tail=100 redirect

.PHONY: psql
psql: ## Open a psql shell on the running database
	$(COMPOSE) exec postgres psql -U $${POSTGRES_USER:-mtlink} -d $${POSTGRES_DB:-mtlink}

.PHONY: backup
backup: ## Dump the database and verify the dump restores
	bash scripts/backup.sh

.PHONY: restore
restore: ## Restore from a dump: make restore FILE=backups/xxx.dump
	bash scripts/restore.sh $(FILE)

.PHONY: geoip
geoip: ## Download/refresh the MaxMind GeoLite2 City database
	bash scripts/update-geoip.sh

.PHONY: certs-dev
certs-dev: ## Generate a self-signed cert for local HTTPS
	bash scripts/dev-certs.sh

.PHONY: prod-up
prod-up: ## Start the production stack
	$(COMPOSE_PROD) up -d --build

.PHONY: prod-down
prod-down: ## Stop the production stack
	$(COMPOSE_PROD) down
