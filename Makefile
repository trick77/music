.PHONY: build test backend-coverage fe-build fe-test fe-coverage run tidy docker-dev docker-dev-down

tidy:
	cd backend && go mod tidy

test:
	cd backend && go test ./...

# Floor enforced by backend-coverage; a drop below it fails the build.
BACKEND_MIN_COVERAGE ?= 75

# -coverpkg=./... credits code executed by *other* packages' tests. Without it
# internal/mockoidc reports 0% despite the unit suite exercising it on every run,
# because go attributes coverage only to the package under test. cmd/ holds the
# binary entrypoints (main, wiring, signal handling), which unit tests can't reach
# and which are covered by running the app — they'd only add constant dead weight.
backend-coverage:
	mkdir -p coverage
	cd backend && go test ./... -covermode=atomic -coverpkg=./... -coverprofile=../coverage/raw.out
	{ echo "mode: atomic"; grep -v '^mode:' coverage/raw.out | grep -v '^github.com/trick77/music/cmd/'; } > coverage/backend.out
	cd backend && go tool cover -func=../coverage/backend.out
	@total=$$(cd backend && go tool cover -func=../coverage/backend.out | awk 'END {gsub("%","",$$NF); print $$NF}'); \
	 awk -v t="$$total" -v m="$(BACKEND_MIN_COVERAGE)" 'BEGIN { if (t+0 < m+0) { printf "\nFAIL: backend coverage %.1f%% is below the %s%% floor\n", t, m; exit 1 } printf "\nbackend coverage %.1f%% (floor %s%%)\n", t, m }'

fe-test:
	cd ui && npm run test -- --run --passWithNoTests

fe-coverage:
	cd ui && npm run test:coverage

fe-build:
	cd ui && npm ci && npm run build

build: fe-build
	cd backend && CGO_ENABLED=0 go build -o ../bin/music ./cmd/music

run:
	cd backend && go run ./cmd/music

docker-dev:
	docker compose -f compose.dev.yaml up --build --remove-orphans

docker-dev-down:
	docker compose -f compose.dev.yaml down
