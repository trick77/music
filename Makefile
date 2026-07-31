.PHONY: build test backend-coverage fe-build fe-test fe-coverage run dev dev-ui tidy docker-dev docker-dev-down

tidy:
	cd backend && go mod tidy

test:
	cd backend && go test ./...

# The coverage floor is NOT defined here. It lives in hack/coverage-floors and is
# enforced by hack/coverage-gate.sh, which CI calls too — so `make backend-coverage`
# and a CI run answer with the same number against the same threshold. These targets
# only produce the artifacts; the gate decides pass or fail.
#
# -coverpkg=./... credits code executed by *other* packages' tests. Without it
# internal/mockoidc reports 0% despite the unit suite exercising it on every run,
# because go attributes coverage only to the package under test. cmd/ holds the
# binary entrypoints (main, wiring, signal handling), which unit tests can't reach;
# the gate excludes that tree itself, so no filtering is needed here.
#
# The Cobertura conversion is not cosmetic: Go reports statement percentages and
# exposes no line metric, and the gate measures lines. It also merges the duplicate
# blocks -coverpkg emits (one set per test binary), which a naive sum gets wrong.
backend-coverage:
	mkdir -p coverage
	cd backend && go test ./... -covermode=atomic -coverpkg=./... -coverprofile=../coverage/backend.out
	cd backend && go run github.com/boumenot/gocover-cobertura@v1.5.0 < ../coverage/backend.out > ../coverage/backend.xml
	./hack/coverage-gate.sh backend

fe-test:
	cd ui && npm run test -- --run --passWithNoTests

fe-coverage:
	cd ui && npm run test:coverage
	./hack/coverage-gate.sh ui

fe-build:
	cd ui && npm ci && npm run build

build: fe-build
	cd backend && CGO_ENABLED=0 go build -o ../bin/music ./cmd/music

run:
	cd backend && go run ./cmd/music

# Everyday local dev — no container runtime. The store is an in-process SQLite
# file and karaoke is off unless BACKEND_ALIGN_URL is set, so nothing here needs
# Docker/OrbStack. BACKEND_SESSION_SECRET is the one hard requirement the binary
# has, and this fills it with a throwaway so `make dev` just starts; export your
# own first and that wins. Do NOT source .env for this — its paths (/data/...)
# are the container's, and the Go binary never reads that file anyway.
dev:
	cd backend && BACKEND_SESSION_SECRET=$${BACKEND_SESSION_SECRET:-dev-secret} go run ./cmd/music

# The Vite dev server, proxying /api to :8080 (ui/vite.config.ts). Run alongside
# `make dev` in a second shell; use this rather than `make fe-build` while
# iterating, so the UI hot-reloads instead of needing a Go rebuild to be served.
dev-ui:
	cd ui && npm run dev

docker-dev:
	docker compose -f compose.dev.yaml up --build --remove-orphans

docker-dev-down:
	docker compose -f compose.dev.yaml down
