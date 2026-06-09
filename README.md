# WebMCP Demo

A simple todo app that exposes tools to AI agents via the [WebMCP](https://github.com/webmachinelearning/webmcp) browser API.

## Requirements

- [Bun](https://bun.sh)
- Chrome Canary with the WebMCP flag enabled

## Install & Run

```bash
bun install
bun dev
```

Open [http://localhost:3000](http://localhost:3000) in Chrome Canary.

## Enable WebMCP in Chrome Canary

1. Go to `chrome://flags`
2. Search for **Model Context**
3. Enable the flag and relaunch

## Pages

| Page | Description |
|------|-------------|
| `/simple` | Client-side todo demo, no backend required |
| `/scalekit` | Full demo with OAuth 2.1 auth via ScaleKit |

## ScaleKit Setup (optional)

```bash
cp .env.example .env

```
