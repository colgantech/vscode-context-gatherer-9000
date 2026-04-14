set shell := ["bash", "-c"]

default:
    @just --list

install:
    bun install

compile:
    bunx tsc -p ./

watch:
    bunx tsc -watch -p ./

package:
    bunx @vscode/vsce package --no-dependencies

install-extension: compile package
    code --install-extension gather-context-files-*.vsix
