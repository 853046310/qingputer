# Policy Matrix

## Default authorization model

- Session creation grants `terminal`, `filesystem`, and/or `browser` once.
- Terminal and filesystem actions may still require explicit approval.
- Browser actions execute directly without approval.
- Explicitly destructive actions are denied.

## Terminal

### Allow

- `pwd`
- `ls`
- `cat`
- `git status`
- `python --version`
- other commands that do not match elevated-risk patterns

### Require approval

- `sudo`
- `rm`, `mv`, `chmod`, `chown`
- `launchctl`, `osascript`
- package installation commands
- `git push`
- downloads to disk
- shell redirection (`>` / `>>`)
- background jobs

### Deny

- `rm -rf /`
- `shutdown`
- `reboot`
- disk erase / formatting commands
- `dd ... of=/dev/...`

## Filesystem

### Allow

- Reads and directory listing inside the user Home directory, excluding sensitive paths

### Require approval

- All writes
- Any read or list outside Home
- Any read or list inside sensitive paths:
  - `~/.ssh`
  - `~/.gnupg`
  - `~/Library/Keychains`
  - `~/Library/Mail`
  - `~/Library/Messages`
  - real browser profile directories

## Browser

### Allow

- `http(s)` navigation
- page text extraction
- regular clicks and typing in the isolated profile

### Deny

- non-`http(s)` URLs
- capabilities not implemented in v1, such as GUI automation outside the browser
