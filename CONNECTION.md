# CONNECTION — ghl-proxy → Muse

Handoff para Muse. Sin secretos: la llave del proxy se entrega al operador por separado.
PENDIENTE DE DEPLOY: regenerar con `./scripts/write-connection.sh <host>` (rellena `middleware_host` y `health_url`).

```yaml
middleware_host: PENDIENTE
auth_placement: header:X-Proxy-Key
rest_base_path: /ghl
mcp_path: /mcp/
health_url: https://PENDIENTE/health
ghl_location_id: L3bLLVwvhdJ7A9WqkPxM
version: 1.0.0
```
