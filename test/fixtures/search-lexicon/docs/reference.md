# Reference

Every key Lexicon reads, and every command it has.

## Settings

| Key | Meaning |
| --- | --- |
| `pollIntervalMs` | How often the watcher looks again, in milliseconds. |
| `retainDays` | How long receipts are kept before they are removed. |

## Commands

| Command | What it does |
| --- | --- |
| `lexicon prune` | Removes receipts older than `retainDays`. |
| plain cell | A row without a code span names nothing and is not a part of its own. |
