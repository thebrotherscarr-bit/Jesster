# Rules

The rulesets of this repository, versioned as JSON so the gate itself is part
of the history. These files are the single source of truth; they are applied
to the repository with the same payload used to create them:

```bash
gh api repos/thebrotherscarr-bit/Jesster/rulesets \
  --method POST --input rules/rulesets/main.json
gh api repos/thebrotherscarr-bit/Jesster/rulesets \
  --method POST --input rules/rulesets/tags.json
```

Update a ruleset in place with `--method PUT /rulesets/<id>`.

## main - the gate

Applied to `refs/heads/main`:

- require a pull request before merging, with 1 approving review and resolved
  threads — every landing passes the operator's hand
- require the proof checks: `prove (ubuntu-latest)` and `prove (windows-latest)`
- require branches to be up to date (strict)
- require linear history — no merge commits; PRs rebase
- block force pushes, restrict deletions
- no bypass actors — the gate holds for everyone, operator included

## tags - immovable

Applied to `refs/tags/**`: no force pushes, no deletions.
