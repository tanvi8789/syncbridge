# SyncBridge

A desktop LAN peer-to-peer file-transfer application built with Electron, React, and Node.js.

## Tech Stack

- Electron
- React
- TypeScript
- Node.js

## Repository Structure

apps/
packages/
docs/

## Development

Install dependencies once, then run the local API and renderer:

```bash
npm install
npm run dev
```

In a second terminal, build and open the Electron shell:

```bash
npm run desktop:electron
```

Run static checks with `npm run check`. The networking engine discovers peers via
UDP broadcast, establishes a framed TCP session, and verifies transferred files
with SHA-256 before acknowledging completion.
