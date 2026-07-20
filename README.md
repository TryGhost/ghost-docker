# Ghost Docker

Configuration to run Ghost and its services with Docker Compose

## IPv6 networking

IPv6 networking is opt-in because it requires newer Docker and Docker Compose versions than the base setup. Enable it by including the IPv6 override file:

```sh
docker compose -f compose.yml -f compose.ipv6.yml up -d
```

# Copyright & License 

Copyright (c) 2013-2026 Ghost Foundation - Released under the [MIT license](LICENSE).
