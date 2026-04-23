# Ghost Docker

Configuration to run Ghost and its services with Docker Compose

## Ghost Coolify

Specifically designed to run Ghost 6 with tinybird analytics from [Coolify](https://coolify.io) UI. Includes [ghost-gate](ghost-gate)
service that automates the tinybird setup flow into a nice web UI, as well as handling migrations from older databases.
For more details, see [coolify/README.md](coolify/README.md).  You can also launch a local version of this all in one
with `coolify/deploy_local.sh` and then opening `http://localhost:3989`.

# Copyright & License 

Copyright (c) 2013-2026 Ghost Foundation - Released under the [MIT license](LICENSE).
