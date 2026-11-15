# Token summary archive

The approximate conversation token count, reference bar, estimated cache timer, tokenizer, conversation-refresh logic and their tests are preserved on the [`archive/token-summary-v2.1.3`](https://github.com/lumigoh/claude-counter/tree/archive/token-summary-v2.1.3) branch, at commit `6acc0957a7790ae79a060d350c91cfad6ad3ebd3`.

They were retired from the active build in 2.1.4 because reconstructed conversation text does not reliably describe the model's active context after compaction. The 200k reference scale also did not establish the current model's actual context limit. The cache timer was an estimate rather than confirmation of server cache state.

The archive includes the full prior extension and standalone userscript, source, tokenizer license and tests. To inspect locally:

```sh
git fetch origin archive/token-summary-v2.1.3
git switch --detach origin/archive/token-summary-v2.1.3
```

Current builds retain session/weekly quota tracking. They do not load the tokenizer or fetch conversation trees for token counting.
