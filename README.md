# RecFlare

<img width="1063" height="409" alt="image" src="https://github.com/user-attachments/assets/521d5b11-fb93-4900-9158-71d51d2343ae" />

![badge](https://github.com/djdevin/recflare/actions/workflows/test.yml/badge.svg?branch=main)

RecFlare is a scalable implementation of RecNet — the Rec Room backend — built on
Cloudflare Workers. It implements the network services the Rec Room client talks
to — accounts, auth, rooms, matchmaking, economy, chat, notifications, and more —
each as an independent Node.js Worker on their own subdomains, just how RecNet was.

> ⚠️ **Disclaimer:** This is an unofficial, fan-made project for preservation and
> experimentation. It is not affiliated with, endorsed by, or connected to Rec
> Room Inc. "Rec Room" is a trademark of its respective owner.

## Why?

There are already so many multiplayer clones, why?

1. None of them are fully open source (some had leaks of old code).
2. None of them run on microservice architecture, most on a single server.
3. None of them had unit tests, so servers are constantly buggy.
4. "Upgrading the server" is not sustainable plan for growth.
5. This was fun (sort of). The goal was to build a project that everyone could use. No gatekeeping or viruses.

# Infrastructure

RecFlare uses a true microservice architecture which is infinitely scalable
and could support the same number of concurrent users as the original game. It
will never run out of CPU, memory, or disk space.

Of course, cloud services cost money. That's the only limitation. So we'll see!

And being truly open source means that this project should have more eyes on it,
resulting in bugs getting fixed faster. I hope.

## Game client

See [RecFlare Client](https://github.com/djdevin/recflare-client) for the official RecFlare build.

These game builds are supported:

| Build         | Manifest              | Support                                                                                 |
| ------------- | --------------------- | --------------------------------------------------------------------------------------- |
| `20230414`    | `7859140924515540835` | **Default**, official — the 2023 build the rest of the stack targets                    |
| `20250718.01` | `1151455856673601091` | **Beta**, official — use the [patch-2025](https://github.com/recflare/patch-2025) patch |
| `20260323.14` |                       | Alpha                                                                                   |
| `20250424.01` |                       | Alpha                                                                                   |
| `20231207`    |                       | Alpha                                                                                   |
| `20230616`    |                       | Alpha                                                                                   |

Alpha builds get past the version check and largely work, but nothing else in the
stack targets them, so expect protocol differences. Other client or game versions
may expect different endpoints and response shapes and are not supported.

Generally speaking any client that effectively rewrites the nameserver with the
right mods (see [RecNet Plugin](https://github.com/djdevin/recnet-plugin), [2025 patch](https://github.com/recflare/patch-2025)) can be used with this server.

## Services

See [SERVICES.md](SERVICES.md)

## Deploying

Want to run it yourself? See [DEPLOYING.md](DEPLOYING.md)

## FAQ

### What year is this for?

Most 2023 and 2025 clients. A few older builds work at
alpha quality — see the table in the "Game client" section above. Other clients may not
work.

See the "Game client" section above for instructions on how to modify a client to connect to this server.

### Can I run this locally on my PC?

It's not currently supported. But theoretically, you could.

See "Run the development microservices" above. It may be possible later as Wrangler will mock remote services. YMMV for now.

### Can I use this to make my own server?

Yes, that's the point. See [DEPLOYING.md](DEPLOYING.md)

### Is there an admin panel?

Yes, the server comes bundled with a simple web panel with more functionality being added.

There are also [CLI tools](CLI.md) you can use for admin tasks like granting roles.

### Can I copy this project and modify it?

Yes, see the [LICENSE](LICENSE).

I would love if you contributed your changes back.

### Why a monorepo?

The services share types, auth logic, and tooling, so keeping them in one repo
keeps those in sync: `pnpm` workspaces share dependencies, `@repo/` packages
share code, Turborepo runs build/test/lint with a single cached task graph, and
cross-service changes land in one atomic commit.

This makes it easier to deploy the whole stack at once or a smaller selection
of microservices to avoid downtime events.

## Credits

I started this soon after the official servers shut down when I saw there were
only monolithic servers usually running on one server. I could only see the
request shapes coming from the game client. I used many different projects as
resources to get response shapes, logic examples, enums, etc. They all had
missing pieces. Again, another reason to come together on one project and
stop gatekeeping.

- [CannedNet](https://github.com/CannedNet/CannedNet)
- [DorkNet](https://github.com/DorkSquadRR/DorkNet)
- jordanparki7's postman collection of RecNet APIs which is gone for some reason.
- Leaked C# projects I won't list (for response shapes)
- Claude and my [wire shapes skill](https://github.com/recflare/skills/blob/main/.claude/skills/wire-shapes/SKILL.md)
