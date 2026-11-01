# How to update the vectors

The repo commits NIST's ACVP files for ML-DSA from `usnistgov/ACVP-Server` and the Wycheproof ML-DSA files from `C2SP/wycheproof` in `vectors/`, byte-identical to those repositories. `vectors/manifest.json` gives each file's source repository, commit, path, URL, and SHA-256. It pins each file by commit, not by tag, because ACVP-Server moved its tag `v1.1.0.43` after mldsa-native's v2.0.0 CI had used it.

A line-ending conversion or a formatter run would change the files' bytes and break their hashes. So `.gitattributes` marks `vectors/` as `-text -diff linguist-generated`, and Git never converts the files' line endings. The manifest is the exception, so a vector update shows its new hashes in the diff. `vite.config.ts` keeps the formatter away from the folder.

To move the vectors to a newer commit of a source repository, follow these steps:

1. Download each file from the new commit into its path in `vectors/`, such as with `curl -sSfL -o vectors/<file> <url>`.
2. In `vectors/manifest.json`, update the entry of each file: its `commit`, its `url`, and its `sha256`. Add an entry for a new file, and delete the entry of a file that you delete.
3. Run `node scripts/vector-provenance.ts`. It fetches each URL in the manifest and fails unless the URL serves the committed bytes. The script needs the network, so the check command doesn't run it.
4. Run `pnpm exec vp test run --silent=false packages/ml-dsa/test/vectors.test.ts`. It prints the count per path and per row of the routing table, and the cases per segment.
5. If a case matches no row or several rows, change the predicates in `packages/ml-dsa/test/routing-table.ts`, and raise `routingTableVersion`. If a case has the result `acceptable`, give its row an assertion for that result and set the row's `handlesAcceptable`. If a vector file doesn't match its schema, or a case breaks a shape rule, the format of the file changed. Check the schemas in `packages/ml-dsa/test/vector-cases.ts`, and the shape rules and the predicates in `routing-table.ts`, against the new format. If a new file has no reader, add one to `vector-cases.ts`.
6. If a row's count changed, set the row's `cases` to the new count. If a segment's counts changed, set its `cases` in `packages/ml-dsa/test/segment-table.ts`.
7. Run `scripts/check`.
8. Commit the files, the manifest, and the pinned counts in one commit.

To confirm that the source repositories still serve the pinned bytes, run `node scripts/vector-provenance.ts` with no changes.
