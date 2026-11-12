# Guide

## Subscribing to updates

The watcher keeps subscribing to marsupial updates until it is stopped.

## Troubleshooting

### Connection problems

Most connection problems are on the network side.

#### Stuck watcher

A stuck watcher stops answering heartbeats; restart it with `lexicon restart`.

#### Slow start

The first poll after a cold boot can take a while.
