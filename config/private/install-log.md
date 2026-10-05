# Install log

One entry for each install, regeneration or switch of a profile on this host. Put the newest entry first.

Warning: do not write a secret value in this file. Write the name of a credential, never its value.

## YYYY-MM-DD: short title

- Kit commit: the full commit hash of the kit clone
- Overlay: the overlay file of this directory that you used
- Target: the absolute path of the generated profile
- Commands: the commands that you ran, in order
- Result: what you checked and what you saw
- Model replied: `yes`, `no` or `not run` (Stage 9 check 3), and the form: print mode or a pasted screen
- Reply matched: `yes`, `no` or `not run`. Write `yes` only when the expected reply is in the print mode output, or in the model line of the screen and not in the user line
- Live agent directory: the `result` of `check-baseline` (`unchanged`, `changed` with the names, or `no_baseline`), and the `recordedAt` time of the baseline
- Not verified: what you did not check
