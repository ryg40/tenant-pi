---
description: Start, stop or show the local artifacts server, show the URLs of its pages, give the private Walkr address, or make a new admin key
argument-hint: "[start | off | status | walkr | rotate]"
---
The word of the user is `${1:-status}`.

1. When the word is `start`, `off`, `stop` or `status`, run `artifacts ${1:-status}`. When the word is `walkr`, run `artifacts walkr-url`. When the word is `rotate`, run `artifacts login rotate`. For another word, name these six words to the user and run nothing.
2. Show the output lines to the user. After `start`, give the URL of the last line in your reply, as the command printed it: usually the page `/artifacts` with the stored pages. A server from before the update prints the root address and a `note:` line; give that note too. The line `root:` names the root page with the links to `/artifacts`, `/walkr` and `/memory/`; a click on `/walkr` opens the Walkr page. The line `walkr:` comes only when Walkr is installed, and the line `memory:` only when the memory viewer can start.
3. After `walkr`, give the one output line in your reply only: it is the private address of the Walkr page, on the port of this server. Write it in no file and no other command. Exit 2 means that the session is unknown, 3 that no server answered or that the server runs from before the update (give its message), 4 that Walkr or Node is absent.
4. `off` stops this server and the live Walkr server; one output line says so. The saved Compare sessions stay. While a `walkr-compare wait` runs, use `artifacts off --keep-walkr`: it leaves the live Walkr server running.
5. The pages need a login: the user `admin` and the key in the password system. After the first `start`, the line `login:` names the store and the item of the new key; give that line too. After `rotate`, show the output lines: the store and the item. The key stays in its store: your reply names only the store and the item. A new key ends each browser session. Exit 6 means that no password system can take the key: give the message, which names the fix.

A refusal names its reason, for example a port that another program uses and the command `artifacts setup --port N`. Give that reason to the user and run no fix of your own.
