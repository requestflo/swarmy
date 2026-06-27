SHELL := /usr/bin/env bash

# Provider identity. The install target lays the binary out under the local
# Terraform plugin filesystem mirror so `terraform init` finds it.
HOSTNAME    := registry.terraform.io
NAMESPACE   := requestflo
NAME        := swarmy
BINARY      := terraform-provider-$(NAME)
VERSION     := 0.1.0
OS_ARCH     := $(shell go env GOOS)_$(shell go env GOARCH)
PLUGIN_DIR  := $(HOME)/.terraform.d/plugins/$(HOSTNAME)/$(NAMESPACE)/$(NAME)/$(VERSION)/$(OS_ARCH)

.PHONY: default build install test testacc vet fmt tidy clean

default: build

## build: compile the provider binary.
build:
	go build -o $(BINARY) .

## install: build and place the provider in the local Terraform plugin mirror.
install: build
	mkdir -p $(PLUGIN_DIR)
	cp $(BINARY) $(PLUGIN_DIR)/$(BINARY)_v$(VERSION)

## test: run unit tests (no live controller required).
test:
	go test ./... $(TESTARGS)

## testacc: run acceptance tests against a live controller.
## Requires SWARMY_ENDPOINT and SWARMY_API_KEY.
testacc:
	TF_ACC=1 go test ./... -v $(TESTARGS) -timeout 120m

## vet: run go vet.
vet:
	go vet ./...

## fmt: format Go sources.
fmt:
	gofmt -w .

## tidy: tidy the module graph.
tidy:
	go mod tidy

## clean: remove built artifacts.
clean:
	rm -f $(BINARY)
