---
title: Local analysis, readings an agent can read
date: 2026-10-26
lanes: [developer]
summary: WavRead measures audio on the computer it runs on and writes the results as files a script or an agent can read, and this post sets out exactly what ships as of WavRead 1.5.6.
draft: false
---

## Where the analysis runs

WavRead analyzes audio on the computer it is installed on. No audio is uploaded, and there is no WavRead server doing the measuring. With the network cable out, the analysis still runs.

## What you get to read

Every analysis can be exported as Markdown, HTML, PDF, JSON and measurement tables. Two of those matter most when code is the reader:

- **The Track Document** is Markdown with stable headings and tables: loudness, structure, frequency balance, stereo over time, each stem on its own, and provenance.
- **The JSON export** carries the numbers themselves, for code that should not parse prose.

A value that could not be measured is written as unavailable, never as zero. Code that reads a reading should treat it as "not measured" and carry on.

## What ships, and what does not

From WavRead 1.5.6, the app carries a small MCP helper, `wavread-mcp`. An assistant that speaks MCP can use it to analyze files, list tracks and read measurements on the same computer. The helper talks only to WavRead and sends nothing anywhere itself. Setup is in [MCP.md](/MCP.md).

While it runs, the app also answers HTTP requests on your own machine, at 127.0.0.1. The [operating reference](/skill/references/operating-wavread.md) in the WavRead skill lists the routes.

There is no hosted WavRead API, no API key and no SDK. As of 1.5.6, building on WavRead means reading files and talking to a program on your own computer, not calling a web service.

## Check provenance before you compare

Each document records the WavRead version and the measurement schema that produced it. When a measurement changes in a way that makes old and new numbers incomparable, the document says so. Read the schema before you diff two readings.
