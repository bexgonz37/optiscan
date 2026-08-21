# OptiScan

Status: ACTIVE

## Goal

Build a professional options intelligence, alerting, research, and decision-support platform.

## Current phase

Validate and deploy the local options research stack.

**Gate open as of 2026-08-21: broad historical market memory.** The analog engine is built,
leakage-hardened and answered NO on 17 symbols; widening it is blocked on STORAGE, not on
the provider. The full eligible universe costs ~$0 in provider requests and ~178 GiB of
SQLite against a 45.53 GiB volume that is already 41% used and growing 172 MB/day. Three
owner decisions are outstanding — storage architecture, point-in-time equity membership,
and scope. See [[../05 Runtime/CURRENT_PACKET]].

## Components

- [[../02 Components/Options Scanner]]
- [[../02 Components/Discord Alerts]]
- [[../02 Components/Market Data]]
- [[../02 Components/Opportunity Lifecycle]]
- [[../02 Components/AI Learning System]]
- [[../02 Components/earlier-entry]]
- [[../02 Components/loss-protection]]
- [[../02 Components/watchlist]]
- [[../02 Components/Research Graph and Loop]]

## Current task

- [[../05 Runtime/CURRENT_PACKET]]

## Safety

- [[../02 Components/safety]]
