# Tests

The unit tests run **without DSH** and without any API key. They use a tiny
committed sample image (`sample.png`) and write into scratch `test-vault` /
`format-vault` directories that are `gitignore`d.

## Run

```sh
node test/test-format.mjs     # check the per-day note markdown shape
node test/test-storage.mjs    # storage + evening organize (backlinks, summaries)
node test/test-ocr.mjs        # live OCR against Qwen — requires DASHSCOPE_API_KEY
```

Or via npm:

```sh
npm test              # format + storage (no key needed)
npm run test:ocr      # live OCR (needs a key)
```

`test-ocr.mjs` calls the real Qwen multimodal API, so it needs a key and a
network connection. When no key is configured it simply skips (exit 0), so a
local, key-less run never fails.
