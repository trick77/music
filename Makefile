.PHONY: build test backend-coverage fe-build fe-test fe-coverage run tidy docker-dev docker-dev-down

tidy:
	cd backend && go mod tidy

test:
	cd backend && go test ./...

backend-coverage:
	mkdir -p coverage
	cd backend && go test ./... -covermode=atomic -coverprofile=../coverage/backend.out
	cd backend && go tool cover -func=../coverage/backend.out

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
