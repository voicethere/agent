# mcp-example-service

A small MCP server for the `llm-mcp-service` template. It speaks streamable HTTP (stateless) at `/mcp`, answers `GET /healthz` with 200 and offers four tools:

- `get_plan_price({ plan })`: monthly price of `free`, `starter` or `team`. The table is sample data, not real prices.
- `get_server_time()`: current UTC time of the service.
- `list_products()`: ids and names of the eight products of the sample Kestrel Outdoor store, for the `llm-store-support` template.
- `get_product_price({ product })`: price in US dollars of a product, by id or name. The catalog is sample data, not real prices. An unknown product returns a text message that lists the known ids.

Log lines carry the tool name, success and duration, never the arguments.

## Run it as a project service

Set the project service image to `ghcr.io/voicethere/mcp-example-service:<version>` (or `latest`), port `8080`, HTTP health check `/healthz`. See the `llm-mcp-service` template README.

## Run it locally

```bash
npm install
PORT=8080 node server.ts
```

Node 26 runs the TypeScript file directly. Set `MCP_TOKEN` to require `Authorization: Bearer <MCP_TOKEN>` on `/mcp`; without it the endpoint is open, which is right behind a project service because the platform checks the service token first and does not pass it on.

## Build the image

```bash
docker build -t mcp-example-service .
docker run --rm -p 8080:8080 mcp-example-service
```
