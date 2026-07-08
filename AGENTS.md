# AGENTS.md

pi-web-tools brings the web access tools missing from the pi coding agent.

## `search_web`

Backed by [Parallel Web Systems](https://parallel.ai/), `search_web` brings web search with output optimized for agent consumption.

## `fetch_web`

Retrieve a full webpage using a flexible backend fetching router that chooses the best fetcher for the job:

- GitHub urls are backed by the Octokit library/GitHub API
- General webpages are retrieved by Parallel's fetch api, which optimizes output for agents
- If Parallel is not available, use a fully-local browser fetch utilizing playwright and Trafilatura for html-to-markdown parsing
- Bonus: the local browser has an interactive mode (`/open-browser`) that enables the user to login to authenticated website, after which the agent gains the same access

## Project context

See @CONTEXT.md for project vocabulary.

## Ethos

- Agents make substantially better decisions when they get access to live information, so we should make it easy for them to reach for it
- Progressive disclosure lets the agents make informed decisions -- tool results should start with a summary of the documents, and a reference to the full contents as needed.
- Certain sources are worth taking special care to optimize how they are presented to an agent

## Core principles

- Build on pi-native concepts, types, and extension APIs where available
- Fetchers import from `contract.ts`/`shared.ts` only — never a sibling fetcher or the router
- Content never crosses the extension/worker socket boundary: fetchers write bodies to disk and return paths and stats

## Code style

See @DEV.md for code style and development commands.
