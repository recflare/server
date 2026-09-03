# Deploying using Docker

These are the instructions for deploying the RecFlare infrastructure using Docker.  
Docker deployments are intended for local testing and small scale servers. For large scale deployments see [Cloudflare Deployments](../DEPLOYING.md).  
Docker deployments currently **do NOT deploy the WWW app**, this may change in the future.

## Prerequisites

- Docker (https://www.docker.com)
- A domain
- SSL certs for above domain

## Using Docker Compose

See the example [compose.yaml](./compose.yaml).  
The example stores all server data in `./data` volume, and expects your ssl `server.key` and `server.crt` files to be in the same dir as the `compose.yaml` file

## Environment Options

| Name                       | Default Value          | Description                                             |  
| -------------------------- | ---------------------- | ------------------------------------------------------- |  
| **RECFLARE_DOAMIN**        | none                   | See [.env.example](../.env.example)                     |  
| **RECFALRE_SSL_CRT**       | none                   | Path to ssl crt file                                    |  
| **RECFALRE_SSL_KEY**       | none                   | Path to ssl key file                                    |  
| RECFALRE_PORT              | 443                    | nginx server port, only this port needs to be forwarded |  
| SUBDOMAINS                 | `{"moderation":"api"}` | See [.env.example]                                      |  
| RECFLARE_MONO_APP_PORT     | 8787                   | mono app server port                                    |  
| RECFLARE_MONO_INSPECT_PORT | 9229                   | mono app wrangler inspect port                          |  
| RECFLARE_ECON_APP_PORT     | 8788                   | econ app server port                                    |  
| RECFLARE_ECON_INSPECT_PORT | 9230                   | econ app wrangler inspect port                          |  
| RECFLARE_IMG_APP_PORT      | 8789                   | img app server port                                     |  
| RECFLARE_IMG_INSPECT_PORT  | 9231                   | img app wrangler inspect port                           |  
**Bold** Options are **Required**

Additional `.env` options can passed to the `entrypoint.sh` script.  
Ex: `--var RECFLARE_MAX_ACCOUNTS_PER_PLATFORM_ID:"5"`  
See [.env.example](../.env.example) for all available options.
