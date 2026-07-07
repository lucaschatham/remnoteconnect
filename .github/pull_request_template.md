## Summary

Describe what changed and why.

## Safety Impact

- [ ] No RemNote graph mutation behavior changed
- [ ] Mutating behavior changed and tests cover readonly/dry-run/confirmation paths
- [ ] Security-sensitive behavior changed and the risk is explained below

Notes:

## Testing

Commands run:

```sh

```

For live RemNote behavior, list the disposable test graph or fixture used. Do not include private note text, daemon tokens, RemNote exports, or graph maps.

## Checklist

- [ ] No daemon tokens were committed
- [ ] No private note/card content was committed
- [ ] No private RemNote exports, backups, or generated graph data were committed
- [ ] Broad or destructive operations remain dry-run-first
- [ ] Read-only enforcement still happens in the daemon before plugin dispatch
