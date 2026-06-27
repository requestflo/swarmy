# swarmy (Python)

Official Python client for the swarmy public REST API. Zero runtime dependencies
(standard-library `urllib` only).

```python
import swarmy

client = swarmy.SwarmyClient("https://swarm.example.com", "swk_...")
services, next_cursor = client.services.list()
for svc in client.services.iterate():
    print(svc.name)
```

See `../README.md` for the regeneration workflow.
