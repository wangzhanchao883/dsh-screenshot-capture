# Contributing

Thanks for taking an interest in `dsh-screenshot-capture`!

## Reporting bugs

Open an issue at
[github.com/wangzhanchao883/dsh-screenshot-capture/issues](https://github.com/wangzhanchao883/dsh-screenshot-capture/issues)
and include:
- what you expected vs. what happened
- the DSH / dsh-market version, platform (Windows 10/11), and PowerShell version
- the relevant config (redact any API key)

## Running the tests

```sh
npm test
```

The unit tests need no DSH and no API key. See [`test/README.md`](./test/README.md).

## Submitting changes

Open a PR against `main`. Please keep it focused: one logical change per PR.
- Keep the bilingual README in sync with any behavior change.
- Update [`CHANGELOG.md`](./CHANGELOG.md) under an appropriate section.
- Don't commit lockfiles, `node_modules/`, or test vault data.

Thanks!
